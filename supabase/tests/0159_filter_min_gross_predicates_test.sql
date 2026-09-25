-- ============================================================================
-- Behavioural tests for 0159 — the filter predicates read the revenue floor
-- (CLAUDE.md §68).
--
-- The assertions that matter most:
--   * a lead with NO gross figure matches NO floored customer, and a
--     null-floor customer still matches it (the whole no-figure semantic);
--   * `>=`, not `>` — a lead exactly ON the floor is admitted;
--   * ⚠️ a LIFT nulls the floor, or a lifted filter keeps one silently;
--   * the UNFILTERED pool is untouched, so a no-figure lead is never stranded;
--   * the GR branch reads no revenue column (invariant 6);
--   * ordinary allocation still spends exactly one credit.
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
  begin execute sql;
  exception when others then raise notice 'ok  % (%)', label, SQLERRM; return;
  end;
  raise exception 'FAIL % — expected an exception, none raised', label;
end $$;

-- ⚠️ Cleared up front as well as at the end — mutation testing aborts a suite
-- by design, and a suite that is not re-runnable reports the wrong failure.
delete from public.lead_events;
delete from public.lead_notes;
delete from public.lead_assignments;
delete from public.leads;
delete from public.customers;
update public.system_settings set value = 'false' where key = 'release_enabled';

-- Floored (BS, £50k+), Unfloored (BS, no floor), Off (no filter), GR.
insert into public.customers
  (id, business_name, contact_name, email, monthly_allocation, lead_balance,
   leads_received_this_month, management_lifetime_leads_received,
   billing_cycle_anchor, account_status, subscription_status,
   gr_subscription_status, gr_monthly_allocation, gr_lead_balance,
   filter_status, filter_areas, filter_min_gross, gr_filter_status)
values
  ('f0000000-0000-0000-0000-000000000001','Floored','A','floor@x.com',20,10,0,0,
   current_date - 3,'active','active','inactive',10,0,'active',array['BS'],50000,'off'),
  ('f0000000-0000-0000-0000-000000000002','Unfloored','B','nofloor@x.com',20,10,0,0,
   current_date - 3,'active','active','inactive',10,0,'active',array['BS'],null,'off'),
  ('f0000000-0000-0000-0000-000000000003','Off','C','off@x.com',20,10,0,0,
   current_date - 3,'active','active','inactive',10,0,'off',null,null,'off'),
  ('f0000000-0000-0000-0000-000000000004','GRonly','D','gr@x.com',20,0,0,0,
   current_date - 3,'waitlisted','inactive','active',10,10,'off',null,null,'active'),
  -- ⚠️ HOLDS BOTH, with a MANAGEMENT floor of £50k and a live GR filter. This
  -- is the only fixture that can tell "the GR branch ignores the floor" from
  -- "the GR branch reads it": every GR lead has no gross figure, so a GR
  -- branch that read filter_min_gross would refuse all of them.
  ('f0000000-0000-0000-0000-000000000005','Both','E','both@x.com',20,10,0,0,
   current_date - 3,'active','active','active',10,10,'active',array['BS'],50000,'active');

-- Leads: well above, exactly on, below, and NO figure at all.
insert into public.leads (id, monday_item_id, lead_name, lead_type, postcode_area,
                          bedrooms, gross_annual_income, max_assignments, assignment_count)
values
  ('1e000000-0000-0000-0000-00000000000a','m-high','High','management','BS','3', 90000,3,0),
  ('1e000000-0000-0000-0000-00000000000b','m-on',  'On',  'management','BS','3', 50000,3,0),
  ('1e000000-0000-0000-0000-00000000000c','m-low', 'Low', 'management','BS','3', 30000,3,0),
  ('1e000000-0000-0000-0000-00000000000d','m-none','None','management','BS','3', null, 3,0),
  ('1e000000-0000-0000-0000-00000000000e','g-none','GR',  'guaranteed_rent','BS','3', null,3,0);

-- ---------------------------------------------------------------------------
-- 1. lead_matches_customer_filter — the canonical predicate
-- ---------------------------------------------------------------------------
do $$
declare v_floored uuid := 'f0000000-0000-0000-0000-000000000001';
        v_plain   uuid := 'f0000000-0000-0000-0000-000000000002';
begin
  perform test_util.assert_eq(
    public.lead_matches_customer_filter('1e000000-0000-0000-0000-00000000000a', v_floored, 'management'),
    true, 'a lead well above the floor matches');
  perform test_util.assert_eq(
    public.lead_matches_customer_filter('1e000000-0000-0000-0000-00000000000b', v_floored, 'management'),
    true, '⚠️ a lead EXACTLY ON the floor matches — >=, never >');
  perform test_util.assert_eq(
    public.lead_matches_customer_filter('1e000000-0000-0000-0000-00000000000c', v_floored, 'management'),
    false, 'a lead below the floor does not');

  -- ⚠️ The whole no-figure semantic, and the NULL-safety with it.
  perform test_util.assert_eq(
    public.lead_matches_customer_filter('1e000000-0000-0000-0000-00000000000d', v_floored, 'management'),
    false, '⚠️ a lead with NO gross figure matches no floored customer');
  perform test_util.assert_eq(
    public.lead_matches_customer_filter('1e000000-0000-0000-0000-00000000000d', v_floored, 'management') is null,
    false,
    '⚠️ and the answer is FALSE, never NULL — get_swap_candidates_for_assignment returns this as a COLUMN');

  -- The same lead, to a customer with no floor.
  perform test_util.assert_eq(
    public.lead_matches_customer_filter('1e000000-0000-0000-0000-00000000000d', v_plain, 'management'),
    true, 'a null-floor customer still matches a no-figure lead');
  perform test_util.assert_eq(
    public.lead_matches_customer_filter('1e000000-0000-0000-0000-00000000000c', v_plain, 'management'),
    true, 'and still matches a low-value one');
end $$;

-- ⚠️ INVARIANT 6. The GR branch has no revenue column to read, so a GR
-- customer matches a no-figure GR lead — which is every GR lead there is.
do $$
begin
  perform test_util.assert_eq(
    public.lead_matches_customer_filter('1e000000-0000-0000-0000-00000000000e',
      'f0000000-0000-0000-0000-000000000004', 'guaranteed_rent'),
    true, '⚠️ invariant 6: a GR lead with no figure still matches a GR customer');
  perform test_util.assert_eq(
    (select count(*)::int from information_schema.columns
      where table_schema='public' and table_name='customers'
        and column_name='gr_filter_min_gross'),
    0, 'and there is still no gr_ column that could be read by mistake');

  -- ⚠️ THE ASSERTION THAT ACTUALLY PINS INVARIANT 6. A customer holding BOTH
  -- products with a £50k MANAGEMENT floor: their GR leads carry no gross
  -- figure (none do), so a GR branch that read filter_min_gross would refuse
  -- every one of them. The GR-only fixture above cannot catch this — its
  -- floor is null, so the clause passes under either rule.
  perform test_util.assert_eq(
    public.lead_matches_customer_filter('1e000000-0000-0000-0000-00000000000e',
      'f0000000-0000-0000-0000-000000000005', 'guaranteed_rent'),
    true,
    '⚠️ invariant 6: a MANAGEMENT floor never gates a GR lead');
  -- …while the same customer's management side does enforce it.
  perform test_util.assert_eq(
    public.lead_matches_customer_filter('1e000000-0000-0000-0000-00000000000c',
      'f0000000-0000-0000-0000-000000000005', 'management'),
    false, 'and their management side still refuses a below-floor lead');

  -- The same split through the candidate pools.
  perform test_util.assert_eq(
    (select count(*)::int from public.get_filtered_candidates_for_lead(
       '1e000000-0000-0000-0000-00000000000e', 10, 'guaranteed_rent')
     where customer_id = 'f0000000-0000-0000-0000-000000000005'),
    1, '⚠️ and the GR candidate pool offers them the no-figure GR lead');
end $$;

-- ---------------------------------------------------------------------------
-- 2. The two candidate pools
-- ---------------------------------------------------------------------------
do $$
declare v_floored uuid := 'f0000000-0000-0000-0000-000000000001';
        v_off     uuid := 'f0000000-0000-0000-0000-000000000003';
begin
  perform test_util.assert_eq(
    (select count(*)::int from public.get_filtered_candidates_for_lead(
       '1e000000-0000-0000-0000-00000000000a', 10, 'management') where customer_id = v_floored),
    1, 'the filtered pool offers a high-value lead to the floored customer');
  perform test_util.assert_eq(
    (select count(*)::int from public.get_filtered_candidates_for_lead(
       '1e000000-0000-0000-0000-00000000000c', 10, 'management') where customer_id = v_floored),
    0, 'and withholds a below-floor one');
  perform test_util.assert_eq(
    (select count(*)::int from public.get_filtered_candidates_for_lead(
       '1e000000-0000-0000-0000-00000000000d', 10, 'management') where customer_id = v_floored),
    0, 'and a no-figure one');
  -- The unfloored filtered customer is unaffected by any of it.
  perform test_util.assert_eq(
    (select count(*)::int from public.get_filtered_candidates_for_lead(
       '1e000000-0000-0000-0000-00000000000d', 10, 'management')
     where customer_id = 'f0000000-0000-0000-0000-000000000002'),
    1, 'the unfloored filtered customer still gets the no-figure lead');

  -- ⚠️ THE REGRESSION. get_unfiltered_candidates_for_lead is deliberately
  -- ABSENT from 0159: an `off` customer has no predicate to test, and they
  -- are what keeps a no-figure lead reachable at all.
  perform test_util.assert_eq(
    (select count(*)::int from public.get_unfiltered_candidates_for_lead(
       '1e000000-0000-0000-0000-00000000000d', 10, 'management') where customer_id = v_off),
    1, '⚠️ an UNFILTERED customer still takes a no-figure lead — never stranded');
  perform test_util.assert_eq(
    (select count(*)::int from public.get_unfiltered_candidates_for_lead(
       '1e000000-0000-0000-0000-00000000000c', 10, 'management') where customer_id = v_off),
    1, 'and a below-floor one');
end $$;

-- ---------------------------------------------------------------------------
-- 3. The money path delegates, and still costs exactly one credit
-- ---------------------------------------------------------------------------
do $$
declare v_assignment uuid;
begin
  perform test_util.assert_raises(
    $q$select public.assign_lead_to_customer(
         '1e000000-0000-0000-0000-00000000000c'::uuid,
         'f0000000-0000-0000-0000-000000000001'::uuid, 15, 'management')$q$,
    'assign_lead_to_customer refuses a below-floor lead to a floored customer');

  select public.assign_lead_to_customer(
    '1e000000-0000-0000-0000-00000000000a'::uuid,
    'f0000000-0000-0000-0000-000000000001'::uuid, 15, 'management') into v_assignment;
  perform test_util.assert_eq(v_assignment is not null, true,
    'and accepts one above it');
  perform test_util.assert_eq(
    (select lead_balance from public.customers where id='f0000000-0000-0000-0000-000000000001'),
    9, 'spending exactly one credit');
  perform test_util.assert_eq(
    (select leads_received_this_month from public.customers where id='f0000000-0000-0000-0000-000000000001'),
    1, 'and moving the monthly counter');
end $$;

-- ---------------------------------------------------------------------------
-- 4. releasable_filter_assignments — both arities, and the shim's meaning
-- ---------------------------------------------------------------------------
do $$
declare v_plain uuid := 'f0000000-0000-0000-0000-000000000002';
begin
  -- Give the unfloored customer an untouched no-figure lead.
  perform public.assign_lead_to_customer(
    '1e000000-0000-0000-0000-00000000000d'::uuid, v_plain, 15, 'management');

  perform test_util.assert_eq(
    (select count(*)::int from public.releasable_filter_assignments(
       v_plain, 'management', array['BS'], null, null, null)),
    0, 'with no proposed floor the matching lead is not releasable');

  perform test_util.assert_eq(
    (select count(*)::int from public.releasable_filter_assignments(
       v_plain, 'management', array['BS'], null, null, 50000)),
    1, '⚠️ proposing a £50k floor makes the no-figure lead releasable');

  -- ⚠️ The five-argument shim means "no floor proposed" — which is exactly
  -- what a caller that predates floors means, and what makes this migration
  -- safe to apply ahead of the code.
  perform test_util.assert_eq(
    (select count(*)::int from public.releasable_filter_assignments(
       v_plain, 'management', array['BS'], null, null)),
    0, '⚠️ the 5-argument shim proposes NO floor');
end $$;

-- ⚠️ release_unmatched_assignments must read the STORED floor, not null.
-- Nothing else in this suite drives that function, and a mutation run found
-- it: passing null there survived every other assertion, because
-- releasable_filter_assignments was being tested directly with a floor
-- passed by hand. The refund is real money (invariant 4's first exception),
-- so it wants its own case.
do $$
declare v_floored uuid := 'f0000000-0000-0000-0000-000000000001';
        v_released integer;
        v_balance_before integer;
begin
  -- ⚠️ ASSIGNED BEFORE THE FLOOR EXISTED, which is the only way this state
  -- arises in life and the whole case §39 exists for: they held the lead,
  -- then narrowed their filter. Assigning it after would be refused by the
  -- floor itself — §35's guard inside assign_lead_to_customer.
  update public.customers set filter_min_gross = null where id = v_floored;
  perform public.assign_lead_to_customer(
    '1e000000-0000-0000-0000-00000000000c'::uuid, v_floored, 15, 'management');
  update public.customers set filter_min_gross = 50000 where id = v_floored;
  select lead_balance into v_balance_before from public.customers where id = v_floored;

  select public.release_unmatched_assignments(v_floored, 'management', 10, 'discard', false)
    into v_released;
  perform test_util.assert_eq(v_released, 1,
    '⚠️ it releases the below-floor lead, reading the floor off the locked row');
  perform test_util.assert_eq(
    (select lead_balance from public.customers where id = v_floored),
    v_balance_before + 1, 'and refunds the credit');
  perform test_util.assert_eq(
    (select count(*)::int from public.lead_assignments
      where customer_id = v_floored and lead_id = '1e000000-0000-0000-0000-00000000000c'),
    0, 'and the assignment is gone');

  -- The ABOVE-floor lead they still hold is untouched by the same call.
  perform test_util.assert_eq(
    (select count(*)::int from public.lead_assignments
      where customer_id = v_floored and lead_id = '1e000000-0000-0000-0000-00000000000a'),
    1, 'while a matching lead is left alone');
end $$;

-- Both arities exist, NEITHER has a default, so a PostgREST named call can
-- never be ambiguous (PGRST203 on every filter apply).
do $$
begin
  perform test_util.assert_eq(
    (select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='releasable_filter_assignments'),
    2, 'both releasable_filter_assignments arities exist');
  perform test_util.assert_eq(
    (select sum(p.pronargdefaults)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='releasable_filter_assignments'),
    0, '⚠️ and NEITHER carries a default — no name-compatible ambiguity');
  perform test_util.assert_eq(
    (select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='execute_filter_lift'),
    1, '⚠️ execute_filter_lift still has exactly ONE signature');
end $$;

-- ---------------------------------------------------------------------------
-- 5. ⚠️ THE LIFT NULLS THE FLOOR
-- ---------------------------------------------------------------------------
do $$
declare v_floored uuid := 'f0000000-0000-0000-0000-000000000001';
begin
  update public.customers
    set filter_status = 'pending_lift', filter_lift_effective_date = current_date
    where id = v_floored;

  perform test_util.assert_eq(
    public.execute_filter_lift(v_floored, 'management'), true, 'the lift executes');
  perform test_util.assert_eq(
    (select filter_min_gross from public.customers where id = v_floored),
    null::integer,
    '⚠️ and NULLS the floor — otherwise routing keeps excluding leads a lifted filter no longer names');
  perform test_util.assert_eq(
    (select filter_areas from public.customers where id = v_floored),
    null::text[], 'alongside the areas');
  perform test_util.assert_eq(
    (select filter_status from public.customers where id = v_floored),
    'off', 'and the status');

  -- The idempotency claim is intact: a second lift does nothing.
  perform test_util.assert_eq(
    public.execute_filter_lift(v_floored, 'management'), false,
    '⚠️ a second lift returns false — the pending_lift predicate IS the claim');

  -- And the lifted customer now matches everything again.
  perform test_util.assert_eq(
    public.lead_matches_customer_filter('1e000000-0000-0000-0000-00000000000d', v_floored, 'management'),
    true, 'a lifted customer matches a no-figure lead again');
end $$;

-- ---------------------------------------------------------------------------
-- 6. ACLs — a drop discards them (§11), so every signature is re-checked
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure::text as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('lead_matches_customer_filter','get_filtered_candidates_for_lead',
                        'release_unmatched_assignments','execute_filter_lift',
                        'releasable_filter_assignments')
  loop
    perform test_util.assert_eq(has_function_privilege('anon', r.sig, 'execute'), false,
      format('anon cannot execute %s', r.sig));
    perform test_util.assert_eq(has_function_privilege('authenticated', r.sig, 'execute'), false,
      format('authenticated cannot execute %s', r.sig));
    perform test_util.assert_eq(has_function_privilege('service_role', r.sig, 'execute'), true,
      format('service_role can execute %s', r.sig));
  end loop;
end $$;

-- Invariant 7 — the four names signed-in users MAY call, by distinct name.
do $$
begin
  perform test_util.assert_eq(
    (select count(distinct p.proname)::int
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public'
       and has_function_privilege('authenticated', p.oid::regprocedure::text, 'execute')
       and p.prosecdef),
    4, 'invariant 7: exactly four SECURITY DEFINER names are authenticated-executable');
end $$;

delete from public.lead_events;
delete from public.lead_notes;
delete from public.lead_assignments;
delete from public.leads;
delete from public.customers;

\o
select '0159 BEHAVIOURAL TESTS PASSED' as result;
