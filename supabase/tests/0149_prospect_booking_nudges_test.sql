-- ============================================================================
-- Behavioural tests for 0149 — chasing an enquirer who never books (§55).
--
-- The whole feature rests on two guarantees, and everything else here is
-- boundary-checking around them:
--
--   1. ⚠️ ONE LIVE LADDER PER PROSPECT. A repeat enquiry must not start a
--      second one — two ladders means two of every message, from a real
--      person's WhatsApp number, to a member of the public.
--
--   2. ⚠️ ONE SEND PER (LADDER, STEP, CHANNEL), EVER. The sending cron runs
--      every minute, so a step being considered twice is the ordinary case
--      rather than a rare one. The unique index is what turns the second
--      consideration into a 23505 instead of a duplicate message.
--
-- Plus the one that keeps a rebuild honest: the sender seed is a SELECT, so on
-- a database with no customers it inserts ZERO ROWS and does not error
-- (§46.6). A bare `values` list with a hardcoded uuid would fail every fresh
-- build, and nothing else in the suite would notice.
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
-- 0. The seed, on a database with no customers
--
-- Asserted BEFORE anything is inserted, because that is the only moment the
-- empty-customers case exists. It is the check that would catch somebody
-- "simplifying" the SELECT into a hardcoded uuid.
-- ---------------------------------------------------------------------------
delete from public.prospect_nudge_sends;
delete from public.prospect_booking_nudges;
delete from public.customers;

do $$
begin
  perform test_util.assert_eq(
    (select count(*) from public.system_settings
      where key = 'prospect_nudge_sender_customer_id')::int,
    0,
    'sender seed inserts zero rows when no customer matches');

  perform test_util.assert_eq(
    (select value from public.system_settings where key = 'prospect_nudge_enabled'),
    'false',
    'the switch ships false');

  perform test_util.assert_eq(
    (select value from public.system_settings where key = 'prospect_nudge_daily_cap'),
    '30',
    'the daily cap is seeded');
end $$;

-- ---------------------------------------------------------------------------
-- Seed: two prospects, exactly as POST /api/enquiry leaves them.
-- ---------------------------------------------------------------------------
insert into public.customers
  (id, business_name, contact_name, email, phone, account_status, subscription_status)
values
  ('11111111-1111-1111-1111-111111111111','Alpha Lets','Ann','ann@alpha.test',
   '+447700900001','waitlisted','inactive'),
  ('22222222-2222-2222-2222-222222222222','Beta Stays','Ben','ben@beta.test',
   '+447700900002','waitlisted','inactive');

-- ---------------------------------------------------------------------------
-- 1. RLS posture — on, with no policies at all
-- ---------------------------------------------------------------------------
do $$
begin
  perform test_util.assert_eq(
    (select relrowsecurity from pg_class where relname = 'prospect_booking_nudges'),
    true, 'prospect_booking_nudges has RLS on');
  perform test_util.assert_eq(
    (select relrowsecurity from pg_class where relname = 'prospect_nudge_sends'),
    true, 'prospect_nudge_sends has RLS on');
  perform test_util.assert_eq(
    (select count(*) from pg_policies
      where tablename in ('prospect_booking_nudges','prospect_nudge_sends'))::int,
    0, 'neither table has a policy — deny-all to the browser');
end $$;

-- ---------------------------------------------------------------------------
-- 2. ⚠️ One live ladder per prospect
-- ---------------------------------------------------------------------------
insert into public.prospect_booking_nudges (id, customer_id, enquired_at)
values ('aaaa1111-0000-0000-0000-000000000001',
        '11111111-1111-1111-1111-111111111111', now());

select test_util.assert_raises($$
  insert into public.prospect_booking_nudges (customer_id)
  values ('11111111-1111-1111-1111-111111111111')
$$, 'a second ACTIVE ladder for the same prospect is refused');

-- A different prospect is unaffected.
insert into public.prospect_booking_nudges (id, customer_id)
values ('aaaa1111-0000-0000-0000-000000000002',
        '22222222-2222-2222-2222-222222222222');

do $$
begin
  perform test_util.assert_eq(
    (select count(*) from public.prospect_booking_nudges where status = 'active')::int,
    2, 'two prospects hold one active ladder each');
end $$;

-- ⚠️ PARTIAL, NOT PLAIN. Once a ladder is finished the prospect may be
-- enrolled again by a fresh enquiry — a plain unique index would bar that for
-- ever, which is a different rule from the one intended.
update public.prospect_booking_nudges
   set status = 'stopped', stopped_reason = 'replied'
 where id = 'aaaa1111-0000-0000-0000-000000000002';

insert into public.prospect_booking_nudges (id, customer_id)
values ('aaaa1111-0000-0000-0000-000000000003',
        '22222222-2222-2222-2222-222222222222');

do $$
begin
  perform test_util.assert_eq(
    (select count(*) from public.prospect_booking_nudges
      where customer_id = '22222222-2222-2222-2222-222222222222')::int,
    2, 'a finished ladder does not bar a later one');
end $$;

-- ---------------------------------------------------------------------------
-- 3. Status CHECK
-- ---------------------------------------------------------------------------
do $$
declare s text;
begin
  foreach s in array array['active','booked','completed','stopped'] loop
    update public.prospect_booking_nudges set status = s
     where id = 'aaaa1111-0000-0000-0000-000000000003';
    perform test_util.assert_eq(
      (select status from public.prospect_booking_nudges
        where id = 'aaaa1111-0000-0000-0000-000000000003'),
      s, format('status %L accepted', s));
  end loop;
end $$;

select test_util.assert_raises($$
  update public.prospect_booking_nudges set status = 'pending'
   where id = 'aaaa1111-0000-0000-0000-000000000003'
$$, 'an unknown status is refused');

select test_util.assert_raises($$
  update public.prospect_booking_nudges set status = ''
   where id = 'aaaa1111-0000-0000-0000-000000000003'
$$, 'an empty status is refused');

-- ---------------------------------------------------------------------------
-- 4. ⚠️ The claim guard — one send per (ladder, step, channel)
-- ---------------------------------------------------------------------------
insert into public.prospect_nudge_sends (nudge_id, step, channel)
values ('aaaa1111-0000-0000-0000-000000000001', 1, 'whatsapp');

select test_util.assert_raises($$
  insert into public.prospect_nudge_sends (nudge_id, step, channel)
  values ('aaaa1111-0000-0000-0000-000000000001', 1, 'whatsapp')
$$, 'the same (ladder, step, channel) collides — the cron cannot send twice');

-- The OTHER channel of the same step is a different claim: step 1 is both.
insert into public.prospect_nudge_sends (nudge_id, step, channel)
values ('aaaa1111-0000-0000-0000-000000000001', 1, 'email');

-- And so is the same channel at a later step.
insert into public.prospect_nudge_sends (nudge_id, step, channel)
values ('aaaa1111-0000-0000-0000-000000000001', 2, 'whatsapp');

do $$
begin
  perform test_util.assert_eq(
    (select count(*) from public.prospect_nudge_sends
      where nudge_id = 'aaaa1111-0000-0000-0000-000000000001')::int,
    3, 'step 1 on both channels plus step 2 is three distinct claims');
end $$;

-- A different ladder at the same step and channel is unrelated.
insert into public.prospect_nudge_sends (nudge_id, step, channel)
values ('aaaa1111-0000-0000-0000-000000000003', 1, 'whatsapp');

do $$
begin
  perform test_util.assert_eq(
    (select count(*) from public.prospect_nudge_sends)::int,
    4, 'the guard is scoped to one ladder, not global');
end $$;

-- ---------------------------------------------------------------------------
-- 5. Step and channel CHECKs, on their boundaries
-- ---------------------------------------------------------------------------
select test_util.assert_raises($$
  insert into public.prospect_nudge_sends (nudge_id, step, channel)
  values ('aaaa1111-0000-0000-0000-000000000003', 0, 'email')
$$, 'step 0 is refused');

select test_util.assert_raises($$
  insert into public.prospect_nudge_sends (nudge_id, step, channel)
  values ('aaaa1111-0000-0000-0000-000000000003', 4, 'email')
$$, 'step 4 is refused — the ladder is three rungs');

insert into public.prospect_nudge_sends (nudge_id, step, channel)
values ('aaaa1111-0000-0000-0000-000000000003', 3, 'email');

select test_util.assert_raises($$
  insert into public.prospect_nudge_sends (nudge_id, step, channel)
  values ('aaaa1111-0000-0000-0000-000000000003', 2, 'sms')
$$, 'an unknown channel is refused');

-- ---------------------------------------------------------------------------
-- 6. Cascades
--
-- A ladder is live state, not a record: when the prospect goes, it goes, and
-- its claims go with it. Nothing here is evidence anybody needs to keep.
-- ---------------------------------------------------------------------------
delete from public.prospect_booking_nudges
 where id = 'aaaa1111-0000-0000-0000-000000000003';

do $$
begin
  perform test_util.assert_eq(
    (select count(*) from public.prospect_nudge_sends
      where nudge_id = 'aaaa1111-0000-0000-0000-000000000003')::int,
    0, 'deleting a ladder cascades its claims');
end $$;

delete from public.customers where id = '11111111-1111-1111-1111-111111111111';

do $$
begin
  perform test_util.assert_eq(
    (select count(*) from public.prospect_booking_nudges
      where customer_id = '11111111-1111-1111-1111-111111111111')::int,
    0, 'deleting a customer cascades their ladder');
  perform test_util.assert_eq(
    (select count(*) from public.prospect_nudge_sends)::int,
    0, 'and the claims underneath it');
end $$;

-- ---------------------------------------------------------------------------
-- 7. The regression: 0149 touches no money column
--
-- The whole migration is additive, so this is cheap to assert and is what
-- would catch a future edit reaching for a balance.
-- ---------------------------------------------------------------------------
do $$
begin
  perform test_util.assert_eq(
    (select count(*) from information_schema.columns
      where table_schema = 'public'
        and table_name in ('prospect_booking_nudges','prospect_nudge_sends')
        and column_name in ('lead_balance','gr_lead_balance','price_paid',
                            'leads_received_this_month','pool_debit'))::int,
    0, 'neither table carries a balance, counter or price column');
end $$;

\o
select '0149 BEHAVIOURAL TESTS PASSED' as result;
