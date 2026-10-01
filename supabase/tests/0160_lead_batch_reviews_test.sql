-- ============================================================================
-- Behavioural tests for 0160: the monthly lead-batch snapshot (CLAUDE.md §73).
--
-- Each customer's cycle is captured inside reset_monthly_counts, before the
-- counter it reads is zeroed. Everything that can go wrong with that is
-- asserted here:
--
--   1. WHO is captured. Management and GR holders on their own anchor day.
--      Not: paused, archived, written off, or on a different anchor day. A
--      GR-only customer is captured for GR only, from gr_ columns only
--      (invariant 6).
--   2. WHAT is captured. The figures as they stood before the reset, and the
--      items in the window: excluding a lead assigned today (it belongs to the
--      next cycle), the customer's own upload (§30), and the other product's
--      leads.
--   3. A same-day re-run inserts nothing. reset_monthly_counts is run three
--      times in one day by 0141's suite.
--   4. ⚠️ A discard keeps its item, with the assignment pointer nulled.
--   5. ⚠️ A failed capture does not stop the counter reset.
--   6. The counters still zero exactly as before.
--   7. The window clamp, the CHECKs, the opt-out key, and the ACLs.
--
-- Run against a scratch Postgres with every migration applied. See README.md.
-- ============================================================================
\set ON_ERROR_STOP on
\pset pager off
\o /dev/null

create schema if not exists test_util;

create or replace function test_util.assert_eq(actual anyelement, expected anyelement, label text)
returns void language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'FAIL % — expected %, got %', label, expected, actual;
  end if;
  raise notice 'ok  %', label;
end $$;

create or replace function test_util.assert_raises(sql text, label text)
returns void language plpgsql as $$
begin
  begin
    execute sql;
  exception when others then
    raise notice 'ok  %', label;
    return;
  end;
  raise exception 'FAIL % — expected an error, none raised', label;
end $$;

-- Cleared up front so the suite can be re-run on the same database (0149's
-- lesson).
delete from public.lead_batch_reviews;
delete from public.service_capacity_snapshots;
delete from public.lead_outcome_reasons;
delete from public.lead_quality_claims;
delete from public.lead_events;
delete from public.lead_notes;
delete from public.lead_assignments;
delete from public.leads;
delete from public.lead_topup_tokens;
delete from public.payments;
delete from public.customers;

-- ---------------------------------------------------------------------------
-- 7a — the window clamp, the CHECKs and the opt-out key, before any data
-- ---------------------------------------------------------------------------
select test_util.assert_eq(public.batch_cycle_start(15, '2026-10-15'), '2026-09-15'::date,
  'cycle start: the same day of the previous month');
select test_util.assert_eq(public.batch_cycle_start(31, '2026-03-31'), '2026-02-28'::date,
  'cycle start: an anchor on the 31st clamps to the last day of February');
select test_util.assert_eq(public.batch_cycle_start(30, '2026-10-30'), '2026-09-30'::date,
  'cycle start: the 30th lands on the 30th of a 30-day month');

select test_util.assert_eq(
  (select (column_default like '%"monthly_review": true%') from information_schema.columns
    where table_schema = 'public' and table_name = 'customers'
      and column_name = 'notification_preferences'),
  true, 'notification_preferences default carries monthly_review');

select test_util.assert_eq(
  (select value from public.system_settings where key = 'batch_reviews_enabled'),
  'false', 'sending ships switched off');

-- ---------------------------------------------------------------------------
-- The book
-- ---------------------------------------------------------------------------
insert into public.customers
  (id, business_name, contact_name, email, is_active,
   monthly_allocation, gr_monthly_allocation, lead_balance, gr_lead_balance,
   leads_received_this_month, gr_leads_received_this_month,
   account_status, subscription_status, gr_subscription_status,
   billing_cycle_anchor, gr_billing_cycle_anchor, paused_at, lapsed_at,
   filter_status, filter_expected_leads, filter_areas, pending_monthly_allocation)
values
  -- 1. Management, anchor today, short by 3. Must be captured.
  ('b0000000-0000-0000-0000-000000000001','Short mgmt','A','a@x.com',true,
   10,10,3,0,7,0,'active','active','inactive',current_date,null,null,null,
   'active',4,'{BS,GL}',20),
  -- 2. Paused. Not captured.
  ('b0000000-0000-0000-0000-000000000002','Paused','B','b@x.com',true,
   10,10,5,0,2,0,'active','active','inactive',current_date,null,now(),null,
   'off',null,null,null),
  -- 3. Archived. Not captured.
  ('b0000000-0000-0000-0000-000000000003','Archived','C','c@x.com',false,
   10,10,0,0,10,0,'active','active','inactive',current_date,null,null,null,
   'off',null,null,null),
  -- 4. GR only: waitlisted for management, active on GR. GR review only.
  ('b0000000-0000-0000-0000-000000000004','GR only','D','d@x.com',true,
   20,10,99,0,99,10,'waitlisted','inactive','active',current_date,current_date,null,null,
   'off',null,null,null),
  -- 5. Management, a different anchor day. Not captured today.
  ('b0000000-0000-0000-0000-000000000005','Other day','E','e@x.com',true,
   10,10,0,0,4,0,'active','active','inactive',current_date - 3,null,null,null,
   'off',null,null,null),
  -- 6. Written off (§59). Not captured.
  ('b0000000-0000-0000-0000-000000000006','Lapsed','F','f@x.com',true,
   10,10,0,0,1,0,'cancelled','past_due','inactive',current_date,null,null,now(),
   'off',null,null,null);

select test_util.assert_eq(
  (select (notification_preferences->>'monthly_review')::boolean
     from public.customers where id = 'b0000000-0000-0000-0000-000000000001'),
  true, 'a new customer gets monthly_review = true');

-- Seven management leads for customer 1, inside the window.
insert into public.leads (id, monday_item_id, lead_name, postcode_area, bedrooms,
                          gross_annual_income, max_assignments, assignment_count, lead_type)
select ('a1000000-0000-0000-0000-0000000000' || lpad(i::text, 2, '0'))::uuid,
       'm-batch-' || i, 'Landlord ' || i, 'BS', '3', 30000 + i, 3, 1, 'management'
  from generate_series(1, 9) i;

insert into public.lead_assignments (id, lead_id, customer_id, price_paid, assigned_at, pipeline_stage, status)
select ('a2000000-0000-0000-0000-0000000000' || lpad(i::text, 2, '0'))::uuid,
       ('a1000000-0000-0000-0000-0000000000' || lpad(i::text, 2, '0'))::uuid,
       'b0000000-0000-0000-0000-000000000001', 15.00,
       now() - make_interval(days => 10 + i),
       case when i = 1 then 'web_meeting_booked' else 'cold' end,
       case when i = 1 then 'contacted' else 'new' end
  from generate_series(1, 7) i;

-- 8: assigned TODAY. It belongs to the next cycle.
insert into public.lead_assignments (id, lead_id, customer_id, price_paid, assigned_at)
values ('a2000000-0000-0000-0000-000000000008','a1000000-0000-0000-0000-000000000008',
        'b0000000-0000-0000-0000-000000000001', 15.00, current_date::timestamptz + interval '1 minute');

-- 9: assigned before the window opened.
insert into public.lead_assignments (id, lead_id, customer_id, price_paid, assigned_at)
values ('a2000000-0000-0000-0000-000000000009','a1000000-0000-0000-0000-000000000009',
        'b0000000-0000-0000-0000-000000000001', 15.00, now() - interval '70 days');

-- The customer's own upload, inside the window. Excluded (§30).
insert into public.leads (id, lead_name, postcode_area, max_assignments, assignment_count,
                          lead_type, owner_customer_id, owner_source)
values ('a1000000-0000-0000-0000-000000000050','My own lead','BS',1,1,'management',
        'b0000000-0000-0000-0000-000000000001','manual');
insert into public.lead_assignments (id, lead_id, customer_id, price_paid, assigned_at)
values ('a2000000-0000-0000-0000-000000000050','a1000000-0000-0000-0000-000000000050',
        'b0000000-0000-0000-0000-000000000001', 0, now() - interval '5 days');

-- A GR lead for customer 1. Not part of their management batch.
insert into public.leads (id, monday_item_id, lead_name, postcode_area, max_assignments, assignment_count, lead_type)
values ('a1000000-0000-0000-0000-000000000060','g-batch-60','GR landlord','BS',3,1,'guaranteed_rent');
insert into public.lead_assignments (id, lead_id, customer_id, price_paid, assigned_at)
values ('a2000000-0000-0000-0000-000000000060','a1000000-0000-0000-0000-000000000060',
        'b0000000-0000-0000-0000-000000000001', 15.00, now() - interval '5 days');

-- One GR lead for the GR-only customer.
insert into public.leads (id, monday_item_id, lead_name, postcode_area, max_assignments, assignment_count, lead_type)
values ('a1000000-0000-0000-0000-000000000061','g-batch-61','GR landlord 2','LS',3,1,'guaranteed_rent');
insert into public.lead_assignments (id, lead_id, customer_id, price_paid, assigned_at)
values ('a2000000-0000-0000-0000-000000000061','a1000000-0000-0000-0000-000000000061',
        'b0000000-0000-0000-0000-000000000004', 15.00, now() - interval '5 days');

-- ---------------------------------------------------------------------------
-- 5 — a failed capture does not stop the reset
--
-- With the table renamed away the capture raises. The reset must still zero the
-- counter, and the rename is rolled back afterwards by the sub-block.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    alter table public.lead_batch_reviews rename to lead_batch_reviews_away;
    perform public.reset_monthly_counts();
    if (select leads_received_this_month from public.customers
         where id = 'b0000000-0000-0000-0000-000000000001') <> 0 then
      raise exception 'FAIL the counter was not zeroed when the capture failed';
    end if;
    raise exception 'rollback_ok';
  exception when others then
    if sqlerrm <> 'rollback_ok' then raise; end if;
  end;
  raise notice 'ok  a failed capture is a warning, and the counter still resets';
end $$;

select test_util.assert_eq(
  (select leads_received_this_month from public.customers
    where id = 'b0000000-0000-0000-0000-000000000001'),
  7, 'the probe above rolled back cleanly');

-- ---------------------------------------------------------------------------
-- 1, 2, 6 — the real reset
-- ---------------------------------------------------------------------------
select public.reset_monthly_counts();

select test_util.assert_eq(
  (select count(*)::int from public.lead_batch_reviews), 2,
  'exactly two reviews: customer 1 management and customer 4 GR');

select test_util.assert_eq(
  (select delivered from public.lead_batch_reviews
    where customer_id = 'b0000000-0000-0000-0000-000000000001' and lead_type = 'management'),
  7, 'delivered = the seven leads in the window (not today''s, not the earlier one, not the upload, not GR)');

select test_util.assert_eq(
  (select (allocation, counter_at_reset, balance_at_reset, next_allocation, cycle_end)::text
     from public.lead_batch_reviews
    where customer_id = 'b0000000-0000-0000-0000-000000000001'),
  (10, 7, 3, 20, current_date)::text,
  'the figures as they stood BEFORE the reset; next allocation reads the pending tier');

select test_util.assert_eq(
  (select (filter_status, filter_expected_leads, filter_areas)::text from public.lead_batch_reviews
    where customer_id = 'b0000000-0000-0000-0000-000000000001'),
  ('active', 4, '{BS,GL}'::text[])::text,
  'the filter is snapshotted as it stood');

select test_util.assert_eq(
  (select cycle_start from public.lead_batch_reviews
    where customer_id = 'b0000000-0000-0000-0000-000000000001'),
  public.batch_cycle_start(extract(day from current_date)::int, current_date),
  'the window opens on the previous anchor occurrence');

select test_util.assert_eq(
  (select (stage_at_capture, status_at_capture, postcode_area)::text
     from public.lead_batch_review_items
    where assignment_id = 'a2000000-0000-0000-0000-000000000001'),
  ('web_meeting_booked', 'contacted', 'BS')::text,
  'the item carries the stage and status at capture and the denormalised area');

select test_util.assert_eq(
  (select count(*)::int from public.lead_batch_review_items
    where assignment_id in ('a2000000-0000-0000-0000-000000000008',
                            'a2000000-0000-0000-0000-000000000009',
                            'a2000000-0000-0000-0000-000000000050',
                            'a2000000-0000-0000-0000-000000000060')),
  0, 'today''s lead, the pre-window lead, the upload and the GR lead are all excluded');

select test_util.assert_eq(
  (select (lead_type, delivered, allocation, counter_at_reset, balance_at_reset)::text
     from public.lead_batch_reviews
    where customer_id = 'b0000000-0000-0000-0000-000000000004'),
  ('guaranteed_rent', 1, 10, 10, 0)::text,
  'GR-only: captured for GR, from gr_ columns only (invariant 6)');

select test_util.assert_eq(
  (select count(*)::int from public.lead_batch_reviews
    where customer_id in ('b0000000-0000-0000-0000-000000000002',
                          'b0000000-0000-0000-0000-000000000003',
                          'b0000000-0000-0000-0000-000000000005',
                          'b0000000-0000-0000-0000-000000000006')),
  0, 'paused, archived, other-day and written-off customers are not captured');

select test_util.assert_eq(
  (select string_agg(id::text || ':' || leads_received_this_month::text, ',' order by id)
     from public.customers),
  'b0000000-0000-0000-0000-000000000001:0,b0000000-0000-0000-0000-000000000002:0,'
  || 'b0000000-0000-0000-0000-000000000003:0,b0000000-0000-0000-0000-000000000004:0,'
  || 'b0000000-0000-0000-0000-000000000005:4,b0000000-0000-0000-0000-000000000006:0',
  'the counters still zero exactly as before (customer 5 is on another day)');

select test_util.assert_eq(
  (select gr_leads_received_this_month from public.customers
    where id = 'b0000000-0000-0000-0000-000000000004'),
  0, 'the GR counter still zeroes');

-- ---------------------------------------------------------------------------
-- 3 — a same-day re-run inserts nothing
-- ---------------------------------------------------------------------------
select public.reset_monthly_counts();
select public.reset_monthly_counts();

select test_util.assert_eq(
  (select count(*)::int from public.lead_batch_reviews), 2,
  'three runs on one day, still two reviews');
select test_util.assert_eq(
  (select count(*)::int from public.lead_batch_review_items), 8,
  'and still eight items');
select test_util.assert_eq(
  (select balance_at_reset from public.lead_batch_reviews
    where customer_id = 'b0000000-0000-0000-0000-000000000001'),
  3, 'a re-run does not overwrite the figures');

-- ⚠️ The capture called DIRECTLY, outside the reset's exception handler. Through
-- the reset a duplicate-key error would be swallowed as a warning, so the three
-- runs above pass whether or not the insert is `on conflict do nothing`.
-- Without it, one already-captured customer would abort the capture for every
-- other customer on that anchor day.
select test_util.assert_eq(public.capture_lead_batch_reviews(current_date), 2,
  'calling the capture directly on a captured day is a no-op, not an error');

-- ---------------------------------------------------------------------------
-- 4 — a discard keeps the item
-- ---------------------------------------------------------------------------
delete from public.lead_assignments where id = 'a2000000-0000-0000-0000-000000000003';

select test_util.assert_eq(
  (select count(*)::int from public.lead_batch_review_items i
     join public.lead_batch_reviews r on r.id = i.review_id
    where r.customer_id = 'b0000000-0000-0000-0000-000000000001'),
  7, 'deleting an assignment leaves its item');
select test_util.assert_eq(
  (select count(*)::int from public.lead_batch_review_items
    where lead_id = 'a1000000-0000-0000-0000-000000000003' and assignment_id is null),
  1, 'with the assignment pointer nulled and the lead kept');

-- ---------------------------------------------------------------------------
-- 7b — CHECKs
-- ---------------------------------------------------------------------------
select test_util.assert_raises(
  $q$update public.lead_batch_review_items set answer = 'maybe'
      where lead_id = 'a1000000-0000-0000-0000-000000000001'$q$,
  'an answer outside the vocabulary is refused');
select test_util.assert_raises(
  $q$update public.lead_batch_review_items set dead_reason = 'ghosted'
      where lead_id = 'a1000000-0000-0000-0000-000000000001'$q$,
  'a dead reason outside the vocabulary is refused');
select test_util.assert_raises(
  $q$update public.lead_batch_reviews set quality_rating = 6$q$,
  'a rating above 5 is refused');
select test_util.assert_raises(
  $q$update public.lead_batch_reviews set comment = repeat('x', 2001)$q$,
  'a comment over 2000 characters is refused');
select test_util.assert_raises(
  $q$insert into public.lead_batch_reviews (customer_id, lead_type, cycle_start, cycle_end,
       allocation, counter_at_reset, balance_at_reset, next_allocation)
     values ('b0000000-0000-0000-0000-000000000001','management', current_date - 30,
             current_date, 10, 0, 0, 10)$q$,
  'one review per customer, product and cycle');

update public.lead_batch_review_items set answer = 'meeting_booked', dead_reason = null
 where lead_id = 'a1000000-0000-0000-0000-000000000001';
update public.lead_batch_reviews set quality_rating = 4, comment = 'ok'
 where customer_id = 'b0000000-0000-0000-0000-000000000001';
select test_util.assert_eq(
  (select answer from public.lead_batch_review_items
    where lead_id = 'a1000000-0000-0000-0000-000000000001'),
  'meeting_booked', 'a valid answer is accepted');

-- ---------------------------------------------------------------------------
-- 7c — ACLs
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('capture_lead_batch_reviews','batch_cycle_start','reset_monthly_counts')
      and (has_function_privilege('anon', p.oid, 'execute')
           or has_function_privilege('authenticated', p.oid, 'execute'))),
  0, 'anon and authenticated execute none of them');
select test_util.assert_eq(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('capture_lead_batch_reviews','batch_cycle_start','reset_monthly_counts')
      and not has_function_privilege('service_role', p.oid, 'execute')),
  0, 'service_role executes all of them');
select test_util.assert_eq(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('lead_batch_reviews','lead_batch_review_items')
      and c.relrowsecurity),
  2, 'both tables have RLS on');
select test_util.assert_eq(
  (select count(*)::int from pg_policies
    where schemaname = 'public'
      and tablename in ('lead_batch_reviews','lead_batch_review_items')),
  0, 'with no policies (deny-all to the browser)');
select test_util.assert_eq(
  (select count(distinct p.proname)::integer from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('get_engagement_benchmarks','set_management_customer_goal',
                        'get_operator_proof','get_recent_wins_anonymised')
      and has_function_privilege('authenticated', p.oid, 'execute')),
  4, 'invariant 7: the four customer-callable functions still are');

-- Teardown. Reviews cascade from customers; clear them anyway.
delete from public.lead_batch_reviews;

\o
select '0160 BEHAVIOURAL TESTS PASSED' as result;
