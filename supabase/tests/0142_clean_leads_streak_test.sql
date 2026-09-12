-- ============================================================================
-- Behavioural tests for 0142 — clean_leads_streak actually counts (§53.2).
--
-- The column has existed since 0137 and nothing has ever incremented it, so
-- earnedBonus() has returned zero for every customer since the day it shipped.
-- These assertions are about the boundary: which deliveries count as restraint,
-- which do not, and that a claim still wipes the run.
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
   gr_monthly_allocation, gr_lead_balance, billing_cycle_anchor,
   quality_allowance_pct, quality_claims_this_cycle, clean_leads_streak,
   account_status, subscription_status, gr_subscription_status)
values
  ('11111111-1111-1111-1111-111111111111','Alpha','A','a@x.com',20,50,20,50,current_date,
   0.10,0,0,'active','active','active');

insert into public.leads (id, monday_item_id, lead_name, postcode_area, bedrooms,
                          max_assignments, assignment_count)
select ('eeee0000-0000-0000-0000-0000000000' || lpad(i::text,2,'0'))::uuid,
       'm-streak-'||i, 'Landlord '||i, 'BS', '3', 3, 0
from generate_series(1,12) i;

insert into public.leads (id, monday_item_id, lead_name, lead_type, postcode_area,
                          bedrooms, max_assignments, assignment_count)
values ('ffff0000-0000-0000-0000-000000000001','g-streak-1','GR Landlord',
        'guaranteed_rent','BS','3',3,0);

-- ---------------------------------------------------------------------------
-- 1 — The ordinary money path counts
-- ---------------------------------------------------------------------------
select public.assign_lead_to_customer(
  'eeee0000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',15.00);
select test_util.assert_eq(
  (select clean_leads_streak from public.customers where id='11111111-1111-1111-1111-111111111111'),
  1, 'assign_lead_to_customer increments the streak');

-- ⚠️ The regression that matters most: the money path still moves money the
-- same way. 0142 adds one column to an existing UPDATE and must change nothing
-- else about the single money path (invariant 1).
select test_util.assert_eq(
  (select lead_balance from public.customers where id='11111111-1111-1111-1111-111111111111'),
  49, 'it still spends exactly one credit');
select test_util.assert_eq(
  (select leads_received_this_month from public.customers where id='11111111-1111-1111-1111-111111111111'),
  1, 'it still bumps the monthly counter');
select test_util.assert_eq(
  (select management_lifetime_leads_received from public.customers where id='11111111-1111-1111-1111-111111111111'),
  1, 'it still bumps the odometer');

-- ---------------------------------------------------------------------------
-- 2 — One counter, both products (§51.3: one budget spans both)
-- ---------------------------------------------------------------------------
select public.assign_lead_to_customer(
  'ffff0000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
  15.00,'guaranteed_rent');
select test_util.assert_eq(
  (select clean_leads_streak from public.customers where id='11111111-1111-1111-1111-111111111111'),
  2, 'a GR delivery increments the SAME streak — one budget spans both products');
select test_util.assert_eq(
  (select gr_lead_balance from public.customers where id='11111111-1111-1111-1111-111111111111'),
  49, 'the GR branch still spends a GR credit');
select test_util.assert_eq(
  (select lead_balance from public.customers where id='11111111-1111-1111-1111-111111111111'),
  49, 'a GR delivery leaves the management balance alone (invariant 6)');

-- ---------------------------------------------------------------------------
-- 3 — An admin override counts too
--
-- §18C: a force-assign paces identically to an automatic one, and it still
-- delivers a workable, reportable lead.
-- ---------------------------------------------------------------------------
select public.admin_assign_lead(
  'eeee0000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111',15.00);
select test_util.assert_eq(
  (select clean_leads_streak from public.customers where id='11111111-1111-1111-1111-111111111111'),
  3, 'admin_assign_lead increments the streak');

-- ---------------------------------------------------------------------------
-- 4 — ⚠️ A POOL CLAIM DOES NOT COUNT
--
-- The boundary this migration exists to draw. A pool-claimed lead can never be
-- reported (claimable_dead_lead_assignments bars claimed_from_pool_at), so
-- restraint was never on offer. Counting it would also open a farming route.
-- ---------------------------------------------------------------------------
update public.leads
  set pool_entered_at = now() - interval '1 day',
      pool_first_entered_at = now() - interval '1 day',
      pool_entry_basis = 'unassigned'
  where id = 'eeee0000-0000-0000-0000-000000000003';

select public.claim_pool_lead(
  'eeee0000-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111',15.00);
select test_util.assert_eq(
  (select clean_leads_streak from public.customers where id='11111111-1111-1111-1111-111111111111'),
  3, 'a pool claim does NOT increment the streak');
select test_util.assert_eq(
  (select count(*)::integer from public.lead_assignments
    where lead_id='eeee0000-0000-0000-0000-000000000003' and claimed_from_pool_at is not null),
  1, 'the pool claim did land — it is the streak that ignores it, not the claim');

-- ---------------------------------------------------------------------------
-- 5 — A customer's own uploaded lead does not count either
--
-- Excluded by construction: create_customer_leads calls neither assign path.
-- ---------------------------------------------------------------------------
select public.create_customer_leads(
  '11111111-1111-1111-1111-111111111111', 'management', 'manual',
  '[{"lead_name":"My Own Landlord","phone":"07700900123","email":"own@x.com"}]'::jsonb);
select test_util.assert_eq(
  (select clean_leads_streak from public.customers where id='11111111-1111-1111-1111-111111111111'),
  3, 'a customer-uploaded lead does not increment the streak');

-- ---------------------------------------------------------------------------
-- 6 — A claim wipes the run
-- ---------------------------------------------------------------------------
insert into public.lead_events (assignment_id, event_type)
select id, 'tel_click' from public.lead_assignments
 where lead_id = 'eeee0000-0000-0000-0000-000000000001';

select public.apply_dead_lead_claim(
  (select id from public.lead_assignments where lead_id='eeee0000-0000-0000-0000-000000000001'),
  '11111111-1111-1111-1111-111111111111',
  'unreachable','Rings out every time and the mailbox is full.',
  current_date - 1,'auto_uphold', true, 'none', 14);

select test_util.assert_eq(
  (select clean_leads_streak from public.customers where id='11111111-1111-1111-1111-111111111111'),
  0, 'an upheld claim resets the run to zero');

-- And it starts again from the next delivery.
select public.assign_lead_to_customer(
  'eeee0000-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111',15.00);
select test_util.assert_eq(
  (select clean_leads_streak from public.customers where id='11111111-1111-1111-1111-111111111111'),
  1, 'the run starts again from the next delivery');

\o
\echo '0142 BEHAVIOURAL TESTS PASSED'
