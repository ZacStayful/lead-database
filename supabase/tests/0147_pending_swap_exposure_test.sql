-- ============================================================================
-- Behavioural tests for 0147 — the standing replacement exposure (§53.13).
--
-- §53's Deferred list said the lag was still open: the ceiling reflects the
-- last 28 days of withdrawals, where the exposure is the entitlement every
-- customer is holding and has not spent. 0145 established that the COST is
-- already inside the ceiling, so what is missing is timing, not magnitude.
--
-- Three things are asserted here and the first two are the whole point:
--
--   1. ⚠️ THE FIGURE IS BOUNDED BY BOTH HALVES, per customer — the remaining
--      entitlement AND the claimable assignments of that product. Measured on
--      production, entitlement alone read 31 against a true exposure of 13, so
--      an assertion that only pins one bound would pass on a figure wrong by
--      more than a factor of two. Both bounds are exercised in both directions.
--
--   2. ⚠️ IT IS REPORTED AND NEVER ADDED. Every ceiling is asserted as an
--      identity over the other returned columns, so subtracting the exposure
--      from any of them breaks a named test.
--
--   3. The claim rule is DELEGATED, not restated — the window, the owner bar
--      and the worked-evidence requirement are all asserted through the
--      aggregate, which they can only satisfy if
--      `claimable_dead_lead_assignments` is genuinely being called.
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

create or replace function test_util.swaps(p_type public.lead_type)
returns integer language sql as $$
  select swaps_available_now from public.get_service_capacity() where lead_type = p_type;
$$;

delete from public.service_capacity_snapshots;
delete from public.lead_outcome_reasons;
delete from public.lead_quality_claims;
delete from public.lead_events;
delete from public.lead_notes;
delete from public.lead_assignments;
delete from public.leads;
delete from public.customers;

-- ---------------------------------------------------------------------------
-- The book, one customer per shape the entitlement rule has to get right.
--
-- ⚠️ E IS THE ONE THAT SEPARATES THIS FROM `swap_demand`. Their management
-- subscription_status is inactive while account_status is active, which
-- `holdsProduct` admits on its OR and the served CTE refuses on its AND. A
-- figure built on the served population would miss them entirely.
--
-- C holds management AND guaranteed rent and is PAUSED, which is the invariant
-- 6 case: no management exposure, because admin_swap_lead_assignment raises on
-- a paused customer, but their GR entitlement is spendable and must still count.
-- ---------------------------------------------------------------------------
insert into public.customers
  (id, business_name, contact_name, email, is_active,
   monthly_allocation, gr_monthly_allocation, lead_balance, gr_lead_balance,
   account_status, subscription_status, gr_subscription_status,
   paused_at, quality_allowance_pct, clean_leads_streak, quality_claims_this_cycle)
values
  ('c0000000-0000-0000-0000-00000000000a','Alpha','A','a@x.com',true,
   20,10,20,0,'active','active','inactive',null,0.10,0,0),
  ('c0000000-0000-0000-0000-00000000000b','Beta','B','b@x.com',true,
   10,10,20,0,'active','active','inactive',null,0.10,0,0),
  ('c0000000-0000-0000-0000-00000000000c','Gamma','C','c@x.com',true,
   20,10,20,20,'active','active','active',now(),0.10,0,0),
  ('c0000000-0000-0000-0000-00000000000d','Delta','D','d@x.com',false,
   20,10,20,0,'active','active','inactive',null,0.10,0,0),
  ('c0000000-0000-0000-0000-00000000000e','Epsilon','E','e@x.com',true,
   20,10,20,0,'active','inactive','inactive',null,0.10,0,0),
  ('c0000000-0000-0000-0000-00000000000f','Zeta','F','f@x.com',true,
   20,10,0,20,'waitlisted','inactive','active',null,0.10,0,0);

-- Every lead carries max_assignments 3 and one holder, so the average
-- withdrawal cost is exactly 3 and `swap_slots_now` is readable by eye.
insert into public.leads
  (id, monday_item_id, lead_name, postcode, postcode_area, bedrooms,
   lead_type, max_assignments, assignment_count, owner_customer_id, owner_source)
values
  ('1ead0000-0000-0000-0000-00000000a001','m-a1','A one','BS1 1AA','BS','3','management',3,1,null,null),
  ('1ead0000-0000-0000-0000-00000000a002','m-a2','A two','BS1 1AB','BS','3','management',3,1,null,null),
  ('1ead0000-0000-0000-0000-00000000a003','m-a3','A three','BS1 1AC','BS','3','management',3,1,null,null),
  ('1ead0000-0000-0000-0000-00000000a004','m-a4','A four','BS1 1AD','BS','3','management',3,1,null,null),
  ('1ead0000-0000-0000-0000-00000000a005','m-a5','A five','BS1 1AE','BS','3','management',3,1,null,null),
  ('1ead0000-0000-0000-0000-00000000b001','m-b1','B one','BS2 2AA','BS','3','management',3,1,null,null),
  ('1ead0000-0000-0000-0000-00000000c001','m-c1','C one','BS3 3AA','BS','3','management',3,1,null,null),
  ('1ead0000-0000-0000-0000-00000000d001','m-d1','D one','BS4 4AA','BS','3','management',3,1,null,null),
  ('1ead0000-0000-0000-0000-00000000e001','m-e1','E one','BS5 5AA','BS','3','management',3,1,null,null),
  -- Replacements to swap in later.
  ('1ead0000-0000-0000-0000-00000000f001','m-spare1','Spare one','BS9 9AA','BS','3','management',3,0,null,null),
  ('1ead0000-0000-0000-0000-00000000f002','m-spare2','Spare two','BS9 9AB','BS','3','management',3,0,null,null),
  ('1ead0000-0000-0000-0000-000000009001','g-c1','C GR','BS3 3AB','BS','3','guaranteed_rent',3,1,null,null),
  ('1ead0000-0000-0000-0000-000000009002','g-f1','F GR','BS6 6AA','BS','3','guaranteed_rent',3,1,null,null);

insert into public.lead_assignments (id, lead_id, customer_id, price_paid)
values
  ('a5510000-0000-0000-0000-00000000a001','1ead0000-0000-0000-0000-00000000a001','c0000000-0000-0000-0000-00000000000a',15.00),
  ('a5510000-0000-0000-0000-00000000a002','1ead0000-0000-0000-0000-00000000a002','c0000000-0000-0000-0000-00000000000a',15.00),
  ('a5510000-0000-0000-0000-00000000a003','1ead0000-0000-0000-0000-00000000a003','c0000000-0000-0000-0000-00000000000a',15.00),
  ('a5510000-0000-0000-0000-00000000a004','1ead0000-0000-0000-0000-00000000a004','c0000000-0000-0000-0000-00000000000a',15.00),
  ('a5510000-0000-0000-0000-00000000a005','1ead0000-0000-0000-0000-00000000a005','c0000000-0000-0000-0000-00000000000a',15.00),
  ('a5510000-0000-0000-0000-00000000b001','1ead0000-0000-0000-0000-00000000b001','c0000000-0000-0000-0000-00000000000b',15.00),
  ('a5510000-0000-0000-0000-00000000c001','1ead0000-0000-0000-0000-00000000c001','c0000000-0000-0000-0000-00000000000c',15.00),
  ('a5510000-0000-0000-0000-00000000d001','1ead0000-0000-0000-0000-00000000d001','c0000000-0000-0000-0000-00000000000d',15.00),
  ('a5510000-0000-0000-0000-00000000e001','1ead0000-0000-0000-0000-00000000e001','c0000000-0000-0000-0000-00000000000e',15.00),
  ('a5510000-0000-0000-0000-000000009001','1ead0000-0000-0000-0000-000000009001','c0000000-0000-0000-0000-00000000000c',15.00),
  ('a5510000-0000-0000-0000-000000009002','1ead0000-0000-0000-0000-000000009002','c0000000-0000-0000-0000-00000000000f',15.00);

-- Worked, which is what `claimable_dead_lead_assignments` requires.
insert into public.lead_events (assignment_id, event_type)
select id, 'tel_click' from public.lead_assignments;

-- ---------------------------------------------------------------------------
-- 1 — The seed, pinned
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select avg_withdrawal_cost from public.get_service_capacity() where lead_type = 'management'),
  3::numeric, 'every seeded lead costs 3 to withdraw, so the average is 3');

-- A: entitlement round(20 × 0.10) = 2 against 5 claimable  → 2
-- B: entitlement round(10 × 0.10) = 1 against 1 claimable  → 1
-- C: PAUSED, so no management exposure                     → 0
-- D: archived                                              → 0
-- E: entitlement 2 against 1 claimable                     → 1
select test_util.assert_eq(test_util.swaps('management'), 4,
  'management exposure is the per-customer least of entitlement and claimable');

-- C: entitlement round((20 + 10) × 0.10) = 3 against 1 claimable → 1
-- F: entitlement round((0 + 10) × 0.10) = 1 against 1 claimable  → 1
select test_util.assert_eq(test_util.swaps('guaranteed_rent'), 2,
  'guaranteed rent counts the paused customer, because GR has no pause');

select test_util.assert_eq(
  (select swap_slots_now from public.get_service_capacity() where lead_type = 'management'),
  12.0::numeric, 'the slot figure is the count times the average withdrawal cost');

select test_util.assert_eq(
  (select swap_slots_now from public.get_service_capacity() where lead_type = 'guaranteed_rent'),
  6.0::numeric, 'and the same on the guaranteed rent side');

-- ---------------------------------------------------------------------------
-- 2 — ⚠️ BOUNDED BY ENTITLEMENT, in both directions
--
-- A holds five claimable assignments and contributes two. Raising the
-- entitlement must move the figure; raising the claimable count must not.
-- ---------------------------------------------------------------------------
update public.customers set quality_allowance_pct = 0.25
 where id = 'c0000000-0000-0000-0000-00000000000a';
select test_util.assert_eq(test_util.swaps('management'), 7,
  'raising one customer entitlement to 5 raises the exposure by 3');
update public.customers set quality_allowance_pct = 0.10
 where id = 'c0000000-0000-0000-0000-00000000000a';

insert into public.leads (id, monday_item_id, lead_name, postcode, postcode_area, bedrooms, lead_type, max_assignments, assignment_count)
values ('1ead0000-0000-0000-0000-00000000a006','m-a6','A six','BS1 1AF','BS','3','management',3,1);
insert into public.lead_assignments (id, lead_id, customer_id, price_paid)
values ('a5510000-0000-0000-0000-00000000a006','1ead0000-0000-0000-0000-00000000a006','c0000000-0000-0000-0000-00000000000a',15.00);
insert into public.lead_events (assignment_id, event_type)
values ('a5510000-0000-0000-0000-00000000a006','tel_click');
select test_util.assert_eq(test_util.swaps('management'), 4,
  'a sixth claimable lead for a customer capped at two changes nothing');

-- 0142's earned bonus is part of the entitlement and must move the figure too.
update public.customers set clean_leads_streak = 10
 where id = 'c0000000-0000-0000-0000-00000000000a';
select test_util.assert_eq(test_util.swaps('management'), 5,
  'an earned bonus raises the exposure, because it raises the entitlement');
update public.customers set clean_leads_streak = 0
 where id = 'c0000000-0000-0000-0000-00000000000a';

-- Entitlement already spent is not exposure.
update public.customers set quality_claims_this_cycle = 2
 where id = 'c0000000-0000-0000-0000-00000000000a';
select test_util.assert_eq(test_util.swaps('management'), 2,
  'entitlement already spent this cycle is not exposure');

-- And it never goes negative, however far over the entitlement a reviewed
-- uphold has pushed the counter (§53's clamp, on the SQL side).
update public.customers set quality_claims_this_cycle = 9
 where id = 'c0000000-0000-0000-0000-00000000000a';
select test_util.assert_eq(test_util.swaps('management'), 2,
  'a customer pushed past their entitlement contributes zero, never a negative');
update public.customers set quality_claims_this_cycle = 0
 where id = 'c0000000-0000-0000-0000-00000000000a';

-- ---------------------------------------------------------------------------
-- 3 — ⚠️ BOUNDED BY CLAIMABLE STOCK, which is the half production proved
--
-- E has an entitlement of two and one claimable lead. Giving them a second
-- must move the figure; the first bound would hide it.
-- ---------------------------------------------------------------------------
insert into public.leads (id, monday_item_id, lead_name, postcode, postcode_area, bedrooms, lead_type, max_assignments, assignment_count)
values ('1ead0000-0000-0000-0000-00000000e002','m-e2','E two','BS5 5AB','BS','3','management',3,1);
insert into public.lead_assignments (id, lead_id, customer_id, price_paid)
values ('a5510000-0000-0000-0000-00000000e002','1ead0000-0000-0000-0000-00000000e002','c0000000-0000-0000-0000-00000000000e',15.00);
insert into public.lead_events (assignment_id, event_type)
values ('a5510000-0000-0000-0000-00000000e002','tel_click');
select test_util.assert_eq(test_util.swaps('management'), 5,
  'a second claimable lead for a customer under their entitlement raises it');

-- ---------------------------------------------------------------------------
-- 4 — The claim rule is DELEGATED, not restated
--
-- Each of these is enforced inside `claimable_dead_lead_assignments` and
-- nowhere in 0147. They can only pass if that function is genuinely called.
-- ---------------------------------------------------------------------------
update public.lead_assignments set assigned_at = now() - interval '20 days'
 where id = 'a5510000-0000-0000-0000-00000000e002';
select test_util.assert_eq(test_util.swaps('management'), 4,
  'a lead outside the claim window stops being exposure');

insert into public.leads (id, lead_name, postcode, postcode_area, bedrooms, lead_type, max_assignments, assignment_count, owner_customer_id, owner_source)
values ('1ead0000-0000-0000-0000-00000000e003','E own','BS5 5AC','BS','3','management',1,1,'c0000000-0000-0000-0000-00000000000e','manual');
insert into public.lead_assignments (id, lead_id, customer_id, price_paid)
values ('a5510000-0000-0000-0000-00000000e003','1ead0000-0000-0000-0000-00000000e003','c0000000-0000-0000-0000-00000000000e',0);
insert into public.lead_events (assignment_id, event_type)
values ('a5510000-0000-0000-0000-00000000e003','tel_click');
select test_util.assert_eq(test_util.swaps('management'), 4,
  'a lead the customer uploaded themselves is never exposure');

insert into public.leads (id, monday_item_id, lead_name, postcode, postcode_area, bedrooms, lead_type, max_assignments, assignment_count)
values ('1ead0000-0000-0000-0000-00000000e004','m-e4','E four','BS5 5AD','BS','3','management',3,1);
insert into public.lead_assignments (id, lead_id, customer_id, price_paid)
values ('a5510000-0000-0000-0000-00000000e004','1ead0000-0000-0000-0000-00000000e004','c0000000-0000-0000-0000-00000000000e',15.00);
select test_util.assert_eq(test_util.swaps('management'), 4,
  'a lead nobody has worked is not claimable and so not exposure');

-- ---------------------------------------------------------------------------
-- 5 — Who is in the population at all
-- ---------------------------------------------------------------------------
update public.customers set paused_at = null
 where id = 'c0000000-0000-0000-0000-00000000000c';
select test_util.assert_eq(test_util.swaps('management'), 5,
  'un-pausing a customer puts their management entitlement back in play');
select test_util.assert_eq(test_util.swaps('guaranteed_rent'), 2,
  'and the guaranteed rent figure does not move, because it never excluded them');
update public.customers set paused_at = now()
 where id = 'c0000000-0000-0000-0000-00000000000c';

update public.customers set is_active = true
 where id = 'c0000000-0000-0000-0000-00000000000d';
select test_util.assert_eq(test_util.swaps('management'), 5,
  'an archived customer is excluded, and un-archiving one puts them back');
update public.customers set is_active = false
 where id = 'c0000000-0000-0000-0000-00000000000d';

-- ⚠️ E is the divergence from `swap_demand`, asserted rather than described:
-- the served CTE cannot see them, so the two figures are built on genuinely
-- different populations and must not be "reconciled" by making one match.
select test_util.assert_eq(
  (select quality_claim_demand_per_month from public.get_service_capacity()
    where lead_type = 'management'),
  3, 'the modelled monthly rate is built on the served population, which is smaller');

select test_util.assert_eq(
  (select swaps_available_now <> quality_claim_demand_per_month
     from public.get_service_capacity() where lead_type = 'management'),
  true, 'the standing stock and the monthly rate are different figures');

select test_util.assert_eq(
  (select swap_slots_now <> withdrawn_slots_per_month
     from public.get_service_capacity() where lead_type = 'management'),
  true, 'and so are the slots queued up and the slots per month');

-- ---------------------------------------------------------------------------
-- 6 — ⚠️ REPORTED, NEVER ADDED
--
-- Every ceiling stated as an identity over the other returned columns. Any
-- attempt to charge the exposure into one of them breaks a named test here.
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select bool_and(serviceable_slots_per_month = round(slots_per_month + recycled_slots_per_month, 1))
     from public.get_service_capacity()),
  true, 'serviceable supply is still slots plus recycling and nothing else');

select test_util.assert_eq(
  (select bool_and(sustainable_customers = case when avg_allocation_with_swaps > 0
      then floor(serviceable_slots_per_month / avg_allocation_with_swaps)::integer else 0 end)
     from public.get_service_capacity()),
  true, 'the headline ceiling carries no exposure term');

select test_util.assert_eq(
  (select bool_and(sustainable_customers_new_only = case when avg_allocation_with_swaps > 0
      then floor(slots_per_month / avg_allocation_with_swaps)::integer else 0 end)
     from public.get_service_capacity()),
  true, 'nor does the new-leads-only ceiling');

select test_util.assert_eq(
  (select bool_and(sustainable_customers_before_swaps = case when avg_allocation > 0
      then floor(serviceable_slots_per_month / avg_allocation)::integer else 0 end)
     from public.get_service_capacity()),
  true, 'nor the before-swaps ceiling');

select test_util.assert_eq(
  (select bool_and(room_for_customers = greatest(sustainable_customers - active_customers, 0))
     from public.get_service_capacity()),
  true, 'nor the room left to sell');

select test_util.assert_eq(
  (select bool_and(avg_allocation_with_swaps >= avg_allocation)
     from public.get_service_capacity()),
  true, 'the swap-inflated divisor is unchanged by the exposure figure');

-- ---------------------------------------------------------------------------
-- 7 — The daily series
--
-- ⚠️ The `on conflict ... do update` list is the one that gets forgotten, and
-- forgetting it fails silently: the day's first capture writes the new columns
-- and every same-day re-run leaves them stale. The escalation cron does re-run.
-- ---------------------------------------------------------------------------
select public.capture_service_capacity();
select test_util.assert_eq(
  (select swaps_available_now from public.service_capacity_snapshots
    where lead_type = 'management' and captured_on = current_date),
  4, 'the daily capture writes the exposure count');
select test_util.assert_eq(
  (select swap_slots_now from public.service_capacity_snapshots
    where lead_type = 'management' and captured_on = current_date),
  12.0::numeric, 'and the slots beside it');

update public.customers set quality_claims_this_cycle = 2
 where id = 'c0000000-0000-0000-0000-00000000000a';
select public.capture_service_capacity();
select test_util.assert_eq(
  (select swaps_available_now from public.service_capacity_snapshots
    where lead_type = 'management' and captured_on = current_date),
  2, 'a same-day re-run refreshes it rather than leaving it stale');
update public.customers set quality_claims_this_cycle = 0
 where id = 'c0000000-0000-0000-0000-00000000000a';

-- ---------------------------------------------------------------------------
-- 8 — The real flow, end to end
--
-- A customer swap spends the entitlement AND consumes the claimable
-- assignment, so the exposure must fall by one — and 0145's withdrawal cost
-- must still be recorded on the lead that went.
-- ---------------------------------------------------------------------------
select test_util.assert_eq(test_util.swaps('management'), 4, 'exposure before the swap');

select count(*)::integer from public.customer_swap_dead_lead(
  'a5510000-0000-0000-0000-00000000b001',
  'c0000000-0000-0000-0000-00000000000b',
  '1ead0000-0000-0000-0000-00000000f001',
  'already_with_operator',
  'The landlord had already signed with another agent last week.',
  current_date,
  1, 0, 0, false, 7);

select test_util.assert_eq(test_util.swaps('management'), 3,
  'a real self-swap spends the entitlement and removes the exposure with it');

select test_util.assert_eq(
  (select withdrawn_slots from public.leads
    where id = '1ead0000-0000-0000-0000-00000000b001'),
  3, '0145 still records what the withdrawal cost');

select test_util.assert_eq(
  (select bool_and(serviceable_slots_per_month = round(slots_per_month + recycled_slots_per_month, 1))
     from public.get_service_capacity()),
  true, 'and the ceilings still carry no exposure term afterwards');

-- ---------------------------------------------------------------------------
-- 9 — ⚠️ THE DROP DISCARDED THE ACL (§11), so the grants are re-asserted
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  has_function_privilege('service_role', 'public.get_service_capacity()', 'execute'),
  true, 'get_service_capacity is executable by service_role');
select test_util.assert_eq(
  has_function_privilege('anon', 'public.get_service_capacity()', 'execute'),
  false, 'and NOT by anon — 0140 dropped a whole function for that');
select test_util.assert_eq(
  has_function_privilege('authenticated', 'public.get_service_capacity()', 'execute'),
  false, 'nor by authenticated');
select test_util.assert_eq(
  has_function_privilege('service_role', 'public.capture_service_capacity()', 'execute'),
  true, 'capture_service_capacity is executable by service_role');
select test_util.assert_eq(
  has_function_privilege('anon', 'public.capture_service_capacity()', 'execute'),
  false, 'and not by anon');

-- Invariant 7: the four that must stay authenticated-executable.
select test_util.assert_eq(
  has_function_privilege('authenticated', 'public.get_engagement_benchmarks()', 'execute'),
  true, 'invariant 7 — get_engagement_benchmarks');
select test_util.assert_eq(
  has_function_privilege('authenticated', 'public.set_management_customer_goal(integer)', 'execute'),
  true, 'invariant 7 — set_management_customer_goal');
select test_util.assert_eq(
  has_function_privilege('authenticated', 'public.get_operator_proof()', 'execute'),
  true, 'invariant 7 — get_operator_proof');
select test_util.assert_eq(
  has_function_privilege('authenticated', 'public.get_recent_wins_anonymised(integer)', 'execute'),
  true, 'invariant 7 — get_recent_wins_anonymised');

\o
select 'ALL 0147 ASSERTIONS PASSED' as result;
