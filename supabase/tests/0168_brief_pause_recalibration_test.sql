-- ============================================================================
-- Behavioural tests for 0168: a long pause's area recalculation, and the n8n
-- event outbox (batch 04 Phase 2; docs/build/04-phase0-report.md, C8 and C9).
--
--   1. write_pending_lead_brief writes ONE pending version, origin recompute,
--      unconfirmed, with effective_at; claims the episode and links it.
--   2. It is once per pause: a second write is 'not_claimable'.
--   3. It refuses a stale caller: a moved active brief, a scheduled change
--      saved since (C9), a customer no longer on a long pause, a short pause,
--      an ordinary pause, a missing effective_at. A refusal writes nothing.
--   4. C9: computed from a scheduled change, it replaces it; a pending
--      widening is superseded.
--   5. n8n_events: one per subject; claim_n8n_events hands each event out
--      once, oldest first, never past the age window, and bounds its limit.
--   6. ACLs and RLS; invariant 7.
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

create or replace function test_util.violated(sql text)
returns text language plpgsql as $$
declare
  v_name text;
begin
  execute sql;
  return null;
exception when check_violation or not_null_violation or unique_violation or foreign_key_violation then
  get stacked diagnostics v_name = constraint_name;
  return coalesce(v_name, sqlstate);
end $$;

-- A computed brief as briefRow.ts builds it, with a chosen radius.
create or replace function test_util.row168(p_radius integer, p_outcodes text[])
returns jsonb language sql as $$
  select jsonb_build_object(
    'base_postcode', 'HG2', 'base_outcode', 'HG2', 'operating_mode', 'anywhere',
    'travel_limit_miles', null, 'allocation', 20,
    'priorities', '[{"key":"location"}]'::jsonb,
    'essentials', '[]'::jsonb, 'min_bedrooms', null, 'min_gross', null,
    'priority_outcodes', '[]'::jsonb, 'similar_areas', '[]'::jsonb,
    'service_radius_miles', p_radius, 'service_outcodes', to_jsonb(p_outcodes),
    'first_pick_outcodes', '[]'::jsonb, 'pace_outcodes', '[]'::jsonb,
    'mix_leans_nearby', false, 'expected_mix', '{}'::jsonb,
    -- Ignored by the function, which decides these itself.
    'status', 'active', 'origin', 'customer', 'confirmed_at', now(), 'locked_until', '2030-01-01'
  );
$$;

create or replace function test_util.write168(
  p_customer uuid, p_active uuid, p_basis uuid, p_pause uuid, p_effective timestamptz
) returns text language sql as $$
  select (public.write_pending_lead_brief(
            p_customer, p_active, p_basis, p_pause,
            test_util.row168(30, '{HG2,HG1}'), p_effective) ->> 'result');
$$;

create or replace function test_util.briefs_of(p_customer uuid)
returns text language sql as $$
  select coalesce(string_agg(status || ':' || origin, ',' order by version), '')
    from public.customer_lead_briefs where customer_id = p_customer;
$$;

delete from public.n8n_events where customer_id::text like 'c1680000-%';
delete from public.customers where id::text like 'c1680000-%';

insert into public.customers
  (id, business_name, contact_name, email, is_active, monthly_allocation,
   account_status, subscription_status, lead_brief_required, lead_brief_completed_at,
   paused_at, pause_resumes_at, pause_holds_area)
values
  -- 1: on a long brief pause.
  ('c1680000-0000-0000-0000-000000000001','Long','Lin Long','l168@x.com',true,20,
   'active','active',true,now(),now(),now() + interval '40 days',false),
  -- 2: on a short brief pause.
  ('c1680000-0000-0000-0000-000000000002','Short','Sam Short','s168@x.com',true,20,
   'active','active',true,now(),now(),now() + interval '14 days',true),
  -- 3: on a long brief pause, with a scheduled change and a pending widening.
  ('c1680000-0000-0000-0000-000000000003','Sched','Sol Sched','x168@x.com',true,20,
   'active','active',true,now(),now(),now() + interval '40 days',false),
  -- 4: not paused.
  ('c1680000-0000-0000-0000-000000000004','Live','Liv Live','v168@x.com',true,20,
   'active','active',true,now(),null,null,null);

insert into public.subscription_pauses (id, customer_id, paused_at, resumes_at, months, reasons, hold_area)
values
  ('a1680000-0000-0000-0000-000000000001','c1680000-0000-0000-0000-000000000001',
   now(), now() + interval '40 days', null, '{seasonal}', false),
  ('a1680000-0000-0000-0000-000000000002','c1680000-0000-0000-0000-000000000002',
   now(), now() + interval '14 days', null, '{seasonal}', true),
  ('a1680000-0000-0000-0000-000000000003','c1680000-0000-0000-0000-000000000003',
   now(), now() + interval '40 days', null, '{seasonal}', false),
  -- An ordinary month-based pause, for customer 1's history: never claimable.
  ('a1680000-0000-0000-0000-000000000009','c1680000-0000-0000-0000-000000000001',
   now() - interval '200 days', now() - interval '170 days', 1, '{seasonal}', null);

insert into public.customer_lead_briefs
  (id, customer_id, version, status, origin, base_postcode, base_outcode, operating_mode,
   travel_limit_miles, allocation, priorities, service_radius_miles, service_outcodes,
   expected_mix, confirmed_at, effective_at, created_at)
values
  ('b1680000-0000-0000-0000-000000000001','c1680000-0000-0000-0000-000000000001',1,'active',
   'customer','HG2','HG2','anywhere',null,20,'[{"key":"location"}]'::jsonb,20,'{HG2}','{}'::jsonb,now(),null,now()),
  ('b1680000-0000-0000-0000-000000000002','c1680000-0000-0000-0000-000000000002',1,'active',
   'customer','HG2','HG2','anywhere',null,20,'[{"key":"location"}]'::jsonb,20,'{HG2}','{}'::jsonb,now(),null,now()),
  ('b1680000-0000-0000-0000-000000000003','c1680000-0000-0000-0000-000000000003',1,'active',
   'customer','HG2','HG2','anywhere',null,20,'[{"key":"location"}]'::jsonb,20,'{HG2}','{}'::jsonb,now(),null,now()),
  ('b1680000-0000-0000-0000-000000000004','c1680000-0000-0000-0000-000000000003',2,'scheduled',
   'customer','HG2','HG2','anywhere',null,20,'[{"key":"location"}]'::jsonb,25,'{HG2,HG3}','{}'::jsonb,now(),null,now()),
  ('b1680000-0000-0000-0000-000000000005','c1680000-0000-0000-0000-000000000004',1,'active',
   'customer','HG2','HG2','anywhere',null,20,'[{"key":"location"}]'::jsonb,20,'{HG2}','{}'::jsonb,now(),null,now());

-- ---------------------------------------------------------------------------
-- 3. Refusals write nothing (run before the successful write)
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  test_util.write168('c1680000-0000-0000-0000-000000000001','b1680000-0000-0000-0000-000000000001',
                     'b1680000-0000-0000-0000-000000000001','a1680000-0000-0000-0000-000000000001', null),
  'effective_at_required', 'a pending version needs effective_at');

select test_util.assert_eq(
  test_util.write168('c1680000-0000-0000-0000-000000000001','b1680000-0000-0000-0000-000000000099',
                     'b1680000-0000-0000-0000-000000000001','a1680000-0000-0000-0000-000000000001', now()),
  'conflict', 'a moved active brief is a conflict');

select test_util.assert_eq(
  test_util.write168('c1680000-0000-0000-0000-000000000003','b1680000-0000-0000-0000-000000000003',
                     'b1680000-0000-0000-0000-000000000003','a1680000-0000-0000-0000-000000000003', now()),
  'conflict', 'C9: computed from the active brief while a scheduled change exists is a conflict');

select test_util.assert_eq(
  test_util.write168('c1680000-0000-0000-0000-000000000002','b1680000-0000-0000-0000-000000000002',
                     'b1680000-0000-0000-0000-000000000002','a1680000-0000-0000-0000-000000000002', now()),
  'not_paused', 'a short pause is never recalculated');

select test_util.assert_eq(
  test_util.write168('c1680000-0000-0000-0000-000000000004','b1680000-0000-0000-0000-000000000005',
                     'b1680000-0000-0000-0000-000000000005','a1680000-0000-0000-0000-000000000001', now()),
  'not_paused', 'a customer who is not paused is never recalculated');

select test_util.assert_eq(
  test_util.write168('c1680000-0000-0000-0000-000000000001','b1680000-0000-0000-0000-000000000001',
                     'b1680000-0000-0000-0000-000000000001','a1680000-0000-0000-0000-000000000009', now()),
  'not_claimable', 'an ordinary (month-based) episode is never claimed');

select test_util.assert_eq(
  test_util.write168('c1680000-0000-0000-0000-000000000001','b1680000-0000-0000-0000-000000000001',
                     'b1680000-0000-0000-0000-000000000001','a1680000-0000-0000-0000-000000000003', now()),
  'not_claimable', 'another customer''s episode is never claimed');

select test_util.assert_eq(
  (select count(*)::integer from public.subscription_pauses
    where id::text like 'a1680000-%' and recalibrated_at is not null),
  0, 'none of the refusals claimed an episode');

select test_util.assert_eq(
  test_util.briefs_of('c1680000-0000-0000-0000-000000000001'),
  'active:customer', 'none of the refusals wrote a version');

-- ---------------------------------------------------------------------------
-- 1. The write
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  test_util.write168('c1680000-0000-0000-0000-000000000001','b1680000-0000-0000-0000-000000000001',
                     'b1680000-0000-0000-0000-000000000001','a1680000-0000-0000-0000-000000000001',
                     '2026-12-01 00:00+00'),
  'written', 'a long pause''s recalculated area is written');

select test_util.assert_eq(
  test_util.briefs_of('c1680000-0000-0000-0000-000000000001'),
  'active:customer,pending_confirmation:recompute',
  'one pending version, origin recompute, beside the untouched active one');

select test_util.assert_eq(
  (select (confirmed_at is null)::text || ':' || coalesce(locked_until::text, 'null') || ':' ||
          effective_at::text || ':' || version::text || ':' || service_radius_miles::text
     from public.customer_lead_briefs
    where customer_id = 'c1680000-0000-0000-0000-000000000001' and status = 'pending_confirmation'),
  'true:null:2026-12-01 00:00:00+00:2:30',
  'unconfirmed, no lock, effective_at as given, the next version, the computed radius');

select test_util.assert_eq(
  (select (p.recalibrated_at is not null)::text || ':' || (p.pending_brief_id = b.id)::text
     from public.subscription_pauses p
     join public.customer_lead_briefs b
       on b.customer_id = p.customer_id and b.status = 'pending_confirmation'
    where p.id = 'a1680000-0000-0000-0000-000000000001'),
  'true:true', 'the episode is stamped and points at the pending version');

-- ---------------------------------------------------------------------------
-- 2. Once per pause
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  test_util.write168('c1680000-0000-0000-0000-000000000001','b1680000-0000-0000-0000-000000000001',
                     'b1680000-0000-0000-0000-000000000001','a1680000-0000-0000-0000-000000000001', now()),
  'not_claimable', 'a second write for the same pause is refused');

select test_util.assert_eq(
  (select count(*)::integer from public.customer_lead_briefs
    where customer_id = 'c1680000-0000-0000-0000-000000000001'),
  2, '… and wrote nothing');

-- ---------------------------------------------------------------------------
-- 4. C9: a scheduled change is the basis and is replaced
-- ---------------------------------------------------------------------------
-- A pending widening (Lead Brief Phase 6) cannot sit beside a scheduled row
-- (0164's one-in-flight index), so swap them first: the scheduled row is the
-- basis, and the widening is tested below.
select test_util.assert_eq(
  test_util.write168('c1680000-0000-0000-0000-000000000003','b1680000-0000-0000-0000-000000000003',
                     'b1680000-0000-0000-0000-000000000004','a1680000-0000-0000-0000-000000000003',
                     '2026-12-01 00:00+00'),
  'written', 'C9: computed from the scheduled change, the write goes through');

select test_util.assert_eq(
  test_util.briefs_of('c1680000-0000-0000-0000-000000000003'),
  'active:customer,pending_confirmation:recompute',
  'C9: the scheduled change is replaced by the pending one (one change in flight)');

-- A pending widening is superseded by a recalculation.
update public.subscription_pauses
   set recalibrated_at = null, pending_brief_id = null
 where id = 'a1680000-0000-0000-0000-000000000003';
update public.customer_lead_briefs set origin = 'recompute'
 where customer_id = 'c1680000-0000-0000-0000-000000000003' and status = 'pending_confirmation';
select test_util.assert_eq(
  test_util.write168('c1680000-0000-0000-0000-000000000003','b1680000-0000-0000-0000-000000000003',
                     'b1680000-0000-0000-0000-000000000003','a1680000-0000-0000-0000-000000000003',
                     '2026-12-01 00:00+00'),
  'written', 'a recalculation goes through beside a pending widening');
select test_util.assert_eq(
  test_util.briefs_of('c1680000-0000-0000-0000-000000000003'),
  'active:customer,superseded:recompute,pending_confirmation:recompute',
  '… which it supersedes');

-- ---------------------------------------------------------------------------
-- 5. n8n_events and the claim
-- ---------------------------------------------------------------------------
insert into public.n8n_events (id, event_type, customer_id, subject_id, payload, created_at)
values
  ('e1680000-0000-0000-0000-000000000001','brief_area_updated','c1680000-0000-0000-0000-000000000001',
   'a1680000-0000-0000-0000-000000000001','{"first_name":"Lin"}', now() - interval '2 hours'),
  ('e1680000-0000-0000-0000-000000000002','brief_area_updated','c1680000-0000-0000-0000-000000000003',
   'a1680000-0000-0000-0000-000000000003','{"first_name":"Sol"}', now() - interval '1 hour'),
  -- Too old to send.
  ('e1680000-0000-0000-0000-000000000003','brief_area_updated','c1680000-0000-0000-0000-000000000002',
   'a1680000-0000-0000-0000-000000000002','{"first_name":"Sam"}', now() - interval '3 days');

select test_util.assert_eq(
  test_util.violated($$insert into public.n8n_events (event_type, customer_id, subject_id, payload)
    values ('brief_area_updated','c1680000-0000-0000-0000-000000000001',
            'a1680000-0000-0000-0000-000000000001','{}')$$),
  'n8n_events_one_per_subject', 'one event per subject');

select test_util.assert_eq(
  test_util.violated($$insert into public.n8n_events (event_type, customer_id, subject_id, payload)
    values ('whatsapp_anything','c1680000-0000-0000-0000-000000000001',
            gen_random_uuid(),'{}')$$),
  'n8n_events_event_type_check', 'the event type is a closed list');

select test_util.assert_eq(
  test_util.violated($$insert into public.n8n_events (event_type, customer_id, subject_id, payload)
    values ('brief_area_updated','c1680000-0000-0000-0000-000000000001',
            gen_random_uuid(),'[]')$$),
  'n8n_events_payload_check', 'the payload is an object');

select test_util.assert_eq(
  (select string_agg(e ->> 'id', ',' order by ord)
     from jsonb_array_elements(public.claim_n8n_events(1, 48)) with ordinality as t(e, ord)),
  'e1680000-0000-0000-0000-000000000001', 'the oldest event first, up to the limit');

select test_util.assert_eq(
  (select string_agg(e ->> 'id', ',' order by ord)
     from jsonb_array_elements(public.claim_n8n_events(10, 48)) with ordinality as t(e, ord)),
  'e1680000-0000-0000-0000-000000000002', 'never the same event twice, never past the age window');

select test_util.assert_eq(
  jsonb_array_length(public.claim_n8n_events(10, 48)), 0, 'an empty queue is an empty array');

select test_util.assert_eq(
  (select (claimed_at is null)::text from public.n8n_events
    where id = 'e1680000-0000-0000-0000-000000000003'),
  'true', 'a stale event is left unclaimed, not handed out');

select test_util.assert_eq(
  (select (e -> 'payload' ->> 'first_name') || ':' || (e ->> 'event_type')
     from jsonb_array_elements(public.claim_n8n_events(10, 100)) as t(e)),
  'Sam:brief_area_updated', 'a wider window reaches it, with its payload and type');

do $$
begin
  perform public.claim_n8n_events(0, 48);
  raise exception 'FAIL claim limit 0 accepted';
exception when raise_exception then
  if sqlerrm like 'FAIL%' then raise; end if;
  raise notice 'ok  a limit of 0 is refused';
end $$;

do $$
begin
  perform public.claim_n8n_events(101, 48);
  raise exception 'FAIL claim limit 101 accepted';
exception when raise_exception then
  if sqlerrm like 'FAIL%' then raise; end if;
  raise notice 'ok  a limit over 100 is refused';
end $$;

-- ---------------------------------------------------------------------------
-- 6. ACLs, RLS and invariant 7
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select string_agg(p.proname || '=' ||
            (has_function_privilege('anon', p.oid, 'execute')
             or has_function_privilege('authenticated', p.oid, 'execute'))::text
            || ':' || has_function_privilege('service_role', p.oid, 'execute')::text,
          ',' order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('write_pending_lead_brief', 'claim_n8n_events')),
  'claim_n8n_events=false:true,write_pending_lead_brief=false:true',
  'both functions are service_role only');

select test_util.assert_eq(
  (select relrowsecurity::text || ':' ||
          (select count(*)::text from pg_policies where tablename = 'n8n_events')
     from pg_class where oid = 'public.n8n_events'::regclass),
  'true:0', 'n8n_events is RLS on with no policies');

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
delete from public.n8n_events where customer_id::text like 'c1680000-%';
delete from public.customers where id::text like 'c1680000-%';

\o
select '0168 BEHAVIOURAL TESTS PASSED' as result;
