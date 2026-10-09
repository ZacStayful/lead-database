-- ============================================================================
-- Behavioural tests for 0163 — Lead Brief routing (Phase 4).
--
-- Block 1 is the one that matters: the legacy pools still return every
-- non-brief customer they returned before, and only lose a customer who is
-- flagged for the brief. Then the brief pool: confirmed brief only, the area
-- boundary, essentials (no figure = not met), first picks, the pace tier only
-- when behind pace and only when asked for, the usual gates, GR untouched, the
-- money path still accepting a brief customer, and the ACLs.
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

-- ⚠️ Cleared up front as well as at the end (0149's lesson).
delete from public.lead_outcome_reasons;
delete from public.lead_quality_claims;
delete from public.lead_events;
delete from public.lead_notes;
delete from public.lead_assignments;
delete from public.customer_lead_briefs;
delete from public.leads;
delete from public.customers;
update public.system_settings set value = '20' where key = 'lead_brief_pace_deficit_pct';

-- Legacy (unfiltered), Filt (filtered BS), Brief (confirmed brief),
-- Incomplete (flagged, not confirmed), BriefFilt (flagged, with an old filter),
-- Paused (confirmed brief, paused), Broke (confirmed brief, no balance).
insert into public.customers
  (id, business_name, contact_name, email, monthly_allocation, lead_balance,
   leads_received_this_month, billing_cycle_anchor,
   gr_monthly_allocation, gr_lead_balance, gr_leads_received_this_month,
   account_status, subscription_status, gr_subscription_status, filter_status, gr_filter_status,
   lead_brief_required, lead_brief_completed_at)
values
  ('c1000000-0000-0000-0000-000000000001','Legacy','A','a@x.com',20,20,0,current_date,10,0,0,'active','active','inactive','off','off',false,null),
  ('c1000000-0000-0000-0000-000000000002','Filt','B','b@x.com',20,20,0,current_date,10,0,0,'active','active','inactive','active','off',false,null),
  ('c1000000-0000-0000-0000-000000000003','Brief','C','c@x.com',20,20,0,current_date,10,10,0,'active','active','active','off','off',true,now()),
  ('c1000000-0000-0000-0000-000000000004','Incomplete','D','d@x.com',20,20,0,current_date,10,0,0,'active','active','inactive','off','off',true,null),
  ('c1000000-0000-0000-0000-000000000005','BriefFilt','E','e@x.com',20,20,0,current_date,10,0,0,'active','active','inactive','active','off',true,now()),
  ('c1000000-0000-0000-0000-000000000006','Paused','F','f@x.com',20,20,0,current_date,10,0,0,'active','active','inactive','off','off',true,now()),
  ('c1000000-0000-0000-0000-000000000007','Broke','G','g@x.com',20,0,0,current_date,10,0,0,'active','active','inactive','off','off',true,now());

update public.customers set filter_areas = '{BS,YO}'
 where id in ('c1000000-0000-0000-0000-000000000002','c1000000-0000-0000-0000-000000000005');
update public.customers set paused_at = now() where id = 'c1000000-0000-0000-0000-000000000006';

-- One active brief each for the flagged customers. Service YO10/YO31, first
-- pick HG1, pace LS1, essential: 3+ bedrooms.
insert into public.customer_lead_briefs
  (customer_id, version, status, origin, base_postcode, base_outcode, operating_mode,
   travel_limit_miles, allocation, priorities, essentials, min_bedrooms,
   service_radius_miles, service_outcodes, first_pick_outcodes, pace_outcodes,
   expected_mix, confirmed_at)
select c.id, 1, 'active', 'customer', 'YO10 5DD', 'YO10', 'anywhere', null, 20,
       '[{"key":"location","threshold":10},{"key":"bedrooms","threshold":3},{"key":"revenue"},{"key":"occupancy"}]'::jsonb,
       '{bedrooms}', 3, 30, '{YO10,YO31}', '{HG1}', '{LS1}', '{}'::jsonb, now()
  from public.customers c
 where c.lead_brief_required;

insert into public.leads (id, monday_item_id, lead_name, lead_type, postcode, postcode_area, bedrooms, gross_annual_income, created_at)
values
  ('d1000000-0000-0000-0000-000000000001','m-63-1','York 3 bed','management','YO10 5DD','YO','3',40000, now() - interval '3 days'),
  ('d1000000-0000-0000-0000-000000000002','m-63-2','York 2 bed','management','YO31 7AA','YO','2',40000, now() - interval '3 days'),
  ('d1000000-0000-0000-0000-000000000003','m-63-3','York no beds','management','YO10 5DE','YO',null,40000, now() - interval '3 days'),
  ('d1000000-0000-0000-0000-000000000004','m-63-4','Harrogate','management','HG1 1AA','HG','4',50000, now() - interval '3 days'),
  ('d1000000-0000-0000-0000-000000000005','m-63-5','Leeds','management','LS1 1AA','LS','3',40000, now() - interval '3 days'),
  ('d1000000-0000-0000-0000-000000000006','m-63-6','Bristol','management','BS1 1AA','BS','3',40000, now() - interval '3 days'),
  ('d1000000-0000-0000-0000-000000000007','m-63-7','GR York','guaranteed_rent','YO10 5DF','YO','3',null, now() - interval '3 days');

-- ---------------------------------------------------------------------------
-- 1. The legacy pools lose ONLY flagged customers
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select array_agg(customer_id order by customer_id)::text
     from public.get_unfiltered_candidates_for_lead('d1000000-0000-0000-0000-000000000001', 10, 'management')),
  '{c1000000-0000-0000-0000-000000000001}',
  'unfiltered management pool keeps Legacy and drops every flagged customer');

select test_util.assert_eq(
  (select array_agg(customer_id order by customer_id)::text
     from public.get_filtered_candidates_for_lead('d1000000-0000-0000-0000-000000000006', 10, 'management')),
  '{c1000000-0000-0000-0000-000000000002}',
  'filtered management pool keeps Filt and drops a flagged customer with an old filter');

update public.customers set lead_brief_required = false where id = 'c1000000-0000-0000-0000-000000000005';
select test_util.assert_eq(
  (select count(*)::int
     from public.get_filtered_candidates_for_lead('d1000000-0000-0000-0000-000000000006', 10, 'management')),
  2,
  'the same customer unflagged is back in the filtered pool (the predicate is the only change)');
update public.customers set lead_brief_required = true where id = 'c1000000-0000-0000-0000-000000000005';

select test_util.assert_eq(
  (select array_agg(customer_id order by customer_id)::text
     from public.get_unfiltered_candidates_for_lead('d1000000-0000-0000-0000-000000000007', 10, 'guaranteed_rent')),
  '{c1000000-0000-0000-0000-000000000003}',
  'GR pool still serves a brief customer who holds GR (invariant 6)');

-- ---------------------------------------------------------------------------
-- 2. The brief pool
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select array_agg(customer_id order by customer_id)::text
     from public.get_brief_candidates_for_lead('d1000000-0000-0000-0000-000000000001', 10, false)),
  '{c1000000-0000-0000-0000-000000000003,c1000000-0000-0000-0000-000000000005}',
  'a 3-bed lead in the service area reaches the confirmed briefs only (not incomplete, paused, no balance or legacy)');

select test_util.assert_eq(
  (select in_service::text || '/' || in_first_pick::text || '/' || pace_only::text
     from public.get_brief_candidates_for_lead('d1000000-0000-0000-0000-000000000001', 10, false)
    where customer_id = 'c1000000-0000-0000-0000-000000000003'),
  'true/false/false',
  'service-area flags');

select test_util.assert_eq(
  (select count(*)::int from public.get_brief_candidates_for_lead('d1000000-0000-0000-0000-000000000002', 10, false)),
  0, 'a 2-bed lead does not meet a 3+ bedroom essential');

select test_util.assert_eq(
  (select count(*)::int from public.get_brief_candidates_for_lead('d1000000-0000-0000-0000-000000000003', 10, false)),
  0, 'a lead with no bedroom figure does not meet the essential');

select test_util.assert_eq(
  (select in_first_pick::text || '/' || pace_only::text
     from public.get_brief_candidates_for_lead('d1000000-0000-0000-0000-000000000004', 10, false)
    where customer_id = 'c1000000-0000-0000-0000-000000000003'),
  'true/false',
  'a lead in a first-pick area is admitted and flagged as a first pick');

select test_util.assert_eq(
  (select count(*)::int from public.get_brief_candidates_for_lead('d1000000-0000-0000-0000-000000000006', 10, true)),
  0, 'a lead outside every brief area reaches nobody, pace or not');

select test_util.assert_eq(
  (select count(*)::int from public.get_brief_candidates_for_lead('d1000000-0000-0000-0000-000000000007', 10, true)),
  0, 'a GR lead never reaches the brief pool');

-- The pace tier.
select test_util.assert_eq(
  (select count(*)::int from public.get_brief_candidates_for_lead('d1000000-0000-0000-0000-000000000005', 10, false)),
  0, 'a pace lead is never admitted without include_pace');

select test_util.assert_eq(
  (select count(*)::int from public.get_brief_candidates_for_lead('d1000000-0000-0000-0000-000000000005', 10, true)),
  0, 'a pace lead is not admitted while the customer is on pace (deficit 0)');

-- Twenty days into the cycle with nothing received: deficit round(20/30 × 20) = 13 ≥ ceil(20 × 0.20) = 4.
update public.customers set billing_cycle_anchor = current_date - 20
 where id = 'c1000000-0000-0000-0000-000000000003';
select test_util.assert_eq(
  (select pace_only::text
     from public.get_brief_candidates_for_lead('d1000000-0000-0000-0000-000000000005', 10, true)
    where customer_id = 'c1000000-0000-0000-0000-000000000003'),
  'true', 'a behind-pace customer is offered a pace lead, flagged pace_only');

update public.system_settings set value = '90' where key = 'lead_brief_pace_deficit_pct';
select test_util.assert_eq(
  (select count(*)::int from public.get_brief_candidates_for_lead('d1000000-0000-0000-0000-000000000005', 10, true)),
  0, 'the threshold comes from lead_brief_pace_deficit_pct (90% needs a deficit of 18)');
update public.system_settings set value = 'nonsense' where key = 'lead_brief_pace_deficit_pct';
select test_util.assert_eq(
  (select count(*)::int from public.get_brief_candidates_for_lead('d1000000-0000-0000-0000-000000000005', 10, true)),
  1, 'a malformed setting reads as 20, never an error');
update public.system_settings set value = '20' where key = 'lead_brief_pace_deficit_pct';

-- In-area candidates are ordered before pace ones.
insert into public.customer_lead_briefs
  (customer_id, version, status, origin, base_postcode, base_outcode, operating_mode,
   travel_limit_miles, allocation, priorities, essentials, min_bedrooms,
   service_radius_miles, service_outcodes, first_pick_outcodes, pace_outcodes,
   expected_mix, confirmed_at)
select 'c1000000-0000-0000-0000-000000000001', 1, 'active', 'customer', 'LS1', 'LS1', 'anywhere', null, 20,
       '[{"key":"location","threshold":10}]'::jsonb, '{}', null, 20, '{LS1}', '{}', '{}', '{}'::jsonb, now();
update public.customers set lead_brief_required = true, lead_brief_completed_at = now()
 where id = 'c1000000-0000-0000-0000-000000000001';
select test_util.assert_eq(
  (select array_agg(customer_id::text || ':' || pace_only::text)::text
     from public.get_brief_candidates_for_lead('d1000000-0000-0000-0000-000000000005', 10, true)),
  '{c1000000-0000-0000-0000-000000000001:false,c1000000-0000-0000-0000-000000000003:true}',
  'an in-area candidate is listed before a behind-pace one, whatever the deficits');
update public.customers set lead_brief_required = false, lead_brief_completed_at = null
 where id = 'c1000000-0000-0000-0000-000000000001';
delete from public.customer_lead_briefs where customer_id = 'c1000000-0000-0000-0000-000000000001';

-- Only the ACTIVE brief counts.
update public.customer_lead_briefs set status = 'superseded', superseded_at = now()
 where customer_id = 'c1000000-0000-0000-0000-000000000005';
select test_util.assert_eq(
  (select count(*)::int
     from public.get_brief_candidates_for_lead('d1000000-0000-0000-0000-000000000001', 10, false)
    where customer_id = 'c1000000-0000-0000-0000-000000000005'),
  0, 'a customer with no ACTIVE brief is not a brief candidate');

-- A retired lead (quality failed, 0111) reaches nobody (invariant 11).
update public.leads set lead_quality_status = 'failed' where id = 'd1000000-0000-0000-0000-000000000004';
select test_util.assert_eq(
  (select count(*)::int from public.get_brief_candidates_for_lead('d1000000-0000-0000-0000-000000000004', 10, true)),
  0, 'a retired lead is never a brief candidate');
update public.leads set lead_quality_status = 'pending' where id = 'd1000000-0000-0000-0000-000000000004';

-- p_max bounds the list.
select test_util.assert_eq(
  (select count(*)::int from public.get_brief_candidates_for_lead('d1000000-0000-0000-0000-000000000001', 0, false)),
  0, 'p_max of 0 returns nothing');

-- ---------------------------------------------------------------------------
-- 3. The money path accepts a brief customer, and they are then excluded
-- ---------------------------------------------------------------------------
select public.assign_lead_to_customer(
  'd1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000003', 15, 'management');
select test_util.assert_eq(
  (select lead_balance from public.customers where id = 'c1000000-0000-0000-0000-000000000003'),
  19, 'assign_lead_to_customer spends exactly one credit for a brief customer');
select test_util.assert_eq(
  (select count(*)::int
     from public.get_brief_candidates_for_lead('d1000000-0000-0000-0000-000000000001', 10, false)
    where customer_id = 'c1000000-0000-0000-0000-000000000003'),
  0, 'a customer already holding the lead is not offered it again');

-- Every other path that reaches the money path, by hand (build prompt, Phase 4:
-- "Manually test any path that reaches assign_lead_to_customer").
--
-- An admin force-assign is an admin decision: it reaches a brief customer
-- whatever their brief says (here a 2-bed lead that misses their essential),
-- spends a credit, and needs no filter override because they sit at 'off'.
select public.admin_assign_lead(
  'd1000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000003', 15, 'management', false);
select test_util.assert_eq(
  (select lead_balance from public.customers where id = 'c1000000-0000-0000-0000-000000000003'),
  18, 'admin_assign_lead reaches a brief customer and spends one credit');
-- An admin assign to the flagged-but-unconfirmed customer still works too: the
-- delivery gate is routing, never an admin's hand.
select public.assign_lead_to_customer(
  'd1000000-0000-0000-0000-000000000006', 'c1000000-0000-0000-0000-000000000004', 15, 'management');
select test_util.assert_eq(
  (select count(*)::int from public.lead_assignments
    where customer_id = 'c1000000-0000-0000-0000-000000000004'),
  1, 'the money path accepts an unconfirmed brief customer when called directly');
-- Escalation and the morning release reach customers only through the two
-- legacy pools and the brief pool; none returns the unconfirmed customer.
select test_util.assert_eq(
  (select count(*)::int from (
     select customer_id from public.get_filtered_candidates_for_lead('d1000000-0000-0000-0000-000000000005', 10, 'management')
     union all
     select customer_id from public.get_unfiltered_candidates_for_lead('d1000000-0000-0000-0000-000000000005', 10, 'management')
     union all
     select customer_id from public.get_brief_candidates_for_lead('d1000000-0000-0000-0000-000000000005', 10, true)
   ) x where customer_id = 'c1000000-0000-0000-0000-000000000004'),
  0, 'no routing pool ever returns a flagged customer who has not confirmed');

-- ---------------------------------------------------------------------------
-- 4. ACLs and shape
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select bool_or(has_function_privilege('anon', p.oid, 'execute'))
       or bool_or(has_function_privilege('authenticated', p.oid, 'execute'))
     from pg_proc p
    where p.proname in ('get_brief_candidates_for_lead','get_filtered_candidates_for_lead','get_unfiltered_candidates_for_lead')),
  false, 'no candidate function is executable by anon or authenticated');
select test_util.assert_eq(
  (select bool_and(has_function_privilege('service_role', p.oid, 'execute'))
     from pg_proc p
    where p.proname in ('get_brief_candidates_for_lead','get_filtered_candidates_for_lead','get_unfiltered_candidates_for_lead')),
  true, 'service_role executes all three');
select test_util.assert_eq(
  (select count(*)::int || ':' || max(pronargdefaults)::text
     from pg_proc where proname = 'get_brief_candidates_for_lead'),
  '1:0', 'one brief candidate function, no defaults (no overload trap)');

-- ---------------------------------------------------------------------------
delete from public.lead_assignments;
delete from public.customer_lead_briefs;
delete from public.leads;
delete from public.customers;
update public.system_settings set value = '20' where key = 'lead_brief_pace_deficit_pct';

\o
select '0163 BEHAVIOURAL TESTS PASSED' as result;
