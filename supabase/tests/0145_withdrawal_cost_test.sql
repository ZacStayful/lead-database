-- ============================================================================
-- Behavioural tests for 0145 — what a swap destroys (§53.11).
--
-- §53's Deferred list said the withdrawal cost "lands in `inventory_slots_now`
-- rather than `slots_per_month`, so the ceiling still understates the cost".
-- Measuring it corrected both halves: `slots_per_month` is
-- `sum(max_assignments)` over the window and the swap's clamp lowers it the
-- instant a withdrawal happens, so the ceiling already carries it — and the
-- clamp is also why the cost was unmeasurable, because it overwrites the cap.
--
-- Two things are asserted here and the first is the whole point:
--
--   1. ⚠️ `withdrawn_slots` EQUALS THE ACTUAL DROP IN `slots_per_month`.
--      Not "free slots lost", not a plausible-looking number — the real delta,
--      taken by reading the function either side of a real swap. A column whose
--      whole purpose is to be a measurement has to be checked against the thing
--      it measures.
--
--   2. It is REPORTED and never folded into a ceiling, because `slots_per_month`
--      already carries it and charging it twice would double-count.
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

delete from public.lead_outcome_reasons;
delete from public.lead_quality_claims;
delete from public.lead_events;
delete from public.lead_notes;
delete from public.lead_assignments;
delete from public.leads;
delete from public.customers;

insert into public.customers
  (id, business_name, contact_name, email, monthly_allocation, lead_balance,
   leads_received_this_month, management_lifetime_leads_received,
   account_status, subscription_status, quality_allowance_pct)
values
  ('11111111-1111-1111-1111-111111111111','Alpha','A','a@x.com',20,17,3,9,
   'active','active',0.10),
  ('22222222-2222-2222-2222-222222222222','Beta','B','b@x.com',20,17,0,0,
   'active','active',0.10);

-- Four outgoing leads, one per shape the cost formula has to get right, plus
-- replacements to swap in. Every lead is created now, so all of them sit in
-- get_service_capacity's own 28-day supply window.
insert into public.leads
  (id, monday_item_id, lead_name, postcode, postcode_area, bedrooms,
   max_assignments, assignment_count)
values
  ('aaaa0000-0000-0000-0000-000000000001','m-sole','Sole holder','BS1 1AA','BS','3',3,1),
  ('aaaa0000-0000-0000-0000-000000000002','m-full','Fully sold','BS2 2BB','BS','3',3,3),
  ('aaaa0000-0000-0000-0000-000000000003','m-pool','Over the cap','BS3 3CC','BS','3',3,4),
  ('aaaa0000-0000-0000-0000-000000000004','m-rep1','Replacement one','BS4 4DD','BS','3',3,0),
  ('aaaa0000-0000-0000-0000-000000000005','m-rep2','Replacement two','BS5 5EE','BS','3',3,0),
  ('aaaa0000-0000-0000-0000-000000000006','m-rep3','Replacement three','BS6 6FF','BS','3',3,0);

insert into public.lead_assignments (id, lead_id, customer_id, price_paid)
values
  ('bbbb0000-0000-0000-0000-000000000001','aaaa0000-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111',15.00),
  ('bbbb0000-0000-0000-0000-000000000002','aaaa0000-0000-0000-0000-000000000002',
   '11111111-1111-1111-1111-111111111111',15.00),
  ('bbbb0000-0000-0000-0000-000000000003','aaaa0000-0000-0000-0000-000000000003',
   '11111111-1111-1111-1111-111111111111',15.00),
  -- ⚠️ A SECOND OPERATOR ON THE FULLY-SOLD LEAD, and it is the only reason the
  -- per-assignment rule below is testable at all. With one assignment per lead
  -- the two averages are arithmetically identical, so an assertion written over
  -- that seed passes whichever rule the function uses — §50.9's shape, and the
  -- mutation run is what found it.
  ('bbbb0000-0000-0000-0000-000000000004','aaaa0000-0000-0000-0000-000000000002',
   '22222222-2222-2222-2222-222222222222',15.00);

-- ---------------------------------------------------------------------------
-- 1 — Nothing has been withdrawn yet, so the figure is an ESTIMATE
--
-- §18.2's rule, applied to a second series: an estimate must never be read as
-- a count, so it carries its own basis rather than looking like an observation
-- of zero.
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select withdrawal_basis from public.get_service_capacity()
    where lead_type = 'management'),
  'estimated', 'with nothing withdrawn the basis reads estimated');

select test_util.assert_eq(
  (select withdrawn_slots_per_month = round(quality_claim_demand_per_month * avg_withdrawal_cost, 1)
     from public.get_service_capacity() where lead_type = 'management'),
  true, 'and the estimate is the claim entitlement times the average cost');

-- The average cost is per ASSIGNMENT, not per lead. FOUR assignments here over
-- THREE leads: one on a lead costing 3, TWO on a lead costing 1, one on a lead
-- costing 0. Per assignment that is 5/4 = 1.25; per lead it would be 4/3 =
-- 1.33, so the two rules are distinguishable and this expectation pins which.
select test_util.assert_eq(
  (select avg_withdrawal_cost from public.get_service_capacity()
    where lead_type = 'management'),
  1.25::numeric, 'the average cost is taken per assignment, not per lead');

-- ---------------------------------------------------------------------------
-- 2 — ⚠️ THE ASSERTION THIS COLUMN EXISTS FOR
--
-- `withdrawn_slots` must equal the real drop in slots_per_month, measured by
-- reading the function either side of a real swap. Every other assertion here
-- is decorative if this one does not hold.
-- ---------------------------------------------------------------------------
create temporary table t_before as
select lead_type, slots_per_month from public.get_service_capacity();

select public.admin_swap_lead_assignment(
  'bbbb0000-0000-0000-0000-000000000001',
  'aaaa0000-0000-0000-0000-000000000004', false);

select test_util.assert_eq(
  (select withdrawn_slots from public.leads
    where id = 'aaaa0000-0000-0000-0000-000000000001'),
  3, 'a sole holder reporting costs the whole lead — 3 slots');

-- ⚠️ The swap ALSO places the replacement, which does not move slots_per_month
-- (that counts caps, not assignments), so the drop is the withdrawal alone.
select test_util.assert_eq(
  (select round(b.slots_per_month - a.slots_per_month, 1)
     from t_before b
     join public.get_service_capacity() a on a.lead_type = b.lead_type
    where b.lead_type = 'management'),
  round(3 * 30.0 / 28, 1),
  'and slots_per_month falls by exactly that, scaled to 30 days');

-- ---------------------------------------------------------------------------
-- 3 — The other two shapes
-- ---------------------------------------------------------------------------
select public.admin_swap_lead_assignment(
  'bbbb0000-0000-0000-0000-000000000002',
  'aaaa0000-0000-0000-0000-000000000005', false);
select test_util.assert_eq(
  (select withdrawn_slots from public.leads
    where id = 'aaaa0000-0000-0000-0000-000000000002'),
  1, 'a fully sold lead costs 1 — the other two holders keep theirs');

-- ⚠️ assignment_count above max_assignments is legal (invariant 3: a pool claim
-- bypasses the cap), and the naive `free slots + 1` would report 1 here where
-- the true drop is zero.
select public.admin_swap_lead_assignment(
  'bbbb0000-0000-0000-0000-000000000003',
  'aaaa0000-0000-0000-0000-000000000006', false);
select test_util.assert_eq(
  (select withdrawn_slots from public.leads
    where id = 'aaaa0000-0000-0000-0000-000000000003'),
  0, 'a lead over its own cap costs nothing, and is not negative');

-- ---------------------------------------------------------------------------
-- 4 — Now something HAS been withdrawn, so the figure is OBSERVED
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select withdrawal_basis from public.get_service_capacity()
    where lead_type = 'management'),
  'observed', 'once a swap has happened the basis flips to observed');

select test_util.assert_eq(
  (select withdrawn_slots_per_month from public.get_service_capacity()
    where lead_type = 'management'),
  round((3 + 1 + 0) * 30.0 / 28, 1),
  'and it is the sum of what those three swaps actually destroyed');

-- ---------------------------------------------------------------------------
-- 5 — ⚠️ REPORTED, NEVER ADDED
--
-- slots_per_month already carries the cost (§2 above proves it), so
-- subtracting the same figure again anywhere would double-count it. The
-- serviceable total is still exactly its two documented parts.
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select serviceable_slots_per_month
        = round(slots_per_month + recycled_slots_per_month, 1)
     from public.get_service_capacity() where lead_type = 'management'),
  true, 'serviceable supply is still new leads plus recycling, and nothing else');

select test_util.assert_eq(
  (select sustainable_customers
        = case when avg_allocation_with_swaps > 0
               then floor(serviceable_slots_per_month / avg_allocation_with_swaps)::integer
               else 0 end
     from public.get_service_capacity() where lead_type = 'management'),
  true, 'and the ceiling is still that total over the swap-inflated allocation');

-- ---------------------------------------------------------------------------
-- 6 — ⚠️ A PRE-0145 WITHDRAWAL IS INVISIBLE, NOT ZERO
--
-- Its cap was overwritten by the clamp and cannot be recovered. Counting it as
-- zero would say the swap cost nothing, which is the one reading this column
-- exists to prevent.
--
-- ⚠️ THE SUM ALONE CANNOT TELL THE TWO RULES APART, and a first draft of this
-- section asserted only the sum. A zero contributes zero to a sum, so
-- coalescing the nulls away passes that assertion exactly. What separates
-- invisible from zero is the COUNT behind the basis — §18.2's rule, which is
-- what the second half below pins. The mutation run is what found it.
-- ---------------------------------------------------------------------------
update public.leads set withdrawn_slots = null
  where id = 'aaaa0000-0000-0000-0000-000000000001';

select test_util.assert_eq(
  (select withdrawn_slots_per_month from public.get_service_capacity()
    where lead_type = 'management'),
  round((1 + 0) * 30.0 / 28, 1),
  'a null-cost withdrawal drops out of the sum rather than adding a zero');

select test_util.assert_eq(
  (select withdrawal_basis from public.get_service_capacity()
    where lead_type = 'management'),
  'observed', 'and the remaining recorded ones still carry the basis');

-- Now every withdrawal on the book is a pre-0145 one. There is nothing
-- observed at all, so the basis must fall back — where counting them as zero
-- would report three swaps that destroyed nothing.
update public.leads set withdrawn_slots = null
  where withdrawn_at is not null;

select test_util.assert_eq(
  (select withdrawal_basis from public.get_service_capacity()
    where lead_type = 'management'),
  'estimated', 'with every recorded cost null the basis falls back to estimated');

select test_util.assert_eq(
  (select withdrawn_slots_per_month
        = round(quality_claim_demand_per_month * avg_withdrawal_cost, 1)
     from public.get_service_capacity() where lead_type = 'management'),
  true, 'and the figure is the estimate again rather than reading as zero');

update public.leads set withdrawn_slots = 3
  where id = 'aaaa0000-0000-0000-0000-000000000001';
update public.leads set withdrawn_slots = 1
  where id = 'aaaa0000-0000-0000-0000-000000000002';
update public.leads set withdrawn_slots = 0
  where id = 'aaaa0000-0000-0000-0000-000000000003';

-- ---------------------------------------------------------------------------
-- 7 — The regression: a swap still does everything it did before
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select lead_balance from public.customers
    where id = '11111111-1111-1111-1111-111111111111'),
  17, 'a swap still moves no money');
select test_util.assert_eq(
  (select leads_received_this_month from public.customers
    where id = '11111111-1111-1111-1111-111111111111'),
  3, 'the monthly counter still does not move');
select test_util.assert_eq(
  (select clean_leads_streak from public.customers
    where id = '11111111-1111-1111-1111-111111111111'),
  0, 'and a swap is still not a delivery for the 0142 streak');
select test_util.assert_eq(
  (select withdrawn_at is not null and max_assignments = assignment_count
     from public.leads where id = 'aaaa0000-0000-0000-0000-000000000002'),
  true, 'the outgoing lead is still withdrawn and clamped');
select test_util.assert_eq(
  (select price_paid from public.lead_assignments
    where lead_id = 'aaaa0000-0000-0000-0000-000000000004'
      and customer_id = '11111111-1111-1111-1111-111111111111'),
  15.00, 'and the replacement still carries the same price_paid');

-- ---------------------------------------------------------------------------
-- 8 — The daily series carries all three, on a re-run as well as a first write
--
-- §53.4's warning: capture_service_capacity has THREE lists, and forgetting the
-- `on conflict ... do update` one fails silently — the day's first capture
-- writes the new columns and every same-day re-run leaves them stale. The
-- escalation cron does re-run.
-- ---------------------------------------------------------------------------
delete from public.service_capacity_snapshots;
select public.capture_service_capacity();

select test_util.assert_eq(
  (select count(*)::integer from public.service_capacity_snapshots
    where withdrawal_basis is not null and withdrawn_slots_per_month is not null
      and avg_withdrawal_cost is not null),
  2, 'the first capture writes all three columns for both products');

-- Move the stored values away from the truth, then re-run: the update list is
-- what must put them back.
update public.service_capacity_snapshots
   set withdrawn_slots_per_month = 999,
       avg_withdrawal_cost       = 9.99,
       withdrawal_basis          = 'stale';
select public.capture_service_capacity();

select test_util.assert_eq(
  (select count(*)::integer from public.service_capacity_snapshots
    where withdrawal_basis = 'stale' or withdrawn_slots_per_month = 999
       or avg_withdrawal_cost = 9.99),
  0, 'a same-day re-run refreshes all three rather than leaving them stale');

select test_util.assert_eq(
  (select withdrawn_slots_per_month from public.service_capacity_snapshots
    where lead_type = 'management'),
  (select round(withdrawn_slots_per_month)::integer
     from public.get_service_capacity() where lead_type = 'management'),
  'the integer column is rounded, not floored');

-- ---------------------------------------------------------------------------
-- 9 — The ACLs the DROP discarded, and invariant 7
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('get_service_capacity','capture_service_capacity',
                        'admin_swap_lead_assignment')
      and (has_function_privilege('anon', p.oid, 'execute')
        or has_function_privilege('authenticated', p.oid, 'execute'))),
  0, 'anon and authenticated can execute none of the three');

select test_util.assert_eq(
  (select has_function_privilege('service_role', p.oid, 'execute')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_service_capacity'),
  true, 'and service_role still can, after the drop and recreate');

select test_util.assert_eq(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('get_engagement_benchmarks','set_management_customer_goal',
                        'get_operator_proof','get_recent_wins_anonymised')
      and has_function_privilege('authenticated', p.oid, 'execute')),
  4, 'invariant 7: the four customer-callable functions still are');

\o
select '0145 BEHAVIOURAL TESTS PASSED' as result;
