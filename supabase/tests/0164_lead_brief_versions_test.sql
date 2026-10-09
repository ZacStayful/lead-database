-- ============================================================================
-- Behavioural tests for 0164 — Lead Brief versions (Phase 5, Part B).
--
-- The status CHECK and the one-change-in-flight index; saving a scheduled
-- area change (conflict, replace, the pending row superseded, the caller never
-- choosing status or version); promoting a priorities edit and a due
-- scheduled row (first picks only ever narrowed); the due rule across a
-- renewal; a scheduled row never reaching routing; and the ACLs.
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

-- True when the statement raises the given SQLSTATE.
create or replace function test_util.raises(p_sql text, p_state text)
returns boolean language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when others then
  return sqlstate = p_state;
end $$;

-- ⚠️ Cleared up front as well as at the end (0149's lesson).
delete from public.lead_outcome_reasons;
delete from public.lead_quality_claims;
delete from public.lead_events;
delete from public.lead_notes;
delete from public.lead_assignments;
delete from public.customer_lead_briefs;
delete from public.leads;
delete from public.customers;

-- Me: the customer editing. Their anchor is today, so a renewal happened today.
-- Rival, Holder, Expired: other live brief customers. Gone: cancelled.
insert into public.customers
  (id, business_name, contact_name, email, monthly_allocation, lead_balance,
   leads_received_this_month, billing_cycle_anchor,
   gr_monthly_allocation, gr_lead_balance, gr_leads_received_this_month,
   account_status, subscription_status, gr_subscription_status, filter_status, gr_filter_status,
   lead_brief_required, lead_brief_completed_at)
values
  ('c1640000-0000-0000-0000-000000000001','Me','A','a@x.com',20,20,0,current_date,10,0,0,'active','active','inactive','off','off',true,now()),
  ('c1640000-0000-0000-0000-000000000002','Rival','B','b@x.com',20,20,0,current_date,10,0,0,'active','active','inactive','off','off',true,now()),
  ('c1640000-0000-0000-0000-000000000003','Holder','C','c@x.com',20,20,0,current_date,10,0,0,'active','active','inactive','off','off',true,now()),
  ('c1640000-0000-0000-0000-000000000004','Expired','D','d@x.com',20,20,0,current_date,10,0,0,'active','active','inactive','off','off',true,now()),
  ('c1640000-0000-0000-0000-000000000005','Gone','E','e@x.com',20,20,0,current_date,10,0,0,'cancelled','canceled','inactive','off','off',true,now());

-- A brief row as the editor route builds it (briefRow.ts), as jsonb.
create or replace function test_util.brief_row(p_base text, p_service text[], p_first text[])
returns jsonb language sql as $$
  select jsonb_build_object(
    'base_postcode', p_base, 'base_outcode', p_base, 'operating_mode', 'anywhere',
    'travel_limit_miles', null, 'allocation', 20,
    'priorities', '[{"key":"location","threshold":10},{"key":"revenue","threshold":40000}]'::jsonb,
    'essentials', '[]'::jsonb, 'min_bedrooms', null, 'min_gross', null,
    'priority_outcodes', '[]'::jsonb, 'similar_areas', '[]'::jsonb,
    'service_radius_miles', 20, 'service_outcodes', to_jsonb(p_service),
    'first_pick_outcodes', to_jsonb(p_first), 'pace_outcodes', '[]'::jsonb,
    'mix_leans_nearby', false, 'expected_mix', '{}'::jsonb,
    -- Ignored: the function decides these, never the caller.
    'status', 'active', 'version', 99, 'origin', 'admin', 'locked_until', '2099-01-01'
  )
$$;

-- Active briefs. Me: YO10. Rival covers HG2 in service. Holder holds HG1 as a
-- first pick until today. Expired held HG3 until yesterday. Gone (cancelled)
-- covers HG4.
insert into public.customer_lead_briefs
  (id, customer_id, version, status, origin, base_postcode, base_outcode, operating_mode,
   travel_limit_miles, allocation, priorities, service_radius_miles, service_outcodes,
   first_pick_outcodes, expected_mix, locked_until, confirmed_at)
values
  ('b1640000-0000-0000-0000-000000000001','c1640000-0000-0000-0000-000000000001',1,'active','customer','YO10','YO10','anywhere',null,20,
   '[{"key":"location","threshold":10}]'::jsonb,20,'{YO10}','{YO8}','{}'::jsonb, current_date + 20, now()),
  ('b1640000-0000-0000-0000-000000000002','c1640000-0000-0000-0000-000000000002',1,'active','customer','HG2','HG2','anywhere',null,20,
   '[{"key":"location","threshold":10}]'::jsonb,20,'{HG2}','{}','{}'::jsonb, current_date + 20, now()),
  ('b1640000-0000-0000-0000-000000000003','c1640000-0000-0000-0000-000000000003',1,'active','customer','YO1','YO1','anywhere',null,20,
   '[{"key":"location","threshold":10}]'::jsonb,20,'{YO1}','{HG1}','{}'::jsonb, current_date, now()),
  ('b1640000-0000-0000-0000-000000000004','c1640000-0000-0000-0000-000000000004',1,'active','customer','YO26','YO26','anywhere',null,20,
   '[{"key":"location","threshold":10}]'::jsonb,20,'{YO26}','{HG3}','{}'::jsonb, current_date - 1, now()),
  ('b1640000-0000-0000-0000-000000000005','c1640000-0000-0000-0000-000000000005',1,'active','customer','HG4','HG4','anywhere',null,20,
   '[{"key":"location","threshold":10}]'::jsonb,20,'{HG4}','{}','{}'::jsonb, current_date + 20, now());

-- ---------------------------------------------------------------------------
-- 1. The status CHECK and one change in flight
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  test_util.raises($$update public.customer_lead_briefs set status = 'bogus'
                      where id = 'b1640000-0000-0000-0000-000000000002'$$, '23514'),
  true, 'an unknown status is refused');

insert into public.customer_lead_briefs
  (customer_id, version, status, origin, base_postcode, base_outcode, operating_mode,
   travel_limit_miles, allocation, priorities, service_radius_miles, service_outcodes, expected_mix)
values ('c1640000-0000-0000-0000-000000000002', 2, 'pending_confirmation', 'recompute', 'HG2', 'HG2', 'anywhere',
        null, 20, '[{"key":"location"}]'::jsonb, 30, '{HG2,HG1}', '{}'::jsonb);
select test_util.assert_eq(
  test_util.raises($$insert into public.customer_lead_briefs
    (customer_id, version, status, origin, base_postcode, base_outcode, operating_mode,
     travel_limit_miles, allocation, priorities, service_radius_miles, service_outcodes, expected_mix, confirmed_at)
    values ('c1640000-0000-0000-0000-000000000002', 3, 'scheduled', 'customer', 'HG2', 'HG2', 'anywhere',
            null, 20, '[{"key":"location"}]'::jsonb, 20, '{HG2}', '{}'::jsonb, now())$$, '23505'),
  true, 'a scheduled row cannot sit beside a pending one (one change in flight)');

-- ---------------------------------------------------------------------------
-- 2. save_scheduled_lead_brief
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  public.save_scheduled_lead_brief('c1640000-0000-0000-0000-000000000001',
    'b1640000-0000-0000-0000-000000000002', test_util.brief_row('YO10', '{YO10,YO31}', '{HG1,HG2,HG3,HG4}')) ->> 'result',
  'conflict', 'a stale active id is a conflict');
select test_util.assert_eq(
  public.save_scheduled_lead_brief('c1640000-0000-0000-0000-000000000001',
    null, test_util.brief_row('YO10', '{YO10,YO31}', '{HG1,HG2,HG3,HG4}')) ->> 'result',
  'conflict', 'no expected id is a conflict');
select test_util.assert_eq(
  (select count(*)::int from public.customer_lead_briefs
    where customer_id = 'c1640000-0000-0000-0000-000000000001' and status = 'scheduled'),
  0, 'a conflict writes nothing');

select test_util.assert_eq(
  public.save_scheduled_lead_brief('c1640000-0000-0000-0000-000000000001',
    'b1640000-0000-0000-0000-000000000001', test_util.brief_row('YO10', '{YO10,YO31}', '{HG1}')) ->> 'version',
  '2', 'the first save is version 2, allocated in SQL');
select test_util.assert_eq(
  (select status || '/' || origin || '/' || (confirmed_at is not null)::text || '/' || coalesce(locked_until::text, 'null')
     from public.customer_lead_briefs
    where customer_id = 'c1640000-0000-0000-0000-000000000001' and status = 'scheduled'),
  'scheduled/customer/true/null',
  'status, origin, confirmed_at and locked_until are decided by the function, not the row');

select test_util.assert_eq(
  public.save_scheduled_lead_brief('c1640000-0000-0000-0000-000000000001',
    'b1640000-0000-0000-0000-000000000001', test_util.brief_row('YO10', '{YO10,YO31,YO32}', '{HG1,HG2,HG3,HG4}')) ->> 'version',
  '2', 'a re-save replaces it under the same version (it never took effect)');
select test_util.assert_eq(
  (select count(*)::int || ':' || max(service_outcodes::text)
     from public.customer_lead_briefs
    where customer_id = 'c1640000-0000-0000-0000-000000000001' and status = 'scheduled'),
  '1:{YO10,YO31,YO32}', 'exactly one scheduled row, holding the latest save');
select test_util.assert_eq(
  (select status from public.customer_lead_briefs where id = 'b1640000-0000-0000-0000-000000000001'),
  'active', 'saving a scheduled change leaves the active brief active');

-- The rival's own area save supersedes their pending (wider) row.
select test_util.assert_eq(
  public.save_scheduled_lead_brief('c1640000-0000-0000-0000-000000000002',
    'b1640000-0000-0000-0000-000000000002', test_util.brief_row('HG2', '{HG2}', '{}')) ->> 'result',
  'saved', 'a customer with a pending row can save');
select test_util.assert_eq(
  (select status || '/' || (superseded_at is not null)::text from public.customer_lead_briefs
    where customer_id = 'c1640000-0000-0000-0000-000000000002' and version = 2),
  'superseded/true', 'their pending row is superseded by their own newer choice');

select test_util.assert_eq(
  test_util.raises($$select public.save_scheduled_lead_brief('c1640000-0000-0000-0000-000000000001',
    'b1640000-0000-0000-0000-000000000001',
    test_util.brief_row('YO10', '{YO31}', '{}'))$$, '23514'),
  true, 'every 0162 CHECK still applies (the base must be in the service area)');

-- ---------------------------------------------------------------------------
-- 3. promote_lead_brief — a priorities edit
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  public.promote_lead_brief('c1640000-0000-0000-0000-000000000001',
    'b1640000-0000-0000-0000-000000000001', null, null, null, null) ->> 'result',
  'priorities_required', 'a priorities edit needs priorities');
select test_util.assert_eq(
  public.promote_lead_brief('c1640000-0000-0000-0000-000000000001',
    'b1640000-0000-0000-0000-000000000002',
    null, '[{"key":"revenue","threshold":45000,"chosen":true},{"key":"location","threshold":10}]'::jsonb, null, null) ->> 'result',
  'conflict', 'a stale active id is a conflict');

select test_util.assert_eq(
  public.promote_lead_brief('c1640000-0000-0000-0000-000000000001',
    'b1640000-0000-0000-0000-000000000001', null,
    '[{"key":"revenue","threshold":45000,"chosen":true},{"key":"location","threshold":10}]'::jsonb,
    '[{"key":"revenue","threshold":45000,"chosen":true},{"key":"location","threshold":15}]'::jsonb,
    null) ->> 'version',
  '3', 'a priorities edit is the next version');
select test_util.assert_eq(
  (select status || '/' || (superseded_at is not null)::text
     from public.customer_lead_briefs where id = 'b1640000-0000-0000-0000-000000000001'),
  'superseded/true', 'the old active version is superseded and stamped');
select test_util.assert_eq(
  (select priorities -> 0 ->> 'key' || '/' || service_outcodes::text || '/' || first_pick_outcodes::text
          || '/' || (locked_until = current_date + 20)::text || '/' || origin
     from public.customer_lead_briefs
    where customer_id = 'c1640000-0000-0000-0000-000000000001' and status = 'active'),
  'revenue/{YO10}/{YO8}/true/customer',
  'the new active version has the new ranking and the SAME area and lock');
select test_util.assert_eq(
  (select priorities -> 1 ->> 'threshold'
     from public.customer_lead_briefs
    where customer_id = 'c1640000-0000-0000-0000-000000000001' and status = 'scheduled'),
  '15', 'the pending area change gets the new priorities too');

-- ---------------------------------------------------------------------------
-- 4. due_scheduled_lead_briefs — the renewal has to have happened
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select count(*)::int from public.due_scheduled_lead_briefs()),
  0, 'rows saved today are not due on today''s renewal');

update public.customer_lead_briefs set created_at = now() - interval '1 day'
 where customer_id = 'c1640000-0000-0000-0000-000000000001' and status = 'scheduled';
select test_util.assert_eq(
  (select count(*)::int || ':' || bool_and(active_id is not null)::text
     from public.due_scheduled_lead_briefs() where customer_id = 'c1640000-0000-0000-0000-000000000001'),
  '1:true', 'a row saved before today''s renewal is due, with its active id');

update public.customers set billing_cycle_anchor = current_date - 10
 where id = 'c1640000-0000-0000-0000-000000000001';
update public.customer_lead_briefs set created_at = now() - interval '5 days'
 where customer_id = 'c1640000-0000-0000-0000-000000000001' and status = 'scheduled';
select test_util.assert_eq(
  (select count(*)::int from public.due_scheduled_lead_briefs()
    where customer_id = 'c1640000-0000-0000-0000-000000000001'),
  0, 'a row saved after the last renewal waits for the next one');
update public.customer_lead_briefs set created_at = now() - interval '11 days'
 where customer_id = 'c1640000-0000-0000-0000-000000000001' and status = 'scheduled';
select test_util.assert_eq(
  (select count(*)::int from public.due_scheduled_lead_briefs()
    where customer_id = 'c1640000-0000-0000-0000-000000000001'),
  1, 'a row saved before the last renewal is due');

-- ---------------------------------------------------------------------------
-- 5. A scheduled row never reaches routing
-- ---------------------------------------------------------------------------
insert into public.leads (id, monday_item_id, lead_name, lead_type, postcode, postcode_area, bedrooms, gross_annual_income, created_at)
values
  ('d1640000-0000-0000-0000-000000000001','m-64-1','York','management','YO10 5DD','YO','3',40000, now() - interval '3 days'),
  ('d1640000-0000-0000-0000-000000000002','m-64-2','York north','management','YO32 1AA','YO','3',40000, now() - interval '3 days');
select test_util.assert_eq(
  (select count(*)::int from public.get_brief_candidates_for_lead('d1640000-0000-0000-0000-000000000002', 10, true)
    where customer_id = 'c1640000-0000-0000-0000-000000000001'),
  0, 'a lead only in the SCHEDULED area does not reach the customer');
select test_util.assert_eq(
  (select count(*)::int from public.get_brief_candidates_for_lead('d1640000-0000-0000-0000-000000000001', 10, true)
    where customer_id = 'c1640000-0000-0000-0000-000000000001'),
  1, 'a lead in the ACTIVE area still does');

-- ---------------------------------------------------------------------------
-- 6. promote_lead_brief — a due scheduled row at renewal
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  public.promote_lead_brief('c1640000-0000-0000-0000-000000000001',
    (select id from public.customer_lead_briefs
      where customer_id = 'c1640000-0000-0000-0000-000000000001' and status = 'active'),
    (select id from public.customer_lead_briefs
      where customer_id = 'c1640000-0000-0000-0000-000000000001' and status = 'active'),
    null, null, current_date + 30) ->> 'result',
  'not_scheduled', 'only a scheduled row can be promoted as a source');
select test_util.assert_eq(
  public.promote_lead_brief('c1640000-0000-0000-0000-000000000001',
    (select id from public.customer_lead_briefs
      where customer_id = 'c1640000-0000-0000-0000-000000000001' and status = 'active'),
    (select id from public.customer_lead_briefs
      where customer_id = 'c1640000-0000-0000-0000-000000000001' and status = 'scheduled'),
    null, null, null) ->> 'result',
  'locked_until_required', 'promoting at renewal needs the new lock date');

create temp table t_before as
  select id, confirmed_at from public.customer_lead_briefs
   where customer_id = 'c1640000-0000-0000-0000-000000000001' and status = 'scheduled';

select test_util.assert_eq(
  public.promote_lead_brief('c1640000-0000-0000-0000-000000000001',
    (select id from public.customer_lead_briefs
      where customer_id = 'c1640000-0000-0000-0000-000000000001' and status = 'active'),
    (select id from t_before), null, null, current_date + 30) ->> 'result',
  'promoted', 'a due scheduled row is promoted');
select test_util.assert_eq(
  (select count(*)::int || ':' || bool_and(id = (select id from t_before))::text
     from public.customer_lead_briefs
    where customer_id = 'c1640000-0000-0000-0000-000000000001' and status = 'active'),
  '1:true', 'it is now the one active row');
select test_util.assert_eq(
  (select first_pick_outcodes::text from public.customer_lead_briefs where id = (select id from t_before)),
  '{HG3,HG4}',
  'first picks another live customer now covers (Rival HG2) or holds (Holder HG1) are dropped; an expired lock (HG3) and a cancelled customer (HG4) are not; order kept');
select test_util.assert_eq(
  (select (locked_until = current_date + 30)::text || '/'
          || (confirmed_at = (select confirmed_at from t_before))::text || '/' || service_outcodes::text
     from public.customer_lead_briefs where id = (select id from t_before)),
  'true/true/{YO10,YO31,YO32}', 'the new lock is set, confirmed_at kept, the area unchanged');
select test_util.assert_eq(
  (select count(*)::int from public.customer_lead_briefs
    where customer_id = 'c1640000-0000-0000-0000-000000000001' and status in ('scheduled', 'pending_confirmation')),
  0, 'nothing is left in flight');
select test_util.assert_eq(
  (select count(*)::int from public.get_brief_candidates_for_lead('d1640000-0000-0000-0000-000000000002', 10, true)
    where customer_id = 'c1640000-0000-0000-0000-000000000001'),
  1, 'once promoted, the new area routes');
select test_util.assert_eq(
  (select count(*)::int from public.due_scheduled_lead_briefs()
    where customer_id = 'c1640000-0000-0000-0000-000000000001'),
  0, 'and it is no longer due');

-- ---------------------------------------------------------------------------
-- 7. ACLs and shape
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select bool_or(has_function_privilege('anon', p.oid, 'execute'))
       or bool_or(has_function_privilege('authenticated', p.oid, 'execute'))
     from pg_proc p
    where p.proname in ('save_scheduled_lead_brief','promote_lead_brief','due_scheduled_lead_briefs')),
  false, 'no 0164 function is executable by anon or authenticated');
select test_util.assert_eq(
  (select count(*)::int || ':' || bool_and(has_function_privilege('service_role', p.oid, 'execute'))::text
          || ':' || max(pronargdefaults)::text
     from pg_proc p
    where p.proname in ('save_scheduled_lead_brief','promote_lead_brief','due_scheduled_lead_briefs')),
  '3:true:0', 'three functions, service_role only, no defaults');

-- ---------------------------------------------------------------------------
drop table t_before;
delete from public.lead_assignments;
delete from public.customer_lead_briefs;
delete from public.leads;
delete from public.customers;

\o
select '0164 BEHAVIOURAL TESTS PASSED' as result;
