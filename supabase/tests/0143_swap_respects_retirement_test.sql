-- ============================================================================
-- Behavioural tests for 0143 — the admin swap honours invariant 11 (§53.7).
--
-- 0109 built the swap's candidate list out of the rules it could see. 0111's
-- quality gate and 0073's pool retirement both landed afterwards and nothing
-- joined them up, so the picker went on offering 42 of 335 in-stock leads that
-- ordinary routing had already refused to sell.
--
-- These assertions are about the boundary: which leads leave the picker, which
-- deliberately stay, and that the two admin escape hatches un-retire a lead
-- everywhere rather than needing a per-swap override.
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
    raise notice 'ok  % (%)', label, SQLERRM;
    return;
  end;
  raise exception 'FAIL % — expected an exception, none raised', label;
end $$;

-- Asserts the message too, because 0143 turns on WHICH guard fires first.
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

delete from public.lead_outcome_reasons;
delete from public.lead_quality_claims;
delete from public.lead_events;
delete from public.lead_notes;
delete from public.lead_assignments;
delete from public.leads;
delete from public.customers;

-- One unfiltered customer, so matches_filter is true throughout and the 0109
-- guard never fires — this suite is about the 0143 one.
insert into public.customers
  (id, business_name, contact_name, email, monthly_allocation, lead_balance,
   leads_received_this_month, management_lifetime_leads_received,
   account_status, subscription_status)
values
  ('11111111-1111-1111-1111-111111111111','Alpha','A','a@x.com',20,17,3,9,
   'active','active');

-- The lead being replaced, plus six candidates: one healthy, and one of each
-- retirement basis, and one pooled on the basis that is deliberately NOT
-- retired (§19.1).
insert into public.leads
  (id, monday_item_id, lead_name, postcode, postcode_area, bedrooms,
   max_assignments, assignment_count)
values
  ('aaaa0000-0000-0000-0000-000000000001','m-out','Outgoing','BS1 1AA','BS','3',3,1),
  ('aaaa0000-0000-0000-0000-000000000002','m-ok','Healthy','BS2 2BB','BS','3',3,0),
  ('aaaa0000-0000-0000-0000-000000000003','m-bad','Bad number','BS3 3CC','BS','3',3,0),
  ('aaaa0000-0000-0000-0000-000000000004','m-pool','Pooled ignored','BS4 4DD','BS','3',3,0),
  ('aaaa0000-0000-0000-0000-000000000005','m-unas','Pooled unassigned','BS5 5EE','BS','3',3,0),
  ('aaaa0000-0000-0000-0000-000000000006','m-claimed','Pool claimed','BS6 6FF','BS','3',3,0),
  ('aaaa0000-0000-0000-0000-000000000007','m-out2','Outgoing blocked','BS7 7GG','BS','3',3,1),
  ('aaaa0000-0000-0000-0000-000000000009','m-out3','Outgoing spare','BS9 9II','BS','3',3,1);

update public.leads set lead_quality_status = 'failed',
                        lead_quality_codes  = array['not_mobile']
  where id = 'aaaa0000-0000-0000-0000-000000000003';

update public.leads set pool_entered_at = now() - interval '1 day',
                        pool_first_entered_at = now() - interval '1 day',
                        pool_entry_basis = 'ignored'
  where id = 'aaaa0000-0000-0000-0000-000000000004';

update public.leads set pool_entered_at = now() - interval '1 day',
                        pool_first_entered_at = now() - interval '1 day',
                        pool_entry_basis = 'unassigned'
  where id = 'aaaa0000-0000-0000-0000-000000000005';

-- The outgoing assignments. The second one's lead is itself quality-blocked,
-- which §2 of the migration says must still be swappable OUT.
insert into public.lead_assignments (id, lead_id, customer_id, price_paid)
values
  ('bbbb0000-0000-0000-0000-000000000001','aaaa0000-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111',15.00),
  ('bbbb0000-0000-0000-0000-000000000002','aaaa0000-0000-0000-0000-000000000007',
   '11111111-1111-1111-1111-111111111111',15.00),
  -- Kept back for §8. Every other outgoing assignment is consumed by a swap
  -- above, and a deleted one raises "not found" before reaching the guard.
  ('bbbb0000-0000-0000-0000-000000000003','aaaa0000-0000-0000-0000-000000000009',
   '11111111-1111-1111-1111-111111111111',15.00);

update public.leads set lead_quality_status = 'failed',
                        lead_quality_codes  = array['not_mobile']
  where id = 'aaaa0000-0000-0000-0000-000000000007';

-- A pool CLAIM on lead 6, by a different customer, which retires it for ever
-- (invariant 11) and has no admin escape hatch by design.
insert into public.customers
  (id, business_name, contact_name, email, account_status, subscription_status)
values ('22222222-2222-2222-2222-222222222222','Beta','B','b@x.com','active','active');
insert into public.lead_assignments (lead_id, customer_id, price_paid, claimed_from_pool_at)
values ('aaaa0000-0000-0000-0000-000000000006','22222222-2222-2222-2222-222222222222',
        15.00, now());
update public.leads set assignment_count = 1
  where id = 'aaaa0000-0000-0000-0000-000000000006';

-- ---------------------------------------------------------------------------
-- 1 — The predicate agrees with the seed before anything is swapped
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  public.lead_retired_from_allocation('aaaa0000-0000-0000-0000-000000000002'), false,
  'a healthy lead is not retired');
select test_util.assert_eq(
  public.lead_retired_from_allocation('aaaa0000-0000-0000-0000-000000000003'), true,
  'a quality-blocked lead is retired');
select test_util.assert_eq(
  public.lead_retired_from_allocation('aaaa0000-0000-0000-0000-000000000004'), true,
  'a lead pooled on the ignored basis is retired');
select test_util.assert_eq(
  public.lead_retired_from_allocation('aaaa0000-0000-0000-0000-000000000005'), false,
  'a lead pooled on the UNASSIGNED basis is NOT retired (§19.1)');
select test_util.assert_eq(
  public.lead_retired_from_allocation('aaaa0000-0000-0000-0000-000000000006'), true,
  'a pool-claimed lead is retired');

-- ---------------------------------------------------------------------------
-- 2 — The picker stops offering them, and keeps offering everything else
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select count(*)::integer from public.get_swap_candidates_for_assignment(
     'bbbb0000-0000-0000-0000-000000000001', null, 50)
   where id = 'aaaa0000-0000-0000-0000-000000000003'),
  0, 'the picker no longer offers a quality-blocked lead');

select test_util.assert_eq(
  (select count(*)::integer from public.get_swap_candidates_for_assignment(
     'bbbb0000-0000-0000-0000-000000000001', null, 50)
   where id = 'aaaa0000-0000-0000-0000-000000000004'),
  0, 'the picker no longer offers a lead pooled as ignored');

select test_util.assert_eq(
  (select count(*)::integer from public.get_swap_candidates_for_assignment(
     'bbbb0000-0000-0000-0000-000000000001', null, 50)
   where id = 'aaaa0000-0000-0000-0000-000000000006'),
  0, 'the picker no longer offers a pool-claimed lead');

-- ⚠️ The regression that matters most. Over-reaching here would take stock the
-- pool deliberately leaves in circulation out of every replacement dropdown.
select test_util.assert_eq(
  (select count(*)::integer from public.get_swap_candidates_for_assignment(
     'bbbb0000-0000-0000-0000-000000000001', null, 50)
   where id = 'aaaa0000-0000-0000-0000-000000000005'),
  1, 'a lead pooled as UNASSIGNED is still offered');

select test_util.assert_eq(
  (select count(*)::integer from public.get_swap_candidates_for_assignment(
     'bbbb0000-0000-0000-0000-000000000001', null, 50)
   where id = 'aaaa0000-0000-0000-0000-000000000002'),
  1, 'a healthy lead is still offered');

select test_util.assert_eq(
  (select matches_filter from public.get_swap_candidates_for_assignment(
     'bbbb0000-0000-0000-0000-000000000001', null, 50)
   where id = 'aaaa0000-0000-0000-0000-000000000002'),
  true, 'an unfiltered customer still sees every candidate as matching (0109)');

-- ---------------------------------------------------------------------------
-- 3 — The swap refuses them, and a refusal writes nothing
-- ---------------------------------------------------------------------------
select test_util.assert_raises_like($q$
  select public.admin_swap_lead_assignment(
    'bbbb0000-0000-0000-0000-000000000001',
    'aaaa0000-0000-0000-0000-000000000003', false)
$q$, '%retired from allocation%', 'a quality-blocked lead cannot be swapped in');

select test_util.assert_raises_like($q$
  select public.admin_swap_lead_assignment(
    'bbbb0000-0000-0000-0000-000000000001',
    'aaaa0000-0000-0000-0000-000000000004', false)
$q$, '%retired from allocation%', 'a lead pooled as ignored cannot be swapped in');

select test_util.assert_raises_like($q$
  select public.admin_swap_lead_assignment(
    'bbbb0000-0000-0000-0000-000000000001',
    'aaaa0000-0000-0000-0000-000000000006', false)
$q$, '%retired from allocation%', 'a pool-claimed lead cannot be swapped in');

-- ⚠️ The filter override must NOT open this door. 0109's flag says "bypass what
-- the customer asked for"; it has never meant "bypass invariant 11".
select test_util.assert_raises_like($q$
  select public.admin_swap_lead_assignment(
    'bbbb0000-0000-0000-0000-000000000001',
    'aaaa0000-0000-0000-0000-000000000003', true)
$q$, '%retired from allocation%',
   'p_allow_filter_mismatch does not override retirement');

select test_util.assert_eq(
  (select count(*)::integer from public.lead_assignments
    where id = 'bbbb0000-0000-0000-0000-000000000001'),
  1, 'a refused swap leaves the assignment standing');
select test_util.assert_eq(
  (select withdrawn_at is null from public.leads
    where id = 'aaaa0000-0000-0000-0000-000000000001'),
  true, 'a refused swap does not withdraw the outgoing lead');
select test_util.assert_eq(
  (select lead_balance from public.customers
    where id = '11111111-1111-1111-1111-111111111111'),
  17, 'a refused swap moves no money');

-- ---------------------------------------------------------------------------
-- 4 — Owned leads: §32.6 still holds, and the owner rule still speaks first
--
-- Two cases, and only the second is about ordering. A resale-qualified owned
-- lead left this predicate in 0108, so it is refused by the owner check
-- whatever order the two sit in. An UNqualified one satisfies both, and the
-- owner message is the specific one — so hoisting the new guard above it
-- silently downgrades what the admin is told.
-- ---------------------------------------------------------------------------
insert into public.leads
  (id, lead_name, postcode, postcode_area, bedrooms, max_assignments,
   assignment_count, owner_customer_id, owner_source, owner_resale_allowed,
   owner_resale_qualified_at, gross_annual_income)
values
  ('aaaa0000-0000-0000-0000-000000000008','Owned qualified','BS8 8HH','BS','3',
   2, 1, '22222222-2222-2222-2222-222222222222','manual', true, now(), 40000);

select test_util.assert_eq(
  public.lead_retired_from_allocation('aaaa0000-0000-0000-0000-000000000008'), false,
  'a resale-qualified owned lead is not retired (0108)');

select test_util.assert_raises_like($q$
  select public.admin_swap_lead_assignment(
    'bbbb0000-0000-0000-0000-000000000001',
    'aaaa0000-0000-0000-0000-000000000008', false)
$q$, '%added by a customer%',
   'a qualified owned lead is still refused by the OWNER rule, not the new one');

select test_util.assert_eq(
  (select count(*)::integer from public.get_swap_candidates_for_assignment(
     'bbbb0000-0000-0000-0000-000000000001', null, 50)
   where id = 'aaaa0000-0000-0000-0000-000000000008'),
  0, 'the picker still withholds a qualified owned lead');

-- The ordering case. This lead is retired AND owned, so both guards would
-- refuse it; the assertion is on WHICH message comes back.
insert into public.leads
  (id, lead_name, postcode, postcode_area, bedrooms, max_assignments,
   assignment_count, owner_customer_id, owner_source, owner_resale_allowed)
values
  ('aaaa0000-0000-0000-0000-00000000000a','Owned unqualified','BSA AJJ','BS','3',
   1, 0, '22222222-2222-2222-2222-222222222222','manual', true);

select test_util.assert_eq(
  public.lead_retired_from_allocation('aaaa0000-0000-0000-0000-00000000000a'), true,
  'an unqualified owned lead IS retired (0108)');

select test_util.assert_raises_like($q$
  select public.admin_swap_lead_assignment(
    'bbbb0000-0000-0000-0000-000000000001',
    'aaaa0000-0000-0000-0000-00000000000a', false)
$q$, '%added by a customer%',
   'an unqualified owned lead is refused by the OWNER rule, which speaks first');

-- ---------------------------------------------------------------------------
-- 5 — Both escape hatches un-retire a lead, so no per-swap override is needed
-- ---------------------------------------------------------------------------
update public.leads set lead_quality_override_at = now(),
                        lead_quality_override_by = 'test'
  where id = 'aaaa0000-0000-0000-0000-000000000003';
select test_util.assert_eq(
  public.lead_retired_from_allocation('aaaa0000-0000-0000-0000-000000000003'), false,
  'a quality override un-retires the lead (§36.4)');
select test_util.assert_eq(
  (select count(*)::integer from public.get_swap_candidates_for_assignment(
     'bbbb0000-0000-0000-0000-000000000001', null, 50)
   where id = 'aaaa0000-0000-0000-0000-000000000003'),
  1, 'and the picker offers it again');

select public.admin_pool_force_out('aaaa0000-0000-0000-0000-000000000004');
select test_util.assert_eq(
  public.lead_retired_from_allocation('aaaa0000-0000-0000-0000-000000000004'), false,
  'forcing a lead out of the pool un-retires it (§19.8)');
select test_util.assert_eq(
  (select count(*)::integer from public.get_swap_candidates_for_assignment(
     'bbbb0000-0000-0000-0000-000000000001', null, 50)
   where id = 'aaaa0000-0000-0000-0000-000000000004'),
  1, 'and the picker offers that one again too');

-- ---------------------------------------------------------------------------
-- 6 — A retired lead may still be swapped OUT (§2 of the migration)
-- ---------------------------------------------------------------------------
select public.admin_swap_lead_assignment(
  'bbbb0000-0000-0000-0000-000000000002',
  'aaaa0000-0000-0000-0000-000000000005', false);
select test_util.assert_eq(
  (select count(*)::integer from public.lead_assignments
    where lead_id = 'aaaa0000-0000-0000-0000-000000000005'
      and customer_id = '11111111-1111-1111-1111-111111111111'),
  1, 'a quality-blocked lead the customer HOLDS can still be swapped out');

-- ---------------------------------------------------------------------------
-- 7 — The regression: an ordinary swap is untouched and still moves no money
-- ---------------------------------------------------------------------------
select public.admin_swap_lead_assignment(
  'bbbb0000-0000-0000-0000-000000000001',
  'aaaa0000-0000-0000-0000-000000000002', false);

select test_util.assert_eq(
  (select count(*)::integer from public.lead_assignments
    where id = 'bbbb0000-0000-0000-0000-000000000001'),
  0, 'the outgoing assignment is gone');
select test_util.assert_eq(
  (select price_paid from public.lead_assignments
    where lead_id = 'aaaa0000-0000-0000-0000-000000000002'
      and customer_id = '11111111-1111-1111-1111-111111111111'),
  15.00, 'the replacement carries the same price_paid');
select test_util.assert_eq(
  (select withdrawn_at is not null and max_assignments = assignment_count
     from public.leads where id = 'aaaa0000-0000-0000-0000-000000000001'),
  true, 'the outgoing lead is withdrawn and clamped');
select test_util.assert_eq(
  (select lead_balance from public.customers
    where id = '11111111-1111-1111-1111-111111111111'),
  17, 'no credit is spent');
select test_util.assert_eq(
  (select leads_received_this_month from public.customers
    where id = '11111111-1111-1111-1111-111111111111'),
  3, 'the monthly counter does not move');
select test_util.assert_eq(
  (select management_lifetime_leads_received from public.customers
    where id = '11111111-1111-1111-1111-111111111111'),
  9, 'the odometer does not move (invariant 9)');
select test_util.assert_eq(
  (select clean_leads_streak from public.customers
    where id = '11111111-1111-1111-1111-111111111111'),
  0, 'a swap is not a delivery for the 0142 streak');

-- ---------------------------------------------------------------------------
-- 8 — The two-argument shim still delegates, and still refuses
-- ---------------------------------------------------------------------------
select test_util.assert_raises_like($q$
  select public.admin_swap_lead_assignment(
    'bbbb0000-0000-0000-0000-000000000003',
    'aaaa0000-0000-0000-0000-000000000006')
$q$, '%retired from allocation%',
   'the two-argument shim inherits the guard');

-- ---------------------------------------------------------------------------
-- 9 — Invariant 7 and the ACLs
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('admin_swap_lead_assignment','get_swap_candidates_for_assignment')
      and (has_function_privilege('anon', p.oid, 'execute')
        or has_function_privilege('authenticated', p.oid, 'execute'))),
  0, 'anon and authenticated can execute neither swap function');

select test_util.assert_eq(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('get_engagement_benchmarks','set_management_customer_goal',
                        'get_operator_proof','get_recent_wins_anonymised')
      and has_function_privilege('authenticated', p.oid, 'execute')),
  4, 'invariant 7: the four customer-callable functions still are');

-- ---------------------------------------------------------------------------
-- 10 — The customer's own swap inherits it (§3 of the migration)
--
-- 0141 filters its candidate list on this predicate but never re-asserted it at
-- the commit, so a lead the nightly sweep retired between the page loading and
-- the button being pressed would have gone through. It calls
-- admin_swap_lead_assignment, so the guard now covers it.
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'customer_swap_dead_lead'
      and p.prosrc like '%admin_swap_lead_assignment%'),
  1, 'customer_swap_dead_lead still commits through admin_swap_lead_assignment');

\o
select '0143 BEHAVIOURAL TESTS PASSED' as result;
