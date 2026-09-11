-- ============================================================================
-- Behavioural tests for 0138 — a reason on every outcome (CLAUDE.md §51.10).
--
-- Three things are worth asserting here and nothing else is:
--
--   1. THE REASON SURVIVES DISCARD. Discard deletes the assignment row, which
--      is why the reason lives in a table of its own with an ON DELETE SET NULL
--      pointer. If that ever regresses, discard silently stops recording the
--      one outcome it never recorded before.
--   2. BOTH ARITIES OF EVERY CHANGED FUNCTION RESOLVE. A defaulted parameter
--      would have made these overloads and broken every existing call with
--      "function is not unique" (§34, §35). The shims are also what make
--      migration-before-code safe.
--   3. AN OWNED LEAD IS NO LONGER REPORTABLE. It was charged nothing, so an
--      upheld report would have credited a lead nobody paid for.
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
-- ---------------------------------------------------------------------------
delete from public.lead_outcome_reasons;
delete from public.lead_quality_claims;
delete from public.lead_events;
delete from public.lead_assignments;
delete from public.leads;
delete from public.customers;

insert into public.customers
  (id, business_name, contact_name, email, monthly_allocation, lead_balance,
   leads_received_this_month, billing_cycle_anchor, account_status,
   subscription_status, is_active)
values
  ('11111111-1111-1111-1111-111111111111','Alpha','A','a@x.com',20,20,3,
   current_date,'active','active',true);

-- A marketplace lead, and one the customer uploaded themselves.
insert into public.leads (id, monday_item_id, lead_name, postcode_area, bedrooms)
values ('aaaa0000-0000-0000-0000-000000000001','m-138-1','Landlord One','BS','3');

insert into public.leads (id, monday_item_id, lead_name, postcode_area, bedrooms,
                          owner_customer_id, owner_source, income_report_status,
                          max_assignments, assignment_count)
values ('aaaa0000-0000-0000-0000-000000000002', null,'Own Landlord','GL','2',
        '11111111-1111-1111-1111-111111111111','manual','no_report',1,1);

-- One assignment per (lead, customer) is enforced by a unique constraint, so
-- each later step below needs a lead of its own.
insert into public.leads (id, monday_item_id, lead_name, postcode_area, bedrooms)
values ('aaaa0000-0000-0000-0000-000000000003','m-138-3','Landlord Three','BS','4'),
       ('aaaa0000-0000-0000-0000-000000000004','m-138-4','Landlord Four','GL','2'),
       ('aaaa0000-0000-0000-0000-000000000005','m-138-5','Landlord Five','BA','3');

insert into public.lead_assignments (id, lead_id, customer_id, price_paid, assigned_at)
values
  ('bbbb0000-0000-0000-0000-000000000001','aaaa0000-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111',15, now() - interval '2 days'),
  ('bbbb0000-0000-0000-0000-000000000002','aaaa0000-0000-0000-0000-000000000002',
   '11111111-1111-1111-1111-111111111111',0, now() - interval '2 days');

-- Both worked, so both would satisfy §51's effort gate.
insert into public.lead_events (assignment_id, event_type)
values
  ('bbbb0000-0000-0000-0000-000000000001','tel_click'),
  ('bbbb0000-0000-0000-0000-000000000002','tel_click');

do $$
declare
  v_n         integer;
  v_lead      uuid;
  v_assign    uuid;
  v_area      text;
  v_reason    text;
  v_detail    text;
begin
  -- =========================================================================
  -- 1 — The table itself
  -- =========================================================================
  perform test_util.assert_eq(
    (select relrowsecurity from pg_class where relname = 'lead_outcome_reasons'),
    true, 'lead_outcome_reasons has RLS on');

  perform test_util.assert_eq(
    (select count(*)::int from pg_policies
      where tablename = 'lead_outcome_reasons'),
    0, 'and zero policies — deny-all to the browser');

  -- =========================================================================
  -- 2 — Every CHECK, on its boundaries
  -- =========================================================================
  perform test_util.assert_raises($q$
    insert into public.lead_outcome_reasons (customer_id, outcome, reason)
    values ('11111111-1111-1111-1111-111111111111','nonsense','wrong_area')
  $q$, 'an unknown outcome is refused');

  perform test_util.assert_raises($q$
    insert into public.lead_outcome_reasons (customer_id, outcome, reason)
    values ('11111111-1111-1111-1111-111111111111','reject','not_interested')
  $q$, 'a close reason is refused on a reject');

  -- ⚠️ The one that keeps the two halves apart: an operator must never be able
  -- to reject a lead "because the landlord had already gone", which would be a
  -- no-refund path to the refundable sentence.
  perform test_util.assert_raises($q$
    insert into public.lead_outcome_reasons (customer_id, outcome, reason)
    values ('11111111-1111-1111-1111-111111111111','reject','already_with_operator')
  $q$, 'a report reason is refused on a reject');

  perform test_util.assert_raises($q$
    insert into public.lead_outcome_reasons (customer_id, outcome, reason)
    values ('11111111-1111-1111-1111-111111111111','close','wrong_area')
  $q$, 'a reject reason is refused on a close');

  perform test_util.assert_raises($q$
    insert into public.lead_outcome_reasons (customer_id, outcome, reason, detail)
    values ('11111111-1111-1111-1111-111111111111','reject','other', repeat('x', 2001))
  $q$, 'a 2001-character detail is refused');

  insert into public.lead_outcome_reasons (customer_id, outcome, reason, detail)
  values ('11111111-1111-1111-1111-111111111111','reject','other', repeat('x', 2000));
  perform test_util.assert_eq(
    (select count(*)::int from public.lead_outcome_reasons), 1,
    'and 2000 characters is accepted');
  delete from public.lead_outcome_reasons;

  -- =========================================================================
  -- 3 — Reject records its reason, and both arities resolve
  -- =========================================================================
  perform public.reject_lead_assignment(
    'bbbb0000-0000-0000-0000-000000000001',
    '11111111-1111-1111-1111-111111111111',
    'wrong_area', 'Two hours from anywhere I cover.');

  select count(*)::int into v_n from public.lead_outcome_reasons where outcome = 'reject';
  perform test_util.assert_eq(v_n, 1, 'reject writes one reason row');

  select postcode_area, reason, detail into v_area, v_reason, v_detail
    from public.lead_outcome_reasons where outcome = 'reject';
  perform test_util.assert_eq(v_area, 'BS', 'and denormalises the postcode area');
  perform test_util.assert_eq(v_reason, 'wrong_area', 'and the reason');
  perform test_util.assert_eq(v_detail, 'Two hours from anywhere I cover.',
    'and the operator''s own words');

  perform test_util.assert_eq(
    (select status from public.lead_assignments
      where id = 'bbbb0000-0000-0000-0000-000000000001'),
    'rejected', 'and the assignment is rejected, as before');

  -- ⚠️ The two-argument shim. A call made before the code deploys must still
  -- work — that is what makes migration-before-code safe here.
  update public.lead_assignments
     set status = 'new' where id = 'bbbb0000-0000-0000-0000-000000000001';
  delete from public.lead_outcome_reasons;

  perform public.reject_lead_assignment(
    'bbbb0000-0000-0000-0000-000000000001',
    '11111111-1111-1111-1111-111111111111');
  perform test_util.assert_eq(
    (select status from public.lead_assignments
      where id = 'bbbb0000-0000-0000-0000-000000000001'),
    'rejected', 'the two-argument reject still rejects');
  perform test_util.assert_eq(
    (select count(*)::int from public.lead_outcome_reasons), 0,
    'and records no reason, rather than failing');

  -- An unknown reason is refused by the CHECK, so the outcome fails rather than
  -- being recorded wrongly.
  update public.lead_assignments
     set status = 'new' where id = 'bbbb0000-0000-0000-0000-000000000001';
  perform test_util.assert_raises($q$
    select public.reject_lead_assignment(
      'bbbb0000-0000-0000-0000-000000000001',
      '11111111-1111-1111-1111-111111111111', 'made_up', null)
  $q$, 'an unknown reject reason is refused');

  -- =========================================================================
  -- 4 — ⚠️ THE ONE THAT MATTERS: the reason survives discard
  -- =========================================================================
  update public.lead_assignments
     set status = 'new' where id = 'bbbb0000-0000-0000-0000-000000000001';
  delete from public.lead_outcome_reasons;

  perform public.discard_lead_assignment(
    'bbbb0000-0000-0000-0000-000000000001', 'at_capacity', null);

  perform test_util.assert_eq(
    (select count(*)::int from public.lead_assignments
      where id = 'bbbb0000-0000-0000-0000-000000000001'),
    0, 'discard deletes the assignment, as before');

  select count(*)::int into v_n from public.lead_outcome_reasons where outcome = 'discard';
  perform test_util.assert_eq(v_n, 1, 'and the reason row SURVIVES it');

  select lead_id, lead_assignment_id, postcode_area
    into v_lead, v_assign, v_area
    from public.lead_outcome_reasons where outcome = 'discard';
  perform test_util.assert_eq(v_lead, 'aaaa0000-0000-0000-0000-000000000001'::uuid,
    'with its lead_id intact');
  perform test_util.assert_eq(v_assign, null::uuid,
    'its assignment pointer nulled rather than cascaded away');
  perform test_util.assert_eq(v_area, 'BS',
    'and the area it was for, which the deleted row can no longer supply');

  perform test_util.assert_eq(
    (select assignment_count from public.leads
      where id = 'aaaa0000-0000-0000-0000-000000000001'),
    0, 'and the slot still reopens, as before');

  -- =========================================================================
  -- 5 — Close, and the one-argument discard shim
  -- =========================================================================
  insert into public.lead_assignments (id, lead_id, customer_id, price_paid, assigned_at)
  values ('bbbb0000-0000-0000-0000-000000000003','aaaa0000-0000-0000-0000-000000000003',
          '11111111-1111-1111-1111-111111111111',15, now() - interval '1 day');

  perform public.close_lead_assignment(
    'bbbb0000-0000-0000-0000-000000000003',
    '11111111-1111-1111-1111-111111111111',
    'sorted_elsewhere', 'Signed with someone last week.');

  perform test_util.assert_eq(
    (select count(*)::int from public.lead_outcome_reasons where outcome = 'close'),
    1, 'close writes one reason row');
  perform test_util.assert_eq(
    (select closed_reason from public.lead_assignments
      where id = 'bbbb0000-0000-0000-0000-000000000003'),
    'sorted_elsewhere', 'and closed_reason on the assignment is unchanged');

  perform test_util.assert_raises($q$
    select public.close_lead_assignment(
      'bbbb0000-0000-0000-0000-000000000003',
      '11111111-1111-1111-1111-111111111111', 'made_up', null)
  $q$, 'an unknown close reason is still refused');

  insert into public.lead_assignments (id, lead_id, customer_id, price_paid, assigned_at)
  values ('bbbb0000-0000-0000-0000-000000000004','aaaa0000-0000-0000-0000-000000000004',
          '11111111-1111-1111-1111-111111111111',15, now());
  perform public.discard_lead_assignment('bbbb0000-0000-0000-0000-000000000004');
  perform test_util.assert_eq(
    (select count(*)::int from public.lead_assignments
      where id = 'bbbb0000-0000-0000-0000-000000000004'),
    0, 'the one-argument discard still discards');

  -- =========================================================================
  -- 6 — ⚠️ An owned lead is no longer reportable
  -- =========================================================================
  perform test_util.assert_eq(
    (select count(*)::int from public.claimable_dead_lead_assignments(
       '11111111-1111-1111-1111-111111111111', 14)
      where assignment_id = 'bbbb0000-0000-0000-0000-000000000002'),
    0, 'a customer''s own lead is not claimable, though it was worked');

  -- And the regression beside it: a marketplace lead still is.
  insert into public.lead_assignments (id, lead_id, customer_id, price_paid, assigned_at)
  values ('bbbb0000-0000-0000-0000-000000000005','aaaa0000-0000-0000-0000-000000000005',
          '11111111-1111-1111-1111-111111111111',15, now());
  insert into public.lead_events (assignment_id, event_type)
  values ('bbbb0000-0000-0000-0000-000000000005','tel_click');
  perform test_util.assert_eq(
    (select count(*)::int from public.claimable_dead_lead_assignments(
       '11111111-1111-1111-1111-111111111111', 14)
      where assignment_id = 'bbbb0000-0000-0000-0000-000000000005'),
    1, 'and a marketplace lead still is');

  -- =========================================================================
  -- 7 — The orphans are gone
  -- =========================================================================
  perform test_util.assert_eq(
    (select count(*)::int from information_schema.columns
      where table_name = 'lead_assignments'
        and column_name in ('rejection_reason','contact_validation_result','claim_denied')),
    0, 'the three orphaned reject columns are dropped');

  perform test_util.assert_eq(
    (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'apply_lead_rejection'),
    0, 'and apply_lead_rejection with them — the last drift from a rebuild');

  -- =========================================================================
  -- 8 — Grants (§11's trap: a create-or-replace must re-assert them)
  -- =========================================================================
  perform test_util.assert_eq(
    (select bool_or(has_function_privilege(r, p.oid, 'execute'))
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace,
            unnest(array['anon','authenticated']) r
      where n.nspname = 'public'
        and p.proname in ('record_lead_outcome_reason','reject_lead_assignment',
                          'discard_lead_assignment','close_lead_assignment',
                          'claimable_dead_lead_assignments')),
    false, 'anon and authenticated cannot execute any 0138 function');

  perform test_util.assert_eq(
    (select bool_and(has_function_privilege('service_role', p.oid, 'execute'))
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('record_lead_outcome_reason','reject_lead_assignment',
                          'discard_lead_assignment','close_lead_assignment',
                          'claimable_dead_lead_assignments')),
    true, 'and service_role can execute all of them');

  -- Invariant 7: the four that must stay reachable by a signed-in customer.
  perform test_util.assert_eq(
    (select bool_and(has_function_privilege('authenticated', p.oid, 'execute'))
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('get_engagement_benchmarks','set_management_customer_goal',
                          'get_operator_proof','get_recent_wins_anonymised')),
    true, 'invariant 7 holds — its four are still authenticated-executable');

  raise notice '== 0138 BEHAVIOURAL TESTS PASSED ==';
end $$;
