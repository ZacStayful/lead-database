-- ============================================================================
-- Behavioural tests for 0148 — one lead a working day (§54).
--
-- The assertion that matters most is the first: with the switch OFF the two
-- candidate functions must return exactly what they returned before, because
-- that is what lets the migration be applied to production ahead of the code.
-- After that: the working-day quota admits and refuses on the right days, the
-- daily cap bounds catch-up, a top-up raises the curve, a hold refuses, the
-- exemption exempts, GR reads only gr_ columns, and the money path is
-- deliberately NOT gated.
--
-- Time control: now() is not stubbed, so elapsed working days are simulated by
-- moving billing_cycle_anchor. `today` here is the London date, as the rule
-- reads it.
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

-- The London date, as the rule reads it.
create or replace function test_util.london_today() returns date language sql stable as $$
  select (now() at time zone 'Europe/London')::date
$$;

-- An anchor such that [anchor, today] contains exactly p_k working days
-- (p_k >= 1), i.e. the customer is on working day p_k of their cycle.
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

insert into public.leads (id, monday_item_id, lead_name, postcode_area, bedrooms, max_assignments, assignment_count)
select ('aaaa0000-0000-0000-0000-0000000000' || lpad(i::text,2,'0'))::uuid,
       'm-rel-'||i, 'Landlord '||i, 'BS', '3', 5, 0
from generate_series(1,12) i;

insert into public.leads (id, monday_item_id, lead_name, lead_type, postcode_area, bedrooms, max_assignments, assignment_count)
values ('bbbb0000-0000-0000-0000-000000000001','g-rel-1','GR Landlord','guaranteed_rent','BS','3',3,0);

-- ---------------------------------------------------------------------------
-- 0 — Switch OFF: the migration is inert
-- ---------------------------------------------------------------------------
update public.system_settings set value = 'false' where key = 'release_enabled';
select test_util.assert_eq(
  (select count(*)::integer from public.get_unfiltered_candidates_for_lead('aaaa0000-0000-0000-0000-000000000001', 10)),
  3, 'switch off: every unfiltered management customer with credit is a candidate');
select test_util.assert_eq(
  (select count(*)::integer from public.get_filtered_candidates_for_lead('aaaa0000-0000-0000-0000-000000000001', 10)),
  1, 'switch off: the filtered customer is a candidate');
select test_util.assert_eq(
  public.customer_release_allows('11111111-1111-1111-1111-111111111111'),
  true, 'switch off: the predicate is true for everyone');
-- A missing row reads as off too (fail towards today''s behaviour).
delete from public.system_settings where key = 'release_enabled';
select test_util.assert_eq(
  public.customer_release_allows('11111111-1111-1111-1111-111111111111'),
  true, 'no release_enabled row: treated as off');
insert into public.system_settings (key, value) values ('release_enabled', 'true');

-- ---------------------------------------------------------------------------
-- 1 — Working-day arithmetic
-- ---------------------------------------------------------------------------
select test_util.assert_eq(public.working_days_between(date '2026-09-07', date '2026-09-11'), 5, 'Mon–Fri is 5 working days');
select test_util.assert_eq(public.working_days_between(date '2026-09-07', date '2026-09-13'), 5, 'Mon–Sun is still 5');
select test_util.assert_eq(public.working_days_between(date '2026-09-12', date '2026-09-13'), 0, 'a weekend alone is 0');
select test_util.assert_eq(public.working_days_between(date '2026-09-07', date '2026-10-06'), 22, 'a 30-day window from a Monday holds 22 working days');
select test_util.assert_eq(public.working_days_between(date '2026-09-11', date '2026-09-07'), 0, 'reversed dates are 0, not negative');
select test_util.assert_eq(public.working_days_between(null, date '2026-09-07'), 0, 'null is 0');

-- ---------------------------------------------------------------------------
-- 2 — A 20-lead plan on working day 1: one lead, then refused
-- ---------------------------------------------------------------------------
-- anchor_for_working_day(k) walks back to a weekday, so [anchor, today]
-- holds exactly k working days whatever day this runs on.
do $$
declare
  v_allowed boolean;
begin

  select public.customer_release_allows('11111111-1111-1111-1111-111111111111') into v_allowed;
  perform test_util.assert_eq(v_allowed, true, 'day 1: a 20-lead customer is allowed one');

  perform public.assign_lead_to_customer(
    'aaaa0000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',15.00);

  select public.customer_release_allows('11111111-1111-1111-1111-111111111111') into v_allowed;
  perform test_util.assert_eq(v_allowed, false, 'day 1: after one lead the 20-lead customer is refused');
  perform test_util.assert_eq(
    (select count(*)::integer from public.get_unfiltered_candidates_for_lead('aaaa0000-0000-0000-0000-000000000002', 10)
      where customer_id = '11111111-1111-1111-1111-111111111111'),
    0, 'day 1: and they are absent from the unfiltered candidate list');

  -- A 10-lead plan: day 1 allowed (ceil(1*10/22) = 1), and after one, refused.
  select public.customer_release_allows('22222222-2222-2222-2222-222222222222') into v_allowed;
  perform test_util.assert_eq(v_allowed, true, 'day 1: a 10-lead customer is allowed one');
  perform public.assign_lead_to_customer(
    'aaaa0000-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222',15.00);
  select public.customer_release_allows('22222222-2222-2222-2222-222222222222') into v_allowed;
  perform test_util.assert_eq(v_allowed, false, 'day 1: the 10-lead customer is refused after one');

  -- Move the 10-lead customer to working day 2: allowance ceil(2*10/W) is still
  -- 1 for any W >= 20, so still refused. Day 3: ceil(30/22) = 2, allowed.
  update public.customers set billing_cycle_anchor = test_util.anchor_for_working_day(2)
    where id = '22222222-2222-2222-2222-222222222222';
  select public.customer_release_allows('22222222-2222-2222-2222-222222222222') into v_allowed;
  perform test_util.assert_eq(v_allowed, false, 'day 2: the 10-lead customer gets nothing (one every other working day)');
  update public.customers set billing_cycle_anchor = test_util.anchor_for_working_day(3)
    where id = '22222222-2222-2222-2222-222222222222';
  select public.customer_release_allows('22222222-2222-2222-2222-222222222222') into v_allowed;
  perform test_util.assert_eq(v_allowed, true, 'day 3: the 10-lead customer is due their second');
end $$;

-- ---------------------------------------------------------------------------
-- 3 — Catch-up is bounded by the daily cap
-- ---------------------------------------------------------------------------
-- Twenty is on working day 6 having received 1: allowance ceil(6*20/W) >= 5,
-- so the curve owes several, but the cap (2/day) allows at most one more
-- today on top of the one already dated today.
update public.customers set billing_cycle_anchor = test_util.anchor_for_working_day(6)
  where id = '11111111-1111-1111-1111-111111111111';
do $$
declare v boolean;
begin
  select public.customer_release_allows('11111111-1111-1111-1111-111111111111') into v;
  perform test_util.assert_eq(v, true, 'day 6, 1 received: behind the curve, allowed');
  perform public.assign_lead_to_customer(
    'aaaa0000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111',15.00);
  select public.customer_release_allows('11111111-1111-1111-1111-111111111111') into v;
  perform test_util.assert_eq(v, false, 'day 6, 2 received today: the daily cap (2) refuses a third');
  -- Raise the cap and the curve is what binds.
  update public.system_settings set value = '5' where key = 'release_max_per_day';
  select public.customer_release_allows('11111111-1111-1111-1111-111111111111') into v;
  perform test_util.assert_eq(v, true, 'cap raised to 5: the curve still owes more, allowed');
  update public.system_settings set value = '2' where key = 'release_max_per_day';
end $$;

-- ---------------------------------------------------------------------------
-- 4 — The curve is on the ENTITLEMENT: a top-up raises it
-- ---------------------------------------------------------------------------
-- Ten on working day 1 has received 1 (the block above) and would be refused;
-- balance 9. A +5 top-up makes E = 15, ceil(1*15/22) = 1 — still refused on
-- day 1. On day 3: ceil(3*15/22) = 3 > 1, allowed, where E = 10 gave 2 (also
-- allowed). Use day 2 to see the difference: ceil(2*10/22) = 1 (refused) vs
-- ceil(2*15/22) = 2 (allowed).
update public.customers set billing_cycle_anchor = test_util.anchor_for_working_day(2)
  where id = '22222222-2222-2222-2222-222222222222';
do $$
declare v boolean;
begin
  select public.customer_release_allows('22222222-2222-2222-2222-222222222222') into v;
  perform test_util.assert_eq(v, false, 'day 2, E=10, 1 received: refused');
  update public.customers set lead_balance = lead_balance + 5 where id = '22222222-2222-2222-2222-222222222222';
  select public.customer_release_allows('22222222-2222-2222-2222-222222222222') into v;
  perform test_util.assert_eq(v, true, 'day 2, E=15 after a top-up: the curve rose, allowed');
  update public.customers set lead_balance = lead_balance - 5 where id = '22222222-2222-2222-2222-222222222222';
end $$;

-- ---------------------------------------------------------------------------
-- 5 — A hold refuses outright, and the day it names is the day leads resume
-- ---------------------------------------------------------------------------
update public.customers set release_hold_until = test_util.london_today() + 3
  where id = '33333333-3333-3333-3333-333333333333';
select test_util.assert_eq(
  public.customer_release_allows('33333333-3333-3333-3333-333333333333'),
  false, 'a hold until three days from now refuses today');
update public.customers set release_hold_until = test_util.london_today()
  where id = '33333333-3333-3333-3333-333333333333';
select test_util.assert_eq(
  public.customer_release_allows('33333333-3333-3333-3333-333333333333'),
  true, 'a hold ending today no longer refuses — the quota decides (day 1, nothing received)');
update public.customers set release_hold_until = null
  where id = '33333333-3333-3333-3333-333333333333';

-- ---------------------------------------------------------------------------
-- 6 — release_mode = immediate is exempt from everything
-- ---------------------------------------------------------------------------
update public.customers set release_mode = 'immediate',
       leads_received_this_month = 20, release_hold_until = test_util.london_today() + 10
  where id = '44444444-4444-4444-4444-444444444444';
select test_util.assert_eq(
  public.customer_release_allows('44444444-4444-4444-4444-444444444444'),
  true, 'immediate: allowed even over the curve and under a hold');
update public.customers set release_mode = 'daily', leads_received_this_month = 0, release_hold_until = null
  where id = '44444444-4444-4444-4444-444444444444';

-- The CHECK holds the vocabulary.
do $$
begin
  begin
    update public.customers set release_mode = 'weekly' where id = '44444444-4444-4444-4444-444444444444';
    raise exception 'FAIL an unknown release_mode was accepted';
  exception when check_violation then
    raise notice 'ok  release_mode refuses an unknown value';
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 7 — GR reads gr_ columns only (invariant 6)
-- ---------------------------------------------------------------------------
-- GRonly holds no management product and has an exhausted management side
-- (balance 0); their GR side is fresh on day 1.
do $$
declare v boolean;
begin
  select public.customer_release_allows('55555555-5555-5555-5555-555555555555', 'guaranteed_rent') into v;
  perform test_util.assert_eq(v, true, 'GR day 1: allowed on the GR columns');
  select public.customer_release_allows('55555555-5555-5555-5555-555555555555', 'management') into v;
  perform test_util.assert_eq(v, false, 'management side of a GR-only customer: E = 0, refused');
  perform public.assign_lead_to_customer(
    'bbbb0000-0000-0000-0000-000000000001','55555555-5555-5555-5555-555555555555',15.00,'guaranteed_rent');
  select public.customer_release_allows('55555555-5555-5555-5555-555555555555', 'guaranteed_rent') into v;
  perform test_util.assert_eq(v, false, 'GR day 1 after one lead: refused on the GR columns');
  -- A management hold must not touch GR.
  update public.customers set release_hold_until = test_util.london_today() + 5
    where id = '55555555-5555-5555-5555-555555555555';
  update public.customers set gr_leads_received_this_month = 0
    where id = '55555555-5555-5555-5555-555555555555';
  -- (today_n still counts the GR assignment dated today, so widen the cap)
  update public.system_settings set value = '5' where key = 'release_max_per_day';
  select public.customer_release_allows('55555555-5555-5555-5555-555555555555', 'guaranteed_rent') into v;
  perform test_util.assert_eq(v, true, 'a MANAGEMENT hold does not gate GR (invariant 6)');
  update public.system_settings set value = '2' where key = 'release_max_per_day';
  update public.customers set release_hold_until = null where id = '55555555-5555-5555-5555-555555555555';
end $$;

-- ---------------------------------------------------------------------------
-- 8 — ⚠️ The money path is NOT gated: a refused candidate can still be
--     assigned directly (admin force-assign, swaps, replacements)
-- ---------------------------------------------------------------------------
update public.customers set leads_received_this_month = 20, lead_balance = 5
  where id = '44444444-4444-4444-4444-444444444444';
select test_util.assert_eq(
  public.customer_release_allows('44444444-4444-4444-4444-444444444444'),
  false, 'over the curve: the candidate predicate refuses');
select public.assign_lead_to_customer(
  'aaaa0000-0000-0000-0000-000000000005','44444444-4444-4444-4444-444444444444',15.00);
select test_util.assert_eq(
  (select count(*)::integer from public.lead_assignments
    where lead_id = 'aaaa0000-0000-0000-0000-000000000005'
      and customer_id = '44444444-4444-4444-4444-444444444444'),
  1, 'assign_lead_to_customer still accepts a direct call for a refused customer');
select test_util.assert_eq(
  (select lead_balance from public.customers where id = '44444444-4444-4444-4444-444444444444'),
  4, 'and it still spends exactly one credit');

-- ---------------------------------------------------------------------------
-- 9 — Invariant 7 and ACLs
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select count(*)::integer from information_schema.role_routine_grants
    where routine_schema = 'public'
      and grantee in ('anon', 'authenticated', 'public')
      and routine_name in ('customer_release_allows', 'working_days_between',
                           'get_filtered_candidates_for_lead', 'get_unfiltered_candidates_for_lead')),
  0, 'anon and authenticated cannot execute any 0148 function');
select test_util.assert_eq(
  has_function_privilege('service_role', 'public.customer_release_allows(uuid, public.lead_type)', 'execute'),
  true, 'service_role can execute customer_release_allows');

-- Leave the switch as the migration ships it.
update public.system_settings set value = 'false' where key = 'release_enabled';

\o
\echo '== 0148 BEHAVIOURAL TESTS PASSED =='
