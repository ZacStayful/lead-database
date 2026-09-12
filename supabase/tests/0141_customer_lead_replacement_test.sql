-- ============================================================================
-- Behavioural tests for 0141 — a customer replaces their own dead lead (§53).
--
-- 0141 reverses two things this codebase argued for at length: §52.1's "a swap
-- is always manual", and §51.3's hidden allowance. Both reversals are product
-- decisions. What is NOT a decision is the money: a swap must move none, the
-- entitlement must actually stop somebody, and the claim must survive the swap
-- that fulfils it. Those are what this file holds down.
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

-- ---------------------------------------------------------------------------
-- Seed
--
-- Alpha holds a worked management lead and has an entitlement of 2
-- (20 x 0.10 = 2). Gamma is the GR mirror. Stock is kept comfortably above
-- replacement_stock_floor so the floor does not fire except where tested.
-- ---------------------------------------------------------------------------
delete from public.lead_outcome_reasons;
delete from public.lead_quality_claims;
delete from public.lead_events;
delete from public.lead_notes;
delete from public.lead_assignments;
delete from public.leads;
delete from public.customers;

insert into public.customers
  (id, business_name, contact_name, email, monthly_allocation, lead_balance,
   leads_received_this_month, billing_cycle_anchor, quality_allowance_pct,
   quality_claims_this_cycle, clean_leads_streak,
   account_status, subscription_status)
values
  ('11111111-1111-1111-1111-111111111111','Alpha','A','a@x.com',20,20,5,current_date,0.10,0,0,'active','active');

insert into public.customers
  (id, business_name, contact_name, email, gr_monthly_allocation, gr_lead_balance,
   lead_balance, gr_leads_received_this_month, gr_billing_cycle_anchor,
   quality_allowance_pct, quality_claims_this_cycle, clean_leads_streak,
   account_status, subscription_status, gr_subscription_status)
values
  ('33333333-3333-3333-3333-333333333333','Gamma','G','g@x.com',20,20,7,5,current_date,0.10,0,0,'waitlisted','inactive','active');

-- The reported lead, plus enough spare stock to clear the floor of 10.
insert into public.leads (id, monday_item_id, lead_name, postcode_area, bedrooms,
                          gross_annual_income, max_assignments, assignment_count)
select
  ('aaaa0000-0000-0000-0000-0000000000' || lpad(i::text, 2, '0'))::uuid,
  'm-rep-' || i, 'Landlord ' || i, 'BS', '3',
  30000 + (i * 1000), 3, case when i = 1 then 1 else 0 end
from generate_series(1, 30) i;

-- One lead far from the reported lead's gross, to prove the ordering.
update public.leads set gross_annual_income = 250000
  where id = 'aaaa0000-0000-0000-0000-000000000020';

-- The GR mirror, also above the floor.
insert into public.leads (id, monday_item_id, lead_name, lead_type, postcode_area,
                          bedrooms, max_assignments, assignment_count)
select
  ('cccc0000-0000-0000-0000-0000000000' || lpad(i::text, 2, '0'))::uuid,
  'g-rep-' || i, 'GR Landlord ' || i, 'guaranteed_rent', 'BS', '3', 3,
  case when i = 1 then 1 else 0 end
from generate_series(1, 20) i;

insert into public.lead_assignments (id, lead_id, customer_id, price_paid, assigned_at)
values
  ('bbbb0000-0000-0000-0000-000000000001','aaaa0000-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111', 15.00, now() - interval '2 days'),
  ('bbbb0000-0000-0000-0000-000000000003','cccc0000-0000-0000-0000-000000000001',
   '33333333-3333-3333-3333-333333333333', 15.00, now() - interval '2 days');

-- Worked: the effort gate wants operator-generated telemetry.
insert into public.lead_events (assignment_id, event_type)
values ('bbbb0000-0000-0000-0000-000000000001','tel_click'),
       ('bbbb0000-0000-0000-0000-000000000003','tel_click');

-- ---------------------------------------------------------------------------
-- 1 — The candidate list is redacted, capped, and ordered by closeness
-- ---------------------------------------------------------------------------

-- ⚠️ The returned shape carries no landlord name and no full postcode. A
-- customer browsing this list must not be able to harvest unsold stock.
do $$
declare v_cols text;
begin
  select string_agg(a.attname, ',' order by a.attnum)
    into v_cols
    from pg_proc p
    join unnest(p.proallargtypes, p.proargnames) with ordinality
         as a(atttypid, attname, attnum) on true
    where p.proname = 'get_customer_replacement_candidates'
      and p.pronamespace = 'public'::regnamespace;
  if v_cols like '%lead_name%' or v_cols like '%,postcode,%' or v_cols like '%email%'
     or v_cols like '%phone%' then
    raise exception 'FAIL candidate shape leaks contact detail: %', v_cols;
  end if;
  raise notice 'ok  candidate shape carries no landlord name, postcode, email or phone';
end $$;

-- ⚠️ THE SHAPE CHECK ABOVE IS NOT ENOUGH ON ITS OWN, and finding that out is
-- why this second one exists. It reads output column NAMES, so aliasing
-- `l.lead_name as postcode_area` sails straight past it — which a mutation run
-- proved. §50.9 records two assertions in this repo already written weak enough
-- to survive the mutation they existed to catch. This one reads the function
-- BODY, so a leak cannot be disguised by renaming it.
do $$
declare v_src text; v_bad text;
begin
  select p.prosrc into v_src from pg_proc p
    where p.proname = 'get_customer_replacement_candidates'
      and p.pronamespace = 'public'::regnamespace;
  -- Whole column names only: postcode_area is fine and contains "postcode".
  foreach v_bad in array array['lead_name','postcode','email','phone','lead_profile'] loop
    if v_src ~ ('l\.' || v_bad || '\M') then
      raise exception 'FAIL candidate function body selects l.%', v_bad;
    end if;
  end loop;
  raise notice 'ok  candidate function body reads no landlord-identifying column';
end $$;

-- Capped in SQL however large a limit the caller asks for.
select test_util.assert_eq(
  (select count(*)::integer from public.get_customer_replacement_candidates(
     'bbbb0000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111', 500)),
  20, 'p_limit of 500 is capped at 20 in SQL');

-- Closest in gross income first. The reported lead is 31000; 32000 is nearest.
select test_util.assert_eq(
  (select c.id from public.get_customer_replacement_candidates(
     'bbbb0000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111', 5) c
   limit 1),
  'aaaa0000-0000-0000-0000-000000000002'::uuid,
  'candidates are ordered by closeness in gross income');

-- Another customer's assignment id returns nothing, not their stock.
select test_util.assert_eq(
  (select count(*)::integer from public.get_customer_replacement_candidates(
     'bbbb0000-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333', 20)),
  0, 'a cross-customer assignment id returns zero rows');

-- A retired lead is never offered. lead_retired_from_allocation is the single
-- expression of this (invariant 11) — 0109's picker checks none of it.
update public.leads set lead_quality_status = 'failed'
  where id = 'aaaa0000-0000-0000-0000-000000000002';
select test_util.assert_eq(
  (select count(*)::integer from public.get_customer_replacement_candidates(
     'bbbb0000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111', 20)
   where id = 'aaaa0000-0000-0000-0000-000000000002'),
  0, 'a quality-blocked lead is not offered as a replacement');
update public.leads set lead_quality_status = 'pending'
  where id = 'aaaa0000-0000-0000-0000-000000000002';

-- An owned lead is never offered in either direction.
update public.leads set owner_customer_id = '33333333-3333-3333-3333-333333333333',
                        owner_source = 'manual'
  where id = 'aaaa0000-0000-0000-0000-000000000003';
select test_util.assert_eq(
  (select count(*)::integer from public.get_customer_replacement_candidates(
     'bbbb0000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111', 20)
   where id = 'aaaa0000-0000-0000-0000-000000000003'),
  0, 'a customer-owned lead is not offered as a replacement');
update public.leads set owner_customer_id = null, owner_source = null
  where id = 'aaaa0000-0000-0000-0000-000000000003';

-- ---------------------------------------------------------------------------
-- 2 — A SWAP MOVES NO MONEY, and the claim survives it
--
-- The most important block in this file. §52.1 and §53 both rest on a swap
-- costing the customer nothing and giving them nothing back but a different
-- lead — and 0139's own headline lesson is that the swap DELETES the
-- assignment, so the claim has to be built to outlive it.
-- ---------------------------------------------------------------------------

create temp table before_swap as
  select lead_balance, gr_lead_balance, leads_received_this_month,
         management_lifetime_leads_received, pool_debit, quality_claims_this_cycle
  from public.customers where id = '11111111-1111-1111-1111-111111111111';

select public.customer_swap_dead_lead(
  'bbbb0000-0000-0000-0000-000000000001',
  '11111111-1111-1111-1111-111111111111',
  'aaaa0000-0000-0000-0000-000000000002',
  'already_with_operator',
  'They told me they signed with another operator last week.',
  current_date - 1,
  2, 0, 0, false, 7
);

select test_util.assert_eq(
  (select lead_balance from public.customers where id='11111111-1111-1111-1111-111111111111'),
  (select lead_balance from before_swap),
  'a swap does not touch lead_balance');

select test_util.assert_eq(
  (select leads_received_this_month from public.customers where id='11111111-1111-1111-1111-111111111111'),
  (select leads_received_this_month from before_swap),
  'a swap does not roll back the monthly counter');

select test_util.assert_eq(
  (select management_lifetime_leads_received from public.customers where id='11111111-1111-1111-1111-111111111111'),
  (select management_lifetime_leads_received from before_swap),
  'a swap does not move the odometer (invariant 9)');

select test_util.assert_eq(
  (select pool_debit from public.customers where id='11111111-1111-1111-1111-111111111111'),
  (select pool_debit from before_swap),
  'a swap does not touch the pool debit (invariant 12)');

select test_util.assert_eq(
  (select quality_claims_this_cycle from public.customers where id='11111111-1111-1111-1111-111111111111'),
  1, 'a swap spends exactly one of the entitlement');

-- ⚠️ The claim outlives the swap that fulfilled it. This is 0139's lesson: the
-- assignment is deleted, the FK nulls the pointer, and origin_assignment_id —
-- trigger-derived, no FK, unique — is what still names where it came from.
select test_util.assert_eq(
  (select count(*)::integer from public.lead_assignments
    where id = 'bbbb0000-0000-0000-0000-000000000001'),
  0, 'the reported assignment is deleted by the swap');

select test_util.assert_eq(
  (select detail from public.lead_quality_claims
    where origin_assignment_id = 'bbbb0000-0000-0000-0000-000000000001'),
  'They told me they signed with another operator last week.',
  'the claim survives the swap with the landlord''s own words intact');

select test_util.assert_eq(
  (select lead_assignment_id from public.lead_quality_claims
    where origin_assignment_id = 'bbbb0000-0000-0000-0000-000000000001'),
  null::uuid, 'the claim''s assignment pointer is nulled, not cascaded away');

select test_util.assert_eq(
  (select resolution from public.lead_quality_claims
    where origin_assignment_id = 'bbbb0000-0000-0000-0000-000000000001'),
  'self_swap', 'a customer swap records self_swap, never swap (0139''s invariant)');

select test_util.assert_eq(
  (select count(*)::integer from public.lead_assignments
    where lead_id = 'aaaa0000-0000-0000-0000-000000000002'
      and customer_id = '11111111-1111-1111-1111-111111111111'),
  1, 'the replacement assignment exists');

select test_util.assert_eq(
  (select price_paid from public.lead_assignments
    where lead_id = 'aaaa0000-0000-0000-0000-000000000002'
      and customer_id = '11111111-1111-1111-1111-111111111111'),
  15.00::numeric, 'the replacement carries the same price_paid');

-- The reported lead is withdrawn from circulation, which is what makes a swap
-- cost two leads rather than one (§52.1's arithmetic).
select test_util.assert_eq(
  (select withdrawn_at is not null from public.leads
    where id = 'aaaa0000-0000-0000-0000-000000000001'),
  true, 'the reported lead is withdrawn from circulation');

-- ---------------------------------------------------------------------------
-- 3 — The entitlement actually stops somebody
--
-- This is the half that makes publishing the number honest. If it did not
-- refuse, the screen would be advertising a limit that is not one.
-- ---------------------------------------------------------------------------

-- Seed a second worked assignment for Alpha.
insert into public.lead_assignments (id, lead_id, customer_id, price_paid, assigned_at)
values ('bbbb0000-0000-0000-0000-000000000004','aaaa0000-0000-0000-0000-000000000004',
        '11111111-1111-1111-1111-111111111111', 15.00, now() - interval '2 days');
update public.leads set assignment_count = 1 where id = 'aaaa0000-0000-0000-0000-000000000004';
insert into public.lead_events (assignment_id, event_type)
values ('bbbb0000-0000-0000-0000-000000000004','tel_click');

-- Second swap: still inside an entitlement of 2, with the counter now at 1.
select public.customer_swap_dead_lead(
  'bbbb0000-0000-0000-0000-000000000004',
  '11111111-1111-1111-1111-111111111111',
  'aaaa0000-0000-0000-0000-000000000005',
  'unreachable', 'Number rings out every time, mailbox is full.',
  current_date - 1, 2, 1, 0, false, 14
);
select test_util.assert_eq(
  (select quality_claims_this_cycle from public.customers where id='11111111-1111-1111-1111-111111111111'),
  2, 'two swaps in a cycle both land while inside the entitlement');

-- A third, now at the entitlement, must be refused AND write nothing.
insert into public.lead_assignments (id, lead_id, customer_id, price_paid, assigned_at)
values ('bbbb0000-0000-0000-0000-000000000006','aaaa0000-0000-0000-0000-000000000006',
        '11111111-1111-1111-1111-111111111111', 15.00, now() - interval '2 days');
update public.leads set assignment_count = 1 where id = 'aaaa0000-0000-0000-0000-000000000006';
insert into public.lead_events (assignment_id, event_type)
values ('bbbb0000-0000-0000-0000-000000000006','tel_click');

select test_util.assert_raises($q$
  select public.customer_swap_dead_lead(
    'bbbb0000-0000-0000-0000-000000000006','11111111-1111-1111-1111-111111111111',
    'aaaa0000-0000-0000-0000-000000000007','unreachable',
    'Another one that never answers the phone at all.',
    current_date - 1, 2, 2, 0, false, 14)
$q$, 'a swap at the entitlement is refused');

select test_util.assert_eq(
  (select count(*)::integer from public.lead_assignments
    where id = 'bbbb0000-0000-0000-0000-000000000006'),
  1, 'a refused swap leaves the assignment standing');

select test_util.assert_eq(
  (select count(*)::integer from public.lead_quality_claims
    where origin_assignment_id = 'bbbb0000-0000-0000-0000-000000000006'),
  0, 'a refused swap writes no claim');

select test_util.assert_eq(
  (select quality_claims_this_cycle from public.customers where id='11111111-1111-1111-1111-111111111111'),
  2, 'a refused swap does not move the counter');

-- ⚠️ THE COMPARE-AND-SWAP TESTS THE STREAK TOO. A caller whose entitlement was
-- computed from a streak that has since been spent must be refused, or two
-- concurrent swaps both pass on a budget the first destroyed.
update public.customers set quality_claims_this_cycle = 0, clean_leads_streak = 20
  where id = '11111111-1111-1111-1111-111111111111';
select test_util.assert_raises($q$
  select public.customer_swap_dead_lead(
    'bbbb0000-0000-0000-0000-000000000006','11111111-1111-1111-1111-111111111111',
    'aaaa0000-0000-0000-0000-000000000007','unreachable',
    'Another one that never answers the phone at all.',
    current_date - 1, 4, 0, 0, false, 14)
$q$, 'a stale streak is refused even when the counter still fits');
update public.customers set clean_leads_streak = 0
  where id = '11111111-1111-1111-1111-111111111111';

-- ---------------------------------------------------------------------------
-- 4 — The stock floor is the back-pressure the capacity panel cannot apply
-- ---------------------------------------------------------------------------
update public.system_settings set value = '999' where key = 'replacement_stock_floor';
select test_util.assert_raises($q$
  select public.customer_swap_dead_lead(
    'bbbb0000-0000-0000-0000-000000000006','11111111-1111-1111-1111-111111111111',
    'aaaa0000-0000-0000-0000-000000000007','unreachable',
    'Another one that never answers the phone at all.',
    current_date - 1, 4, 0, 0, false, 14)
$q$, 'a swap is refused when unsold stock is below the floor');
update public.system_settings set value = '10' where key = 'replacement_stock_floor';

-- ---------------------------------------------------------------------------
-- 5 — Guaranteed rent reads gr_ and only gr_ (invariant 6)
-- ---------------------------------------------------------------------------
select public.customer_swap_dead_lead(
  'bbbb0000-0000-0000-0000-000000000003','33333333-3333-3333-3333-333333333333',
  'cccc0000-0000-0000-0000-000000000002','property_sold',
  'The landlord has accepted an offer and is selling the flat.',
  current_date - 1, 2, 0, 0, false, 14
);
select test_util.assert_eq(
  (select gr_lead_balance from public.customers where id='33333333-3333-3333-3333-333333333333'),
  20, 'a GR swap does not touch gr_lead_balance');
select test_util.assert_eq(
  (select lead_balance from public.customers where id='33333333-3333-3333-3333-333333333333'),
  7, 'a GR swap does not touch the management balance (invariant 6)');
select test_util.assert_eq(
  (select count(*)::integer from public.lead_assignments
    where lead_id = 'cccc0000-0000-0000-0000-000000000002'
      and customer_id = '33333333-3333-3333-3333-333333333333'),
  1, 'the GR replacement assignment exists');

-- ---------------------------------------------------------------------------
-- 5A — The customer's own filter is honoured, and departing from it is explicit
--
-- §34 refuses an off-filter swap unless p_allow_filter_mismatch is passed true.
-- The customer picker ranks matches first and offers the rest behind a tick —
-- so the flag must be genuinely required, not inferred.
-- ---------------------------------------------------------------------------

insert into public.lead_assignments (id, lead_id, customer_id, price_paid, assigned_at)
values ('bbbb0000-0000-0000-0000-000000000008','aaaa0000-0000-0000-0000-000000000008',
        '11111111-1111-1111-1111-111111111111', 15.00, now() - interval '2 days');
update public.leads set assignment_count = 1 where id = 'aaaa0000-0000-0000-0000-000000000008';
insert into public.lead_events (assignment_id, event_type)
values ('bbbb0000-0000-0000-0000-000000000008','tel_click');

-- Alpha now wants GL only, and every replacement in stock is BS.
update public.customers
  set filter_status = 'active', filter_areas = array['GL'], quality_claims_this_cycle = 0
  where id = '11111111-1111-1111-1111-111111111111';

select test_util.assert_eq(
  (select count(*)::integer from public.get_customer_replacement_candidates(
     'bbbb0000-0000-0000-0000-000000000008','11111111-1111-1111-1111-111111111111', 20)
   where matches_filter),
  0, 'a filtered customer with no matching stock sees zero MATCHING candidates');

select test_util.assert_eq(
  (select bool_or(not matches_filter) from public.get_customer_replacement_candidates(
     'bbbb0000-0000-0000-0000-000000000008','11111111-1111-1111-1111-111111111111', 20)),
  true, 'off-filter leads are still offered, labelled — never an empty picker');

select test_util.assert_raises($q$
  select public.customer_swap_dead_lead(
    'bbbb0000-0000-0000-0000-000000000008','11111111-1111-1111-1111-111111111111',
    'aaaa0000-0000-0000-0000-000000000009','unreachable',
    'Rings out every time and the mailbox is always full.',
    current_date - 1, 2, 0, 0, false, 14)
$q$, 'an off-filter replacement is refused without the explicit flag');

select public.customer_swap_dead_lead(
  'bbbb0000-0000-0000-0000-000000000008','11111111-1111-1111-1111-111111111111',
  'aaaa0000-0000-0000-0000-000000000009','unreachable',
  'Rings out every time and the mailbox is always full.',
  current_date - 1, 2, 0, 0, true, 14);
select test_util.assert_eq(
  (select count(*)::integer from public.lead_assignments
    where lead_id = 'aaaa0000-0000-0000-0000-000000000009'
      and customer_id = '11111111-1111-1111-1111-111111111111'),
  1, 'the same off-filter replacement lands once the flag is passed');

update public.customers
  set filter_status = 'off', filter_areas = null
  where id = '11111111-1111-1111-1111-111111111111';

-- ---------------------------------------------------------------------------
-- 6 — reset_monthly_counts: ONE reset a month, not two
--
-- ⚠️ The trap this guards. quality_claims_this_cycle is ONE budget spanning
-- both products (§51.3). Adding it to the GR branch as well as the management
-- one would zero a dual-product customer's counter on TWO anchor days a month
-- and silently double their entitlement.
-- ---------------------------------------------------------------------------

-- A customer holding both, with the two anchors on DIFFERENT days.
insert into public.customers
  (id, business_name, contact_name, email, monthly_allocation, gr_monthly_allocation,
   lead_balance, gr_lead_balance, billing_cycle_anchor, gr_billing_cycle_anchor,
   quality_claims_this_cycle, account_status, subscription_status, gr_subscription_status)
values
  ('44444444-4444-4444-4444-444444444444','Delta','D','d@x.com',20,20,20,20,
   current_date, current_date - interval '1 day', 2,
   'active','active','active');

select public.reset_monthly_counts();
select test_util.assert_eq(
  (select quality_claims_this_cycle from public.customers where id='44444444-4444-4444-4444-444444444444'),
  0, 'the claim counter resets on the management anchor for a dual-product customer');

-- Put it back, and roll the clock to the GR anchor day. It must NOT reset again.
update public.customers
  set quality_claims_this_cycle = 2,
      billing_cycle_anchor    = current_date + interval '1 day',
      gr_billing_cycle_anchor = current_date
  where id = '44444444-4444-4444-4444-444444444444';
select public.reset_monthly_counts();
select test_util.assert_eq(
  (select quality_claims_this_cycle from public.customers where id='44444444-4444-4444-4444-444444444444'),
  2, 'the claim counter does NOT reset again on the GR anchor — one budget, one anchor');

-- A GR-only customer still resets, on the GR anchor rather than their signup day.
update public.customers
  set quality_claims_this_cycle = 2, gr_billing_cycle_anchor = current_date
  where id = '33333333-3333-3333-3333-333333333333';
select public.reset_monthly_counts();
select test_util.assert_eq(
  (select quality_claims_this_cycle from public.customers where id='33333333-3333-3333-3333-333333333333'),
  0, 'a GR-only customer''s claim counter resets on their GR anchor');

-- ---------------------------------------------------------------------------
-- 7 — Capacity: replacement demand is inside the ceiling, and reported beside it
-- ---------------------------------------------------------------------------

select test_util.assert_eq(
  (select count(*)::integer from public.get_service_capacity()
    where quality_claim_demand_per_month is not null
      and avg_allocation_with_swaps is not null
      and sustainable_customers_before_swaps is not null),
  2, 'every product row carries the three new figures');

-- ⚠️ The inflated divisor must lower the ceiling, or the whole change is inert.
select test_util.assert_eq(
  (select bool_and(sustainable_customers <= sustainable_customers_before_swaps)
     from public.get_service_capacity()),
  true, 'the swap-inflated divisor can only lower the ceiling, never raise it');

-- ⚠️ new_only shares the inflated divisor. §18.1 says the gap between the two
-- ceilings is exactly the recycling dependency — that is only true while the
-- NUMERATOR is the sole difference between them.
select test_util.assert_eq(
  (select bool_and(sustainable_customers_new_only <= sustainable_customers)
     from public.get_service_capacity()),
  true, 'new_only stays at or below the headline, sharing its divisor');

select test_util.assert_eq(
  (select bool_and(avg_allocation_with_swaps >= avg_allocation)
     from public.get_service_capacity()),
  true, 'the swap-inflated average allocation is never below the plain one');

-- The snapshot writer carries the three through, on a re-run as well as a first
-- write. The on-conflict list is the one that gets forgotten and fails silently.
select public.capture_service_capacity();
update public.service_capacity_snapshots
  set quality_claim_demand_per_month = null, sustainable_customers_before_swaps = null
  where captured_on = current_date;
select public.capture_service_capacity();
select test_util.assert_eq(
  (select count(*)::integer from public.service_capacity_snapshots
    where captured_on = current_date
      and quality_claim_demand_per_month is not null
      and sustainable_customers_before_swaps is not null),
  2, 'a same-day re-run refreshes the new columns (the on-conflict list is complete)');

-- ---------------------------------------------------------------------------
-- 8 — Regression: ordinary allocation is untouched
-- ---------------------------------------------------------------------------
insert into public.leads (id, monday_item_id, lead_name, postcode_area, bedrooms,
                          max_assignments, assignment_count)
values ('dddd0000-0000-0000-0000-000000000001','m-reg-1','Regression Landlord','BS','3',3,0);

select test_util.assert_eq(
  public.lead_retired_from_allocation('dddd0000-0000-0000-0000-000000000001'),
  false, 'a marketplace lead is still not retired from allocation');

create temp table before_alloc as
  select lead_balance, leads_received_this_month
  from public.customers where id = '11111111-1111-1111-1111-111111111111';

select public.assign_lead_to_customer(
  'dddd0000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',15.00);

select test_util.assert_eq(
  (select lead_balance from public.customers where id='11111111-1111-1111-1111-111111111111'),
  (select lead_balance - 1 from before_alloc),
  'ordinary allocation still spends exactly one credit');

-- ---------------------------------------------------------------------------
-- 9 — Invariant 7
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select count(*)::integer from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('get_customer_replacement_candidates','customer_swap_dead_lead',
                        'get_service_capacity','capture_service_capacity')
      and (has_function_privilege('anon', p.oid, 'execute')
        or has_function_privilege('authenticated', p.oid, 'execute'))),
  0, 'anon and authenticated hold zero execute grants on any 0141 function');

\o
\echo '0141 BEHAVIOURAL TESTS PASSED'
