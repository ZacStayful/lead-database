-- ============================================================================
-- Behavioural tests for 0139 — a reported lead can be REPLACED (CLAUDE.md §51).
--
-- 0139 makes a swap a second resolution for an upheld claim, which puts it on
-- the same footing as 0137: every assertion below is about money, or about the
-- evidence that justifies moving it.
--
-- The one that matters most is §2. admin_swap_lead_assignment DELETES the
-- assignment, and before 0139 the claim cascaded away with it — so approving a
-- claim by swapping destroyed the reason, the landlord's own words and the
-- record that we had decided anything. Everything else here is secondary.
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
-- Seed: one operator holding a worked lead, and spare stock to swap in.
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
   account_status, subscription_status)
values
  ('11111111-1111-1111-1111-111111111111','Alpha','A','a@x.com',20,20,3,current_date,0.10,'active','active'),
  ('22222222-2222-2222-2222-222222222222','Beta','B','b@x.com',20,20,3,current_date,0.10,'active','active');

insert into public.leads (id, monday_item_id, lead_name, postcode_area, bedrooms, max_assignments, assignment_count)
values
  ('aaaa0000-0000-0000-0000-000000000001','m-swap-1','Reported Landlord','BS','3',3,1),
  ('aaaa0000-0000-0000-0000-000000000002','m-swap-2','Replacement Landlord','BS','3',3,0),
  ('aaaa0000-0000-0000-0000-000000000003','m-swap-3','Second Replacement','BS','3',3,0);

insert into public.lead_assignments (id, lead_id, customer_id, price_paid, assigned_at)
values
  ('bbbb0000-0000-0000-0000-000000000001','aaaa0000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',15.00, now() - interval '2 days');

-- Worked: one open and one call, so the effort gate admits it.
insert into public.lead_events (assignment_id, event_type)
values
  ('bbbb0000-0000-0000-0000-000000000001','detail_opened'),
  ('bbbb0000-0000-0000-0000-000000000001','tel_click');

-- ---------------------------------------------------------------------------
-- 1 — The vocabulary. Six reasons, and both CHECKs agree.
-- ---------------------------------------------------------------------------
do $$
declare r text;
begin
  foreach r in array array['already_with_operator','never_interested','no_longer_interested',
                           'property_sold','unreachable','wrong_details']
  loop
    begin
      insert into public.lead_quality_claims
        (lead_assignment_id, lead_id, customer_id, reason, detail, status)
      values ('bbbb0000-0000-0000-0000-000000000001','aaaa0000-0000-0000-0000-000000000001',
              '11111111-1111-1111-1111-111111111111', r, 'twenty characters of detail here', 'under_review');
      delete from public.lead_quality_claims;
    exception when others then
      raise exception 'FAIL the claim CHECK refused %', r;
    end;
  end loop;
  raise notice 'ok  all six reasons are accepted by lead_quality_claims';
end $$;

select test_util.assert_raises($q$
  insert into public.lead_quality_claims
    (lead_assignment_id, lead_id, customer_id, reason, detail, status)
  values ('bbbb0000-0000-0000-0000-000000000001','aaaa0000-0000-0000-0000-000000000001',
          '11111111-1111-1111-1111-111111111111','made_up_reason','twenty characters of detail here','under_review');
$q$, 'a seventh reason is refused');

do $$
declare r text;
begin
  foreach r in array array['already_with_operator','never_interested','no_longer_interested',
                           'property_sold','unreachable','wrong_details']
  loop
    begin
      insert into public.lead_outcome_reasons (customer_id, lead_id, outcome, reason)
      values ('11111111-1111-1111-1111-111111111111','aaaa0000-0000-0000-0000-000000000001','report', r);
    exception when others then
      raise exception 'FAIL the outcome CHECK refused report reason %', r;
    end;
  end loop;
  delete from public.lead_outcome_reasons;
  raise notice 'ok  all six reasons are accepted by lead_outcome_reasons';
end $$;

-- ⚠️ The two halves must never overlap (§51.10). A landlord-state reason on the
-- reject list would be a no-refund path to the refundable sentence.
select test_util.assert_raises($q$
  insert into public.lead_outcome_reasons (customer_id, lead_id, outcome, reason)
  values ('11111111-1111-1111-1111-111111111111','aaaa0000-0000-0000-0000-000000000001','reject','never_interested');
$q$, 'a report reason is still refused on a reject');

-- ---------------------------------------------------------------------------
-- 2 — ⚠️ THE ASSERTION THIS MIGRATION EXISTS FOR.
--     A claim survives the swap that fulfils it.
-- ---------------------------------------------------------------------------
select public.apply_dead_lead_claim(
  'bbbb0000-0000-0000-0000-000000000001'::uuid,
  '11111111-1111-1111-1111-111111111111'::uuid,
  'already_with_operator',
  'They told me they had signed with another agent a fortnight ago.',
  current_date, 'review', false, 'none', 14
);

select test_util.assert_eq(
  (select origin_assignment_id from public.lead_quality_claims limit 1),
  'bbbb0000-0000-0000-0000-000000000001'::uuid,
  'origin_assignment_id is derived on insert, without the writer naming it');

-- Balances before.
create temp table before_swap as
  select lead_balance, leads_received_this_month, quality_claims_this_cycle, clean_leads_streak
  from public.customers where id = '11111111-1111-1111-1111-111111111111';

select public.resolve_dead_lead_claim_with_swap(
  (select id from public.lead_quality_claims limit 1),
  null, 'Landlord confirmed it', 'aaaa0000-0000-0000-0000-000000000002'::uuid, false
);

select test_util.assert_eq(
  (select count(*)::int from public.lead_quality_claims), 1,
  '⚠️ the claim SURVIVES the swap that fulfilled it');

select test_util.assert_eq(
  (select lead_assignment_id from public.lead_quality_claims limit 1), null::uuid,
  'its pointer is nulled rather than cascaded away');

select test_util.assert_eq(
  (select origin_assignment_id from public.lead_quality_claims limit 1),
  'bbbb0000-0000-0000-0000-000000000001'::uuid,
  'and origin_assignment_id still names the assignment it came from');

select test_util.assert_eq(
  (select detail from public.lead_quality_claims limit 1),
  'They told me they had signed with another agent a fortnight ago.',
  'the landlord''s own words survive — the evidence the feature collects');

select test_util.assert_eq(
  (select resolution from public.lead_quality_claims limit 1), 'swap',
  'it records that it was settled with a replacement');

select test_util.assert_eq(
  (select replacement_lead_id from public.lead_quality_claims limit 1),
  'aaaa0000-0000-0000-0000-000000000002'::uuid,
  'and which lead was handed over');

select test_util.assert_eq(
  (select count(*)::int from public.lead_assignments
    where id = (select replacement_assignment_id from public.lead_quality_claims limit 1)),
  1, 'the replacement assignment exists and is recorded');

-- ---------------------------------------------------------------------------
-- 3 — ⚠️ A SWAP MOVES NO MONEY. The customer keeps the slot they paid for.
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select lead_balance from public.customers where id='11111111-1111-1111-1111-111111111111'),
  (select lead_balance from before_swap),
  '⚠️ no credit is returned by a swap');

select test_util.assert_eq(
  (select leads_received_this_month from public.customers where id='11111111-1111-1111-1111-111111111111'),
  (select leads_received_this_month from before_swap),
  'the monthly counter is not rolled back');

select test_util.assert_eq(
  (select quality_claims_this_cycle from public.customers where id='11111111-1111-1111-1111-111111111111'),
  (select quality_claims_this_cycle from before_swap),
  'no allowance is spent on a swap');

select test_util.assert_eq(
  (select clean_leads_streak from public.customers where id='11111111-1111-1111-1111-111111111111'),
  (select clean_leads_streak from before_swap),
  'and the clean streak is not reset');

select test_util.assert_eq(
  (select price_paid from public.lead_assignments
    where id = (select replacement_assignment_id from public.lead_quality_claims limit 1)),
  15.00::numeric, 'the replacement carries the same price_paid');

-- The reported lead is withdrawn and clamped, so it is never sold on (§19.6).
select test_util.assert_eq(
  (select withdrawn_at is not null from public.leads where id='aaaa0000-0000-0000-0000-000000000001'),
  true, 'the reported lead is withdrawn from circulation');

-- ---------------------------------------------------------------------------
-- 4 — Settling twice is refused, and a second claim cannot reuse the origin.
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  public.resolve_dead_lead_claim_with_swap(
    (select id from public.lead_quality_claims limit 1),
    null, 'again', 'aaaa0000-0000-0000-0000-000000000003'::uuid, false),
  null::uuid,
  'an already-settled claim returns null rather than swapping twice');

select test_util.assert_eq(
  (select count(*)::int from public.lead_assignments
    where lead_id='aaaa0000-0000-0000-0000-000000000003'),
  0, 'and no second replacement was handed over');

select test_util.assert_raises($q$
  insert into public.lead_quality_claims
    (lead_assignment_id, origin_assignment_id, lead_id, customer_id, reason, detail, status)
  values (null,'bbbb0000-0000-0000-0000-000000000001','aaaa0000-0000-0000-0000-000000000001',
          '11111111-1111-1111-1111-111111111111','unreachable','twenty characters of detail here','under_review');
$q$, '⚠️ the idempotency guard still holds after the pointer is nulled');

-- ---------------------------------------------------------------------------
-- 5 — ⚠️ Atomicity. A refused swap settles nothing.
--
-- The whole reason resolve_dead_lead_claim_with_swap exists rather than two
-- HTTP calls: if the swap fails, the claim must not be left marked upheld.
-- ---------------------------------------------------------------------------
delete from public.lead_quality_claims;
update public.leads set withdrawn_at = null, max_assignments = 3, assignment_count = 1
  where id = 'aaaa0000-0000-0000-0000-000000000001';
insert into public.lead_assignments (id, lead_id, customer_id, price_paid, assigned_at)
values ('bbbb0000-0000-0000-0000-000000000009','aaaa0000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',15.00, now() - interval '2 days');
insert into public.lead_events (assignment_id, event_type)
values ('bbbb0000-0000-0000-0000-000000000009','tel_click');

select public.apply_dead_lead_claim(
  'bbbb0000-0000-0000-0000-000000000009'::uuid,
  '11111111-1111-1111-1111-111111111111'::uuid,
  'never_interested', 'They never wanted a management service at all.',
  current_date, 'review', false, 'none', 14
);

-- Swapping in a lead the customer ALREADY holds is refused by 0109.
select test_util.assert_raises(
  format($q$ select public.resolve_dead_lead_claim_with_swap(%L, null, 'x', %L, false) $q$,
         (select id from public.lead_quality_claims limit 1),
         'aaaa0000-0000-0000-0000-000000000001'),
  'a swap the underlying function refuses raises');

select test_util.assert_eq(
  (select status from public.lead_quality_claims limit 1), 'under_review',
  '⚠️ and the claim is left under_review, not marked upheld');

select test_util.assert_eq(
  (select count(*)::int from public.lead_assignments where id='bbbb0000-0000-0000-0000-000000000009'),
  1, 'the assignment is still there — nothing was half-settled');

-- ---------------------------------------------------------------------------
-- 6 — get_assignment_effort sees a LIVE assignment, which is its whole point.
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select status from public.lead_assignments where id='bbbb0000-0000-0000-0000-000000000009'),
  'contacted', 'the assignment is live (a tel_click flipped it to contacted)');

insert into public.lead_events (assignment_id, event_type)
values ('bbbb0000-0000-0000-0000-000000000009','detail_opened'),
       ('bbbb0000-0000-0000-0000-000000000009','detail_opened'),
       ('bbbb0000-0000-0000-0000-000000000009','whatsapp_click'),
       ('bbbb0000-0000-0000-0000-000000000009','nudge_sent');

select test_util.assert_eq(
  (select opens from public.get_assignment_effort(array['bbbb0000-0000-0000-0000-000000000009'::uuid])),
  2, 'opens are counted');

select test_util.assert_eq(
  (select contact_clicks from public.get_assignment_effort(array['bbbb0000-0000-0000-0000-000000000009'::uuid])),
  2, 'contact clicks are counted (tel + whatsapp)');

-- ⚠️ §3: our own nudge is not the operator's effort.
select test_util.assert_eq(
  (select opens + contact_clicks from public.get_assignment_effort(array['bbbb0000-0000-0000-0000-000000000009'::uuid])),
  4, '⚠️ nudge_sent is excluded from both tallies');

select test_util.assert_eq(
  (select tel_clicks from public.get_assignment_effort(array['bbbb0000-0000-0000-0000-000000000009'::uuid])),
  1, 'and the channels are broken out');

select test_util.assert_eq(
  (select count(*)::int from public.get_outcome_evidence('rejected')),
  0, '⚠️ get_outcome_evidence is untouched — it still cannot see a live assignment');

-- ---------------------------------------------------------------------------
-- 7 — Invariant 7. Nothing new is reachable from a browser.
-- ---------------------------------------------------------------------------
do $$
declare f text; r text;
begin
  foreach f in array array[
    'resolve_dead_lead_claim_with_swap(uuid, uuid, text, uuid, boolean)',
    'get_assignment_effort(uuid[])',
    'flag_lead_dead_if_unanimous(uuid)']
  loop
    foreach r in array array['anon','authenticated'] loop
      if has_function_privilege(r, f, 'execute') then
        raise exception 'FAIL % is executable by %', f, r;
      end if;
    end loop;
    if not has_function_privilege('service_role', f, 'execute') then
      raise exception 'FAIL service_role cannot execute %', f;
    end if;
  end loop;
  raise notice 'ok  anon and authenticated cannot execute any 0139 function';
end $$;

-- Resolved by NAME rather than by a hand-written signature, the way 0138 does
-- it: get_recent_wins_anonymised takes a p_limit, and spelling a signature out
-- here is how this assertion silently starts testing nothing.
select test_util.assert_eq(
  (select bool_and(has_function_privilege('authenticated', p.oid, 'execute'))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('get_engagement_benchmarks','set_management_customer_goal',
                        'get_operator_proof','get_recent_wins_anonymised')),
  true, 'invariant 7 holds — its four are still authenticated-executable');

\o
\echo '== 0139 BEHAVIOURAL TESTS PASSED =='
