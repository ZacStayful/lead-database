-- ============================================================================
-- Behavioural tests for 0167: data for brief customers' pauses and area
-- changes (batch 04 Phase 1; docs/build/04-phase0-report.md, C2 and C6).
--
--   1. An ordinary pause (the existing 1/2/3-month card) inserts exactly as
--      before: months set, hold_area null, and it may not drop its months.
--   2. A brief pause: months may be null, and hold_area must agree with the
--      length — 28 days or fewer by LONDON dates, not hours and not UTC dates.
--   3. The brief maximum: up to 3 months by London dates, with the month-end
--      clamp; an ordinary pause is not bound by it.
--   4. recalibrated_at only on a long pause; pending_brief_id only after a
--      recalibration, and set null when that brief is deleted.
--   5. Brief versions: a pending one needs effective_at; an auto-accept is a
--      confirmation; the auto-accept index.
--   6. C2: a paused BRIEF customer banks no management replacements, through
--      the grant function and through reset_monthly_counts, and is granted
--      again from the day they return. A paused ordinary customer still
--      accrues (§61), and a paused brief customer's GR share still accrues
--      (invariant 6).
--   7. customers.pause_holds_area exists and nothing writes it.
--   8. ACLs, and invariant 7.
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

-- The name of the constraint a statement violated, or null.
create or replace function test_util.violated(sql text)
returns text language plpgsql as $$
declare
  v_name text;
begin
  execute sql;
  return null;
exception when check_violation or not_null_violation or unique_violation or foreign_key_violation then
  get stacked diagnostics v_name = constraint_name;
  return coalesce(v_name, sqlstate);
end $$;

create or replace function test_util.grant_of(p_id uuid)
returns integer language sql as $$
  select public.replacement_monthly_grant(c) from public.customers c where c.id = p_id;
$$;

create or replace function test_util.balance_of(p_id uuid)
returns integer language sql as $$
  select replacement_balance from public.customers where id = p_id;
$$;

-- An episode insert for customer p_customer, as text so it can be run under
-- violated(). Times are explicit UTC so the London-date cases mean what they
-- say whatever the server's TimeZone.
create or replace function test_util.pause_sql(
  p_customer text, p_paused text, p_resumes text, p_months text, p_hold text
) returns text language sql as $$
  select format(
    'insert into public.subscription_pauses (customer_id, paused_at, resumes_at, months, reasons, hold_area) '
    'values (%L, %L::timestamptz, %L::timestamptz, %s, %L::text[], %s)',
    p_customer, p_paused, p_resumes, p_months, '{seasonal}', p_hold);
$$;

-- Cleared up front so the suite can be re-run on the same database. Pauses and
-- briefs go with their customers (on delete cascade).
delete from public.customers where id::text like 'c1670000-%';

insert into public.customers
  (id, business_name, contact_name, email, is_active,
   monthly_allocation, gr_monthly_allocation, lead_balance, gr_lead_balance,
   account_status, subscription_status, gr_subscription_status,
   quality_allowance_pct, billing_cycle_anchor, gr_billing_cycle_anchor,
   paused_at, lead_brief_required, lead_brief_completed_at)
values
  -- An ordinary management customer, paused: still accrues (§61).
  ('c1670000-0000-0000-0000-000000000001','Ordinary paused','A','a167@x.com',true,
   20,10,20,0,'active','active','inactive',0.10,current_date,null,now(),false,null),
  -- A brief customer, paused: banks nothing on the management side (C2).
  ('c1670000-0000-0000-0000-000000000002','Brief paused','B','b167@x.com',true,
   20,10,20,0,'active','active','inactive',0.10,current_date,null,now(),true,now()),
  -- A brief customer, not paused: accrues as usual.
  ('c1670000-0000-0000-0000-000000000003','Brief active','C','c167@x.com',true,
   20,10,20,0,'active','active','inactive',0.10,current_date,null,null,true,now()),
  -- A paused brief customer who also holds GR: the GR share still accrues
  -- (a pause is management only, invariant 6). 20 + 10 at 0.10, the management
  -- term zeroed: round(10 × 0.10) = 1.
  ('c1670000-0000-0000-0000-000000000004','Brief paused, GR','D','d167@x.com',true,
   20,10,20,20,'active','active','active',0.10,current_date,current_date,now(),true,now()),
  -- A brief customer flagged but not yet through the questionnaire, paused:
  -- still a brief customer (lead_brief_required is what routing keys on, 0163).
  ('c1670000-0000-0000-0000-000000000005','Brief flagged, paused','E','e167@x.com',true,
   10,10,20,0,'active','active','inactive',0.10,current_date,null,now(),true,null);

-- ---------------------------------------------------------------------------
-- 1. An ordinary pause is unchanged
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  test_util.violated(test_util.pause_sql(
    'c1670000-0000-0000-0000-000000000001',
    '2026-10-10 09:00+00', '2027-01-10 09:00+00', '3', 'null')),
  null, 'an ordinary 3-month pause inserts as before, months set and hold_area null');

select test_util.assert_eq(
  test_util.violated(test_util.pause_sql(
    'c1670000-0000-0000-0000-000000000001',
    '2026-10-10 09:00+00', '2026-11-10 09:00+00', 'null', 'null')),
  'subscription_pauses_months_or_brief',
  'an ordinary pause may not drop its months (only a brief pause may)');

select test_util.assert_eq(
  test_util.violated(test_util.pause_sql(
    'c1670000-0000-0000-0000-000000000001',
    '2026-10-10 09:00+00', '2026-11-10 09:00+00', '4', 'null')),
  'subscription_pauses_months_check',
  '0084''s month CHECK still refuses a month count outside 1–3');

-- ⚠️ JavaScript's setMonth on 30 Nov + 3 lands on 2 Mar. That is the existing
-- route's arithmetic (§11), and the brief maximum must not reach it.
select test_util.assert_eq(
  test_util.violated(test_util.pause_sql(
    'c1670000-0000-0000-0000-000000000001',
    '2026-11-30 09:00+00', '2027-03-02 09:00+00', '3', 'null')),
  null, 'an ordinary pause is not bound by the brief maximum');

-- ---------------------------------------------------------------------------
-- 2. A brief pause: 28 days or fewer, by London dates
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  test_util.violated(test_util.pause_sql(
    'c1670000-0000-0000-0000-000000000002',
    '2026-10-10 09:00+00', '2026-11-07 09:00+00', 'null', 'true')),
  null, 'a 28-day brief pause holds the area, with no month count');

select test_util.assert_eq(
  test_util.violated(test_util.pause_sql(
    'c1670000-0000-0000-0000-000000000002',
    '2026-10-10 09:00+00', '2026-11-07 09:00+00', 'null', 'false')),
  'subscription_pauses_hold_area_length', '… and may not be marked as releasing it');

select test_util.assert_eq(
  test_util.violated(test_util.pause_sql(
    'c1670000-0000-0000-0000-000000000002',
    '2026-10-10 09:00+00', '2026-11-08 09:00+00', 'null', 'false')),
  null, 'a 29-day brief pause releases the area');

select test_util.assert_eq(
  test_util.violated(test_util.pause_sql(
    'c1670000-0000-0000-0000-000000000002',
    '2026-10-10 09:00+00', '2026-11-08 09:00+00', 'null', 'true')),
  'subscription_pauses_hold_area_length', '… and may not be marked as holding it');

-- ⚠️ Not hours: paused at 06:00 UTC, back at 09:00 UTC on day 28 is 28 days
-- and three hours, and still a short pause.
select test_util.assert_eq(
  test_util.violated(test_util.pause_sql(
    'c1670000-0000-0000-0000-000000000002',
    '2026-10-10 06:00+00', '2026-11-07 09:00+00', 'null', 'true')),
  null, 'the length is counted in dates, not hours');

-- ⚠️ Not UTC dates: 23:30 UTC on 10 Oct is 00:30 on 11 Oct in London (BST),
-- and 08:00 UTC on 8 Nov is 8 Nov in London (GMT). In London that is 28 days;
-- in UTC dates it would be 29.
select test_util.assert_eq(
  test_util.violated(test_util.pause_sql(
    'c1670000-0000-0000-0000-000000000002',
    '2026-10-10 23:30+00', '2026-11-08 08:00+00', 'null', 'true')),
  null, 'the length is counted in LONDON dates, across the clock change');

select test_util.assert_eq(
  test_util.violated(test_util.pause_sql(
    'c1670000-0000-0000-0000-000000000002',
    '2026-10-10 23:30+00', '2026-11-08 08:00+00', 'null', 'false')),
  'subscription_pauses_hold_area_length', '… so the same dates may not be marked long');

-- A brief pause may still carry a month count; nothing forbids it.
select test_util.assert_eq(
  test_util.violated(test_util.pause_sql(
    'c1670000-0000-0000-0000-000000000002',
    '2026-10-10 09:00+00', '2026-12-10 09:00+00', '2', 'false')),
  null, 'a brief pause may still record a month count');

-- ---------------------------------------------------------------------------
-- 3. The brief maximum: 3 months by London dates, month-end clamped
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  test_util.violated(test_util.pause_sql(
    'c1670000-0000-0000-0000-000000000002',
    '2026-11-30 09:00+00', '2027-02-28 09:00+00', 'null', 'false')),
  null, 'a brief pause from 30 Nov may return on 28 Feb (3 months, clamped)');

select test_util.assert_eq(
  test_util.violated(test_util.pause_sql(
    'c1670000-0000-0000-0000-000000000002',
    '2026-11-30 09:00+00', '2027-03-01 09:00+00', 'null', 'false')),
  'subscription_pauses_brief_max', '… and not on 1 Mar');

select test_util.assert_eq(
  test_util.violated(test_util.pause_sql(
    'c1670000-0000-0000-0000-000000000002',
    '2026-10-10 09:00+00', '2027-01-10 09:00+00', 'null', 'false')),
  null, 'a brief pause of exactly 3 months is allowed');

select test_util.assert_eq(
  test_util.violated(test_util.pause_sql(
    'c1670000-0000-0000-0000-000000000002',
    '2026-10-10 09:00+00', '2027-01-11 09:00+00', 'null', 'false')),
  'subscription_pauses_brief_max', 'a brief pause of 3 months and a day is refused');

-- 0084's ordering CHECK still applies.
select test_util.assert_eq(
  test_util.violated(test_util.pause_sql(
    'c1670000-0000-0000-0000-000000000002',
    '2026-10-10 09:00+00', '2026-10-10 09:00+00', 'null', 'true')),
  'subscription_pauses_resumes_after_pause', 'a return must still come after the pause');

-- ---------------------------------------------------------------------------
-- 4. Recalibration and the pending brief it wrote
-- ---------------------------------------------------------------------------
insert into public.subscription_pauses
  (id, customer_id, paused_at, resumes_at, months, reasons, hold_area)
values
  ('a1670000-0000-0000-0000-000000000001', 'c1670000-0000-0000-0000-000000000002',
   '2026-10-10 09:00+00', '2026-12-10 09:00+00', null, '{seasonal}', false),
  ('a1670000-0000-0000-0000-000000000002', 'c1670000-0000-0000-0000-000000000002',
   '2026-10-10 09:00+00', '2026-10-24 09:00+00', null, '{seasonal}', true),
  ('a1670000-0000-0000-0000-000000000003', 'c1670000-0000-0000-0000-000000000001',
   '2026-10-10 09:00+00', '2027-01-10 09:00+00', 3, '{seasonal}', null);

select test_util.assert_eq(
  test_util.violated($$update public.subscription_pauses set recalibrated_at = now()
                        where id = 'a1670000-0000-0000-0000-000000000001'$$),
  null, 'a long brief pause can be recalibrated');

select test_util.assert_eq(
  test_util.violated($$update public.subscription_pauses set recalibrated_at = now()
                        where id = 'a1670000-0000-0000-0000-000000000002'$$),
  'subscription_pauses_recalibrated_long_only', 'a short brief pause is never recalibrated');

-- ⚠️ `hold_area = false` would pass here (NULL), which is why the CHECK says
-- `is false`.
select test_util.assert_eq(
  test_util.violated($$update public.subscription_pauses set recalibrated_at = now()
                        where id = 'a1670000-0000-0000-0000-000000000003'$$),
  'subscription_pauses_recalibrated_long_only', 'nor is an ordinary pause (hold_area null)');

insert into public.customer_lead_briefs
  (id, customer_id, version, status, origin, base_postcode, base_outcode, operating_mode,
   travel_limit_miles, allocation, priorities, service_radius_miles, service_outcodes,
   expected_mix, confirmed_at)
values
  ('b1670000-0000-0000-0000-000000000001', 'c1670000-0000-0000-0000-000000000002', 1, 'active',
   'customer', 'HG2', 'HG2', 'anywhere', null, 20, '[{"key":"location"}]'::jsonb, 20, '{HG2}',
   '{}'::jsonb, now());

select test_util.assert_eq(
  test_util.violated($$insert into public.customer_lead_briefs
    (id, customer_id, version, status, origin, base_postcode, base_outcode, operating_mode,
     travel_limit_miles, allocation, priorities, service_radius_miles, service_outcodes, expected_mix)
    values ('b1670000-0000-0000-0000-000000000002', 'c1670000-0000-0000-0000-000000000002', 2,
            'pending_confirmation', 'recompute', 'HG2', 'HG2', 'anywhere', null, 20,
            '[{"key":"location"}]'::jsonb, 30, '{HG2,HG1}', '{}'::jsonb)$$),
  'customer_lead_briefs_pending_effective', 'a pending version without effective_at is refused');

insert into public.customer_lead_briefs
  (id, customer_id, version, status, origin, base_postcode, base_outcode, operating_mode,
   travel_limit_miles, allocation, priorities, service_radius_miles, service_outcodes,
   expected_mix, effective_at)
values
  ('b1670000-0000-0000-0000-000000000002', 'c1670000-0000-0000-0000-000000000002', 2,
   'pending_confirmation', 'recompute', 'HG2', 'HG2', 'anywhere', null, 20,
   '[{"key":"location"}]'::jsonb, 30, '{HG2,HG1}', '{}'::jsonb, '2026-12-10 09:00+00');

select test_util.assert_eq(
  (select count(*)::integer from public.customer_lead_briefs
    where customer_id = 'c1670000-0000-0000-0000-000000000002' and status = 'pending_confirmation'),
  1, 'a pending version with effective_at sits beside the active one');

select test_util.assert_eq(
  test_util.violated($$update public.subscription_pauses
                          set pending_brief_id = 'b1670000-0000-0000-0000-000000000002',
                              recalibrated_at = null
                        where id = 'a1670000-0000-0000-0000-000000000001'$$),
  'subscription_pauses_pending_brief_recalibrated',
  'a pending brief is only recorded on a recalibrated pause');

update public.subscription_pauses
   set pending_brief_id = 'b1670000-0000-0000-0000-000000000002', recalibrated_at = now()
 where id = 'a1670000-0000-0000-0000-000000000001';

select test_util.assert_eq(
  test_util.violated($$update public.subscription_pauses
                          set pending_brief_id = 'b1670000-0000-0000-0000-0000000000ff'
                        where id = 'a1670000-0000-0000-0000-000000000001'$$),
  'subscription_pauses_pending_brief_id_fkey', 'pending_brief_id must name a real brief version');

delete from public.customer_lead_briefs where id = 'b1670000-0000-0000-0000-000000000002';
select test_util.assert_eq(
  (select (pending_brief_id is null)::text || ':' || (recalibrated_at is not null)::text
     from public.subscription_pauses where id = 'a1670000-0000-0000-0000-000000000001'),
  'true:true', 'deleting the brief nulls the pointer and keeps the episode');

-- ---------------------------------------------------------------------------
-- 5. Brief versions: auto-accept, and the index
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  test_util.violated($$update public.customer_lead_briefs set auto_accepted_at = now()
                        where id = 'b1670000-0000-0000-0000-000000000001'$$),
  'customer_lead_briefs_auto_accept_confirmed',
  'an auto-accept needs the effective date it was measured from');

select test_util.assert_eq(
  test_util.violated($$update public.customer_lead_briefs
                          set auto_accepted_at = now(), effective_at = now() - interval '3 days'
                        where id = 'b1670000-0000-0000-0000-000000000001'$$),
  null, 'an auto-accepted active version with its effective date is accepted');

select test_util.assert_eq(
  test_util.violated($$insert into public.customer_lead_briefs
    (customer_id, version, status, origin, base_postcode, base_outcode, operating_mode,
     travel_limit_miles, allocation, priorities, service_radius_miles, service_outcodes,
     expected_mix, effective_at, auto_accepted_at)
    values ('c1670000-0000-0000-0000-000000000002', 3, 'pending_confirmation', 'recompute',
            'HG2', 'HG2', 'anywhere', null, 20, '[{"key":"location"}]'::jsonb, 30, '{HG2,HG1}',
            '{}'::jsonb, now(), now())$$),
  'customer_lead_briefs_auto_accept_confirmed', 'an auto-accept is a confirmation, so it needs confirmed_at');

select test_util.assert_eq(
  (select pg_get_indexdef(i.indexrelid) like '%(effective_at)%WHERE (status = ''pending_confirmation''::text)%'
     from pg_index i join pg_class c on c.oid = i.indexrelid
    where c.relname = 'customer_lead_briefs_pending_effective_idx'),
  true, 'the auto-accept index covers pending versions by effective_at');

-- ---------------------------------------------------------------------------
-- 6. C2: the replacement grant
-- ---------------------------------------------------------------------------
select test_util.assert_eq(test_util.grant_of('c1670000-0000-0000-0000-000000000001'), 2,
  'a paused ORDINARY customer still accrues (§61)');
select test_util.assert_eq(test_util.grant_of('c1670000-0000-0000-0000-000000000002'), 0,
  'C2: a paused brief customer banks no replacements');
select test_util.assert_eq(test_util.grant_of('c1670000-0000-0000-0000-000000000003'), 2,
  'a brief customer who is not paused accrues as usual');
select test_util.assert_eq(test_util.grant_of('c1670000-0000-0000-0000-000000000004'), 1,
  'a paused brief customer''s GR share still accrues (invariant 6)');
select test_util.assert_eq(test_util.grant_of('c1670000-0000-0000-0000-000000000005'), 0,
  'a flagged brief customer who has not finished the questionnaire is a brief customer too');

-- Through the reset. Never granted for this cycle: the ordinary customer is
-- granted, the paused brief customer is not, and is not stamped either.
update public.customers set replacement_balance = 0, replacement_granted_on = null
 where id::text like 'c1670000-%';
select public.reset_monthly_counts();

select test_util.assert_eq(test_util.balance_of('c1670000-0000-0000-0000-000000000001'), 2,
  'the reset grants the paused ordinary customer');
select test_util.assert_eq(test_util.balance_of('c1670000-0000-0000-0000-000000000002'), 0,
  'the reset grants the paused brief customer nothing');
select test_util.assert_eq(
  (select replacement_granted_on from public.customers where id = 'c1670000-0000-0000-0000-000000000002'),
  null::date, '… and does not stamp them, so the grant lands when they return');
select test_util.assert_eq(test_util.balance_of('c1670000-0000-0000-0000-000000000004'), 1,
  'the reset grants the paused brief customer their GR share only');

-- The return: resuming clears the pause and re-anchors the cycle to today
-- (resumePausedCustomer, §21). The next run grants.
update public.customers set paused_at = null, billing_cycle_anchor = current_date
 where id = 'c1670000-0000-0000-0000-000000000002';
select public.reset_monthly_counts();
select test_util.assert_eq(test_util.balance_of('c1670000-0000-0000-0000-000000000002'), 2,
  'the grant lands on the first run after they return');
select public.reset_monthly_counts();
select test_util.assert_eq(test_util.balance_of('c1670000-0000-0000-0000-000000000002'), 2,
  '… once');

-- ---------------------------------------------------------------------------
-- 7. customers.pause_holds_area
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select data_type || ':' || is_nullable from information_schema.columns
    where table_schema = 'public' and table_name = 'customers' and column_name = 'pause_holds_area'),
  'boolean:YES', 'customers.pause_holds_area is a nullable boolean');

select test_util.assert_eq(
  (select count(*)::integer from public.customers where pause_holds_area is not null),
  0, 'nothing writes pause_holds_area yet (Phase 2 does)');

-- ⚠️ No CHECK ties it to paused_at, so clearing a pause without it (the
-- webhook's resume detection, §21's third case) must not fail.
update public.customers set pause_holds_area = false, paused_at = now()
 where id = 'c1670000-0000-0000-0000-000000000003';
select test_util.assert_eq(
  test_util.violated($$update public.customers set paused_at = null
                        where id = 'c1670000-0000-0000-0000-000000000003'$$),
  null, 'clearing paused_at alone never fails on pause_holds_area');

-- ---------------------------------------------------------------------------
-- 8. ACLs and invariant 7
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select (has_function_privilege('anon', p.oid, 'execute')
        or has_function_privilege('authenticated', p.oid, 'execute'))::text
       || ':' || has_function_privilege('service_role', p.oid, 'execute')::text
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'replacement_monthly_grant'),
  'false:true', 'replacement_monthly_grant is service_role only');

select test_util.assert_eq(
  (select count(distinct p.proname)::integer from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('get_engagement_benchmarks','set_management_customer_goal',
                        'get_operator_proof','get_recent_wins_anonymised')
      and has_function_privilege('authenticated', p.oid, 'execute')),
  4, 'invariant 7: the four customer-callable functions still are');

select test_util.assert_eq(
  (select relrowsecurity::text || ':' ||
          (select count(*)::text from pg_policies where tablename = 'subscription_pauses')
     from pg_class where oid = 'public.subscription_pauses'::regclass),
  'true:0', 'subscription_pauses keeps RLS on with no policies');

-- ---------------------------------------------------------------------------
-- Teardown
-- ---------------------------------------------------------------------------
delete from public.customers where id::text like 'c1670000-%';

\o
select '0167 BEHAVIOURAL TESTS PASSED' as result;
