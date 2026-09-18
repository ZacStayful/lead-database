-- ============================================================================
-- Behavioural tests for 0154 — a fresh lead skips the curve, never the cap
-- (CLAUDE.md §63).
--
-- The assertion that matters most is block 1: with release_fresh_hours at its
-- seeded 0 the three-argument rule is 0148's rule, and the two-argument shim
-- is never fresh — which is what lets the migration be applied to production
-- ahead of the code. After that: the window admits a lead under it and refuses
-- one over it, the hold and the entitlement still refuse a fresh lead, the
-- daily cap still bounds it, both candidate functions pass the lead's own
-- created_at, GR reads gr_ columns only, the money path is untouched, and the
-- overload shape that keeps the one-argument call resolving.
--
-- Time control as in 0148: now() is not stubbed, so elapsed working days are
-- simulated by moving billing_cycle_anchor, and lead age by setting created_at.
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

create or replace function test_util.london_today() returns date language sql stable as $$
  select (now() at time zone 'Europe/London')::date
$$;

create or replace function test_util.anchor_for_working_day(p_k integer) returns date
language plpgsql stable as $$
declare
  d date := test_util.london_today();
  n integer := 0;
begin
  loop
    if extract(isodow from d) < 6 then n := n + 1; end if;
    exit when n = p_k;
    d := d - 1;
  end loop;
  return d;
end $$;

-- ⚠️ Cleared UP FRONT as well as at the end: mutation testing aborts a suite
-- by design, and a suite that is not re-runnable reports the wrong failure on
-- the next pass (0149's lesson).
delete from public.lead_outcome_reasons;
delete from public.lead_quality_claims;
delete from public.lead_events;
delete from public.lead_notes;
delete from public.lead_assignments;
delete from public.leads;
delete from public.customers;

-- Twenty (unfiltered), Ten (unfiltered), Filt (filtered BS 3+), Exempt, GR-only.
insert into public.customers
  (id, business_name, contact_name, email, monthly_allocation, lead_balance,
   leads_received_this_month, billing_cycle_anchor,
   gr_monthly_allocation, gr_lead_balance, gr_leads_received_this_month, gr_billing_cycle_anchor,
   account_status, subscription_status, gr_subscription_status, filter_status, gr_filter_status)
values
  ('11111111-1111-1111-1111-111111111111','Twenty','A','a@x.com',20,20,0,test_util.anchor_for_working_day(1),
   10,0,0,null,'active','active','inactive','off','off'),
  ('22222222-2222-2222-2222-222222222222','Ten','B','b@x.com',10,10,0,test_util.anchor_for_working_day(1),
   10,0,0,null,'active','active','inactive','off','off'),
  ('33333333-3333-3333-3333-333333333333','Filt','C','c@x.com',20,20,0,test_util.anchor_for_working_day(1),
   10,0,0,null,'active','active','inactive','active','off'),
  ('44444444-4444-4444-4444-444444444444','Exempt','D','d@x.com',20,20,0,test_util.anchor_for_working_day(1),
   10,0,0,null,'active','active','inactive','off','off'),
  ('55555555-5555-5555-5555-555555555555','GRonly','E','e@x.com',20,0,0,null,
   10,10,0,test_util.anchor_for_working_day(1),'waitlisted','inactive','active','off','off');

update public.customers set filter_areas = '{BS}', filter_min_bedrooms = 3
  where id = '33333333-3333-3333-3333-333333333333';

-- Leads: 01 is a plain banked lead used to fill today's slot; FRESH landed
-- just now; STALE landed 25 hours ago; EDGE landed 23 hours ago.
insert into public.leads (id, monday_item_id, lead_name, postcode_area, bedrooms, max_assignments, assignment_count, created_at)
values
  ('aaaa0000-0000-0000-0000-000000000001','m-fresh-1','Banked 1','BS','3',5,0, now() - interval '10 days'),
  ('aaaa0000-0000-0000-0000-000000000002','m-fresh-2','Banked 2','BS','3',5,0, now() - interval '10 days'),
  ('aaaa0000-0000-0000-0000-00000000000f','m-fresh-f','Fresh lead','BS','3',5,0, now()),
  ('aaaa0000-0000-0000-0000-00000000005a','m-fresh-s','Stale lead','BS','3',5,0, now() - interval '25 hours'),
  ('aaaa0000-0000-0000-0000-00000000005e','m-fresh-e','Edge lead','BS','3',5,0, now() - interval '23 hours');

insert into public.leads (id, monday_item_id, lead_name, lead_type, postcode_area, bedrooms, max_assignments, assignment_count, created_at)
values
  ('bbbb0000-0000-0000-0000-000000000001','g-fresh-1','GR Banked','guaranteed_rent','BS','3',3,0, now() - interval '10 days'),
  ('bbbb0000-0000-0000-0000-00000000000f','g-fresh-f','GR Fresh','guaranteed_rent','BS','3',3,0, now());

-- ---------------------------------------------------------------------------
-- 0 — Seeds and the overload shape
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select value from public.system_settings where key = 'release_fresh_hours'),
  '0', 'release_fresh_hours ships at 0 (off)');
select test_util.assert_eq(
  (select value from public.system_settings where key = 'lead_sync_enabled'),
  'false', 'lead_sync_enabled ships false');
select test_util.assert_eq(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'customer_release_allows'),
  2, 'exactly two overloads of customer_release_allows');
select test_util.assert_eq(
  (select p.pronargdefaults::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'customer_release_allows' and p.pronargs = 3),
  0, 'the three-argument form carries NO defaults');
select test_util.assert_eq(
  (select p.pronargdefaults::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'customer_release_allows' and p.pronargs = 2),
  1, 'the two-argument shim keeps its one default');
-- The one-argument call (0148''s suite) still resolves.
select test_util.assert_eq(
  public.customer_release_allows('11111111-1111-1111-1111-111111111111'),
  true, 'a one-argument call still resolves through the shim');

-- ---------------------------------------------------------------------------
-- 1 — ⚠️ INERT at fresh_hours 0: the three-argument body is 0148's body
-- ---------------------------------------------------------------------------
update public.system_settings set value = 'true' where key = 'release_enabled';
update public.system_settings set value = '2' where key = 'release_max_per_day';

-- Fill Twenty's day-1 slot (allowance ceil(1*20/W) = 1) so they are over the curve.
select public.assign_lead_to_customer(
  'aaaa0000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',15.00);
select test_util.assert_eq(
  public.customer_release_allows('11111111-1111-1111-1111-111111111111'),
  false, 'inert: over the curve, the two-argument form refuses');
select test_util.assert_eq(
  public.customer_release_allows('11111111-1111-1111-1111-111111111111', 'management', now()),
  false, 'inert: at fresh_hours 0 a lead created just now is NOT fresh');
select test_util.assert_eq(
  (select count(*)::integer from public.get_unfiltered_candidates_for_lead('aaaa0000-0000-0000-0000-00000000000f', 10)
    where customer_id = '11111111-1111-1111-1111-111111111111'),
  0, 'inert: the fresh lead does not reach an over-curve customer');

-- ---------------------------------------------------------------------------
-- 2 — The window: under it admits, over it refuses, null is never fresh
-- ---------------------------------------------------------------------------
update public.system_settings set value = '24' where key = 'release_fresh_hours';
select test_util.assert_eq(
  public.customer_release_allows('11111111-1111-1111-1111-111111111111', 'management', now()),
  true, 'window 24h: a lead created just now skips the curve');
select test_util.assert_eq(
  public.customer_release_allows('11111111-1111-1111-1111-111111111111', 'management', now() - interval '23 hours'),
  true, 'window 24h: a 23-hour-old lead is still fresh');
select test_util.assert_eq(
  public.customer_release_allows('11111111-1111-1111-1111-111111111111', 'management', now() - interval '25 hours'),
  false, 'window 24h: a 25-hour-old lead is not fresh — the curve refuses');
select test_util.assert_eq(
  public.customer_release_allows('11111111-1111-1111-1111-111111111111', 'management', null::timestamptz),
  false, 'window 24h: NULL is never fresh');
select test_util.assert_eq(
  public.customer_release_allows('11111111-1111-1111-1111-111111111111'),
  false, 'window 24h: the two-argument shim passes null and still refuses');

-- ---------------------------------------------------------------------------
-- 3 — A hold still refuses a fresh lead
-- ---------------------------------------------------------------------------
update public.customers set release_hold_until = test_util.london_today() + 3
  where id = '11111111-1111-1111-1111-111111111111';
select test_util.assert_eq(
  public.customer_release_allows('11111111-1111-1111-1111-111111111111', 'management', now()),
  false, 'a hold refuses a fresh lead — "hold my leads" means all of them');
update public.customers set release_hold_until = null
  where id = '11111111-1111-1111-1111-111111111111';

-- ---------------------------------------------------------------------------
-- 4 — No entitlement still refuses a fresh lead
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  public.customer_release_allows('55555555-5555-5555-5555-555555555555', 'management', now()),
  false, 'management side of a GR-only customer (E = 0): a fresh lead is still refused');

-- ---------------------------------------------------------------------------
-- 5 — The daily cap still bounds a fresh lead
-- ---------------------------------------------------------------------------
update public.system_settings set value = '1' where key = 'release_max_per_day';
select test_util.assert_eq(
  public.customer_release_allows('11111111-1111-1111-1111-111111111111', 'management', now()),
  false, 'cap 1 with one dated today: a fresh lead is refused by the cap');
update public.system_settings set value = '2' where key = 'release_max_per_day';
select test_util.assert_eq(
  public.customer_release_allows('11111111-1111-1111-1111-111111111111', 'management', now()),
  true, 'cap 2 with one dated today: the fresh lead is the second');

-- ---------------------------------------------------------------------------
-- 6 — Both candidate functions pass the lead's OWN created_at
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select count(*)::integer from public.get_unfiltered_candidates_for_lead('aaaa0000-0000-0000-0000-00000000000f', 10)
    where customer_id = '11111111-1111-1111-1111-111111111111'),
  1, 'unfiltered: an over-curve customer is a candidate for the FRESH lead');
select test_util.assert_eq(
  (select count(*)::integer from public.get_unfiltered_candidates_for_lead('aaaa0000-0000-0000-0000-00000000005a', 10)
    where customer_id = '11111111-1111-1111-1111-111111111111'),
  0, 'unfiltered: and not for the 25-hour-old lead');
select test_util.assert_eq(
  (select count(*)::integer from public.get_unfiltered_candidates_for_lead('aaaa0000-0000-0000-0000-00000000005e', 10)
    where customer_id = '11111111-1111-1111-1111-111111111111'),
  1, 'unfiltered: the 23-hour-old lead still counts as fresh');

-- Filt over the curve: fill their day-1 slot first.
select public.assign_lead_to_customer(
  'aaaa0000-0000-0000-0000-000000000002','33333333-3333-3333-3333-333333333333',15.00);
select test_util.assert_eq(
  (select count(*)::integer from public.get_filtered_candidates_for_lead('aaaa0000-0000-0000-0000-00000000005a', 10)
    where customer_id = '33333333-3333-3333-3333-333333333333'),
  0, 'filtered: over the curve, the 25-hour-old lead does not reach them');
select test_util.assert_eq(
  (select count(*)::integer from public.get_filtered_candidates_for_lead('aaaa0000-0000-0000-0000-00000000000f', 10)
    where customer_id = '33333333-3333-3333-3333-333333333333'),
  1, 'filtered: the fresh BS 3-bed reaches the over-curve filtered customer');

-- ---------------------------------------------------------------------------
-- 7 — With the daily release OFF nothing here matters
-- ---------------------------------------------------------------------------
update public.system_settings set value = 'false' where key = 'release_enabled';
select test_util.assert_eq(
  public.customer_release_allows('11111111-1111-1111-1111-111111111111', 'management', now() - interval '40 days'),
  true, 'release off: a 40-day-old lead is allowed (three-argument form)');
select test_util.assert_eq(
  public.customer_release_allows('11111111-1111-1111-1111-111111111111'),
  true, 'release off: the shim is true for everyone');
update public.system_settings set value = 'true' where key = 'release_enabled';

-- ---------------------------------------------------------------------------
-- 8 — GR reads gr_ columns only (invariant 6)
-- ---------------------------------------------------------------------------
select public.assign_lead_to_customer(
  'bbbb0000-0000-0000-0000-000000000001','55555555-5555-5555-5555-555555555555',15.00,'guaranteed_rent');
select test_util.assert_eq(
  public.customer_release_allows('55555555-5555-5555-5555-555555555555', 'guaranteed_rent', now() - interval '25 hours'),
  false, 'GR day 1 after one lead: a stale lead is refused on the GR columns');
select test_util.assert_eq(
  public.customer_release_allows('55555555-5555-5555-5555-555555555555', 'guaranteed_rent', now()),
  true, 'GR day 1 after one lead: a fresh lead skips the GR curve');
update public.customers set release_hold_until = test_util.london_today() + 5
  where id = '55555555-5555-5555-5555-555555555555';
select test_util.assert_eq(
  public.customer_release_allows('55555555-5555-5555-5555-555555555555', 'guaranteed_rent', now()),
  true, 'a MANAGEMENT hold does not gate a fresh GR lead (invariant 6)');
update public.customers set release_hold_until = null
  where id = '55555555-5555-5555-5555-555555555555';
select test_util.assert_eq(
  (select count(*)::integer from public.get_unfiltered_candidates_for_lead('bbbb0000-0000-0000-0000-00000000000f', 10, 'guaranteed_rent')
    where customer_id = '55555555-5555-5555-5555-555555555555'),
  1, 'GR: the fresh GR lead reaches the over-curve GR customer through the candidate function');

-- ---------------------------------------------------------------------------
-- 9 — ⚠️ The money path is still not gated
-- ---------------------------------------------------------------------------
update public.system_settings set value = '0' where key = 'release_fresh_hours';
select test_util.assert_eq(
  public.customer_release_allows('11111111-1111-1111-1111-111111111111', 'management', now()),
  false, 'window back at 0: the fresh lead is refused again');
select public.assign_lead_to_customer(
  'aaaa0000-0000-0000-0000-00000000000f','11111111-1111-1111-1111-111111111111',15.00);
select test_util.assert_eq(
  (select count(*)::integer from public.lead_assignments
    where lead_id = 'aaaa0000-0000-0000-0000-00000000000f'
      and customer_id = '11111111-1111-1111-1111-111111111111'),
  1, 'assign_lead_to_customer still accepts a direct call for a refused customer');
select test_util.assert_eq(
  (select lead_balance from public.customers where id = '11111111-1111-1111-1111-111111111111'),
  18, 'and it still spends exactly one credit');

-- ---------------------------------------------------------------------------
-- 10 — ACLs, both overloads and both candidate functions
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select count(*)::integer from information_schema.role_routine_grants
    where routine_schema = 'public'
      and grantee in ('anon', 'authenticated', 'public')
      and routine_name in ('customer_release_allows',
                           'get_filtered_candidates_for_lead', 'get_unfiltered_candidates_for_lead')),
  0, 'anon and authenticated cannot execute any 0154 function');
-- ⚠️ information_schema names PUBLIC in upper case and the check above cannot
-- see a grant left on it; has_function_privilege follows role membership, so
-- these are the assertions that catch a dropped revoke.
select test_util.assert_eq(
  has_function_privilege('anon', 'public.customer_release_allows(uuid, public.lead_type, timestamptz)', 'execute'),
  false, 'anon cannot execute the three-argument form');
select test_util.assert_eq(
  has_function_privilege('authenticated', 'public.customer_release_allows(uuid, public.lead_type, timestamptz)', 'execute'),
  false, 'authenticated cannot execute the three-argument form');
select test_util.assert_eq(
  has_function_privilege('anon', 'public.customer_release_allows(uuid, public.lead_type)', 'execute'),
  false, 'anon cannot execute the shim');
select test_util.assert_eq(
  has_function_privilege('service_role', 'public.customer_release_allows(uuid, public.lead_type, timestamptz)', 'execute'),
  true, 'service_role can execute the three-argument form');
select test_util.assert_eq(
  has_function_privilege('service_role', 'public.customer_release_allows(uuid, public.lead_type)', 'execute'),
  true, 'service_role can execute the shim');

-- Leave the settings as the migration ships them, and the tables clear.
update public.system_settings set value = 'false' where key = 'release_enabled';
update public.system_settings set value = '0' where key = 'release_fresh_hours';
update public.system_settings set value = '2' where key = 'release_max_per_day';
delete from public.lead_assignments;
delete from public.leads;
delete from public.customers;

\o
\echo '== 0154 BEHAVIOURAL TESTS PASSED =='
