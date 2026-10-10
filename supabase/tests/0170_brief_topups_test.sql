-- ============================================================================
-- Behavioural tests for 0170: top-ups for Lead Brief customers (batch 04
-- Phase 4; docs/build/04-phase0-report.md §2, C3, C7).
--
--   1. The new column: 0 for everyone, never negative.
--   2. record_lead_topup_success: a brief customer's Management top-up adds to
--      brief_topup_credits as well as lead_balance; every other top-up
--      (another customer, a GR top-up, a replay) is exactly what it was.
--   3. The in-area pool spends plan credits only: a brief customer whose plan
--      credits are gone is sent nothing inside their area, however many
--      top-up credits they hold.
--   4. Who may take a lead on a top-up credit: outside the service area only
--      (first picks and the pace ring count as outside), the essentials and
--      the daily cap still apply, never a paused customer, never one with no
--      top-up credit left, never a customer who is not on a brief.
--   5. assign_brief_topup_lead: assign_lead_to_customer's effects, then one
--      top-up credit spent. A lead inside the area, or no top-up credit left,
--      is refused and the assignment rolled back with nothing written.
--   6. assign_lead_to_customer is unchanged. ACLs. Invariant 7.
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

-- Runs a statement and returns its error message, or 'ok'. The statement runs
-- in its own subtransaction, so an error rolls back everything it wrote.
create or replace function test_util.error_of(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlerrm;
end $$;

create or replace function test_util.state170(p_customer uuid)
returns text language sql as $$
  select lead_balance || '/' || brief_topup_credits || '/' || leads_received_this_month
    from public.customers where id = p_customer;
$$;

delete from public.lead_topup_tokens where id::text like 'f1700000-%';
delete from public.payments where customer_id::text like 'c1700000-%';
delete from public.leads where id::text like 'd1700000-%';
delete from public.customers where id::text like 'c1700000-%';

-- A deterministic release: off, so the curve and cap admit everybody until
-- section 4 turns them on.
create temp table settings_before as
  select key, value from public.system_settings
   where key in ('release_enabled', 'release_max_per_day', 'release_fresh_hours');
update public.system_settings set value = 'false' where key = 'release_enabled';

insert into public.customers
  (id, business_name, contact_name, email, is_active, monthly_allocation, lead_balance,
   account_status, subscription_status, gr_subscription_status, gr_lead_balance,
   lead_brief_required, lead_brief_completed_at, billing_cycle_anchor,
   paused_at, pause_resumes_at, pause_holds_area)
values
  -- 1: a Lead Brief customer, 2 plan credits left, who also holds GR.
  ('c1700000-0000-0000-0000-000000000001','Brief','Bea Brief','b170@x.com',true,20,2,
   'active','active','active',4,true,now(),current_date - 10,null,null,null),
  -- 2: an existing customer, not on a brief.
  ('c1700000-0000-0000-0000-000000000002','Legacy','Lee Legacy','l170@x.com',true,20,3,
   'active','active','inactive',0,false,null,current_date - 10,null,null,null),
  -- 3: a brief customer whose essentials ask for 4+ bedrooms, with top-up credits.
  ('c1700000-0000-0000-0000-000000000003','Picky','Pia Picky','p170@x.com',true,20,5,
   'active','active','inactive',0,true,now(),current_date - 10,null,null,null),
  -- 4: a brief customer on a short pause, with top-up credits.
  ('c1700000-0000-0000-0000-000000000004','Paused','Pat Paused','z170@x.com',true,20,5,
   'active','active','inactive',0,true,now(),current_date - 10,now() - interval '2 days',now() + interval '10 days',true);

update public.customers set brief_topup_credits = 5
 where id in ('c1700000-0000-0000-0000-000000000003','c1700000-0000-0000-0000-000000000004');

insert into public.customer_lead_briefs
  (id, customer_id, version, status, origin, base_postcode, base_outcode, operating_mode,
   travel_limit_miles, allocation, priorities, service_radius_miles, service_outcodes,
   first_pick_outcodes, pace_outcodes, min_bedrooms, essentials, expected_mix, confirmed_at)
values
  ('b1700000-0000-0000-0000-000000000001','c1700000-0000-0000-0000-000000000001',1,'active',
   'customer','HG2 7AA','HG2','local',10,20,'[{"key":"location"}]'::jsonb,10,'{HG2}',
   '{HG9}','{HG1}',null,'{}','{}'::jsonb,now()),
  ('b1700000-0000-0000-0000-000000000003','c1700000-0000-0000-0000-000000000003',1,'active',
   'customer','HG2 7AA','HG2','local',10,20,'[{"key":"location"}]'::jsonb,10,'{HG2}',
   '{}','{HG1}',4,'{bedrooms}','{}'::jsonb,now()),
  ('b1700000-0000-0000-0000-000000000004','c1700000-0000-0000-0000-000000000004',1,'active',
   'customer','HG2 7AA','HG2','local',10,20,'[{"key":"location"}]'::jsonb,10,'{HG2}',
   '{}','{HG1}',null,'{}','{}'::jsonb,now());

insert into public.leads (id, monday_item_id, lead_name, lead_type, postcode, postcode_area, bedrooms, gross_annual_income, created_at)
values
  -- Inside the service area.
  ('d1700000-0000-0000-0000-000000000001','m-170-1','In area','management','HG2 8BB','HG','3',40000, now() - interval '3 days'),
  -- In the pace ring, beyond the service area.
  ('d1700000-0000-0000-0000-000000000002','m-170-2','Pace ring','management','HG1 1AA','HG','3',40000, now() - interval '3 days'),
  -- A first pick, beyond the service area.
  ('d1700000-0000-0000-0000-000000000003','m-170-3','First pick','management','HG9 9ZZ','HG','3',40000, now() - interval '3 days'),
  -- Far away: the database leaves the distance to the caller.
  ('d1700000-0000-0000-0000-000000000004','m-170-4','Far','management','LS6 1AA','LS','3',40000, now() - interval '3 days'),
  -- Another pace-ring lead, for the second top-up.
  ('d1700000-0000-0000-0000-000000000005','m-170-5','Pace ring two','management','HG1 2BB','HG','3',40000, now() - interval '3 days'),
  -- A GR lead in the pace ring.
  ('d1700000-0000-0000-0000-000000000006','m-170-6','GR','guaranteed_rent','HG1 3CC','HG','3',40000, now() - interval '3 days'),
  -- A pace-ring lead the quality check failed, so retired (invariant 11).
  ('d1700000-0000-0000-0000-000000000007','m-170-7','Retired','management','HG1 4DD','HG','3',40000, now() - interval '3 days');
update public.leads set lead_quality_status = 'failed' where id = 'd1700000-0000-0000-0000-000000000007';

-- ---------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select count(*)::integer from public.customers where brief_topup_credits <> 0
     and id not in ('c1700000-0000-0000-0000-000000000003','c1700000-0000-0000-0000-000000000004')),
  0, 'every customer starts with no top-up credits');

select test_util.assert_eq(
  test_util.error_of($q$update public.customers set brief_topup_credits = -1 where id = 'c1700000-0000-0000-0000-000000000001'$q$)
    like '%customers_brief_topup_credits_nonneg%',
  true, 'top-up credits can never go negative');

-- ---------------------------------------------------------------------------
-- 2. Crediting a top-up
-- ---------------------------------------------------------------------------
insert into public.lead_topup_tokens (id, customer_id, lead_type, token_hash, credits, amount_pence, expires_at)
values
  ('f1700000-0000-0000-0000-000000000001','c1700000-0000-0000-0000-000000000001','management','h170-1',5,7500,now() + interval '1 day'),
  ('f1700000-0000-0000-0000-000000000002','c1700000-0000-0000-0000-000000000002','management','h170-2',5,7500,now() + interval '1 day'),
  ('f1700000-0000-0000-0000-000000000003','c1700000-0000-0000-0000-000000000001','guaranteed_rent','h170-3',5,7500,now() + interval '1 day');

create temp table before170 as
  select id, lead_balance, gr_lead_balance, replacement_balance, brief_topup_credits
    from public.customers where id::text like 'c1700000-%';

select test_util.assert_eq(
  public.record_lead_topup_success('f1700000-0000-0000-0000-000000000001', 'pi_170_1'),
  true, 'a brief customer''s top-up is credited');
select test_util.assert_eq(
  (select (c.lead_balance - b.lead_balance) || '/' || (c.brief_topup_credits - b.brief_topup_credits)
          || '/' || (c.replacement_balance - b.replacement_balance)
     from public.customers c join before170 b on b.id = c.id
    where c.id = 'c1700000-0000-0000-0000-000000000001'),
  '5/5/1', 'a brief customer: five credits, all five kept for beyond the area, one replacement banked');

select test_util.assert_eq(
  public.record_lead_topup_success('f1700000-0000-0000-0000-000000000001', 'pi_170_1'),
  false, 'a replayed top-up is refused');
select test_util.assert_eq(
  test_util.state170('c1700000-0000-0000-0000-000000000001'),
  '7/5/0', 'and credits nothing twice');

select public.record_lead_topup_success('f1700000-0000-0000-0000-000000000002', 'pi_170_2');
select test_util.assert_eq(
  (select (c.lead_balance - b.lead_balance) || '/' || c.brief_topup_credits
          || '/' || (c.replacement_balance - b.replacement_balance)
     from public.customers c join before170 b on b.id = c.id
    where c.id = 'c1700000-0000-0000-0000-000000000002'),
  '5/0/1', 'an existing customer''s top-up is exactly what it was: no top-up credits');

select public.record_lead_topup_success('f1700000-0000-0000-0000-000000000003', 'pi_170_3');
select test_util.assert_eq(
  (select (c.gr_lead_balance - b.gr_lead_balance) || '/' || c.brief_topup_credits
     from public.customers c join before170 b on b.id = c.id
    where c.id = 'c1700000-0000-0000-0000-000000000001'),
  '5/5', 'a GR top-up credits GR only and leaves the Management top-up credits alone');

-- ---------------------------------------------------------------------------
-- 3. The in-area pool spends plan credits only
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select count(*)::integer from public.get_brief_candidates_for_lead('d1700000-0000-0000-0000-000000000001', 5, true)
    where customer_id = 'c1700000-0000-0000-0000-000000000001'),
  1, 'with plan credits left (7 against 5 for top-ups), the in-area lead is offered');

update public.customers set lead_balance = 5 where id = 'c1700000-0000-0000-0000-000000000001';
select test_util.assert_eq(
  (select count(*)::integer from public.get_brief_candidates_for_lead('d1700000-0000-0000-0000-000000000001', 5, true)
    where customer_id = 'c1700000-0000-0000-0000-000000000001'),
  0, 'plan credits gone: nothing inside the area, though five top-up credits remain');
select test_util.assert_eq(
  (select count(*)::integer from public.get_brief_candidates_for_lead('d1700000-0000-0000-0000-000000000003', 5, true)
    where customer_id = 'c1700000-0000-0000-0000-000000000001'),
  0, 'nor a first pick: those are routed on plan credits');

-- ---------------------------------------------------------------------------
-- 4. Who may take a lead on a top-up credit
-- ---------------------------------------------------------------------------
create or replace function test_util.topup170(p_lead uuid, p_customer uuid)
returns integer language sql as $$
  select count(*)::integer from public.get_brief_topup_candidates_for_lead(p_lead, 10)
   where customer_id = p_customer;
$$;

select test_util.assert_eq(
  test_util.topup170('d1700000-0000-0000-0000-000000000001','c1700000-0000-0000-0000-000000000001'),
  0, 'never a lead inside the service area');
select test_util.assert_eq(
  test_util.topup170('d1700000-0000-0000-0000-000000000002','c1700000-0000-0000-0000-000000000001'),
  1, 'a lead in the pace ring');
select test_util.assert_eq(
  test_util.topup170('d1700000-0000-0000-0000-000000000003','c1700000-0000-0000-0000-000000000001'),
  1, 'a first pick, which is outside the service area');
select test_util.assert_eq(
  test_util.topup170('d1700000-0000-0000-0000-000000000004','c1700000-0000-0000-0000-000000000001'),
  1, 'a far lead too: the distance is the caller''s to judge, the database cannot');
select test_util.assert_eq(
  (select topup_credits || ':' || allocation || ':' || base_outcode
     from public.get_brief_topup_candidates_for_lead('d1700000-0000-0000-0000-000000000002', 10)
    where customer_id = 'c1700000-0000-0000-0000-000000000001'),
  '5:20:HG2', 'it reports the top-up credits, the plan and the base the caller measures from');
select test_util.assert_eq(
  test_util.topup170('d1700000-0000-0000-0000-000000000006','c1700000-0000-0000-0000-000000000001'),
  0, 'never a GR lead');
select test_util.assert_eq(
  test_util.topup170('d1700000-0000-0000-0000-000000000007','c1700000-0000-0000-0000-000000000001'),
  0, 'never a retired lead (invariant 11)');

-- Even one holding an active brief row and top-up credits (the brief join
-- alone would admit them): lead_brief_required is what decides.
insert into public.customer_lead_briefs
  (id, customer_id, version, status, origin, base_postcode, base_outcode, operating_mode,
   travel_limit_miles, allocation, priorities, service_radius_miles, service_outcodes,
   first_pick_outcodes, pace_outcodes, min_bedrooms, essentials, expected_mix, confirmed_at)
values
  ('b1700000-0000-0000-0000-000000000002','c1700000-0000-0000-0000-000000000002',1,'active',
   'customer','HG2 7AA','HG2','local',10,20,'[{"key":"location"}]'::jsonb,10,'{HG2}',
   '{}','{HG1}',null,'{}','{}'::jsonb,now());
update public.customers set brief_topup_credits = 5, lead_brief_completed_at = now()
 where id = 'c1700000-0000-0000-0000-000000000002';
select test_util.assert_eq(
  test_util.topup170('d1700000-0000-0000-0000-000000000002','c1700000-0000-0000-0000-000000000002'),
  0, 'never a customer who is not on a brief');
select test_util.assert_eq(
  test_util.topup170('d1700000-0000-0000-0000-000000000002','c1700000-0000-0000-0000-000000000003'),
  0, 'the essentials still apply: a 3-bedroom lead for a 4+ brief');
select test_util.assert_eq(
  test_util.topup170('d1700000-0000-0000-0000-000000000002','c1700000-0000-0000-0000-000000000004'),
  0, 'never a paused customer');

update public.customers set lead_balance = 3 where id = 'c1700000-0000-0000-0000-000000000003';
update public.customer_lead_briefs set min_bedrooms = null, essentials = '{}' where id = 'b1700000-0000-0000-0000-000000000003';
select test_util.assert_eq(
  (select topup_credits from public.get_brief_topup_candidates_for_lead('d1700000-0000-0000-0000-000000000002', 10)
    where customer_id = 'c1700000-0000-0000-0000-000000000003'),
  3, 'top-up credits are read as no more than the balance holds');
update public.customers set brief_topup_credits = 0 where id = 'c1700000-0000-0000-0000-000000000003';
select test_util.assert_eq(
  test_util.topup170('d1700000-0000-0000-0000-000000000002','c1700000-0000-0000-0000-000000000003'),
  0, 'never a customer with no top-up credit left');

-- ---------------------------------------------------------------------------
-- 5. Spending a top-up credit
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  test_util.error_of($q$select public.assign_brief_topup_lead('d1700000-0000-0000-0000-000000000001','c1700000-0000-0000-0000-000000000001',15)$q$)
    like '%not beyond the service area%',
  true, 'a lead inside the area is refused');
select test_util.assert_eq(
  test_util.state170('c1700000-0000-0000-0000-000000000001')
    || '|' || (select assignment_count from public.leads where id = 'd1700000-0000-0000-0000-000000000001')
    || '|' || (select count(*) from public.lead_assignments where lead_id = 'd1700000-0000-0000-0000-000000000001'),
  '5/5/0|0|0', 'and the refusal rolls the assignment back: nothing spent, nothing written');

select test_util.assert_eq(
  (select public.assign_brief_topup_lead('d1700000-0000-0000-0000-000000000002','c1700000-0000-0000-0000-000000000001',15) is not null),
  true, 'a pace-ring lead is assigned on a top-up credit');
select test_util.assert_eq(
  test_util.state170('c1700000-0000-0000-0000-000000000001')
    || '|' || (select assignment_count from public.leads where id = 'd1700000-0000-0000-0000-000000000002'),
  '4/4/1|1', 'one credit and one top-up credit spent, the monthly counter and the lead''s count moved');

select test_util.assert_eq(
  test_util.error_of($q$select public.assign_brief_topup_lead('d1700000-0000-0000-0000-000000000002','c1700000-0000-0000-0000-000000000001',15)$q$)
    like '%already has this lead%',
  true, 'the same lead twice is refused by assign_lead_to_customer, as always');

-- The daily cap applies to a top-up exactly as to any routed lead.
update public.system_settings set value = 'true' where key = 'release_enabled';
update public.system_settings set value = '1' where key = 'release_max_per_day';
select test_util.assert_eq(
  test_util.topup170('d1700000-0000-0000-0000-000000000005','c1700000-0000-0000-0000-000000000001'),
  0, 'with the release on and a cap of one a day, today''s top-up lead has been sent');
update public.system_settings set value = 'false' where key = 'release_enabled';

update public.customers set brief_topup_credits = 0 where id = 'c1700000-0000-0000-0000-000000000001';
select test_util.assert_eq(
  test_util.error_of($q$select public.assign_brief_topup_lead('d1700000-0000-0000-0000-000000000005','c1700000-0000-0000-0000-000000000001',15)$q$)
    like '%no top-up credit left%',
  true, 'no top-up credit left: refused');
select test_util.assert_eq(
  test_util.state170('c1700000-0000-0000-0000-000000000001')
    || '|' || (select count(*) from public.lead_assignments where lead_id = 'd1700000-0000-0000-0000-000000000005'),
  '4/0/1|0', 'and the assignment assign_lead_to_customer made is rolled back with it');

-- ---------------------------------------------------------------------------
-- 6. assign_lead_to_customer unchanged, ACLs, invariant 7
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'assign_lead_to_customer' and p.pronargs = 5),
  '2bff0e5a66d060cd47d935f36c0da0ff', 'assign_lead_to_customer''s body is unchanged (0142)');

select test_util.assert_eq(
  (select string_agg(p.proname || '=' ||
            (has_function_privilege('anon', p.oid, 'execute')
             or has_function_privilege('authenticated', p.oid, 'execute'))::text
            || ':' || has_function_privilege('service_role', p.oid, 'execute')::text,
          ',' order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('assign_brief_topup_lead', 'get_brief_topup_candidates_for_lead',
                        'get_brief_candidates_for_lead', 'record_lead_topup_success')),
  'assign_brief_topup_lead=false:true,get_brief_candidates_for_lead=false:true,'
    || 'get_brief_topup_candidates_for_lead=false:true,record_lead_topup_success=false:true',
  'all four functions are service_role only');

select test_util.assert_eq(
  (select count(distinct p.proname)::integer from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('get_engagement_benchmarks','set_management_customer_goal',
                        'get_operator_proof','get_recent_wins_anonymised')
      and has_function_privilege('authenticated', p.oid, 'execute')),
  4, 'invariant 7: the four customer-callable functions still are');

-- ---------------------------------------------------------------------------
-- Teardown
-- ---------------------------------------------------------------------------
update public.system_settings s set value = b.value from settings_before b where s.key = b.key;
delete from public.lead_topup_tokens where id::text like 'f1700000-%';
delete from public.payments where customer_id::text like 'c1700000-%';
delete from public.lead_assignments where lead_id::text like 'd1700000-%';
delete from public.leads where id::text like 'd1700000-%';
delete from public.customers where id::text like 'c1700000-%';

\o
select '0170 BEHAVIOURAL TESTS PASSED' as result;
