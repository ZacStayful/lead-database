-- ============================================================================
-- Behavioural tests for 0153 — replacements carry over (CLAUDE.md §61).
--
-- The entitlement stopped being a per-cycle share of the plan and became a
-- balance: customers.replacement_balance, credited on each cycle start and on
-- each top-up, spent one at a time by a swap or a consuming credit claim, never
-- capped and never zeroed. Everything money-shaped about that is asserted here:
--
--   1. The GRANT — who accrues and how much: both products summed and rounded
--      ONCE, a paused customer still accruing, a written-off one not, and an
--      allowance of zero granting nothing.
--   2. The CYCLE START the grant keys on — the same coalesce order 0141 chose,
--      with the month-end clamp.
--   3. reset_monthly_counts — grants once per cycle, catches up a customer
--      never granted for the current cycle, adds nothing on a same-day re-run,
--      grants a dual-product customer on ONE anchor, skips archived and lapsed
--      rows, and ⚠️ still zeroes the three counters it always did.
--   4. A top-up banks its share the moment it is paid, and a replayed Stripe
--      event banks nothing twice.
--   5. The credit path spends one, an admin uphold at zero CLAMPS rather than
--      raises, goodwill spends nothing.
--   6. The eight-argument swap spends one and refuses at zero with nothing
--      written; the eleven-argument shim ignores its three seen-values.
--   7. The standing exposure reads the balance, still bounded by claimable.
--   8. The tenure seed — the formula, the stamp, and idempotency — driven
--      through the real function rather than a restatement of it.
--   9. ACLs on every signature touched, and invariant 7.
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

create or replace function test_util.grant_of(p_id uuid)
returns integer language sql as $$
  select public.replacement_monthly_grant(c) from public.customers c where c.id = p_id;
$$;

create or replace function test_util.cycle_start_of(p_id uuid)
returns date language sql as $$
  select public.replacement_cycle_start(c) from public.customers c where c.id = p_id;
$$;

create or replace function test_util.balance_of(p_id uuid)
returns integer language sql as $$
  select replacement_balance from public.customers where id = p_id;
$$;

create or replace function test_util.swaps(p_type public.lead_type)
returns integer language sql as $$
  select swaps_available_now from public.get_service_capacity() where lead_type = p_type;
$$;

-- ⚠️ Cleared UP FRONT as well as relied on by later suites: mutation testing
-- aborts a suite by design, and a suite that is not re-runnable reports the
-- wrong failure on the next pass (0149's lesson).
delete from public.service_capacity_snapshots;
delete from public.lead_outcome_reasons;
delete from public.lead_quality_claims;
delete from public.lead_events;
delete from public.lead_notes;
delete from public.lead_assignments;
delete from public.leads;
delete from public.lead_topup_tokens;
delete from public.payments;
delete from public.customers;

-- ---------------------------------------------------------------------------
-- The book: one customer per shape the grant has to get right.
-- ---------------------------------------------------------------------------
insert into public.customers
  (id, business_name, contact_name, email, is_active,
   monthly_allocation, gr_monthly_allocation, lead_balance, gr_lead_balance,
   account_status, subscription_status, gr_subscription_status,
   quality_allowance_pct, billing_cycle_anchor, gr_billing_cycle_anchor,
   paused_at, lapsed_at, gr_lapsed_at)
values
  -- A 20-lead management plan: grants 2.
  ('c0000000-0000-0000-0000-000000000001','Mgmt twenty','A','a@x.com',true,
   20,10,20,0,'active','active','inactive',0.10,current_date,null,null,null,null),
  -- A 10-lead management plan: grants 1.
  ('c0000000-0000-0000-0000-000000000002','Mgmt ten','B','b@x.com',true,
   10,10,20,0,'active','active','inactive',0.10,current_date,null,null,null,null),
  -- Guaranteed rent only. ⚠️ account_status waitlisted for ever (§18A), and the
  -- GR anchor is the one that counts.
  ('c0000000-0000-0000-0000-000000000003','GR only','C','c@x.com',true,
   20,20,0,20,'waitlisted','inactive','active',0.10,null,current_date,null,null,null),
  -- Both products, 10 + 10 at 0.05: rounded ONCE that is 1; per product it
  -- would be round(0.5) + round(0.5) = 2 (§53.4's trap).
  ('c0000000-0000-0000-0000-000000000004','Dual','D','d@x.com',true,
   10,10,20,20,'active','active','active',0.05,current_date,current_date - 1,null,null,null),
  -- Paused: still accrues, by decision (§61).
  ('c0000000-0000-0000-0000-000000000005','Paused','E','e@x.com',true,
   20,10,20,0,'active','active','inactive',0.10,current_date,null,now(),null,null),
  -- Written off under §59: account_status cancelled, subscription_status still
  -- past_due (which holdsProduct counts as held), lapsed_at set. Accrues nothing.
  ('c0000000-0000-0000-0000-000000000006','Lapsed','F','f@x.com',true,
   20,10,20,0,'cancelled','past_due','inactive',0.10,current_date,null,null,now(),null),
  -- A prospect holding nothing.
  ('c0000000-0000-0000-0000-000000000007','Prospect','G','g@x.com',true,
   20,10,0,0,'waitlisted','inactive','inactive',0.10,null,null,null,null,null),
  -- Archived (§18D): the grant function says 2, the reset must skip it.
  ('c0000000-0000-0000-0000-000000000008','Archived','H','h@x.com',false,
   20,10,20,0,'active','active','inactive',0.10,current_date,null,null,null,null),
  -- An allowance of zero.
  ('c0000000-0000-0000-0000-000000000009','Zero pct','I','i@x.com',true,
   20,10,20,0,'active','active','inactive',0,current_date,null,null,null,null),
  -- GR held but written off on the GR side.
  ('c0000000-0000-0000-0000-00000000000a','GR lapsed','J','j@x.com',true,
   20,20,0,20,'waitlisted','inactive','past_due',0.10,null,current_date,null,null,now());

-- ---------------------------------------------------------------------------
-- 1 — The grant
-- ---------------------------------------------------------------------------
select test_util.assert_eq(test_util.grant_of('c0000000-0000-0000-0000-000000000001'), 2,
  'a 20-lead plan grants two a month');
select test_util.assert_eq(test_util.grant_of('c0000000-0000-0000-0000-000000000002'), 1,
  'a 10-lead plan grants one a month');
select test_util.assert_eq(test_util.grant_of('c0000000-0000-0000-0000-000000000003'), 2,
  'a GR-only customer is granted on the GR allocation despite being waitlisted for management (invariant 6)');
select test_util.assert_eq(test_util.grant_of('c0000000-0000-0000-0000-000000000004'), 1,
  'both products are summed and rounded ONCE — 10 + 10 at 0.05 is 1, not 1 + 1');
select test_util.assert_eq(test_util.grant_of('c0000000-0000-0000-0000-000000000005'), 2,
  'a paused customer still accrues');
select test_util.assert_eq(test_util.grant_of('c0000000-0000-0000-0000-000000000006'), 0,
  'a customer written off under §59 accrues nothing, though holdsProduct still counts them as held');
select test_util.assert_eq(test_util.grant_of('c0000000-0000-0000-0000-00000000000a'), 0,
  'and the same on the guaranteed-rent side');
select test_util.assert_eq(test_util.grant_of('c0000000-0000-0000-0000-000000000007'), 0,
  'a prospect holding nothing accrues nothing');
select test_util.assert_eq(test_util.grant_of('c0000000-0000-0000-0000-000000000009'), 0,
  'an allowance of zero grants nothing');

-- ---------------------------------------------------------------------------
-- 2 — The cycle start
-- ---------------------------------------------------------------------------
select test_util.assert_eq(test_util.cycle_start_of('c0000000-0000-0000-0000-000000000001'),
  current_date, 'an anchor on today starts the cycle today');

update public.customers set billing_cycle_anchor = current_date - 1
  where id = 'c0000000-0000-0000-0000-000000000001';
select test_util.assert_eq(test_util.cycle_start_of('c0000000-0000-0000-0000-000000000001'),
  current_date - 1, 'an anchor on yesterday started the cycle yesterday, across a month boundary too');

update public.customers set billing_cycle_anchor = current_date + 1
  where id = 'c0000000-0000-0000-0000-000000000001';
select test_util.assert_eq(
  (select s < current_date and s >= current_date - 31
     from test_util.cycle_start_of('c0000000-0000-0000-0000-000000000001') s),
  true, 'an anchor on tomorrow started the current cycle about a month ago');

update public.customers set billing_cycle_anchor = current_date
  where id = 'c0000000-0000-0000-0000-000000000001';

select test_util.assert_eq(test_util.cycle_start_of('c0000000-0000-0000-0000-000000000003'),
  current_date, 'a GR-only customer reads the GR anchor — the same coalesce order as 0141');

select test_util.assert_eq(test_util.cycle_start_of('c0000000-0000-0000-0000-000000000007'),
  current_date, 'with no anchor at all the signup date is the anchor');

-- ---------------------------------------------------------------------------
-- 3 — reset_monthly_counts grants, once per cycle
-- ---------------------------------------------------------------------------
update public.customers set quality_claims_this_cycle = 3
  where id = 'c0000000-0000-0000-0000-000000000001';

select public.reset_monthly_counts();

select test_util.assert_eq(test_util.balance_of('c0000000-0000-0000-0000-000000000001'), 2,
  'the first run grants a customer never granted before');
select test_util.assert_eq(
  (select replacement_granted_on from public.customers where id = 'c0000000-0000-0000-0000-000000000001'),
  current_date, 'and stamps the cycle it was granted for');
select test_util.assert_eq(test_util.balance_of('c0000000-0000-0000-0000-000000000002'), 1,
  'the 10-lead plan banked one');
select test_util.assert_eq(test_util.balance_of('c0000000-0000-0000-0000-000000000003'), 2,
  'the GR-only customer was granted on their GR anchor');
select test_util.assert_eq(test_util.balance_of('c0000000-0000-0000-0000-000000000004'), 1,
  'the dual-product customer was granted once, rounded once');
select test_util.assert_eq(test_util.balance_of('c0000000-0000-0000-0000-000000000005'), 2,
  'the paused customer was granted');
select test_util.assert_eq(test_util.balance_of('c0000000-0000-0000-0000-000000000006'), 0,
  'the written-off customer was not');
select test_util.assert_eq(test_util.balance_of('c0000000-0000-0000-0000-000000000007'), 0,
  'nor the prospect');
select test_util.assert_eq(test_util.balance_of('c0000000-0000-0000-0000-000000000008'), 0,
  'nor the archived row, though the grant function would say 2');
select test_util.assert_eq(
  (select replacement_granted_on from public.customers where id = 'c0000000-0000-0000-0000-000000000008'),
  null::date, 'and the archived row is never stamped, so un-archiving is caught up on the next run');
select test_util.assert_eq(test_util.balance_of('c0000000-0000-0000-0000-000000000009'), 0,
  'an allowance of zero banked nothing');

-- ⚠️ The three original statements are untouched (0018's rule: they reset for
-- everyone, whatever their status).
select test_util.assert_eq(
  (select quality_claims_this_cycle from public.customers where id = 'c0000000-0000-0000-0000-000000000001'),
  0, 'the per-cycle counter still zeroes on the anchor day');

select public.reset_monthly_counts();
select test_util.assert_eq(test_util.balance_of('c0000000-0000-0000-0000-000000000001'), 2,
  'a same-day re-run adds nothing');

-- Granted for the PREVIOUS cycle: the new cycle start grants again.
update public.customers set replacement_granted_on = (current_date - interval '1 month')::date
  where id = 'c0000000-0000-0000-0000-000000000001';
select public.reset_monthly_counts();
select test_util.assert_eq(test_util.balance_of('c0000000-0000-0000-0000-000000000001'), 4,
  'a customer last granted for the previous cycle is granted for this one, on top');

-- ⚠️ THE CATCH-UP. A customer whose anchor day was three days ago and who has
-- never been granted for this cycle — the shape of a new customer whose first
-- invoice landed after the 00:05 run — is granted on the NEXT run, not on the
-- next anchor day a month away.
update public.customers
  set replacement_granted_on = null, billing_cycle_anchor = current_date - 3
  where id = 'c0000000-0000-0000-0000-000000000002';
select public.reset_monthly_counts();
select test_util.assert_eq(test_util.balance_of('c0000000-0000-0000-0000-000000000002'), 2,
  'a customer never granted for the current cycle is caught up on the next run, not on the anchor day');
select test_util.assert_eq(
  (select replacement_granted_on from public.customers where id = 'c0000000-0000-0000-0000-000000000002'),
  current_date - 3, 'stamped with the cycle start, not with today');
select public.reset_monthly_counts();
select test_util.assert_eq(test_util.balance_of('c0000000-0000-0000-0000-000000000002'), 2,
  'and not again the day after');

-- ⚠️ ONE BALANCE, ONE ANCHOR. Roll the dual-product customer onto their GR
-- anchor day with the management anchor still ahead: nothing lands.
update public.customers
  set billing_cycle_anchor = current_date + 1, gr_billing_cycle_anchor = current_date
  where id = 'c0000000-0000-0000-0000-000000000004';
select public.reset_monthly_counts();
select test_util.assert_eq(test_util.balance_of('c0000000-0000-0000-0000-000000000004'), 1,
  'a dual-product customer is NOT granted again on the GR anchor — one balance, one anchor');
update public.customers
  set billing_cycle_anchor = current_date, gr_billing_cycle_anchor = current_date - 1
  where id = 'c0000000-0000-0000-0000-000000000004';

-- ---------------------------------------------------------------------------
-- 4 — A top-up banks its share the moment it is paid
-- ---------------------------------------------------------------------------
insert into public.lead_topup_tokens (id, customer_id, lead_type, token_hash, credits, amount_pence, expires_at)
values
  ('70000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000001','management','h1',5,7500,now() + interval '1 day'),
  ('70000000-0000-0000-0000-000000000002','c0000000-0000-0000-0000-000000000003','guaranteed_rent','h2',15,22500,now() + interval '1 day'),
  ('70000000-0000-0000-0000-000000000003','c0000000-0000-0000-0000-000000000009','management','h3',5,7500,now() + interval '1 day');

create temp table before_topup as
  select id, lead_balance, gr_lead_balance, replacement_balance from public.customers;

select test_util.assert_eq(
  public.record_lead_topup_success('70000000-0000-0000-0000-000000000001', 'pi_1'),
  true, 'a top-up is credited');
select test_util.assert_eq(
  (select lead_balance from public.customers where id = 'c0000000-0000-0000-0000-000000000001'),
  (select lead_balance + 5 from before_topup where id = 'c0000000-0000-0000-0000-000000000001'),
  '0041 still credits the five leads');
select test_util.assert_eq(
  test_util.balance_of('c0000000-0000-0000-0000-000000000001'),
  (select replacement_balance + 1 from before_topup where id = 'c0000000-0000-0000-0000-000000000001'),
  'a 5-lead top-up banks one replacement the moment it is paid');

select test_util.assert_eq(
  public.record_lead_topup_success('70000000-0000-0000-0000-000000000001', 'pi_1'),
  false, 'a replayed top-up is refused');
select test_util.assert_eq(
  test_util.balance_of('c0000000-0000-0000-0000-000000000001'),
  (select replacement_balance + 1 from before_topup where id = 'c0000000-0000-0000-0000-000000000001'),
  'and banks nothing twice');

select public.record_lead_topup_success('70000000-0000-0000-0000-000000000002', 'pi_2');
select test_util.assert_eq(
  (select gr_lead_balance from public.customers where id = 'c0000000-0000-0000-0000-000000000003'),
  (select gr_lead_balance + 15 from before_topup where id = 'c0000000-0000-0000-0000-000000000003'),
  'a GR top-up still credits the GR balance');
select test_util.assert_eq(
  test_util.balance_of('c0000000-0000-0000-0000-000000000003'),
  (select replacement_balance + 2 from before_topup where id = 'c0000000-0000-0000-0000-000000000003'),
  'a GR top-up banks into the SAME balance, rounded on the top-up itself (15 at 0.10 is 2)');

select public.record_lead_topup_success('70000000-0000-0000-0000-000000000003', 'pi_3');
select test_util.assert_eq(
  test_util.balance_of('c0000000-0000-0000-0000-000000000009'),
  (select replacement_balance from before_topup where id = 'c0000000-0000-0000-0000-000000000009'),
  'an allowance of zero banks nothing from a top-up');

-- ---------------------------------------------------------------------------
-- Leads and worked assignments for the money paths below. Thirty management
-- leads in stock clear replacement_stock_floor (10).
-- ---------------------------------------------------------------------------
insert into public.leads (id, monday_item_id, lead_name, postcode_area, bedrooms,
                          gross_annual_income, max_assignments, assignment_count)
select
  ('aaaa0000-0000-0000-0000-0000000000' || lpad(i::text, 2, '0'))::uuid,
  'm-bal-' || i, 'Landlord ' || i, 'BS', '3', 30000 + i * 1000, 3,
  case when i <= 6 then 1 else 0 end
from generate_series(1, 36) i;

insert into public.lead_assignments (id, lead_id, customer_id, price_paid, assigned_at)
select
  ('bbbb0000-0000-0000-0000-0000000000' || lpad(i::text, 2, '0'))::uuid,
  ('aaaa0000-0000-0000-0000-0000000000' || lpad(i::text, 2, '0'))::uuid,
  'c0000000-0000-0000-0000-000000000001', 15.00, now() - interval '2 days'
from generate_series(1, 6) i;

insert into public.lead_events (assignment_id, event_type)
select id, 'tel_click' from public.lead_assignments;

-- ---------------------------------------------------------------------------
-- 5 — The credit path spends the same balance
-- ---------------------------------------------------------------------------
update public.customers set replacement_balance = 1, lead_balance = 20, quality_claims_this_cycle = 0
  where id = 'c0000000-0000-0000-0000-000000000001';

select * from public.apply_dead_lead_claim(
  'bbbb0000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
  'unreachable', 'Rings out every single time and the mailbox is always full.',
  current_date - 1, 'auto_uphold', true, 'none', 14);

select test_util.assert_eq(test_util.balance_of('c0000000-0000-0000-0000-000000000001'), 0,
  'a consuming credit claim spends one banked replacement');
select test_util.assert_eq(
  (select lead_balance from public.customers where id = 'c0000000-0000-0000-0000-000000000001'),
  21, 'and still restores the credit (0137)');
select test_util.assert_eq(
  (select quality_claims_this_cycle from public.customers where id = 'c0000000-0000-0000-0000-000000000001'),
  1, 'and still counts one against the per-cycle statistic');

-- A reviewed claim upheld by an admin AT ZERO: the balance clamps, the credit
-- still lands. An admin uphold must never fail on the CHECK.
create temp table t_review as
select * from public.apply_dead_lead_claim(
  'bbbb0000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001',
  'property_sold', 'The landlord has accepted an offer and is selling the flat.',
  current_date - 1, 'review', false, 'none', 14);
select test_util.assert_eq(
  public.resolve_dead_lead_claim((select claim_id from t_review), true, null, 'checked', true),
  true, 'an admin upholds the reviewed claim');
select test_util.assert_eq(test_util.balance_of('c0000000-0000-0000-0000-000000000001'), 0,
  'an admin uphold with nothing banked clamps at zero rather than raising');
select test_util.assert_eq(
  (select lead_balance from public.customers where id = 'c0000000-0000-0000-0000-000000000001'),
  22, 'and the credit still lands');

-- Goodwill spends nothing.
update public.customers set replacement_balance = 1
  where id = 'c0000000-0000-0000-0000-000000000001';
create temp table t_goodwill as
select * from public.apply_dead_lead_claim(
  'bbbb0000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000001',
  'never_interested', 'Said they never asked for management and hung up.',
  current_date - 1, 'review', false, 'none', 14);
select public.resolve_dead_lead_claim((select claim_id from t_goodwill), true, null, 'goodwill', false);
select test_util.assert_eq(test_util.balance_of('c0000000-0000-0000-0000-000000000001'), 1,
  'a goodwill uphold spends nothing');

-- A corroborated auto-uphold spends nothing either (the route passes false).
select * from public.apply_dead_lead_claim(
  'bbbb0000-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-000000000001',
  'unreachable', 'Number is dead, straight to a disconnected tone.',
  current_date - 1, 'auto_uphold', false, 'peer_agrees', 14);
select test_util.assert_eq(test_util.balance_of('c0000000-0000-0000-0000-000000000001'), 1,
  'a corroborated claim spends nothing');

-- ---------------------------------------------------------------------------
-- 6 — The swap: eight arguments, and the shim
-- ---------------------------------------------------------------------------
create temp table before_swap as
  select lead_balance, leads_received_this_month, management_lifetime_leads_received
  from public.customers where id = 'c0000000-0000-0000-0000-000000000001';

create temp table t_swap as
select * from public.customer_swap_dead_lead(
  'bbbb0000-0000-0000-0000-000000000005', 'c0000000-0000-0000-0000-000000000001',
  'aaaa0000-0000-0000-0000-000000000010', 'unreachable',
  'Rang four times over a week, never answered, no voicemail.',
  current_date - 1, false, 14);

select test_util.assert_eq(test_util.balance_of('c0000000-0000-0000-0000-000000000001'), 0,
  'the eight-argument swap spends one');
select test_util.assert_eq(
  (select count(*)::integer from public.lead_assignments
    where id = (select replacement_assignment_id from t_swap)),
  1, 'and the replacement assignment exists');
select test_util.assert_eq(
  (select lead_balance from public.customers where id = 'c0000000-0000-0000-0000-000000000001'),
  (select lead_balance from before_swap), 'a swap still moves no credit');
select test_util.assert_eq(
  (select management_lifetime_leads_received from public.customers where id = 'c0000000-0000-0000-0000-000000000001'),
  (select management_lifetime_leads_received from before_swap), 'nor the odometer (invariant 9)');

select test_util.assert_raises($q$
  select * from public.customer_swap_dead_lead(
    'bbbb0000-0000-0000-0000-000000000006', 'c0000000-0000-0000-0000-000000000001',
    'aaaa0000-0000-0000-0000-000000000011', 'unreachable',
    'Another one that never answers the phone at all.',
    current_date - 1, false, 14)
$q$, 'a swap with nothing banked is refused');
select test_util.assert_eq(
  (select count(*)::integer from public.lead_assignments where id = 'bbbb0000-0000-0000-0000-000000000006'),
  1, 'a refused swap leaves the assignment standing');
select test_util.assert_eq(
  (select count(*)::integer from public.lead_quality_claims
    where origin_assignment_id = 'bbbb0000-0000-0000-0000-000000000006'),
  0, 'and writes no claim');
select test_util.assert_eq(test_util.balance_of('c0000000-0000-0000-0000-000000000001'), 0,
  'and moves no balance');

-- The eleven-argument shim ignores its three seen-values.
update public.customers set replacement_balance = 1
  where id = 'c0000000-0000-0000-0000-000000000001';
select * from public.customer_swap_dead_lead(
  'bbbb0000-0000-0000-0000-000000000006', 'c0000000-0000-0000-0000-000000000001',
  'aaaa0000-0000-0000-0000-000000000011', 'unreachable',
  'Another one that never answers the phone at all.',
  current_date - 1, 0, 99, 99, false, 14);
select test_util.assert_eq(test_util.balance_of('c0000000-0000-0000-0000-000000000001'), 0,
  'the eleven-argument shim swaps on the balance alone — an entitlement of 0 and 99 claims seen are ignored');
select test_util.assert_eq(
  (select count(*)::integer from public.lead_assignments
    where lead_id = 'aaaa0000-0000-0000-0000-000000000011'
      and customer_id = 'c0000000-0000-0000-0000-000000000001'),
  1, 'and the replacement landed');

-- ⚠️ 0143 §10 counts overloads whose body names admin_swap_lead_assignment
-- and expects one; the shim must not, even in a comment.
select test_util.assert_eq(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'customer_swap_dead_lead'),
  2, 'both swap overloads exist');
select test_util.assert_eq(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'customer_swap_dead_lead'
      and p.prosrc like '%admin_swap_lead_assignment%'),
  1, 'and only the eight-argument form commits through admin_swap_lead_assignment');

-- ---------------------------------------------------------------------------
-- 7 — The standing exposure reads the balance
-- ---------------------------------------------------------------------------
-- Only one customer holds anything claimable now: the sixth assignment was
-- swapped, so seed one more worked lead for them.
insert into public.leads (id, monday_item_id, lead_name, postcode_area, bedrooms, max_assignments, assignment_count)
values ('aaaa0000-0000-0000-0000-000000000099','m-bal-99','Landlord 99','BS','3',3,1);
insert into public.lead_assignments (id, lead_id, customer_id, price_paid, assigned_at)
values ('bbbb0000-0000-0000-0000-000000000099','aaaa0000-0000-0000-0000-000000000099',
        'c0000000-0000-0000-0000-000000000001', 15.00, now() - interval '2 days');
insert into public.lead_events (assignment_id, event_type)
values ('bbbb0000-0000-0000-0000-000000000099','tel_click');

update public.customers set replacement_balance = 5
  where id = 'c0000000-0000-0000-0000-000000000001';
select test_util.assert_eq(test_util.swaps('management'), 1,
  'the exposure is the balance bounded by claimable stock — five banked, one claimable, one');
update public.customers set replacement_balance = 0
  where id = 'c0000000-0000-0000-0000-000000000001';
select test_util.assert_eq(test_util.swaps('management'), 0,
  'and nothing banked is no exposure however much is claimable');

-- ---------------------------------------------------------------------------
-- 8 — The tenure seed, through the real function
-- ---------------------------------------------------------------------------
insert into public.customers
  (id, business_name, contact_name, email, is_active,
   monthly_allocation, gr_monthly_allocation, lead_balance, gr_lead_balance,
   account_status, subscription_status, gr_subscription_status, quality_allowance_pct,
   replacement_balance, created_at)
values
  -- Two completed months since their first paid invoice, one top-up, one
  -- consumed claim: (2 + 1) x 2 + 1 - 1 = 6.
  ('5eed0000-0000-0000-0000-000000000001','Seed tenure','S','s1@x.com',true,
   20,10,20,0,'active','active','inactive',0.10,0,now()),
  -- No invoice on record, signed up 45 days ago: (1 + 1) x 1 = 2.
  ('5eed0000-0000-0000-0000-000000000002','Seed signup','S','s2@x.com',true,
   10,10,20,0,'active','active','inactive',0.10,0,now() - interval '45 days'),
  -- Already carrying a balance: untouched.
  ('5eed0000-0000-0000-0000-000000000003','Seed banked','S','s3@x.com',true,
   20,10,20,0,'active','active','inactive',0.10,3,now()),
  -- Archived: untouched.
  ('5eed0000-0000-0000-0000-000000000004','Seed archived','S','s4@x.com',false,
   20,10,20,0,'active','active','inactive',0.10,0,now()),
  -- A prospect: nothing to seed.
  ('5eed0000-0000-0000-0000-000000000005','Seed prospect','S','s5@x.com',true,
   20,10,0,0,'waitlisted','inactive','inactive',0.10,0,now());

insert into public.payments (customer_id, stripe_payment_intent_id, amount_pence, credits_added, payment_type, status, lead_type, created_at)
values
  ('5eed0000-0000-0000-0000-000000000001','pi_s1a',30000,20,'subscription','paid','management', now() - interval '2 months 10 days'),
  ('5eed0000-0000-0000-0000-000000000001','pi_s1b',30000,20,'subscription','paid','management', now() - interval '1 month 10 days'),
  ('5eed0000-0000-0000-0000-000000000001','pi_s1c',7500,5,'topup','paid','management', now() - interval '20 days'),
  -- ⚠️ A FAILED invoice must not count as the start of tenure.
  ('5eed0000-0000-0000-0000-000000000002','pi_s2f',15000,0,'subscription','failed','management', now() - interval '3 years');

-- The consumed claim: a worked lead reported and auto-upheld at a balance of 0
-- (which clamps), leaving allowance_consumed = true behind.
insert into public.leads (id, monday_item_id, lead_name, postcode_area, bedrooms, max_assignments, assignment_count)
values ('aaaa0000-0000-0000-0000-000000000098','m-seed-1','Seed landlord','BS','3',3,1);
insert into public.lead_assignments (id, lead_id, customer_id, price_paid, assigned_at)
values ('bbbb0000-0000-0000-0000-000000000098','aaaa0000-0000-0000-0000-000000000098',
        '5eed0000-0000-0000-0000-000000000001', 15.00, now() - interval '2 days');
insert into public.lead_events (assignment_id, event_type)
values ('bbbb0000-0000-0000-0000-000000000098','tel_click');
select * from public.apply_dead_lead_claim(
  'bbbb0000-0000-0000-0000-000000000098', '5eed0000-0000-0000-0000-000000000001',
  'unreachable', 'The number goes straight to an unobtainable tone.',
  current_date - 1, 'auto_uphold', true, 'none', 14);
select test_util.assert_eq(test_util.balance_of('5eed0000-0000-0000-0000-000000000001'), 0,
  'the seed customer is still at zero after the clamped uphold');

-- ⚠️ The four earlier customers this suite already seeded by hand carry
-- balances or stamps, so the function must not touch them either; the count it
-- returns is the two fresh ones.
select test_util.assert_eq(public.seed_replacement_balances(), 2,
  'the seed writes exactly the two customers with nothing banked and no stamp');

select test_util.assert_eq(test_util.balance_of('5eed0000-0000-0000-0000-000000000001'), 6,
  'tenure from the first PAID invoice: (2 completed months + 1) x 2, plus one for the top-up, minus the consumed claim');
select test_util.assert_eq(test_util.balance_of('5eed0000-0000-0000-0000-000000000002'), 2,
  'with no paid invoice the signup date is the start: (1 + 1) x 1, and a failed invoice counts for nothing');
select test_util.assert_eq(test_util.balance_of('5eed0000-0000-0000-0000-000000000003'), 3,
  'a customer already carrying a balance is untouched');
select test_util.assert_eq(test_util.balance_of('5eed0000-0000-0000-0000-000000000004'), 0,
  'an archived row is untouched');
select test_util.assert_eq(test_util.balance_of('5eed0000-0000-0000-0000-000000000005'), 0,
  'a prospect is untouched');
select test_util.assert_eq(
  (select replacement_granted_on from public.customers where id = '5eed0000-0000-0000-0000-000000000001'),
  test_util.cycle_start_of('5eed0000-0000-0000-0000-000000000001'),
  'the seed stamps the current cycle start');

select test_util.assert_eq(public.seed_replacement_balances(), 0,
  'a second run seeds nobody');
select test_util.assert_eq(test_util.balance_of('5eed0000-0000-0000-0000-000000000001'), 6,
  'and changes nothing');

-- The stamp is what stops the cron granting again the next morning.
select public.reset_monthly_counts();
select test_util.assert_eq(test_util.balance_of('5eed0000-0000-0000-0000-000000000001'), 6,
  'the cron does not grant a seeded customer again for the same cycle');

-- ---------------------------------------------------------------------------
-- 9 — ACLs and invariant 7
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select count(*)::integer from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('replacement_monthly_grant','replacement_cycle_start',
                        'seed_replacement_balances','customer_swap_dead_lead',
                        'record_lead_topup_success','uphold_dead_lead_claim',
                        'reset_monthly_counts','get_service_capacity')
      and (has_function_privilege('anon', p.oid, 'execute')
        or has_function_privilege('authenticated', p.oid, 'execute'))),
  0, 'anon and authenticated hold zero execute grants on any 0153 function, both swap overloads included');

select test_util.assert_eq(
  (select count(*)::integer from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('replacement_monthly_grant','replacement_cycle_start',
                        'seed_replacement_balances','customer_swap_dead_lead',
                        'record_lead_topup_success','uphold_dead_lead_claim',
                        'reset_monthly_counts','get_service_capacity')
      and not has_function_privilege('service_role', p.oid, 'execute')),
  0, 'service_role can execute every one of them');

select test_util.assert_eq(
  (select count(distinct p.proname)::integer from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('get_engagement_benchmarks','set_management_customer_goal',
                        'get_operator_proof','get_recent_wins_anonymised')
      and has_function_privilege('authenticated', p.oid, 'execute')),
  4, 'invariant 7: the four customer-callable functions still are');

-- ---------------------------------------------------------------------------
-- Teardown — leave the database as the next suite expects to find it.
--
-- ⚠️ This is the only suite that seeds `payments` and `lead_topup_tokens`, and
-- no other suite's setup clears them. Both carry a foreign key to customers, so
-- rows left behind make every LATER `delete from public.customers` fail with an
-- FK violation — a failure reported by a suite that did nothing wrong. ci.sh
-- runs this file last, so CI never sees it; a re-run on one database, or a
-- mutation harness that runs the suites in another order, does.
-- ---------------------------------------------------------------------------
delete from public.lead_topup_tokens;
delete from public.payments;

\o
select '0153 BEHAVIOURAL TESTS PASSED' as result;
