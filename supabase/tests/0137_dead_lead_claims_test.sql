-- ============================================================================
-- Behavioural tests for 0137 — dead-lead quality claims (CLAUDE.md §51).
--
-- These exist because 0137 amends invariant 4. Every assertion below is about
-- money: one credit per upheld claim, never two, never for a lead that was not
-- worked, and never at the cost of reopening a slot somebody rejected.
--
-- Run against a scratch Postgres with every migration applied. See README.md.
-- ============================================================================
\set ON_ERROR_STOP on
\pset pager off
-- Assertions report through NOTICE (stderr); the result rows are noise.
\o /dev/null

-- The helper lives in its own schema so it never lands in public.
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
-- Seed: three operators on one lead, all in credit.
-- ---------------------------------------------------------------------------
delete from public.lead_quality_claims;
delete from public.lead_events;
delete from public.lead_assignments;
delete from public.leads;
delete from public.customers;

insert into public.customers
  (id, business_name, contact_name, email, monthly_allocation, lead_balance,
   leads_received_this_month, billing_cycle_anchor, quality_allowance_pct)
values
  ('11111111-1111-1111-1111-111111111111','Alpha','A','a@x.com',20,20,3,current_date,0.10),
  ('22222222-2222-2222-2222-222222222222','Beta','B','b@x.com',20,20,3,current_date,0.10),
  ('33333333-3333-3333-3333-333333333333','Gamma','C','c@x.com',20,20,3,current_date,0.10);

insert into public.leads (id, monday_item_id, lead_name)
values ('aaaa0000-0000-0000-0000-000000000001','m-dead-1','Landlord One');

insert into public.lead_assignments (id, lead_id, customer_id, price_paid, assigned_at)
values
  ('bbbb0000-0000-0000-0000-000000000001','aaaa0000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',15.00, now() - interval '2 days'),
  ('bbbb0000-0000-0000-0000-000000000002','aaaa0000-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222',15.00, now() - interval '2 days'),
  ('bbbb0000-0000-0000-0000-000000000003','aaaa0000-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333',15.00, now() - interval '2 days');

-- ---------------------------------------------------------------------------
-- 1 — The effort gate. This is what separates §51 from a refund on
--     worked-for value, so it gets the most assertions.
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select count(*)::int from public.claimable_dead_lead_assignments('11111111-1111-1111-1111-111111111111')),
  0, 'a lead with no engagement events is NOT claimable');

-- nudge_sent is system-generated (CLAUDE.md §3) and must not qualify anyone.
insert into public.lead_events (assignment_id, event_type)
values ('bbbb0000-0000-0000-0000-000000000001','nudge_sent');
select test_util.assert_eq(
  (select count(*)::int from public.claimable_dead_lead_assignments('11111111-1111-1111-1111-111111111111')),
  0, 'nudge_sent alone does NOT qualify a lead — it is something we did, not them');

-- A real operator action does.
insert into public.lead_events (assignment_id, event_type)
values ('bbbb0000-0000-0000-0000-000000000001','tel_click');
select test_util.assert_eq(
  (select count(*)::int from public.claimable_dead_lead_assignments('11111111-1111-1111-1111-111111111111')),
  1, 'an operator tel_click makes the lead claimable');

-- ---------------------------------------------------------------------------
-- 2 — The window.
-- ---------------------------------------------------------------------------
update public.lead_assignments set assigned_at = now() - interval '40 days'
  where id = 'bbbb0000-0000-0000-0000-000000000001';
select test_util.assert_eq(
  (select count(*)::int from public.claimable_dead_lead_assignments('11111111-1111-1111-1111-111111111111', 14)),
  0, 'outside the claim window it is not claimable');
update public.lead_assignments set assigned_at = now() - interval '2 days'
  where id = 'bbbb0000-0000-0000-0000-000000000001';

-- ---------------------------------------------------------------------------
-- 3 — Bars carried over from existing rules.
-- ---------------------------------------------------------------------------
update public.lead_assignments set status = 'won'
  where id = 'bbbb0000-0000-0000-0000-000000000001';
select test_util.assert_eq(
  (select count(*)::int from public.claimable_dead_lead_assignments('11111111-1111-1111-1111-111111111111')),
  0, 'a won lead cannot also have been dead on arrival');
update public.lead_assignments set status = 'contacted'
  where id = 'bbbb0000-0000-0000-0000-000000000001';

-- Invariant 11 / §19.6: a pool claim is not sold supply.
update public.lead_assignments set claimed_from_pool_at = now()
  where id = 'bbbb0000-0000-0000-0000-000000000001';
select test_util.assert_eq(
  (select count(*)::int from public.claimable_dead_lead_assignments('11111111-1111-1111-1111-111111111111')),
  0, 'a lead claimed from the pool is not claimable');
update public.lead_assignments set claimed_from_pool_at = null
  where id = 'bbbb0000-0000-0000-0000-000000000001';

-- ---------------------------------------------------------------------------
-- 4 — An upheld claim: exactly one credit back, and the slot NOT reopened.
-- ---------------------------------------------------------------------------
update public.customers set clean_leads_streak = 17
  where id = '11111111-1111-1111-1111-111111111111';

select public.apply_dead_lead_claim(
  'bbbb0000-0000-0000-0000-000000000001',
  '11111111-1111-1111-1111-111111111111',
  'already_with_operator',
  'They told me they signed with another agent a fortnight ago.',
  current_date, 'auto_uphold', true, 'none');

select test_util.assert_eq(lead_balance, 21, 'an upheld claim restores exactly one credit'),
       test_util.assert_eq(leads_received_this_month, 2, 'and rolls back the monthly counter'),
       test_util.assert_eq(quality_claims_this_cycle, 1, 'and spends one of the hidden allowance'),
       test_util.assert_eq(clean_leads_streak, 0, 'and resets the clean streak')
from public.customers where id = '11111111-1111-1111-1111-111111111111';

select test_util.assert_eq(assignment_count, 0, 'the claimed slot is NOT reopened (§19.6)')
from public.leads where id = 'aaaa0000-0000-0000-0000-000000000001';

select test_util.assert_eq(resolution, 'credit', 'the claim settles as a credit, never a replacement')
from public.lead_quality_claims where lead_assignment_id = 'bbbb0000-0000-0000-0000-000000000001';

-- ---------------------------------------------------------------------------
-- 5 — No double refund, by construction.
-- ---------------------------------------------------------------------------
select test_util.assert_raises($q$
  select public.apply_dead_lead_claim(
    'bbbb0000-0000-0000-0000-000000000001',
    '11111111-1111-1111-1111-111111111111',
    'already_with_operator', 'Trying the very same claim a second time over.',
    current_date, 'auto_uphold', true, 'none')
$q$, 'a second claim on the same assignment is refused');

select test_util.assert_eq(lead_balance, 21, 'and the balance is unchanged by the attempt')
from public.customers where id = '11111111-1111-1111-1111-111111111111';

select test_util.assert_eq(count(*)::int, 1, 'exactly one claim row exists')
from public.lead_quality_claims
where lead_assignment_id = 'bbbb0000-0000-0000-0000-000000000001';

-- ---------------------------------------------------------------------------
-- 6 — The detail is the whole basis for tracing a dead lead. Enforce it.
-- ---------------------------------------------------------------------------
insert into public.lead_events (assignment_id, event_type)
values ('bbbb0000-0000-0000-0000-000000000002','detail_opened');

select test_util.assert_raises($q$
  select public.apply_dead_lead_claim(
    'bbbb0000-0000-0000-0000-000000000002',
    '22222222-2222-2222-2222-222222222222',
    'no_longer_interested', 'gone', current_date, 'auto_uphold', true, 'none')
$q$, 'a claim with no real detail is refused');

-- ---------------------------------------------------------------------------
-- 7 — Review, and a decision that applies exactly once.
-- ---------------------------------------------------------------------------
select claim_id from public.apply_dead_lead_claim(
  'bbbb0000-0000-0000-0000-000000000002',
  '22222222-2222-2222-2222-222222222222',
  'no_longer_interested',
  'Landlord has taken the property off the market entirely for now.',
  current_date, 'review', false, 'none') \gset rev_

select test_util.assert_eq(status, 'under_review', 'an over-budget claim waits for a human')
from public.lead_quality_claims where id = :'rev_claim_id'::uuid;

select test_util.assert_eq(lead_balance, 20, 'a claim under review refunds nothing yet')
from public.customers where id = '22222222-2222-2222-2222-222222222222';

select public.resolve_dead_lead_claim(:'rev_claim_id'::uuid, true, null, 'Checked with the landlord.', true) \gset r1_
select test_util.assert_eq(:'r1_resolve_dead_lead_claim'::boolean, true, 'the first decision applies');
select test_util.assert_eq(lead_balance, 21, 'upholding on review refunds the credit')
from public.customers where id = '22222222-2222-2222-2222-222222222222';

select public.resolve_dead_lead_claim(:'rev_claim_id'::uuid, true, null, 'Double click.', true) \gset r2_
select test_util.assert_eq(:'r2_resolve_dead_lead_claim'::boolean, false, 'a second decision is refused');
select test_util.assert_eq(lead_balance, 21, 'and does not refund twice')
from public.customers where id = '22222222-2222-2222-2222-222222222222';

-- ---------------------------------------------------------------------------
-- 8 — An upheld review DOES spend allowance when the admin says so.
-- ---------------------------------------------------------------------------
select test_util.assert_eq(quality_claims_this_cycle, 1,
  'upholding on review spends allowance when the reviewer leaves it on')
from public.customers where id = '22222222-2222-2222-2222-222222222222';

-- ---------------------------------------------------------------------------
-- 9 — 'dead' only when every operator agrees.
-- ---------------------------------------------------------------------------
select public.flag_lead_dead_if_unanimous('aaaa0000-0000-0000-0000-000000000001');
select test_util.assert_eq(quality_flag, 'suspect', 'two of three is only suspect')
from public.leads where id = 'aaaa0000-0000-0000-0000-000000000001';

insert into public.lead_events (assignment_id, event_type)
values ('bbbb0000-0000-0000-0000-000000000003','mailto_click');
select public.apply_dead_lead_claim(
  'bbbb0000-0000-0000-0000-000000000003',
  '33333333-3333-3333-3333-333333333333',
  'already_with_operator',
  'Same story from my end, they had already appointed somebody else.',
  current_date, 'auto_uphold', false, 'peer_agrees');

select public.flag_lead_dead_if_unanimous('aaaa0000-0000-0000-0000-000000000001');
select test_util.assert_eq(quality_flag, 'dead', 'unanimous claims mark the lead dead')
from public.leads where id = 'aaaa0000-0000-0000-0000-000000000001';

-- Gamma's claim above carried peer_agrees and consumes_allowance = false: it
-- agreed with a claim already settled, so it cost nothing. This is the whole
-- point of corroboration — telling the truth is cheaper than fishing.
select test_util.assert_eq(quality_claims_this_cycle, 0,
  'a corroborated claim spends no allowance')
from public.customers where id = '33333333-3333-3333-3333-333333333333';

-- ---------------------------------------------------------------------------
-- 10 — Guaranteed rent refunds the GR balance (invariant 6).
-- ---------------------------------------------------------------------------
insert into public.leads (id, monday_item_id, lead_name, lead_type)
values ('aaaa0000-0000-0000-0000-000000000002','m-dead-2','GR Landlord','guaranteed_rent');
insert into public.lead_assignments (id, lead_id, customer_id, price_paid, assigned_at)
values ('bbbb0000-0000-0000-0000-000000000004','aaaa0000-0000-0000-0000-000000000002','33333333-3333-3333-3333-333333333333',10.00, now() - interval '1 day');
insert into public.lead_events (assignment_id, event_type)
values ('bbbb0000-0000-0000-0000-000000000004','tel_click');

update public.customers
  set gr_lead_balance = 5, gr_leads_received_this_month = 2
  where id = '33333333-3333-3333-3333-333333333333';

select public.apply_dead_lead_claim(
  'bbbb0000-0000-0000-0000-000000000004',
  '33333333-3333-3333-3333-333333333333',
  'unreachable',
  'Six calls and two emails across ten days and nothing came back at all.',
  current_date, 'auto_uphold', true, 'none');

select test_util.assert_eq(gr_lead_balance, 6, 'a GR claim refunds the GR balance'),
       test_util.assert_eq(gr_leads_received_this_month, 1, 'and the GR monthly counter'),
       test_util.assert_eq(lead_balance, 21, 'and leaves the management balance alone')
from public.customers where id = '33333333-3333-3333-3333-333333333333';

-- ---------------------------------------------------------------------------
-- 11 — The allowance resets with the customer's own cycle.
-- ---------------------------------------------------------------------------
update public.customers
  set quality_claims_this_cycle = 5, billing_cycle_anchor = current_date;
select public.reset_monthly_counts();
select test_util.assert_eq(quality_claims_this_cycle, 0, 'the allowance resets on the anchor day')
from public.customers where id = '11111111-1111-1111-1111-111111111111';

update public.customers
  set quality_claims_this_cycle = 4,
      billing_cycle_anchor = current_date - interval '10 days';
select public.reset_monthly_counts();
select test_util.assert_eq(quality_claims_this_cycle, 4, 'and holds on every other day')
from public.customers where id = '11111111-1111-1111-1111-111111111111';

-- ---------------------------------------------------------------------------
-- 12 — Invariant 7: the browser roles cannot call any of this.
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select count(*)::int
     from information_schema.role_routine_grants
    where routine_schema = 'public'
      and grantee in ('anon','authenticated','public')
      and routine_name in ('apply_dead_lead_claim','resolve_dead_lead_claim',
                           'uphold_dead_lead_claim','claimable_dead_lead_assignments',
                           'flag_lead_dead_if_unanimous')),
  0, 'anon and authenticated cannot execute any 0137 function');

\o
\echo '== 0137 BEHAVIOURAL TESTS PASSED =='
