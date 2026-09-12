-- ============================================================================
-- Behavioural tests for 0144 — say WHY a lead is not offered (§53.10).
--
-- 0143 stopped the admin swap picker offering leads ordinary routing had
-- retired, by dropping them from the list. 0144 puts them back, last, carrying
-- the basis — §52.4's rule that a control which silently disappears reads as
-- broken and teaches nobody why.
--
-- Two things are being asserted here and they are not the same weight:
--
--   1. ⚠️ THE EQUIVALENCE. 0144 rewrites lead_retired_from_allocation, the most
--      load-bearing predicate in the schema (invariant 11), to delegate to the
--      new reason function. §1 below pins the pre-0144 body under a second name
--      and compares the two over every combination of every basis. A test that
--      derived its expectation from the new function would pass whatever the
--      rewrite got wrong — the duplication is deliberate, as §27.2 records for
--      the API field list.
--
--   2. The picker's new shape: the reason values, the ordering that keeps
--      retired rows from eating the cap, and the refusal being unchanged.
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

create or replace function test_util.assert_raises_like(sql text, pattern text, label text)
returns void language plpgsql as $$
declare msg text;
begin
  begin
    execute sql;
  exception when others then
    msg := SQLERRM;
    if msg not like pattern then
      raise exception 'FAIL % — expected a message like %, got %', label, pattern, msg;
    end if;
    raise notice 'ok  % (%)', label, msg;
    return;
  end;
  raise exception 'FAIL % — expected an exception, none raised', label;
end $$;

-- ⚠️ THE ORACLE. This is 0111's body, transcribed verbatim, living in test_util
-- so it never reaches a schema diff. It is what lead_retired_from_allocation
-- returned before 0144 and it is what 0144 must go on returning. Do not
-- "simplify" it to call the real function — that is the whole point of it.
create or replace function test_util.lead_retired_0111(p_lead_id uuid)
returns boolean language sql stable as $$
  select
    exists (
      select 1 from public.lead_assignments la
      where la.lead_id = p_lead_id
        and la.claimed_from_pool_at is not null
    )
    or exists (
      select 1 from public.leads l
      where l.id = p_lead_id
        and (
          l.pool_expired_at is not null
          or (l.pool_entered_at is not null and l.pool_entry_basis = 'ignored')
          or (
            l.owner_customer_id is not null
            and l.owner_resale_qualified_at is null
          )
          or (
            l.lead_quality_status = 'failed'
            and l.lead_quality_override_at is null
          )
        )
    );
$$;

delete from public.lead_outcome_reasons;
delete from public.lead_quality_claims;
delete from public.lead_events;
delete from public.lead_notes;
delete from public.lead_assignments;
delete from public.leads;
delete from public.customers;

insert into public.customers
  (id, business_name, contact_name, email, monthly_allocation, lead_balance,
   account_status, subscription_status)
values
  ('11111111-1111-1111-1111-111111111111','Alpha','A','a@x.com',20,17,'active','active'),
  ('22222222-2222-2222-2222-222222222222','Beta','B','b@x.com',20,17,'active','active');

-- ---------------------------------------------------------------------------
-- 1 — ⚠️ EQUIVALENCE, over every combination of every basis
--
-- Five independent conditions, so 32 shapes. Each is generated rather than
-- hand-listed, so a basis cannot be covered by accident and missed by accident.
-- The pool-claim arm is the one that lives on lead_assignments rather than
-- leads, so it is applied as a separate insert below.
-- ---------------------------------------------------------------------------
insert into public.leads
  (id, monday_item_id, lead_name, postcode, postcode_area, bedrooms,
   max_assignments, assignment_count,
   pool_expired_at, pool_entered_at, pool_first_entered_at, pool_entry_basis,
   owner_customer_id, owner_source, owner_resale_allowed, owner_resale_qualified_at,
   lead_quality_status, lead_quality_override_at)
select
  ('cccc0000-0000-0000-0000-0000000000' || lpad(to_hex(i), 2, '0'))::uuid,
  case when (i & 4) > 0 then null else 'm-matrix-' || i end,
  'Matrix ' || i, 'BS1 1AA', 'BS', '3', 3, 0,
  case when (i & 1) > 0 then now() - interval '1 day' end,
  case when (i & 2) > 0 then now() - interval '1 day' end,
  case when (i & 2) > 0 then now() - interval '1 day' end,
  case when (i & 2) > 0 then 'ignored' else null end,
  case when (i & 4) > 0 then '22222222-2222-2222-2222-222222222222'::uuid end,
  case when (i & 4) > 0 then 'manual' end,
  case when (i & 4) > 0 then true else false end,
  case when (i & 4) > 0 and (i & 8) > 0 then now() end,
  case when (i & 16) > 0 then 'failed' else 'passed' end,
  case when (i & 16) > 0 and (i & 8) > 0 then now() end
from generate_series(0, 31) i;

-- A sixth shape the matrix cannot express: the pool claim, which is a fact
-- about an assignment. Applied to one otherwise-clean lead and to one that is
-- ALSO quality-blocked, so arm precedence has something to be wrong about.
insert into public.leads
  (id, monday_item_id, lead_name, postcode, postcode_area, bedrooms,
   max_assignments, assignment_count, lead_quality_status)
values
  ('cccc0000-0000-0000-0000-0000000000f0','m-claimed','Claimed','BS2 2BB','BS','3',3,1,'passed'),
  ('cccc0000-0000-0000-0000-0000000000f1','m-claimed2','Claimed and blocked','BS3 3CC','BS','3',3,1,'failed');

insert into public.lead_assignments (lead_id, customer_id, price_paid, claimed_from_pool_at)
values
  ('cccc0000-0000-0000-0000-0000000000f0','22222222-2222-2222-2222-222222222222',15.00, now()),
  ('cccc0000-0000-0000-0000-0000000000f1','22222222-2222-2222-2222-222222222222',15.00, now());

-- The assertion. Every lead in the table, both answers, no exceptions.
select test_util.assert_eq(
  (select count(*)::integer from public.leads l
    where public.lead_retired_from_allocation(l.id)
       is distinct from test_util.lead_retired_0111(l.id)),
  0, 'the rewritten predicate agrees with 0111 on every one of 34 shapes');

-- And the same claim stated the other way round, so a function that returned
-- NULL throughout would not satisfy both.
select test_util.assert_eq(
  (select count(*)::integer from public.leads l
    where test_util.lead_retired_0111(l.id)),
  29, 'the matrix really does contain retired leads — 27 of the 32 shapes, plus both claimed ones');

select test_util.assert_eq(
  (select count(*)::integer from public.leads l
    where not test_util.lead_retired_0111(l.id)),
  5, 'and five it must leave alone: clean, override-only, qualified-owned, and the two combinations of those');

-- ⚠️ A LEAD THAT DOES NOT EXIST STAYS FALSE. 0111 answered `exists() or
-- exists()`, which is false for an unknown id. 0144 selects from leads, gets no
-- row, and a scalar SQL function with no row yields NULL — so `is not null`
-- is false and the answer survives. Same result, different route; worth its own
-- assertion because nothing else would notice it changing.
select test_util.assert_eq(
  public.lead_retired_from_allocation('00000000-0000-0000-0000-0000000000ff'),
  false, 'an unknown lead id is not retired');
select test_util.assert_eq(
  public.lead_retirement_reason('00000000-0000-0000-0000-0000000000ff'),
  null::text, 'and it has no reason either');

-- ---------------------------------------------------------------------------
-- 2 — The reason values, one per basis
--
-- These strings are the contract with src/lib/leadRetirement.ts, which maps
-- them to what an admin reads. A value added here and not there renders as the
-- raw key; a value renamed here and not there renders as nothing.
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  public.lead_retirement_reason('cccc0000-0000-0000-0000-000000000000'),
  null::text, 'a healthy lead has no reason');
select test_util.assert_eq(
  public.lead_retirement_reason('cccc0000-0000-0000-0000-000000000001'),
  'pool_expired', 'an expired lead reports pool_expired');
select test_util.assert_eq(
  public.lead_retirement_reason('cccc0000-0000-0000-0000-000000000002'),
  'pooled_ignored', 'a lead pooled as ignored reports pooled_ignored');
select test_util.assert_eq(
  public.lead_retirement_reason('cccc0000-0000-0000-0000-000000000004'),
  'owner_unqualified', 'an unqualified owned lead reports owner_unqualified');
select test_util.assert_eq(
  public.lead_retirement_reason('cccc0000-0000-0000-0000-000000000010'),
  'quality_failed', 'a quality-blocked lead reports quality_failed');
select test_util.assert_eq(
  public.lead_retirement_reason('cccc0000-0000-0000-0000-0000000000f0'),
  'claimed_from_pool', 'a pool-claimed lead reports claimed_from_pool');

-- The two cases where a basis is present and DELIBERATELY not retiring.
select test_util.assert_eq(
  public.lead_retirement_reason('cccc0000-0000-0000-0000-00000000000c'),
  null::text, 'a resale-QUALIFIED owned lead has no reason (0108)');
select test_util.assert_eq(
  public.lead_retirement_reason('cccc0000-0000-0000-0000-000000000018'),
  null::text, 'a quality-blocked lead with an override has no reason (§36.4)');

-- ⚠️ Arm precedence. A pool claim outranks everything below it, because it is
-- the only basis with no admin escape hatch — clearing the quality flag on this
-- lead would leave it just as unsellable, so reporting the flag would send an
-- admin to a control that changes nothing.
select test_util.assert_eq(
  public.lead_retirement_reason('cccc0000-0000-0000-0000-0000000000f1'),
  'claimed_from_pool',
  'a claimed AND quality-blocked lead reports the claim, not the flag');

-- ---------------------------------------------------------------------------
-- 3 — The picker returns them, greyed rather than absent
-- ---------------------------------------------------------------------------
insert into public.leads
  (id, monday_item_id, lead_name, postcode, postcode_area, bedrooms,
   max_assignments, assignment_count)
values
  ('dddd0000-0000-0000-0000-000000000001','m-out','Outgoing','BS9 9ZZ','BS','3',3,1);
insert into public.lead_assignments (id, lead_id, customer_id, price_paid)
values
  ('bbbb0000-0000-0000-0000-000000000001','dddd0000-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111',15.00);

select test_util.assert_eq(
  (select retired_reason from public.get_swap_candidates_for_assignment(
     'bbbb0000-0000-0000-0000-000000000001', null, 200)
   where id = 'cccc0000-0000-0000-0000-000000000010'),
  'quality_failed', 'the picker returns a quality-blocked lead, carrying its reason');

select test_util.assert_eq(
  (select retired_reason from public.get_swap_candidates_for_assignment(
     'bbbb0000-0000-0000-0000-000000000001', null, 200)
   where id = 'cccc0000-0000-0000-0000-000000000002'),
  'pooled_ignored', 'and a pooled-ignored one');

select test_util.assert_eq(
  (select retired_reason from public.get_swap_candidates_for_assignment(
     'bbbb0000-0000-0000-0000-000000000001', null, 200)
   where id = 'cccc0000-0000-0000-0000-000000000000'),
  null::text, 'a selectable lead carries no reason');

-- ⚠️ Owned leads stay EXCLUDED, not greyed, and the reason is that the two
-- rules are different questions. An unqualified owned lead would carry
-- owner_unqualified and read correctly; a QUALIFIED one carries nothing at all
-- (0108 took it out of the predicate) and would read as selectable while the
-- swap refuses it on its own owner rule. Greying one and not the other is
-- worse than withholding both.
select test_util.assert_eq(
  (select count(*)::integer from public.get_swap_candidates_for_assignment(
     'bbbb0000-0000-0000-0000-000000000001', null, 200)
   where id = 'cccc0000-0000-0000-0000-00000000000c'),
  0, 'a resale-qualified owned lead is still absent, not greyed');
select test_util.assert_eq(
  (select count(*)::integer from public.get_swap_candidates_for_assignment(
     'bbbb0000-0000-0000-0000-000000000001', null, 200)
   where id = 'cccc0000-0000-0000-0000-000000000004'),
  0, 'and so is an unqualified one');

-- ---------------------------------------------------------------------------
-- 4 — ⚠️ THE ORDERING, WHICH IS NOT COSMETIC
--
-- The list is capped. A retired lead sorting by created_at alongside the rest
-- would consume a slot a selectable lead needed, so the picker would show
-- FEWER usable options than before 0144 — a worse outcome than the silence
-- this is fixing.
-- ---------------------------------------------------------------------------
create temporary table t_order as
select retired_reason, row_number() over () as row_no
from public.get_swap_candidates_for_assignment(
  'bbbb0000-0000-0000-0000-000000000001', null, 200);

select test_util.assert_eq(
  (select count(*)::integer from t_order where retired_reason is null), 3,
  'the matrix leaves three selectable candidates');
select test_util.assert_eq(
  (select count(*)::integer from t_order where retired_reason is not null), 15,
  'and fifteen unavailable ones — enough that a bad sort would be visible');

select test_util.assert_eq(
  (select (max(row_no) filter (where retired_reason is null))
        < (min(row_no) filter (where retired_reason is not null))
     from t_order),
  true, 'every selectable candidate sorts before every unavailable one');

-- ---------------------------------------------------------------------------
-- 5 — ⚠️ AND THEREFORE THE CAP NEVER SPENDS ITSELF ON AN UNAVAILABLE LEAD
--
-- The consequence of §4, asserted directly rather than inferred: ask for fewer
-- rows than there are selectable leads and not one unavailable row comes back.
-- Stated here so it is not mistaken for a bug later — where selectable stock
-- exceeds the cap, the greyed rows are simply not shown, and the search box is
-- what narrows to them.
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select count(*)::integer from public.get_swap_candidates_for_assignment(
     'bbbb0000-0000-0000-0000-000000000001', null, 3)
   where retired_reason is not null),
  0, 'a cap at the selectable count returns no unavailable leads at all');

-- The search box is the way to them, which is what makes that acceptable.
select test_util.assert_eq(
  (select retired_reason from public.get_swap_candidates_for_assignment(
     'bbbb0000-0000-0000-0000-000000000001', 'Matrix 16', 3)
   where id = 'cccc0000-0000-0000-0000-000000000010'),
  'quality_failed', 'searching for one by name still finds it, greyed');

-- ---------------------------------------------------------------------------
-- 6 — ⚠️ THE REFUSAL IS UNCHANGED. 0144 CHANGES WHAT IS SHOWN, NOT WHAT IS
--     ALLOWED.
--
-- This is the assertion that would catch the obvious over-reach: having put the
-- rows back in the list, letting them through the swap as well. 0143's guard
-- stands, and the filter override still does not open it.
-- ---------------------------------------------------------------------------
select test_util.assert_raises_like($q$
  select public.admin_swap_lead_assignment(
    'bbbb0000-0000-0000-0000-000000000001',
    'cccc0000-0000-0000-0000-000000000010', false)
$q$, '%retired from allocation%', 'a greyed lead is still refused by the swap');

select test_util.assert_raises_like($q$
  select public.admin_swap_lead_assignment(
    'bbbb0000-0000-0000-0000-000000000001',
    'cccc0000-0000-0000-0000-000000000010', true)
$q$, '%retired from allocation%',
   'and p_allow_filter_mismatch still does not override it');

select test_util.assert_eq(
  (select count(*)::integer from public.lead_assignments
    where id = 'bbbb0000-0000-0000-0000-000000000001'),
  1, 'a refused swap leaves the assignment standing');

-- The regression beside it: a selectable candidate still swaps in.
select public.admin_swap_lead_assignment(
  'bbbb0000-0000-0000-0000-000000000001',
  'cccc0000-0000-0000-0000-000000000000', false);
select test_util.assert_eq(
  (select count(*)::integer from public.lead_assignments
    where lead_id = 'cccc0000-0000-0000-0000-000000000000'
      and customer_id = '11111111-1111-1111-1111-111111111111'),
  1, 'a selectable candidate still swaps in');
select test_util.assert_eq(
  (select lead_balance from public.customers
    where id = '11111111-1111-1111-1111-111111111111'),
  17, 'and still moves no money');

-- ---------------------------------------------------------------------------
-- 7 — ⚠️ THE BOOLEAN DELEGATES, SO THE ARMS CANNOT DRIFT
--
-- §1 proves the two agree TODAY. This is what keeps them agreeing: there is one
-- copy of the arms, and the boolean is derived from it. A sixth basis added to
-- the reason function reaches invariant 11's predicate for free; a sixth basis
-- added to a second, parallel copy would not, and no behavioural test would
-- notice until somebody wrote a seed for it.
--
-- Asserted on the real body rather than on behaviour, because that is the only
-- thing that can see the shape (§42.8 — a boundary asserted in prose and never
-- written cost 91 sequence runs).
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select p.prosrc like '%lead_retirement_reason%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'lead_retired_from_allocation'),
  true, 'lead_retired_from_allocation is derived from lead_retirement_reason');

-- And it holds no arms of its own — a body that both delegated AND kept a
-- clause would satisfy the test above while drifting exactly as before.
select test_util.assert_eq(
  (select p.prosrc not like '%pool_entry_basis%'
      and p.prosrc not like '%lead_quality_status%'
      and p.prosrc not like '%owner_resale_qualified_at%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'lead_retired_from_allocation'),
  true, 'and carries no copy of the arms itself');

-- ---------------------------------------------------------------------------
-- 8 — The ACLs the DROP discarded, and invariant 7
--
-- get_swap_candidates_for_assignment gains a column, so it is dropped and
-- recreated — and a drop takes the grants with it (§11: 0038 dropped a function
-- and handed it back to anon).
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('get_swap_candidates_for_assignment',
                        'lead_retirement_reason',
                        'lead_retired_from_allocation')
      and (has_function_privilege('anon', p.oid, 'execute')
        or has_function_privilege('authenticated', p.oid, 'execute'))),
  0, 'anon and authenticated can execute none of the three');

select test_util.assert_eq(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('get_swap_candidates_for_assignment',
                        'lead_retirement_reason',
                        'lead_retired_from_allocation')
      and has_function_privilege('service_role', p.oid, 'execute')),
  3, 'and service_role can execute all three');

select test_util.assert_eq(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('get_engagement_benchmarks','set_management_customer_goal',
                        'get_operator_proof','get_recent_wins_anonymised')
      and has_function_privilege('authenticated', p.oid, 'execute')),
  4, 'invariant 7: the four customer-callable functions still are');

-- Both new bodies pin search_path, or Supabase's linter grows a finding and a
-- list nobody reads is a list that stops being read (§31).
select test_util.assert_eq(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('get_swap_candidates_for_assignment','lead_retirement_reason',
                        'lead_retired_from_allocation')
      and (p.proconfig is null
        or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))),
  0, 'all three pin search_path');

\o
select '0144 BEHAVIOURAL TESTS PASSED' as result;
