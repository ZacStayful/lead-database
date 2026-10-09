-- ============================================================================
-- Behavioural tests for 0166: enquiry routes on funnel sessions, and the
-- Monday claim table (batch 03 Part A, Phase 1;
-- docs/build/03-phase0-report.md, E1 and E3).
--
--   1. A session inserted without the new columns (the shape the deployed
--      session route writes) still inserts, with all three null.
--   2. entry_point and offer_order: every value on their closed lists, null,
--      and junk refused.
--   3. E1's overwrite rule, in the shape the route writes it: entry_point
--      changes while first_answered_at is null, and the same write changes
--      nothing once the first answer is stamped.
--   4. funnel_monday_writes: the primary key is the claim, the closed lists,
--      outcome and completed_at settled together, the detail cap, the FK and
--      the cascade.
--   5. E3: a claim does not move the session's updated_at, and the table has
--      no trigger of its own.
--   6. Deny-all RLS, no function added, and invariant 7.
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

-- Cleared up front so the suite can be re-run on the same database. The
-- claims go with their sessions (on delete cascade).
delete from public.funnel_sessions;

create or replace function test_util.h(n int) returns text language sql as $$
  select lpad(to_hex(n), 64, '0')
$$;

-- ---------------------------------------------------------------------------
-- 1 — the deployed route's insert still works
-- ---------------------------------------------------------------------------
insert into public.funnel_sessions (id, token_hash, name, email, phone, monday_item_id)
values ('00000000-0000-0000-0000-000000160001', test_util.h(1), 'Ann Operator',
        'ann@example.com', '+447700900123', '13049622496');

select test_util.assert_eq(
  (select (entry_point is null)::text || ':' || (offer_order is null)::text
          || ':' || (first_answered_at is null)::text
     from public.funnel_sessions where id = '00000000-0000-0000-0000-000000160001'),
  'true:true:true', 'a session inserted without the new columns has all three null');

-- ---------------------------------------------------------------------------
-- 2 — the closed lists
-- ---------------------------------------------------------------------------
update public.funnel_sessions set entry_point = 'instant'   where token_hash = test_util.h(1);
update public.funnel_sessions set entry_point = 'chase'     where token_hash = test_util.h(1);
update public.funnel_sessions set entry_point = 'no_show'   where token_hash = test_util.h(1);
update public.funnel_sessions set entry_point = 'post_call' where token_hash = test_util.h(1);
update public.funnel_sessions set entry_point = null        where token_hash = test_util.h(1);
select test_util.assert_eq(
  (select entry_point is null from public.funnel_sessions where token_hash = test_util.h(1)),
  true, 'all four entry points and null are accepted');

select test_util.assert_raises(
  format($$update public.funnel_sessions set entry_point = 'website' where token_hash = %L$$, test_util.h(1)),
  'an unknown entry point is refused');
select test_util.assert_raises(
  format($$update public.funnel_sessions set entry_point = 'Instant' where token_hash = %L$$, test_util.h(1)),
  'an entry point is lower-case');
select test_util.assert_raises(
  format($$update public.funnel_sessions set entry_point = 'no-show' where token_hash = %L$$, test_util.h(1)),
  'no_show takes an underscore');
select test_util.assert_raises(
  format($$update public.funnel_sessions set entry_point = '' where token_hash = %L$$, test_util.h(1)),
  'an empty entry point is refused (absent is null)');

update public.funnel_sessions set offer_order = 'call_first'   where token_hash = test_util.h(1);
update public.funnel_sessions set offer_order = 'funnel_first' where token_hash = test_util.h(1);
update public.funnel_sessions set offer_order = null           where token_hash = test_util.h(1);
select test_util.assert_eq(
  (select offer_order is null from public.funnel_sessions where token_hash = test_util.h(1)),
  true, 'both offer orders and null are accepted');
select test_util.assert_raises(
  format($$update public.funnel_sessions set offer_order = 'random' where token_hash = %L$$, test_util.h(1)),
  'an unknown offer order is refused');
select test_util.assert_raises(
  format($$update public.funnel_sessions set offer_order = 'call-first' where token_hash = %L$$, test_util.h(1)),
  'call_first takes an underscore');
select test_util.assert_raises(
  format($$update public.funnel_sessions set offer_order = '' where token_hash = %L$$, test_util.h(1)),
  'an empty offer order is refused (absent is null)');

-- Refusing a few junk values cannot see a list widened by one extra value, so
-- the four closed lists are also read back from the constraints themselves.
select test_util.assert_eq(
  (select string_agg(conname || ' ' || pg_get_constraintdef(oid), E'\n' order by conname)
     from pg_constraint
    where conname in ('funnel_sessions_entry_point', 'funnel_sessions_offer_order',
                      'funnel_monday_writes_transition', 'funnel_monday_writes_outcome')),
  'funnel_monday_writes_outcome CHECK (((outcome IS NULL) OR (outcome = ANY (ARRAY[''written''::text, ''skipped''::text, ''failed''::text]))))' || E'\n' ||
  'funnel_monday_writes_transition CHECK ((transition = ANY (ARRAY[''started''::text, ''finished''::text])))' || E'\n' ||
  'funnel_sessions_entry_point CHECK (((entry_point IS NULL) OR (entry_point = ANY (ARRAY[''instant''::text, ''chase''::text, ''no_show''::text, ''post_call''::text]))))' || E'\n' ||
  'funnel_sessions_offer_order CHECK (((offer_order IS NULL) OR (offer_order = ANY (ARRAY[''call_first''::text, ''funnel_first''::text]))))',
  'the four closed lists are exactly these values');

-- E3 from the other side: 0166 adds no Monday claim column to funnel_sessions.
-- monday_item_id (0165) is the only Monday column the session row carries.
select test_util.assert_eq(
  (select string_agg(column_name::text, ',' order by column_name)
     from information_schema.columns
    where table_schema = 'public' and table_name = 'funnel_sessions'
      and (column_name like '%monday%' or column_name in ('entry_point', 'offer_order', 'first_answered_at'))),
  'entry_point,first_answered_at,monday_item_id,offer_order',
  'funnel_sessions gains exactly the three route columns and no claim column');

-- ---------------------------------------------------------------------------
-- 3 — E1: entry_point moves only before the first answer
-- ---------------------------------------------------------------------------
update public.funnel_sessions set entry_point = 'instant', offer_order = 'call_first'
 where token_hash = test_util.h(1);

-- The route's write: guarded on first_answered_at being null, in the write.
update public.funnel_sessions set entry_point = 'chase'
 where id = '00000000-0000-0000-0000-000000160001' and first_answered_at is null;
select test_util.assert_eq(
  (select entry_point from public.funnel_sessions where token_hash = test_util.h(1)),
  'chase', 'before the first answer, a later call moves entry_point');

-- The answers route's stamp: first one wins.
update public.funnel_sessions set first_answered_at = '2026-10-09 10:00:00+00'
 where id = '00000000-0000-0000-0000-000000160001' and first_answered_at is null;
update public.funnel_sessions set first_answered_at = '2026-10-09 11:00:00+00'
 where id = '00000000-0000-0000-0000-000000160001' and first_answered_at is null;
select test_util.assert_eq(
  (select first_answered_at from public.funnel_sessions where token_hash = test_util.h(1)),
  '2026-10-09 10:00:00+00'::timestamptz, 'the first answer stamp is never moved');

update public.funnel_sessions set entry_point = 'post_call'
 where id = '00000000-0000-0000-0000-000000160001' and first_answered_at is null;
select test_util.assert_eq(
  (select entry_point || ':' || offer_order from public.funnel_sessions where token_hash = test_util.h(1)),
  'chase:call_first', 'after the first answer, the same write changes nothing');

-- ---------------------------------------------------------------------------
-- 4 — funnel_monday_writes
-- ---------------------------------------------------------------------------
insert into public.funnel_monday_writes (session_id, transition)
values ('00000000-0000-0000-0000-000000160001', 'started');

select test_util.assert_eq(
  (select (claimed_at is not null)::text || ':' || (outcome is null)::text || ':' || (completed_at is null)::text
     from public.funnel_monday_writes
    where session_id = '00000000-0000-0000-0000-000000160001' and transition = 'started'),
  'true:true:true', 'a fresh claim is stamped and unsettled');

select test_util.assert_raises(
  $$insert into public.funnel_monday_writes (session_id, transition)
    values ('00000000-0000-0000-0000-000000160001', 'started')$$,
  'the same transition cannot be claimed twice for one session');

insert into public.funnel_monday_writes (session_id, transition)
values ('00000000-0000-0000-0000-000000160001', 'finished');
select test_util.assert_eq(
  (select count(*)::int from public.funnel_monday_writes
    where session_id = '00000000-0000-0000-0000-000000160001'),
  2, 'each transition is its own claim');

select test_util.assert_raises(
  $$insert into public.funnel_monday_writes (session_id, transition)
    values ('00000000-0000-0000-0000-000000160001', 'paid')$$,
  'an unknown transition is refused');
select test_util.assert_raises(
  $$insert into public.funnel_monday_writes (session_id, transition)
    values ('00000000-0000-0000-0000-0000001600ff', 'started')$$,
  'a claim needs a real session');

update public.funnel_monday_writes set outcome = 'written', completed_at = now()
 where session_id = '00000000-0000-0000-0000-000000160001' and transition = 'started';
update public.funnel_monday_writes set outcome = 'skipped', completed_at = now(), detail = 'protected_status'
 where session_id = '00000000-0000-0000-0000-000000160001' and transition = 'finished';
update public.funnel_monday_writes set outcome = 'failed'
 where session_id = '00000000-0000-0000-0000-000000160001' and transition = 'finished';
select test_util.assert_eq(
  (select string_agg(transition || '=' || outcome, ',' order by transition)
     from public.funnel_monday_writes where session_id = '00000000-0000-0000-0000-000000160001'),
  'finished=failed,started=written', 'all three outcomes are accepted');

select test_util.assert_raises(
  $$update public.funnel_monday_writes set outcome = 'done'
     where session_id = '00000000-0000-0000-0000-000000160001' and transition = 'started'$$,
  'an unknown outcome is refused');
select test_util.assert_raises(
  $$update public.funnel_monday_writes set completed_at = null
     where session_id = '00000000-0000-0000-0000-000000160001' and transition = 'started'$$,
  'an outcome without a completion time is refused');
select test_util.assert_raises(
  $$update public.funnel_monday_writes set outcome = null
     where session_id = '00000000-0000-0000-0000-000000160001' and transition = 'started'$$,
  'a completion time without an outcome is refused');
select test_util.assert_raises(
  format($$update public.funnel_monday_writes set detail = %L
            where session_id = '00000000-0000-0000-0000-000000160001' and transition = 'started'$$,
         repeat('x', 501)),
  'detail is capped at 500 characters');
update public.funnel_monday_writes set detail = repeat('x', 500)
 where session_id = '00000000-0000-0000-0000-000000160001' and transition = 'started';

-- ---------------------------------------------------------------------------
-- 5 — E3: a claim never moves the session's updated_at
-- ---------------------------------------------------------------------------
insert into public.funnel_sessions (id, token_hash, name, email, step)
values ('00000000-0000-0000-0000-000000160002', test_util.h(2), 'Bob Operator',
        'bob@example.com', 'previewed');

create temporary table t_before as
  select updated_at from public.funnel_sessions where id = '00000000-0000-0000-0000-000000160002';

select pg_sleep(0.05);

insert into public.funnel_monday_writes (session_id, transition)
values ('00000000-0000-0000-0000-000000160002', 'finished');
update public.funnel_monday_writes set outcome = 'written', completed_at = now()
 where session_id = '00000000-0000-0000-0000-000000160002';

select test_util.assert_eq(
  (select s.updated_at = b.updated_at
     from public.funnel_sessions s, t_before b
    where s.id = '00000000-0000-0000-0000-000000160002'),
  true, 'claiming and settling a Monday write leaves the session''s updated_at alone');

select test_util.assert_eq(
  (select count(*)::int from pg_trigger
    where tgrelid = 'public.funnel_monday_writes'::regclass and not tgisinternal),
  0, 'the claim table has no trigger of its own');

-- And the session's own touch trigger still works, so the test above means something.
update public.funnel_sessions set plan_selected = 10 where id = '00000000-0000-0000-0000-000000160002';
select test_util.assert_eq(
  (select s.updated_at > b.updated_at
     from public.funnel_sessions s, t_before b
    where s.id = '00000000-0000-0000-0000-000000160002'),
  true, 'an update to the session itself still moves its updated_at');

drop table t_before;

-- The cascade: deleting a session takes its claims with it.
delete from public.funnel_sessions where id = '00000000-0000-0000-0000-000000160001';
select test_util.assert_eq(
  (select count(*)::int from public.funnel_monday_writes
    where session_id = '00000000-0000-0000-0000-000000160001'),
  0, 'a deleted session takes its claims with it');

-- ---------------------------------------------------------------------------
-- 6 — RLS, functions and invariant 7
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select relrowsecurity from pg_class where oid = 'public.funnel_monday_writes'::regclass),
  true, 'RLS is on for funnel_monday_writes');
select test_util.assert_eq(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'funnel_monday_writes'),
  0, 'and it has no policy (deny-all to the browser)');

-- 0166 adds no function: the only funnel function is still 0165's limiter.
select test_util.assert_eq(
  (select string_agg(proname, ',' order by proname) from pg_proc
    where pronamespace = 'public'::regnamespace
      and (proname ilike '%funnel%' or proname ilike '%entry_point%' or proname ilike '%offer_order%')),
  'consume_funnel_preview', 'no function was added');

select test_util.assert_eq(
  (select count(distinct p.proname)::int
     from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.prosecdef
      and has_function_privilege('authenticated', p.oid, 'execute')),
  4, 'invariant 7 still holds');

-- ---------------------------------------------------------------------------
delete from public.funnel_sessions;
drop function test_util.h(int);

\o
select '0166 BEHAVIOURAL TESTS PASSED' as result;
