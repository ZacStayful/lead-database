-- ============================================================================
-- Behavioural tests for 0158 — a revenue floor on a lead filter, and a
-- version on the public volume cache (CLAUDE.md §28, §68).
--
-- 0158 is INERT: it adds two nullable columns and one CHECK, and no function
-- reads either. So the assertions that matter are (a) the CHECK admits
-- EXACTLY the five thresholds the TypeScript constant carries and nothing
-- else, (b) there is deliberately NO gr_ mirror, and (c) ordinary allocation
-- is untouched.
--
-- ⚠️ (a) is the load-bearing one. The prediction's banding is only exact
-- because the floors are a fixed list that falls on band edges. A sixth value
-- admitted here — or one of the five refused — makes every floored quote
-- compute at the wrong edge, and half the directions OVERSTATE.
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

-- ⚠️ Cleared UP FRONT as well as at the end: mutation testing aborts a suite
-- by design, and a suite that is not re-runnable reports the wrong failure on
-- the next pass.
delete from public.lead_assignments;
delete from public.leads;
delete from public.customers;

insert into public.customers
  (id, business_name, contact_name, email, monthly_allocation, lead_balance,
   leads_received_this_month, billing_cycle_anchor,
   account_status, subscription_status, filter_status)
values
  ('a1111111-1111-1111-1111-111111111111','Floored','A','floor@x.com',20,10,0,current_date - 3,
   'active','active','active');

-- ---------------------------------------------------------------------------
-- 1. Shape
-- ---------------------------------------------------------------------------
do $$
declare v_type text; v_null text;
begin
  select data_type, is_nullable into v_type, v_null
  from information_schema.columns
  where table_schema = 'public' and table_name = 'customers'
    and column_name = 'filter_min_gross';
  perform test_util.assert_eq(v_type, 'integer', 'filter_min_gross is an integer');
  perform test_util.assert_eq(v_null, 'YES', 'and nullable — null means no floor');

  perform test_util.assert_eq(
    (select count(*)::int from information_schema.columns
      where table_schema = 'public' and table_name = 'public_filter_volume'
        and column_name = 'schema_version'),
    1, 'public_filter_volume.schema_version exists');

  perform test_util.assert_eq(
    (select schema_version from public.public_filter_volume where id = 1),
    null::integer,
    '⚠️ and starts NULL — a payload written before versioning is unusable, not version 0');
end $$;

-- ⚠️ THE DELIBERATE ABSENCE. Guaranteed rent carries ZERO leads with a gross
-- figure, so a gr_ mirror could never hold a meaningful value. Asserted so
-- that "completing the symmetry" is a test failure rather than a tidy-up.
do $$
begin
  perform test_util.assert_eq(
    (select count(*)::int from information_schema.columns
      where table_schema = 'public' and table_name = 'customers'
        and column_name = 'gr_filter_min_gross'),
    0, '⚠️ there is NO gr_filter_min_gross, by design');
end $$;

-- ---------------------------------------------------------------------------
-- 2. The CHECK admits exactly the five thresholds
-- ---------------------------------------------------------------------------
do $$
declare t integer;
begin
  foreach t in array array[25000, 30000, 40000, 50000, 75000] loop
    update public.customers set filter_min_gross = t
      where id = 'a1111111-1111-1111-1111-111111111111';
    perform test_util.assert_eq(
      (select filter_min_gross from public.customers
        where id = 'a1111111-1111-1111-1111-111111111111'),
      t, format('a floor of %s is accepted', t));
  end loop;

  update public.customers set filter_min_gross = null
    where id = 'a1111111-1111-1111-1111-111111111111';
  perform test_util.assert_eq(
    (select filter_min_gross from public.customers
      where id = 'a1111111-1111-1111-1111-111111111111'),
    null::integer, 'null is accepted — no floor');
end $$;

do $$
declare bad integer;
begin
  -- Off-by-one either side of every edge, plus the dropped £100k, plus a
  -- PENCE value: §7's unit trap. 2_500_000 is £25k in pence and must be
  -- refused loudly rather than silently matching nothing.
  foreach bad in array array[
    0, -1, 1, 24999, 25001, 29999, 30001, 39999, 40001,
    49999, 50001, 74999, 75001, 100000, 2500000
  ] loop
    perform test_util.assert_raises(
      format($q$update public.customers set filter_min_gross = %s
               where id = 'a1111111-1111-1111-1111-111111111111'$q$, bad),
      format('a floor of %s is refused', bad));
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Inert — ordinary allocation is untouched
-- ---------------------------------------------------------------------------
delete from public.customers where id = 'a1111111-1111-1111-1111-111111111111';

insert into public.customers
  (id, business_name, contact_name, email, monthly_allocation, lead_balance,
   leads_received_this_month, management_lifetime_leads_received,
   billing_cycle_anchor, account_status, subscription_status, filter_status)
values
  ('b2222222-2222-2222-2222-222222222222','Plain','B','plain@x.com',20,10,0,0,
   current_date - 3,'active','active','off');

insert into public.leads (id, monday_item_id, lead_name, lead_type, postcode_area, bedrooms,
                          gross_annual_income, max_assignments, assignment_count)
values ('c3333333-3333-3333-3333-333333333333','m-0158','Landlord','management','BS','3',
        52000, 3, 0);

do $$
declare v_assignment uuid;
begin
  select public.assign_lead_to_customer(
    'c3333333-3333-3333-3333-333333333333'::uuid,
    'b2222222-2222-2222-2222-222222222222'::uuid,
    15, 'management') into v_assignment;
  perform test_util.assert_eq(v_assignment is not null, true, 'an ordinary lead still allocates');
  perform test_util.assert_eq(
    (select lead_balance from public.customers where id = 'b2222222-2222-2222-2222-222222222222'),
    9, 'and still spends exactly one credit');
  perform test_util.assert_eq(
    (select leads_received_this_month from public.customers
      where id = 'b2222222-2222-2222-2222-222222222222'),
    1, 'and still moves the monthly counter');
end $$;

-- ⚠️ WHAT "INERT" MEANS HERE, stated so it survives 0159.
--
-- The first draft of this asserted that the predicate IGNORES a floor set on
-- the row — true of 0158 alone, and false the moment 0159 teaches the
-- predicate to read one. A suite that runs after every migration cannot
-- assert the absence of a later migration's behaviour, so it asserts the
-- property that ACTUALLY made this apply safe and is true for ever: a
-- customer with NO floor — which is all 61 of them at apply time — matches
-- exactly what they matched before the column existed.
update public.customers set filter_status = 'active', filter_areas = array['BS']
  where id = 'b2222222-2222-2222-2222-222222222222';

do $$
begin
  perform test_util.assert_eq(
    (select filter_min_gross from public.customers
      where id = 'b2222222-2222-2222-2222-222222222222'),
    null::integer, 'the column defaults to NULL on every existing row');
  perform test_util.assert_eq(
    public.lead_matches_customer_filter(
      'c3333333-3333-3333-3333-333333333333'::uuid,
      'b2222222-2222-2222-2222-222222222222'::uuid,
      'management'),
    true,
    '⚠️ and a customer with no floor matches exactly as they did before it existed');
end $$;

delete from public.lead_assignments;
delete from public.leads;
delete from public.customers;

\o
select '0158 BEHAVIOURAL TESTS PASSED' as result;
