-- ============================================================================
-- Behavioural tests for 0146 — a replacement for a replacement (§53.12).
--
-- §53's Deferred list carried this: "Replacement-of-a-replacement is unbounded
-- except by the counter. The new assignment carries a null quality_claim_id,
-- so it can itself be reported."
--
-- Three things are asserted here, and the second is why the column exists at
-- all rather than a join:
--
--   1. The depth counts, and it counts through the PRE-IMAGE. The outgoing
--      assignment is deleted four statements before the insert, so a depth
--      read from the table rather than from v_old would be reading a row that
--      is gone.
--
--   2. ⚠️ IT SEES A CHAIN THAT PASSES THROUGH A PLAIN ADMIN SWAP, which writes
--      no lead_quality_claims row at all. Every claims-based derivation is
--      blind to exactly that shape, and it is the one a support swap produces.
--
--   3. All three swap callers stamp it, because there is one insert of a
--      replacement assignment in the schema and they all go through it.
--
-- Plus the regressions 0146 must not disturb: no money moves, 0145's
-- withdrawal cost still lands, 0143's retirement guard still refuses, and
-- eligibility is untouched — a chained assignment is still CLAIMABLE, because
-- what 0146 changes is who settles it, not whether it can be reported.
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
-- Alpha holds one worked management lead and has a deliberately generous
-- entitlement, because several of the assertions below swap more than twice
-- and the entitlement is not what is under test here.
--
-- Stock is kept well above replacement_stock_floor (10) so the floor fires
-- only where 0141's own suite tests it.
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
   leads_received_this_month, management_lifetime_leads_received,
   billing_cycle_anchor, quality_allowance_pct, quality_claims_this_cycle,
   clean_leads_streak, account_status, subscription_status)
values
  ('11111111-1111-1111-1111-111111111111','Alpha','A','a@x.com',20,20,5,9,
   current_date,0.10,0,0,'active','active');

-- Thirty management leads. #1 is the one Alpha holds; the rest are stock.
insert into public.leads (id, monday_item_id, lead_name, postcode, postcode_area,
                          bedrooms, max_assignments, assignment_count)
select
  ('aaaa0000-0000-0000-0000-0000000000' || lpad(i::text, 2, '0'))::uuid,
  'm-chain-' || i, 'Landlord ' || i, 'BS' || i || ' 1AA', 'BS', '3', 3,
  case when i = 1 then 1 else 0 end
from generate_series(1, 30) i;

insert into public.lead_assignments (id, lead_id, customer_id, price_paid, assigned_at)
values
  ('bbbb0000-0000-0000-0000-000000000001','aaaa0000-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111', 15.00, now() - interval '2 days');

-- Worked: the effort gate wants operator-generated telemetry.
insert into public.lead_events (assignment_id, event_type)
values ('bbbb0000-0000-0000-0000-000000000001','tel_click');


-- ---------------------------------------------------------------------------
-- 1 — The column, and what a row that was never a replacement says
--
-- ⚠️ 0146 takes the OPPOSITE decision from 0145 one migration earlier, which
-- made withdrawn_slots nullable so a pre-0145 swap would be invisible rather
-- than counted as zero. A zero there asserts "that swap cost nothing", which
-- is false. A zero HERE asserts "this assignment did not arrive as a
-- replacement", which is true of essentially the whole book — so the default
-- is the honest reading and the null would be the misleading one.
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select replacement_depth from public.lead_assignments
    where id = 'bbbb0000-0000-0000-0000-000000000001'),
  0, 'an ordinary assignment is depth 0');

select test_util.assert_eq(
  (select count(*)::int from public.lead_assignments where replacement_depth is null),
  0, 'the column is NOT NULL, so no reader has to interpret a null');

select test_util.assert_raises($$
  insert into public.lead_assignments (lead_id, customer_id, price_paid, replacement_depth)
  values ('aaaa0000-0000-0000-0000-000000000002',
          '11111111-1111-1111-1111-111111111111', 15.00, -1)
$$, 'a negative depth is refused by the CHECK');


-- ---------------------------------------------------------------------------
-- 2 — A plain admin swap stamps depth 1
--
-- This is the caller that writes no claim, and therefore the one a derivation
-- from lead_quality_claims cannot see. It is tested FIRST for that reason.
-- ---------------------------------------------------------------------------
create temporary table t_swap1 as
select public.admin_swap_lead_assignment(
  'bbbb0000-0000-0000-0000-000000000001',
  'aaaa0000-0000-0000-0000-000000000002',
  false) as new_id;

select test_util.assert_eq(
  (select replacement_depth from public.lead_assignments
    where id = (select new_id from t_swap1)),
  1, 'the replacement for a swapped-out lead is depth 1');

-- ⚠️ The outgoing row is GONE, which is why the depth has to come from the
-- locked pre-image rather than from the table. 0145 states the same rule for
-- withdrawn_slots, where the row survived and only the value had moved; here
-- there is nothing left to read.
select test_util.assert_eq(
  (select count(*)::int from public.lead_assignments
    where id = 'bbbb0000-0000-0000-0000-000000000001'),
  0, 'the outgoing assignment is deleted, so the depth cannot be read from it');

select test_util.assert_eq(
  (select count(*)::int from public.lead_quality_claims),
  0, 'a plain admin swap writes no claim at all');

-- ⚠️ AND IT IS STILL CLAIMABLE, asserted here at depth 1 as well as at depth 6
-- in §8. 0146 changes WHO settles a chained report, never whether one can be
-- made — a predicate that filtered on depth would take the report control away
-- from the customer entirely, which is the opposite of what §51.3 settles.
-- Pinned at the earliest depth a chain exists so a reordering of this file
-- cannot lose the check.
insert into public.lead_events (assignment_id, event_type)
select new_id, 'tel_click' from t_swap1;

select test_util.assert_eq(
  (select count(*)::int from public.claimable_dead_lead_assignments(
     '11111111-1111-1111-1111-111111111111', 14)
   where assignment_id = (select new_id from t_swap1)),
  1, 'a depth-1 assignment is claimable, exactly as a depth-0 one is');


-- ---------------------------------------------------------------------------
-- 3 — ⚠️ THE ASSERTION THIS COLUMN EXISTS FOR
--
-- Swap the replacement. The chain has now passed through TWO plain admin
-- swaps and there is still not one lead_quality_claims row in the database —
-- so a recursive walk over replacement_assignment_id / origin_assignment_id
-- would report this customer as having had no replacement at all, while the
-- column reads 2.
-- ---------------------------------------------------------------------------
create temporary table t_swap2 as
select public.admin_swap_lead_assignment(
  (select new_id from t_swap1),
  'aaaa0000-0000-0000-0000-000000000003',
  false) as new_id;

select test_util.assert_eq(
  (select replacement_depth from public.lead_assignments
    where id = (select new_id from t_swap2)),
  2, 'the replacement for a replacement is depth 2');

select test_util.assert_eq(
  (select count(*)::int from public.lead_quality_claims),
  0, 'and the whole chain is still invisible to any claims-based derivation');

-- It keeps counting rather than saturating at 1 — a boolean "is a replacement"
-- would answer the depth-2 question and lose the depth-3 one.
create temporary table t_swap3 as
select public.admin_swap_lead_assignment(
  (select new_id from t_swap2),
  'aaaa0000-0000-0000-0000-000000000004',
  false) as new_id;

select test_util.assert_eq(
  (select replacement_depth from public.lead_assignments
    where id = (select new_id from t_swap3)),
  3, 'the depth counts rather than saturating at 1');


-- ---------------------------------------------------------------------------
-- 4 — The two-argument shim stamps it too
--
-- 0109 kept the old arity as a delegating shim so code deployed before a
-- migration keeps working. It must not be a way to create an unstamped
-- replacement.
-- ---------------------------------------------------------------------------
create temporary table t_shim as
select public.admin_swap_lead_assignment(
  (select new_id from t_swap3),
  'aaaa0000-0000-0000-0000-000000000005') as new_id;

select test_util.assert_eq(
  (select replacement_depth from public.lead_assignments
    where id = (select new_id from t_shim)),
  4, 'the two-argument shim stamps the depth as well');


-- ---------------------------------------------------------------------------
-- 5 — customer_swap_dead_lead stamps it (0141's caller)
-- ---------------------------------------------------------------------------
insert into public.lead_events (assignment_id, event_type)
select id, 'tel_click' from t_shim
  join public.lead_assignments la on la.id = t_shim.new_id;

create temporary table t_self as
select * from public.customer_swap_dead_lead(
  (select new_id from t_shim),
  '11111111-1111-1111-1111-111111111111',
  'aaaa0000-0000-0000-0000-000000000006',
  'unreachable',
  'Rang four times over a week, the number rings out every time.',
  current_date,
  9,   -- entitlement: generous on purpose, the budget is not under test here
  0,   -- claims seen
  0,   -- streak seen
  false,
  14);

select test_util.assert_eq(
  (select replacement_depth from public.lead_assignments
    where id = (select replacement_assignment_id from t_self)),
  5, 'a customer''s own swap stamps the depth through the same insert');

select test_util.assert_eq(
  (select count(*)::int from public.lead_quality_claims where resolution = 'self_swap'),
  1, 'and it is the only caller here that has written a claim');


-- ---------------------------------------------------------------------------
-- 6 — resolve_dead_lead_claim_with_swap stamps it (0139's caller)
--
-- The admin settling path: a claim goes to review, then a person picks the
-- replacement. It is a third entry point and the same one insert.
-- ---------------------------------------------------------------------------
insert into public.lead_events (assignment_id, event_type)
select replacement_assignment_id, 'tel_click' from t_self;

create temporary table t_claim as
select * from public.apply_dead_lead_claim(
  (select replacement_assignment_id from t_self),
  '11111111-1111-1111-1111-111111111111',
  'no_longer_interested',
  'Landlord said they have taken the property off the market entirely.',
  current_date,
  'review',
  false,
  null,
  14);

create temporary table t_admin as
select public.resolve_dead_lead_claim_with_swap(
  (select claim_id from t_claim),
  null,
  'Second dead one on this slot — replacing by hand.',
  'aaaa0000-0000-0000-0000-000000000007',
  false) as new_id;

select test_util.assert_eq(
  (select replacement_depth from public.lead_assignments
    where id = (select new_id from t_admin)),
  6, 'an admin settling a claim by swap stamps the depth too');


-- ---------------------------------------------------------------------------
-- 7 — A refused swap writes nothing
--
-- 0143's retirement guard, re-asserted here because 0146 touches the same
-- function body. A refusal must leave no assignment behind carrying a depth.
-- ---------------------------------------------------------------------------
update public.leads set lead_quality_status = 'failed'
  where id = 'aaaa0000-0000-0000-0000-000000000008';

create temporary table t_counts_before as
select (select count(*) from public.lead_assignments) as assignments,
       (select max(replacement_depth) from public.lead_assignments) as max_depth;

select test_util.assert_raises(format($$
  select public.admin_swap_lead_assignment(%L, %L, false)
$$, (select new_id from t_admin), 'aaaa0000-0000-0000-0000-000000000008'),
  'a retired replacement is still refused');

select test_util.assert_eq(
  (select count(*) from public.lead_assignments),
  (select assignments from t_counts_before),
  'and the refusal created no assignment');

select test_util.assert_eq(
  (select max(replacement_depth) from public.lead_assignments),
  (select max_depth from t_counts_before),
  'and moved no depth');

select test_util.assert_eq(
  (select replacement_depth from public.lead_assignments
    where id = (select new_id from t_admin)),
  6, 'the assignment it was refused for is untouched');


-- ---------------------------------------------------------------------------
-- 8 — ⚠️ ELIGIBILITY IS UNTOUCHED
--
-- 0146's header is explicit that a chained assignment is still CLAIMABLE —
-- what changes is that settling it needs a person, and that decision lives in
-- TypeScript. If this predicate ever started filtering on depth, the customer
-- would lose the report control entirely rather than having their claim
-- reviewed, which is the opposite of what §51.3 settles.
-- ---------------------------------------------------------------------------
insert into public.lead_events (assignment_id, event_type)
select new_id, 'tel_click' from t_admin;

select test_util.assert_eq(
  (select count(*)::int from public.claimable_dead_lead_assignments(
     '11111111-1111-1111-1111-111111111111', 14)
   where assignment_id = (select new_id from t_admin)),
  1, 'a depth-6 assignment is still claimable — depth decides WHO settles it');


-- ---------------------------------------------------------------------------
-- 9 — Regressions. 0146 adds one column to the swap and must move nothing else
-- ---------------------------------------------------------------------------

-- No money. Six swaps have happened above and the customer's balances, monthly
-- counter, odometer and 0142 streak must all read exactly as seeded.
select test_util.assert_eq(
  (select lead_balance from public.customers
    where id = '11111111-1111-1111-1111-111111111111'),
  20, 'six swaps moved no balance');

select test_util.assert_eq(
  (select leads_received_this_month from public.customers
    where id = '11111111-1111-1111-1111-111111111111'),
  5, 'and no monthly counter');

select test_util.assert_eq(
  (select management_lifetime_leads_received from public.customers
    where id = '11111111-1111-1111-1111-111111111111'),
  9, 'and no odometer (invariant 9)');

-- 0145's withdrawal cost still lands on every swapped-out lead. Lead #2 was
-- held by one operator at a cap of 3, so withdrawing it cost 3 slots.
select test_util.assert_eq(
  (select withdrawn_slots from public.leads
    where id = 'aaaa0000-0000-0000-0000-000000000002'),
  3, '0145''s withdrawal cost is still recorded');

select test_util.assert_eq(
  (select count(*)::int from public.leads
    where withdrawn_at is not null and withdrawn_slots is null),
  0, 'and no swap left a withdrawal unmeasured');

-- Ordinary allocation is untouched: a marketplace lead still places and still
-- spends exactly one credit.
select public.assign_lead_to_customer(
  'aaaa0000-0000-0000-0000-000000000010',
  '11111111-1111-1111-1111-111111111111',
  15.00);

select test_util.assert_eq(
  (select lead_balance from public.customers
    where id = '11111111-1111-1111-1111-111111111111'),
  19, 'ordinary allocation still spends exactly one credit');

select test_util.assert_eq(
  (select replacement_depth from public.lead_assignments
    where lead_id = 'aaaa0000-0000-0000-0000-000000000010'
      and customer_id = '11111111-1111-1111-1111-111111111111'),
  0, 'and an allocated lead is depth 0, not a replacement');


-- ---------------------------------------------------------------------------
-- 10 — ACLs. The function was `create or replace`d, so its grants survive —
-- re-checked anyway, which is the convention since 0049.
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure::text as sig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname = 'admin_swap_lead_assignment'
  loop
    if has_function_privilege('anon', r.sig, 'execute')
       or has_function_privilege('authenticated', r.sig, 'execute') then
      raise exception 'FAIL % is executable by anon or authenticated', r.sig;
    end if;
    if not has_function_privilege('service_role', r.sig, 'execute') then
      raise exception 'FAIL % is not executable by service_role', r.sig;
    end if;
  end loop;
  raise notice 'ok  both swap signatures are service_role-only';
end $$;

-- Invariant 7: exactly four functions stay authenticated-executable.
do $$
declare v int;
begin
  select count(*) into v from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname in ('get_engagement_benchmarks','set_management_customer_goal',
                      'get_operator_proof','get_recent_wins_anonymised')
    and has_function_privilege('authenticated', p.oid::regprocedure::text, 'execute');
  if v <> 4 then
    raise exception 'FAIL invariant 7 — % of 4 still authenticated-executable', v;
  end if;
  raise notice 'ok  invariant 7 holds';
end $$;

\o
