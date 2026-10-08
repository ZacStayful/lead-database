-- ============================================================================
-- Behavioural tests for 0161 and 0162 — the Lead Brief schema (Phase 1).
--
-- Both migrations are INERT: nothing reads the new columns or tables until the
-- brief code ships. So what matters here is that
--   (a) leads.outcode is derived correctly from the postcode, and cannot be
--       written directly;
--   (b) every CHECK on customer_lead_briefs admits the shapes the engine will
--       write and refuses the ones it must never write, as a CHECK VIOLATION
--       (23514) rather than some other error — a validator that raises on bad
--       input is a 500 on a bad write;
--   (c) one active and one pending brief per customer, enforced by the
--       database rather than by the writers (A10);
--   (d) the match_* columns on lead_assignments are null together, and the
--       money path still writes none of them;
--   (e) the new tables are deny-all and no new function is SECURITY DEFINER.
--
-- ⚠️ What is deliberately NOT asserted: the DEFAULT of
-- customers.lead_brief_required. It is false at 0162 and the go-live migration
-- flips it to true; a suite that runs after every migration cannot assert the
-- absence of a later migration's change (the lesson in 0158's suite). The
-- "every existing customer stays false" check is made on production at apply
-- time, where the existing rows are.
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

-- A refusal that must come from a CHECK, specifically. Any other error — a
-- cast failure, a jsonb function raising on the wrong type — fails the test.
create or replace function test_util.assert_check_violation(sql text, label text)
returns void language plpgsql as $$
begin
  begin
    execute sql;
  exception
    when check_violation then
      raise notice 'ok  % (%)', label, SQLERRM;
      return;
    when others then
      raise exception 'FAIL % — expected a check violation, got % (%)', label, SQLSTATE, SQLERRM;
  end;
  raise exception 'FAIL % — expected a check violation, none raised', label;
end $$;

-- ⚠️ Cleared UP FRONT as well as at the end: mutation testing aborts a suite
-- by design, and a suite that is not re-runnable reports the wrong failure on
-- the next pass.
delete from public.area_competition;
delete from public.lead_assignments;
delete from public.leads;
delete from public.customers;

insert into public.customers
  (id, business_name, contact_name, email, monthly_allocation, lead_balance,
   leads_received_this_month, billing_cycle_anchor,
   account_status, subscription_status, filter_status, lead_brief_required)
values
  ('d1111111-1111-1111-1111-111111111111','Briefed','A','brief@x.com',20,10,0,current_date - 3,
   'active','active','off', true),
  ('d2222222-2222-2222-2222-222222222222','Legacy','B','legacy@x.com',20,10,0,current_date - 3,
   'active','active','off', false);

-- A helper that builds one VALID brief, with any column overridden by a jsonb
-- patch, so each refusal below changes exactly one thing.
create or replace function test_util.brief_sql(p_patch jsonb default '{}'::jsonb)
returns text language plpgsql as $$
declare
  v jsonb := jsonb_build_object(
    'customer_id',          '''d1111111-1111-1111-1111-111111111111''',
    'version',              '1',
    'status',               '''active''',
    'base_postcode',        '''YO10 5DD''',
    'base_outcode',         '''YO10''',
    'operating_mode',       '''growing''',
    'travel_limit_miles',   '50',
    'allocation',           '20',
    'priorities',           '''[{"key":"location"},{"key":"revenue"},{"key":"bedrooms"},{"key":"occupancy"}]''::jsonb',
    'essentials',           '''{}''::text[]',
    'min_bedrooms',         'null',
    'min_gross',            'null',
    'priority_outcodes',    '''{}''::text[]',
    'similar_areas',        '''{}''::text[]',
    'service_radius_miles', '20',
    'service_outcodes',     '''{YO10,YO1,YO31}''::text[]',
    'first_pick_outcodes',  '''{}''::text[]',
    'pace_outcodes',        '''{}''::text[]',
    'expected_mix',         '''{}''::jsonb',
    'confirmed_at',         'now()',
    'superseded_at',        'null'
  ) || p_patch;
  cols text := '';
  vals text := '';
  k text;
begin
  for k in select jsonb_object_keys(v) loop
    cols := cols || case when cols = '' then '' else ', ' end || k;
    vals := vals || case when vals = '' then '' else ', ' end || (v ->> k);
  end loop;
  return format('insert into public.customer_lead_briefs (%s) values (%s)', cols, vals);
end $$;

-- ---------------------------------------------------------------------------
-- 1. 0161 — leads.outcode is generated from the postcode
-- ---------------------------------------------------------------------------
insert into public.leads (id, monday_item_id, lead_name, lead_type, postcode)
values
  ('e0000000-0000-0000-0000-000000000001','m-0162-1','L1','management','YO10 5DD'),
  ('e0000000-0000-0000-0000-000000000002','m-0162-2','L2','management',' yo10 5dd '),
  ('e0000000-0000-0000-0000-000000000003','m-0162-3','L3','management','M50 2HN'),
  ('e0000000-0000-0000-0000-000000000004','m-0162-4','L4','management','EC1A 1BB'),
  ('e0000000-0000-0000-0000-000000000005','m-0162-5','L5','management','LS2'),
  ('e0000000-0000-0000-0000-000000000006','m-0162-6','L6','management',null),
  ('e0000000-0000-0000-0000-000000000007','m-0162-7','L7','management','YO105DD'),
  ('e0000000-0000-0000-0000-000000000008','m-0162-8','L8','management','B22 2AX');

do $$
begin
  perform test_util.assert_eq(
    (select outcode from public.leads where id = 'e0000000-0000-0000-0000-000000000001'),
    'YO10', 'outcode from a canonical postcode');
  perform test_util.assert_eq(
    (select outcode from public.leads where id = 'e0000000-0000-0000-0000-000000000002'),
    'YO10', 'outcode ignores case and surrounding space');
  perform test_util.assert_eq(
    (select outcode from public.leads where id = 'e0000000-0000-0000-0000-000000000003'),
    'M50', '⚠️ an outcode missing from the centroid list is still stored (syntactic, not parseOutcode)');
  perform test_util.assert_eq(
    (select outcode from public.leads where id = 'e0000000-0000-0000-0000-000000000004'),
    'EC1A', 'a four-character London outcode');
  perform test_util.assert_eq(
    (select outcode from public.leads where id = 'e0000000-0000-0000-0000-000000000005'),
    null::text, 'an outcode on its own is not a postcode, so no outcode');
  perform test_util.assert_eq(
    (select outcode from public.leads where id = 'e0000000-0000-0000-0000-000000000006'),
    null::text, 'no postcode, no outcode');
  perform test_util.assert_eq(
    (select outcode from public.leads where id = 'e0000000-0000-0000-0000-000000000007'),
    'YO10', 'a postcode with the space missing still yields its outcode');
  perform test_util.assert_eq(
    (select outcode from public.leads where id = 'e0000000-0000-0000-0000-000000000008'),
    'B22', 'a well-formed but unreal postcode yields its outcode (harmless: no area lists it)');

  update public.leads set postcode = 'LS6 1AA' where id = 'e0000000-0000-0000-0000-000000000001';
  perform test_util.assert_eq(
    (select outcode from public.leads where id = 'e0000000-0000-0000-0000-000000000001'),
    'LS6', 'changing the postcode moves the outcode with it');
end $$;

select test_util.assert_raises(
  $q$update public.leads set outcode = 'ZZ1' where id = 'e0000000-0000-0000-0000-000000000003'$q$,
  'outcode cannot be written directly');

-- ---------------------------------------------------------------------------
-- 2. Shape and posture
-- ---------------------------------------------------------------------------
do $$
begin
  perform test_util.assert_eq(
    (select data_type || ' ' || is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'customers'
        and column_name = 'lead_brief_required'),
    'boolean NO', 'customers.lead_brief_required is a not-null boolean');
  perform test_util.assert_eq(
    (select data_type || ' ' || is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'customers'
        and column_name = 'lead_brief_completed_at'),
    'timestamp with time zone YES', 'customers.lead_brief_completed_at is a nullable timestamp');

  perform test_util.assert_eq(
    (select count(*)::int from pg_class
      where relnamespace = 'public'::regnamespace
        and relname in ('customer_lead_briefs', 'area_competition')
        and relrowsecurity),
    2, 'both new tables have RLS on');
  perform test_util.assert_eq(
    (select count(*)::int from pg_policies
      where schemaname = 'public'
        and tablename in ('customer_lead_briefs', 'area_competition')),
    0, '⚠️ and no policies: deny-all, read on the service role only (C19)');

  perform test_util.assert_eq(
    (select count(*)::int from pg_proc
      where pronamespace = 'public'::regnamespace
        and proname in ('lead_brief_codes_valid', 'lead_brief_essentials_valid',
                        'lead_brief_priorities_valid', 'lead_brief_mix_valid',
                        'touch_lead_brief_updated_at')
        and prosecdef),
    0, 'no new function is SECURITY DEFINER');
  perform test_util.assert_eq(
    (select count(*)::int from pg_proc
      where pronamespace = 'public'::regnamespace
        and proname in ('lead_brief_codes_valid', 'lead_brief_essentials_valid',
                        'lead_brief_priorities_valid', 'lead_brief_mix_valid')
        and provolatile = 'i'),
    4, 'the four validators are immutable, so a CHECK may call them');

  -- Invariant 7: still exactly the four named functions.
  perform test_util.assert_eq(
    (select count(distinct p.proname)::int from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and p.prosecdef
        and has_function_privilege('authenticated', p.oid, 'execute')),
    4, 'invariant 7: four SECURITY DEFINER names executable by authenticated');

  perform test_util.assert_eq(
    (select value from public.system_settings where key = 'lead_brief_enabled'),
    'false', 'the kill switch ships off (it is flipped in admin, never by a migration)');
  perform test_util.assert_eq(
    (select value from public.system_settings where key = 'lead_brief_pace_deficit_pct'),
    '20', 'the behind-pace threshold is 20% (D9)');
end $$;

-- ---------------------------------------------------------------------------
-- 3. A valid brief, and one active / one pending per customer (A10)
-- ---------------------------------------------------------------------------
do $$ begin execute test_util.brief_sql(); end $$;

do $$
begin
  perform test_util.assert_eq(
    (select count(*)::int from public.customer_lead_briefs
      where customer_id = 'd1111111-1111-1111-1111-111111111111' and status = 'active'),
    1, 'a valid, confirmed brief is accepted as active');
  perform test_util.assert_eq(
    (select origin from public.customer_lead_briefs
      where customer_id = 'd1111111-1111-1111-1111-111111111111' and version = 1),
    'customer', 'origin defaults to customer');
end $$;

select test_util.assert_raises(
  test_util.brief_sql('{"version":"2"}'),
  '⚠️ a second ACTIVE brief for one customer is refused');

do $$ begin
  execute test_util.brief_sql('{"version":"2","status":"''pending_confirmation''","confirmed_at":"null","origin":"''recompute''"}');
end $$;
select test_util.assert_eq(
  (select count(*)::int from public.customer_lead_briefs
    where customer_id = 'd1111111-1111-1111-1111-111111111111'),
  2, 'a pending version can sit beside the active one');

select test_util.assert_raises(
  test_util.brief_sql('{"version":"3","status":"''pending_confirmation''","confirmed_at":"null"}'),
  '⚠️ a second PENDING brief for one customer is refused');

select test_util.assert_raises(
  test_util.brief_sql('{"version":"1","status":"''superseded''","superseded_at":"now()"}'),
  'a version number is used once per customer');

do $$ begin
  execute test_util.brief_sql('{"version":"3","status":"''superseded''","superseded_at":"now()"}');
  execute test_util.brief_sql('{"version":"4","status":"''superseded''","superseded_at":"now()","confirmed_at":"null"}');
end $$;
select test_util.assert_eq(
  (select count(*)::int from public.customer_lead_briefs
    where customer_id = 'd1111111-1111-1111-1111-111111111111' and status = 'superseded'),
  2, 'superseded versions are unlimited, confirmed or not');

-- Everything below inserts under customer 2, which has no brief, so the
-- one-active index never interferes with a CHECK test. A refused case must
-- fail on a CHECK; an accepted one is inserted and then removed.
create or replace function test_util.refused(p_patch jsonb, p_label text)
returns void language plpgsql as $$
begin
  perform test_util.assert_check_violation(
    test_util.brief_sql(
      jsonb_build_object(
        'customer_id', '''d2222222-2222-2222-2222-222222222222''',
        'version', '10') || p_patch),
    p_label);
end $$;

create or replace function test_util.accepted(p_patch jsonb, p_label text)
returns void language plpgsql as $$
begin
  execute test_util.brief_sql(
    jsonb_build_object(
      'customer_id', '''d2222222-2222-2222-2222-222222222222''',
      'version', '10') || p_patch);
  delete from public.customer_lead_briefs
   where customer_id = 'd2222222-2222-2222-2222-222222222222';
  raise notice 'ok  %', p_label;
end $$;

select test_util.refused('{"confirmed_at":"null"}',
  'an active brief must have been confirmed');
select test_util.refused('{"superseded_at":"now()"}',
  'an active brief carries no superseded stamp');
select test_util.refused('{"status":"''superseded''"}',
  'a superseded brief must carry its stamp');
select test_util.refused('{"status":"''archived''"}',
  'status is active, pending_confirmation or superseded only');
select test_util.refused('{"origin":"''funnel''"}',
  'origin is customer, recompute or admin only');
select test_util.refused('{"version":"0"}',
  'versions start at 1');

-- ---------------------------------------------------------------------------
-- 4. The base postcode and its outcode
-- ---------------------------------------------------------------------------
select test_util.accepted('{"base_postcode":"''YO10''"}',
  'just the outcode is accepted as the base postcode');
select test_util.refused('{"base_postcode":"''yo10 5dd''"}',
  'the base postcode is stored upper-case');
select test_util.refused('{"base_postcode":"'' YO10 5DD''"}',
  'and trimmed');
select test_util.refused('{"base_outcode":"''YO1''"}',
  '⚠️ the outcode must be the outward part of the postcode (YO1 is not YO10)');
select test_util.refused('{"base_postcode":"''YO10 5DD XX''"}',
  'a base postcode longer than a UK postcode is refused');
-- The four below all START with the right outcode and a space, so the prefix
-- check alone would admit them: they isolate the format check. The mutation
-- run found that the four above did not.
select test_util.refused('{"base_postcode":"''YO10 5dd''"}',
  '⚠️ a lower-case inward code is refused');
select test_util.refused('{"base_postcode":"''YO10 5DD ''"}',
  '⚠️ a trailing space is refused');
select test_util.refused('{"base_postcode":"''YO10  5DD''"}',
  '⚠️ a doubled space is refused');
select test_util.refused('{"base_postcode":"''YO10 XYZ''"}',
  '⚠️ an inward code that is not digit-letter-letter is refused');

-- The validators answer false, never NULL: a CHECK passes on NULL.
do $$
begin
  -- 'YO' passes the pattern the CASE falls through to, so this is the input
  -- where everything but the kind test is true and the AND yields NULL.
  perform test_util.assert_eq(public.lead_brief_codes_valid(array['YO'], null), false,
    '⚠️ codes_valid(…, null kind) is false, not null');
  perform test_util.assert_eq(public.lead_brief_codes_valid(null, 'outcode'), false,
    'codes_valid(null, …) is false');
  perform test_util.assert_eq(public.lead_brief_codes_valid(array['YO10'], 'district'), false,
    'codes_valid with an unknown kind is false');
  perform test_util.assert_eq(public.lead_brief_essentials_valid(null), false,
    'essentials_valid(null) is false');
  perform test_util.assert_eq(public.lead_brief_priorities_valid(null), false,
    'priorities_valid(null) is false');
  perform test_util.assert_eq(public.lead_brief_mix_valid(null), false,
    'mix_valid(null) is false');
end $$;

-- ---------------------------------------------------------------------------
-- 5. Travel limit and operating mode (A8): derived, and validated as a list
-- ---------------------------------------------------------------------------
select test_util.accepted('{"operating_mode":"''local''","travel_limit_miles":"10","service_radius_miles":"10"}',
  '10 miles is local');
select test_util.accepted('{"operating_mode":"''growing''","travel_limit_miles":"25"}',
  '25 miles is growing');
select test_util.accepted('{"operating_mode":"''anywhere''","travel_limit_miles":"null"}',
  'anywhere has no travel limit');
select test_util.refused('{"operating_mode":"''local''","travel_limit_miles":"25"}',
  '25 miles is not local');
select test_util.refused('{"operating_mode":"''growing''","travel_limit_miles":"10","service_radius_miles":"10"}',
  '10 miles is not growing');
select test_util.refused('{"operating_mode":"''anywhere''","travel_limit_miles":"50"}',
  'anywhere cannot carry a limit');
select test_util.refused('{"operating_mode":"''local''","travel_limit_miles":"null"}',
  'local must carry a limit');
select test_util.refused('{"operating_mode":"''growing''","travel_limit_miles":"30"}',
  '⚠️ a distance the questionnaire does not offer is refused (a list, not a range)');

-- ---------------------------------------------------------------------------
-- 6. The radius cap (A3): the smaller of the travel limit and the plan maximum
-- ---------------------------------------------------------------------------
select test_util.accepted('{"allocation":"10","operating_mode":"''anywhere''","travel_limit_miles":"null","service_radius_miles":"40"}',
  'a 10-lead plan may reach 40 miles');
select test_util.refused('{"allocation":"10","operating_mode":"''anywhere''","travel_limit_miles":"null","service_radius_miles":"41"}',
  '⚠️ but never 41');
select test_util.accepted('{"allocation":"20","operating_mode":"''anywhere''","travel_limit_miles":"null","service_radius_miles":"75"}',
  'a 20-lead plan may reach 75 miles');
select test_util.refused('{"allocation":"20","operating_mode":"''anywhere''","travel_limit_miles":"null","service_radius_miles":"76"}',
  '⚠️ but never 76');
select test_util.refused('{"allocation":"20","operating_mode":"''growing''","travel_limit_miles":"25","service_radius_miles":"26"}',
  '⚠️ and never beyond the customer''s own travel limit');
select test_util.refused('{"service_radius_miles":"0"}',
  'a radius is at least one mile');
select test_util.refused('{"allocation":"0"}',
  'an allocation is positive');

-- ---------------------------------------------------------------------------
-- 7. Essentials (A8 Q3) and their thresholds
-- ---------------------------------------------------------------------------
select test_util.accepted('{"essentials":"''{bedrooms}''::text[]","min_bedrooms":"3"}',
  'minimum bedrooms as an essential, with its threshold');
select test_util.accepted('{"essentials":"''{revenue}''::text[]","min_gross":"50000"}',
  'minimum revenue as an essential, with its threshold');
select test_util.accepted('{"essentials":"''{revenue,bedrooms}''::text[]","min_gross":"25000","min_bedrooms":"2"}',
  'both essentials at once');
select test_util.refused('{"essentials":"''{bedrooms}''::text[]"}',
  'an essential without its threshold is refused');
select test_util.refused('{"min_bedrooms":"3"}',
  'a threshold without its essential is refused');
select test_util.refused('{"min_gross":"50000"}',
  'a revenue threshold without its essential is refused');
select test_util.refused('{"essentials":"''{revenue}''::text[]","min_gross":"45000"}',
  '⚠️ a revenue threshold off the GROSS_THRESHOLDS list is refused');
select test_util.refused('{"essentials":"''{bedrooms}''::text[]","min_bedrooms":"0"}',
  'zero bedrooms is not a minimum');
select test_util.refused('{"essentials":"''{bedrooms,bedrooms}''::text[]","min_bedrooms":"3"}',
  'an essential at most once');
select test_util.refused('{"essentials":"''{location}''::text[]"}',
  'location is a priority, not an essential (A8)');
select test_util.refused('{"essentials":"''{bedrooms,revenue,bedrooms}''::text[]","min_bedrooms":"3","min_gross":"25000"}',
  'at most two essentials');
select test_util.refused('{"essentials":"array[null]::text[]"}',
  'a null essential is refused');

-- ---------------------------------------------------------------------------
-- 8. Priorities (A8): a ranked jsonb array
-- ---------------------------------------------------------------------------
select test_util.accepted('{"priorities":"''[{\"key\":\"location\"},{\"key\":\"bedrooms\",\"threshold\":3}]''::jsonb"}',
  'a partial ranking with a numeric threshold');
select test_util.refused('{"priorities":"''[]''::jsonb"}',
  'an empty ranking is refused');
select test_util.refused('{"priorities":"''[{\"key\":\"location\"},{\"key\":\"location\"}]''::jsonb"}',
  'each priority at most once');
select test_util.refused('{"priorities":"''[{\"key\":\"location\"},{\"key\":\"revenue\"},{\"key\":\"bedrooms\"},{\"key\":\"occupancy\"},{\"key\":\"revenue\"}]''::jsonb"}',
  'more than four is refused');
select test_util.refused('{"priorities":"''[{\"key\":\"price\"}]''::jsonb"}',
  'an unknown priority is refused');
select test_util.refused('{"priorities":"''[{\"key\":\"bedrooms\",\"threshold\":\"three\"}]''::jsonb"}',
  'a threshold must be a number');
select test_util.refused('{"priorities":"''[\"location\"]''::jsonb"}',
  'each priority is an object, not a bare string');
select test_util.refused('{"priorities":"''{\"key\":\"location\"}''::jsonb"}',
  '⚠️ an object instead of an array is a CHECK violation, not a jsonb error');
select test_util.refused('{"priorities":"''\"location\"''::jsonb"}',
  '⚠️ and so is a scalar');

-- ---------------------------------------------------------------------------
-- 9. Area lists
-- ---------------------------------------------------------------------------
select test_util.accepted('{"priority_outcodes":"''{YO24,HG1}''::text[]","first_pick_outcodes":"''{YO41}''::text[]","pace_outcodes":"''{YO8,DN14}''::text[]","similar_areas":"''{HG,DL}''::text[]"}',
  'every list in its own format');
select test_util.refused('{"service_outcodes":"''{YO10,yo1}''::text[]"}',
  'a lower-case outcode is refused');
select test_util.refused('{"service_outcodes":"''{YO10,YO1,YO1}''::text[]"}',
  'a repeated outcode is refused');
select test_util.refused('{"service_outcodes":"array[''YO10'', null]::text[]"}',
  'a null outcode is refused');
select test_util.refused('{"first_pick_outcodes":"''{YO}''::text[]"}',
  'a postcode area is not an outcode');
select test_util.refused('{"similar_areas":"''{YO10}''::text[]"}',
  'an outcode is not a postcode area');
select test_util.refused('{"service_outcodes":"''{YO1,YO31}''::text[]"}',
  '⚠️ the base outcode is always inside the service area');
select test_util.refused('{"pace_outcodes":"''{YO8,YO31}''::text[]"}',
  '⚠️ pace outcodes are beyond the service area, never inside it (A11)');
select test_util.refused('{"service_outcodes":"''{}''::text[]"}',
  'a service area is never empty');

-- ---------------------------------------------------------------------------
-- 10. Expected mix: the customer's own allocation, never a volume (A4)
-- ---------------------------------------------------------------------------
select test_util.accepted('{"expected_mix":"''{\"top_match\":12,\"strong_match\":5,\"first_pick\":2,\"nearby_opportunity\":1}''::jsonb"}',
  'a split across the four labels');
select test_util.refused('{"expected_mix":"''{\"volume\":40}''::jsonb"}',
  'any key that is not a label is refused');
select test_util.refused('{"expected_mix":"''{\"top_match\":-1}''::jsonb"}',
  'a negative count is refused');
select test_util.refused('{"expected_mix":"''{\"top_match\":2.5}''::jsonb"}',
  'a fractional count is refused');
select test_util.refused('{"expected_mix":"''{\"top_match\":\"12\"}''::jsonb"}',
  '⚠️ a string count is a CHECK violation, not a cast error');
select test_util.refused('{"expected_mix":"''[12,5]''::jsonb"}',
  '⚠️ an array is a CHECK violation, not a jsonb error');

-- ---------------------------------------------------------------------------
-- 11. updated_at follows every update
-- ---------------------------------------------------------------------------
-- The touch trigger rewrites that update too, so set an old value with the
-- trigger out of the way, then prove an ordinary update moves it forward.
alter table public.customer_lead_briefs disable trigger trg_customer_lead_briefs_touch;
update public.customer_lead_briefs
   set updated_at = now() - interval '1 day'
 where customer_id = 'd1111111-1111-1111-1111-111111111111' and version = 2;
alter table public.customer_lead_briefs enable trigger trg_customer_lead_briefs_touch;
update public.customer_lead_briefs
   set locked_until = current_date + 30
 where customer_id = 'd1111111-1111-1111-1111-111111111111' and version = 2;
select test_util.assert_eq(
  (select updated_at > now() - interval '1 hour' from public.customer_lead_briefs
    where customer_id = 'd1111111-1111-1111-1111-111111111111' and version = 2),
  true, 'an update stamps updated_at');

-- ---------------------------------------------------------------------------
-- 12. The label on an assignment, and the money path untouched
-- ---------------------------------------------------------------------------
insert into public.leads (id, monday_item_id, lead_name, lead_type, postcode, postcode_area,
                          bedrooms, gross_annual_income, max_assignments, assignment_count)
values ('e0000000-0000-0000-0000-0000000000a1','m-0162-a1','Landlord','management',
        'YO10 5DD','YO','3', 52000, 3, 0);

do $$
declare v_assignment uuid;
begin
  select public.assign_lead_to_customer(
    'e0000000-0000-0000-0000-0000000000a1'::uuid,
    'd2222222-2222-2222-2222-222222222222'::uuid,
    15, 'management') into v_assignment;
  perform test_util.assert_eq(v_assignment is not null, true, 'an ordinary lead still allocates');
  perform test_util.assert_eq(
    (select lead_balance from public.customers where id = 'd2222222-2222-2222-2222-222222222222'),
    9, 'and still spends exactly one credit');
  perform test_util.assert_eq(
    (select (match_label, match_score, match_reasons, match_brief_id) is null
       from public.lead_assignments where id = v_assignment),
    true, '⚠️ and the money path writes no match_* column');
end $$;

select test_util.assert_check_violation(
  $q$update public.lead_assignments set match_label = 'top_match'
      where lead_id = 'e0000000-0000-0000-0000-0000000000a1'$q$,
  'a label without its score and reasons is refused');
select test_util.assert_check_violation(
  $q$update public.lead_assignments
        set match_brief_id = (select id from public.customer_lead_briefs
                               where customer_id = 'd1111111-1111-1111-1111-111111111111'
                                 and status = 'active')
      where lead_id = 'e0000000-0000-0000-0000-0000000000a1'$q$,
  'a brief pointer without a label is refused');
select test_util.assert_check_violation(
  $q$update public.lead_assignments
        set match_label = 'best', match_score = 1, match_reasons = '{}'
      where lead_id = 'e0000000-0000-0000-0000-0000000000a1'$q$,
  'an unknown label is refused');
select test_util.assert_check_violation(
  $q$update public.lead_assignments
        set match_label = 'top_match', match_score = -1, match_reasons = '{}'
      where lead_id = 'e0000000-0000-0000-0000-0000000000a1'$q$,
  'a negative score is refused');
select test_util.assert_check_violation(
  $q$update public.lead_assignments
        set match_label = 'top_match', match_score = 1, match_reasons = '[]'
      where lead_id = 'e0000000-0000-0000-0000-0000000000a1'$q$,
  'reasons are an object');

update public.lead_assignments
   set match_label = 'first_pick', match_score = 87.5,
       match_reasons = '{"first_pick":true}',
       match_brief_id = (select id from public.customer_lead_briefs
                          where customer_id = 'd1111111-1111-1111-1111-111111111111'
                            and status = 'superseded' and version = 3)
 where lead_id = 'e0000000-0000-0000-0000-0000000000a1';

delete from public.customer_lead_briefs
 where customer_id = 'd1111111-1111-1111-1111-111111111111' and version = 3;

select test_util.assert_eq(
  (select match_brief_id is null and match_label = 'first_pick'
     from public.lead_assignments where lead_id = 'e0000000-0000-0000-0000-0000000000a1'),
  true, 'deleting a brief nulls the pointer and keeps the label');

-- ---------------------------------------------------------------------------
-- 13. area_competition
-- ---------------------------------------------------------------------------
insert into public.area_competition (area_kind, area_code, tier, source)
values ('outcode', 'YO10', 'low', 'admin'),
       ('postcode_area', 'YO', 'medium', 'contention');

select test_util.assert_eq(
  (select count(*)::int from public.area_competition), 2,
  'an outcode tier and a postcode-area tier');
select test_util.assert_raises(
  $q$insert into public.area_competition (area_kind, area_code, tier, source)
     values ('outcode', 'YO10', 'high', 'contention')$q$,
  '⚠️ one row per area: a computed tier cannot sit beside an admin one');
select test_util.assert_check_violation(
  $q$insert into public.area_competition (area_kind, area_code, tier, source)
     values ('outcode', 'YO', 'low', 'admin')$q$,
  'a postcode area is not an outcode');
select test_util.assert_check_violation(
  $q$insert into public.area_competition (area_kind, area_code, tier, source)
     values ('postcode_area', 'yo', 'low', 'admin')$q$,
  'codes are upper-case');
select test_util.assert_check_violation(
  $q$insert into public.area_competition (area_kind, area_code, tier, source)
     values ('outcode', 'LS6', 'none', 'admin')$q$,
  'tier is high, medium or low');
select test_util.assert_check_violation(
  $q$insert into public.area_competition (area_kind, area_code, tier, source)
     values ('outcode', 'LS6', 'low', 'monday')$q$,
  'source is contention or admin');
select test_util.assert_check_violation(
  $q$insert into public.area_competition (area_kind, area_code, tier, source, note)
     values ('outcode', 'LS6', 'low', 'admin', repeat('x', 501))$q$,
  'a note is at most 500 characters');

update public.area_competition
   set updated_at = now() - interval '1 day' where area_code = 'YO10';
select test_util.assert_eq(
  (select updated_at > now() - interval '1 hour' from public.area_competition
    where area_code = 'YO10'),
  true, 'area_competition.updated_at is touched on update');

-- ---------------------------------------------------------------------------
-- 14. Deleting a customer removes their briefs
-- ---------------------------------------------------------------------------
delete from public.lead_assignments;
delete from public.customers where id = 'd1111111-1111-1111-1111-111111111111';
select test_util.assert_eq(
  (select count(*)::int from public.customer_lead_briefs), 0,
  'briefs cascade with their customer');

delete from public.area_competition;
delete from public.lead_assignments;
delete from public.leads;
delete from public.customers;

\o
select '0161/0162 BEHAVIOURAL TESTS PASSED' as result;
