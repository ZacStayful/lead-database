-- ============================================================================
-- Behavioural tests for 0169: confirming a recalculated area, and extending a
-- long pause (batch 04 Phase 3; docs/build/04-phase0-report.md, C10).
--
--   1. confirm_pending_lead_brief refuses a stale or wrong caller and writes
--      nothing: no lock date, a moved active brief, a row that is not pending
--      (or is somebody else's), an auto-accept before 72 hours.
--   2. It makes the pending version active and the old one superseded, with
--      confirmed_at and the lock date; an auto-accept also stamps
--      auto_accepted_at.
--   3. First picks: the caller's recomputed list, or the stored one when it
--      passes null; either way a pick another customer's active brief covers
--      is dropped, except a customer on a LONG pause (they hold no area).
--   4. extend_brief_pause moves the return date later (up to 3 months from
--      the pause), supersedes the waiting area, sets the episode back to not
--      recalculated and clears the notice stamp. It refuses an earlier date,
--      a date past the maximum, today, a short pause, and a customer who is
--      no longer paused; a refusal writes nothing.
--   5. ACLs; invariant 7.
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

create or replace function test_util.briefs_of(p_customer uuid)
returns text language sql as $$
  select coalesce(string_agg(status || ':' || origin, ',' order by version), '')
    from public.customer_lead_briefs where customer_id = p_customer;
$$;

create or replace function test_util.confirm169(
  p_customer uuid, p_active uuid, p_pending uuid, p_picks text[], p_locked date, p_auto boolean
) returns text language sql as $$
  select public.confirm_pending_lead_brief(p_customer, p_active, p_pending, p_picks, p_locked, p_auto) ->> 'result';
$$;

delete from public.customers where id::text like 'c1690000-%';

insert into public.customers
  (id, business_name, contact_name, email, is_active, monthly_allocation,
   account_status, subscription_status, lead_brief_required, lead_brief_completed_at,
   paused_at, pause_resumes_at, pause_holds_area, pause_ending_notice_sent_at)
values
  -- 1: on a long brief pause, area waiting (effective 4 days ago, so due).
  ('c1690000-0000-0000-0000-000000000001','Long','Lin Long','l169@x.com',true,20,
   'active','active',true,now(),now() - interval '50 days',now() - interval '4 days',false,null),
  -- 2: a live customer with a pending widening, effective yesterday (not due).
  ('c1690000-0000-0000-0000-000000000002','Wide','Wyn Wide','w169@x.com',true,20,
   'active','active',true,now(),null,null,null,null),
  -- 3: another live brief customer, whose area covers HG3 and locks HG4.
  ('c1690000-0000-0000-0000-000000000003','Near','Ned Near','n169@x.com',true,20,
   'active','active',true,now(),null,null,null,null),
  -- 4: another brief customer on a LONG pause, whose area covers HG5.
  ('c1690000-0000-0000-0000-000000000004','Away','Ava Away','a169@x.com',true,20,
   'active','active',true,now(),now() - interval '40 days',now() + interval '20 days',false,null),
  -- 5: on a long pause, to extend. Paused 40 days ago, back in 10, notice sent.
  ('c1690000-0000-0000-0000-000000000005','Ext','Eli Ext','e169@x.com',true,20,
   'active','active',true,now(),now() - interval '40 days',now() + interval '10 days',false,now()),
  -- 6: on a short brief pause.
  ('c1690000-0000-0000-0000-000000000006','Short','Sam Short','s169@x.com',true,20,
   'active','active',true,now(),now() - interval '5 days',now() + interval '10 days',true,null),
  -- 7: held past their return date, waiting to confirm.
  ('c1690000-0000-0000-0000-000000000007','Held','Hal Held','h169@x.com',true,20,
   'active','active',true,now(),now() - interval '50 days',now() - interval '2 days',false,null);

insert into public.subscription_pauses
  (id, customer_id, paused_at, resumes_at, months, reasons, hold_area, recalibrated_at)
values
  ('a1690000-0000-0000-0000-000000000005','c1690000-0000-0000-0000-000000000005',
   now() - interval '40 days', now() + interval '10 days', null, '{seasonal}', false, now() - interval '1 day'),
  ('a1690000-0000-0000-0000-000000000006','c1690000-0000-0000-0000-000000000006',
   now() - interval '5 days', now() + interval '10 days', null, '{seasonal}', true, null),
  ('a1690000-0000-0000-0000-000000000007','c1690000-0000-0000-0000-000000000007',
   now() - interval '50 days', now() - interval '2 days', null, '{seasonal}', false, now() - interval '9 days');

insert into public.customer_lead_briefs
  (id, customer_id, version, status, origin, base_postcode, base_outcode, operating_mode,
   travel_limit_miles, allocation, priorities, service_radius_miles, service_outcodes,
   first_pick_outcodes, locked_until, expected_mix, confirmed_at, effective_at)
values
  ('b1690000-0000-0000-0000-000000000001','c1690000-0000-0000-0000-000000000001',1,'active',
   'customer','HG2','HG2','anywhere',null,20,'[{"key":"location"}]'::jsonb,20,'{HG2}',
   '{HG9}','2026-01-01','{}'::jsonb,now(),null),
  ('b1690000-0000-0000-0000-000000000002','c1690000-0000-0000-0000-000000000001',2,'pending_confirmation',
   'recompute','HG2','HG2','anywhere',null,20,'[{"key":"location"}]'::jsonb,30,'{HG2,HG1}',
   '{HG3,HG4,HG5,HG6}',null,'{}'::jsonb,null,now() - interval '4 days'),
  ('b1690000-0000-0000-0000-000000000003','c1690000-0000-0000-0000-000000000002',1,'active',
   'customer','YO10','YO10','anywhere',null,20,'[{"key":"location"}]'::jsonb,20,'{YO10}',
   '{}',null,'{}'::jsonb,now(),null),
  ('b1690000-0000-0000-0000-000000000004','c1690000-0000-0000-0000-000000000002',2,'pending_confirmation',
   'recompute','YO10','YO10','anywhere',null,20,'[{"key":"location"}]'::jsonb,30,'{YO10,YO1}',
   '{YO8}',null,'{}'::jsonb,null,now() - interval '1 day'),
  ('b1690000-0000-0000-0000-000000000005','c1690000-0000-0000-0000-000000000003',1,'active',
   'customer','HG3','HG3','anywhere',null,20,'[{"key":"location"}]'::jsonb,10,'{HG3}',
   '{HG4}',current_date + 10,'{}'::jsonb,now(),null),
  ('b1690000-0000-0000-0000-000000000006','c1690000-0000-0000-0000-000000000004',1,'active',
   'customer','HG5','HG5','anywhere',null,20,'[{"key":"location"}]'::jsonb,10,'{HG5}',
   '{}',null,'{}'::jsonb,now(),null),
  ('b1690000-0000-0000-0000-000000000007','c1690000-0000-0000-0000-000000000005',1,'active',
   'customer','LS6','LS6','anywhere',null,20,'[{"key":"location"}]'::jsonb,20,'{LS6}',
   '{}',null,'{}'::jsonb,now(),null),
  ('b1690000-0000-0000-0000-000000000008','c1690000-0000-0000-0000-000000000005',2,'pending_confirmation',
   'recompute','LS6','LS6','anywhere',null,20,'[{"key":"location"}]'::jsonb,30,'{LS6,LS7}',
   '{}',null,'{}'::jsonb,null,now() + interval '10 days');

update public.subscription_pauses set pending_brief_id = 'b1690000-0000-0000-0000-000000000008'
 where id = 'a1690000-0000-0000-0000-000000000005';

-- ---------------------------------------------------------------------------
-- 1. Refusals write nothing
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  test_util.confirm169('c1690000-0000-0000-0000-000000000001','b1690000-0000-0000-0000-000000000001',
                       'b1690000-0000-0000-0000-000000000002', null, null, false),
  'locked_until_required', 'a confirm needs the lock date');

select test_util.assert_eq(
  test_util.confirm169('c1690000-0000-0000-0000-000000000001','b1690000-0000-0000-0000-000000000099',
                       'b1690000-0000-0000-0000-000000000002', null, '2026-12-01', false),
  'conflict', 'a moved active brief is a conflict');

select test_util.assert_eq(
  test_util.confirm169('c1690000-0000-0000-0000-000000000001','b1690000-0000-0000-0000-000000000001',
                       'b1690000-0000-0000-0000-000000000001', null, '2026-12-01', false),
  'not_pending', 'an active row is not a pending one');

select test_util.assert_eq(
  test_util.confirm169('c1690000-0000-0000-0000-000000000001','b1690000-0000-0000-0000-000000000001',
                       'b1690000-0000-0000-0000-000000000004', null, '2026-12-01', false),
  'not_pending', 'another customer''s pending row is never confirmed');

select test_util.assert_eq(
  test_util.confirm169('c1690000-0000-0000-0000-000000000002','b1690000-0000-0000-0000-000000000003',
                       'b1690000-0000-0000-0000-000000000004', null, '2026-12-01', true),
  'not_due', 'an auto-accept before 72 hours is refused');

select test_util.assert_eq(
  test_util.briefs_of('c1690000-0000-0000-0000-000000000001') || '|' ||
  test_util.briefs_of('c1690000-0000-0000-0000-000000000002'),
  'active:customer,pending_confirmation:recompute|active:customer,pending_confirmation:recompute',
  'none of the refusals changed a version');

-- ---------------------------------------------------------------------------
-- 2 + 3. An auto-accept that is due, keeping the stored first picks
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  test_util.confirm169('c1690000-0000-0000-0000-000000000001','b1690000-0000-0000-0000-000000000001',
                       'b1690000-0000-0000-0000-000000000002', null, '2026-12-01', true),
  'confirmed', 'an auto-accept 72 hours after the effective date goes through');

select test_util.assert_eq(
  test_util.briefs_of('c1690000-0000-0000-0000-000000000001'),
  'superseded:customer,active:recompute', 'the pending version is active, the old one superseded');

select test_util.assert_eq(
  (select (confirmed_at is not null)::text || ':' || (auto_accepted_at is not null)::text || ':' ||
          locked_until::text || ':' || service_radius_miles::text
     from public.customer_lead_briefs where id = 'b1690000-0000-0000-0000-000000000002'),
  'true:true:2026-12-01:30', 'confirmed, auto-accepted, locked to the date given, the new radius');

select test_util.assert_eq(
  (select array_to_string(first_pick_outcodes, ',')
     from public.customer_lead_briefs where id = 'b1690000-0000-0000-0000-000000000002'),
  'HG5,HG6',
  'stored picks kept in order, minus one another live brief covers (HG3) or has locked (HG4); a long-paused customer''s area (HG5) blocks nothing');

-- A second confirm finds nothing pending.
select test_util.assert_eq(
  test_util.confirm169('c1690000-0000-0000-0000-000000000001','b1690000-0000-0000-0000-000000000002',
                       'b1690000-0000-0000-0000-000000000002', null, '2026-12-01', false),
  'not_pending', 'a confirmed version cannot be confirmed again');

-- ---------------------------------------------------------------------------
-- 2 + 3. A customer's own confirm, with recomputed first picks
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  test_util.confirm169('c1690000-0000-0000-0000-000000000002','b1690000-0000-0000-0000-000000000003',
                       'b1690000-0000-0000-0000-000000000004', '{YO7,HG3,YO6}', '2026-11-20', false),
  'confirmed', 'the customer confirms before the auto-accept is due');

select test_util.assert_eq(
  (select array_to_string(first_pick_outcodes, ',') || ':' || (auto_accepted_at is null)::text
     from public.customer_lead_briefs where id = 'b1690000-0000-0000-0000-000000000004'),
  'YO7,YO6:true',
  'the recomputed picks replace the stored ones, still filtered; not an auto-accept');

select test_util.assert_eq(
  (select count(*)::integer from public.customer_lead_briefs
    where customer_id = 'c1690000-0000-0000-0000-000000000002' and status = 'active'),
  1, 'exactly one active version');

-- ---------------------------------------------------------------------------
-- 4. Extending a long pause
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  public.extend_brief_pause('c1690000-0000-0000-0000-000000000005','a1690000-0000-0000-0000-000000000005',
                            now() + interval '5 days') ->> 'result',
  'not_later', 'an earlier return date is not an extension');

select test_util.assert_eq(
  public.extend_brief_pause('c1690000-0000-0000-0000-000000000005','a1690000-0000-0000-0000-000000000005',
                            now() + interval '80 days') ->> 'result',
  'too_late', 'never past 3 months from the day they paused');

select test_util.assert_eq(
  public.extend_brief_pause('c1690000-0000-0000-0000-000000000006','a1690000-0000-0000-0000-000000000006',
                            now() + interval '20 days') ->> 'result',
  'not_extendable', 'a short pause is not extended here');

select test_util.assert_eq(
  public.extend_brief_pause('c1690000-0000-0000-0000-000000000002','a1690000-0000-0000-0000-000000000005',
                            now() + interval '20 days') ->> 'result',
  'not_extendable', 'another customer''s episode is never extended');

select test_util.assert_eq(
  public.extend_brief_pause('c1690000-0000-0000-0000-000000000005','a1690000-0000-0000-0000-000000000005',
                            null) ->> 'result',
  'resumes_at_required', 'a new date is required');

select test_util.assert_eq(
  (select (p.recalibrated_at is not null)::text || ':' || (p.pending_brief_id is not null)::text || ':' ||
          (c.pause_ending_notice_sent_at is not null)::text || ':' ||
          test_util.briefs_of(c.id)
     from public.subscription_pauses p join public.customers c on c.id = p.customer_id
    where p.id = 'a1690000-0000-0000-0000-000000000005'),
  'true:true:true:active:customer,pending_confirmation:recompute',
  'none of the refusals changed the pause or the area');

select test_util.assert_eq(
  public.extend_brief_pause('c1690000-0000-0000-0000-000000000005','a1690000-0000-0000-0000-000000000005',
                            date_trunc('day', now()) + interval '30 days') ->> 'result',
  'extended', 'a later date within the maximum is accepted');

select test_util.assert_eq(
  (select (p.resumes_at = c.pause_resumes_at)::text || ':' ||
          (p.resumes_at = date_trunc('day', now()) + interval '30 days')::text || ':' ||
          (p.recalibrated_at is null)::text || ':' || (p.pending_brief_id is null)::text || ':' ||
          (c.pause_ending_notice_sent_at is null)::text || ':' || c.pause_holds_area::text
     from public.subscription_pauses p join public.customers c on c.id = p.customer_id
    where p.id = 'a1690000-0000-0000-0000-000000000005'),
  'true:true:true:true:true:false',
  'the episode and the customer carry the new date; not recalculated yet; no notice yet; still a long pause');

select test_util.assert_eq(
  test_util.briefs_of('c1690000-0000-0000-0000-000000000005'),
  'active:customer,superseded:recompute', 'the waiting area is set aside');

-- A customer held past their return date may extend, from tomorrow.
select test_util.assert_eq(
  public.extend_brief_pause('c1690000-0000-0000-0000-000000000007','a1690000-0000-0000-0000-000000000007',
                            now()) ->> 'result',
  'too_soon', 'a held customer cannot extend to today');
select test_util.assert_eq(
  public.extend_brief_pause('c1690000-0000-0000-0000-000000000007','a1690000-0000-0000-0000-000000000007',
                            now() + interval '2 days') ->> 'result',
  'extended', '… but can extend to a later date');

-- A customer no longer paused cannot extend.
update public.customers set paused_at = null, pause_holds_area = null
 where id = 'c1690000-0000-0000-0000-000000000005';
select test_util.assert_eq(
  public.extend_brief_pause('c1690000-0000-0000-0000-000000000005','a1690000-0000-0000-0000-000000000005',
                            now() + interval '40 days') ->> 'result',
  'not_paused', 'a customer who has resumed is not extended');

-- ---------------------------------------------------------------------------
-- 6. Delivery is held until the area is confirmed, and the first lead after
--    is matched against the NEW area (get_brief_candidates_for_lead, 0163)
-- ---------------------------------------------------------------------------
insert into public.customers
  (id, business_name, contact_name, email, is_active, monthly_allocation, lead_balance,
   account_status, subscription_status, lead_brief_required, lead_brief_completed_at,
   billing_cycle_anchor, paused_at, pause_resumes_at, pause_holds_area)
values
  ('c1690000-0000-0000-0000-000000000008','Back','Bo Back','b169@x.com',true,20,5,
   'active','active',true,now(),current_date - 10,now() - interval '50 days',now() - interval '1 day',false);

insert into public.customer_lead_briefs
  (id, customer_id, version, status, origin, base_postcode, base_outcode, operating_mode,
   travel_limit_miles, allocation, priorities, service_radius_miles, service_outcodes,
   first_pick_outcodes, expected_mix, confirmed_at, effective_at)
values
  ('b1690000-0000-0000-0000-000000000011','c1690000-0000-0000-0000-000000000008',1,'active',
   'customer','HG2 7AA','HG2','anywhere',null,20,'[{"key":"location"}]'::jsonb,10,'{HG2}',
   '{}','{}'::jsonb,now(),null),
  ('b1690000-0000-0000-0000-000000000012','c1690000-0000-0000-0000-000000000008',2,'pending_confirmation',
   'recompute','HG2 7AA','HG2','anywhere',null,20,'[{"key":"location"}]'::jsonb,30,'{HG2,HG1}',
   '{}','{}'::jsonb,null,now() - interval '1 day');

insert into public.leads (id, monday_item_id, lead_name, lead_type, postcode, postcode_area, bedrooms, gross_annual_income, created_at)
values ('d1690000-0000-0000-0000-000000000001','m-169-1','Harrogate new area','management','HG1 1AA','HG','3',40000, now() - interval '3 days');

select test_util.assert_eq(
  (select count(*)::integer from public.get_brief_candidates_for_lead('d1690000-0000-0000-0000-000000000001', 5, true)
    where customer_id = 'c1690000-0000-0000-0000-000000000008'),
  0, 'held: a customer waiting to confirm is sent nothing');

select test_util.assert_eq(
  test_util.confirm169('c1690000-0000-0000-0000-000000000008','b1690000-0000-0000-0000-000000000011',
                       'b1690000-0000-0000-0000-000000000012', null, '2026-12-01', false),
  'confirmed', 'they confirm');

-- resumePausedCustomer's clear, as the route runs it after the confirm.
update public.customers
   set paused_at = null, pause_resumes_at = null, pause_holds_area = null
 where id = 'c1690000-0000-0000-0000-000000000008';

select test_util.assert_eq(
  (select in_service::text || ':' || brief_id::text
     from public.get_brief_candidates_for_lead('d1690000-0000-0000-0000-000000000001', 5, true)
    where customer_id = 'c1690000-0000-0000-0000-000000000008'),
  'true:b1690000-0000-0000-0000-000000000012',
  'the first lead after confirmation is matched against the new area (HG1 was not in the old one)');

delete from public.leads where id = 'd1690000-0000-0000-0000-000000000001';

-- ---------------------------------------------------------------------------
-- 5. ACLs and invariant 7
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select string_agg(p.proname || '=' ||
            (has_function_privilege('anon', p.oid, 'execute')
             or has_function_privilege('authenticated', p.oid, 'execute'))::text
            || ':' || has_function_privilege('service_role', p.oid, 'execute')::text,
          ',' order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('confirm_pending_lead_brief', 'extend_brief_pause')),
  'confirm_pending_lead_brief=false:true,extend_brief_pause=false:true',
  'both functions are service_role only');

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
delete from public.customers where id::text like 'c1690000-%';

\o
select '0169 BEHAVIOURAL TESTS PASSED' as result;
