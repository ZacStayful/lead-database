-- ============================================================================
-- Behavioural tests for 0165: the self-serve funnel's storage (batch 02,
-- Phase 1; docs/build/02-phase0-report.md).
--
--   1. funnel_sessions: every CHECK on its boundaries, the token-hash and
--      one-open-session-per-email indexes, and the paid stamp.
--   2. consume_funnel_preview: increments, refuses nothing itself, reaches 21
--      on the 21st call (the caller's ceiling is 20), resets after the
--      window, and returns null for an unknown session.
--   3. customers.signup_source defaults to 'call' and refuses anything else;
--      password_set_at is null.
--   4. post_call_offers.source admits 'funnel' and still refuses junk, and
--      the one-live-code-per-email index still holds across sources.
--   5. duplicate_subscriptions: the primary key is the idempotency claim,
--      and a subscription cannot duplicate itself.
--   6. Deny-all RLS on both new tables, the ACL, and invariant 7.
--   7. funnel_enabled ships 'false'.
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

-- Cleared up front so the suite can be re-run on the same database.
delete from public.funnel_sessions;
delete from public.duplicate_subscriptions;
delete from public.post_call_offers;
delete from public.lead_batch_reviews;
delete from public.lead_assignments;
delete from public.customer_lead_briefs;
delete from public.leads;
delete from public.customers;

-- A 64-hex token hash per session.
create or replace function test_util.h(n int) returns text language sql as $$
  select lpad(to_hex(n), 64, '0')
$$;

-- ---------------------------------------------------------------------------
-- 1 — funnel_sessions
-- ---------------------------------------------------------------------------
insert into public.funnel_sessions (id, token_hash, name, email, phone, monday_item_id)
values ('00000000-0000-0000-0000-0000000f0001', test_util.h(1), 'Ann Operator',
        'ann@example.com', '+447700900123', '13049622496');

select test_util.assert_eq(
  (select step || ':' || preview_count::text || ':' || (paid_at is null)::text
          || ':' || (answers = '{}'::jsonb)::text
     from public.funnel_sessions where token_hash = test_util.h(1)),
  'started:0:true:true', 'a new session starts at started, count 0, unpaid, empty answers');

select test_util.assert_raises(
  $$insert into public.funnel_sessions (token_hash, name, email)
    values ('not-a-hash', 'X', 'x@example.com')$$,
  'a token hash must be 64 hex characters');
select test_util.assert_raises(
  format($$insert into public.funnel_sessions (token_hash, name, email)
           values (%L, 'X', 'x@example.com')$$, test_util.h(1)),
  'the token hash is unique');
select test_util.assert_raises(
  format($$insert into public.funnel_sessions (token_hash, name, email)
           values (%L, 'Second', 'ann@example.com')$$, test_util.h(2)),
  'one open session per email');
select test_util.assert_raises(
  format($$insert into public.funnel_sessions (token_hash, name, email)
           values (%L, 'X', 'Upper@Example.com')$$, test_util.h(3)),
  'the email is stored lower-case');
select test_util.assert_raises(
  format($$insert into public.funnel_sessions (token_hash, name, email)
           values (%L, 'X', ' x@example.com')$$, test_util.h(3)),
  'the email is stored trimmed');
select test_util.assert_raises(
  format($$insert into public.funnel_sessions (token_hash, name, email)
           values (%L, 'X', 'not-an-email')$$, test_util.h(3)),
  'the email must look like one');
select test_util.assert_raises(
  format($$insert into public.funnel_sessions (token_hash, name, email)
           values (%L, '   ', 'y@example.com')$$, test_util.h(3)),
  'a blank name is refused');
select test_util.assert_raises(
  format($$insert into public.funnel_sessions (token_hash, name, email, monday_item_id)
           values (%L, 'X', 'y@example.com', 'abc')$$, test_util.h(3)),
  'a Monday item id is digits');
select test_util.assert_raises(
  format($$insert into public.funnel_sessions (token_hash, name, email, answers)
           values (%L, 'X', 'y@example.com', '[]')$$, test_util.h(3)),
  'answers is an object');
select test_util.assert_raises(
  format($$insert into public.funnel_sessions (token_hash, name, email, preview_snapshot)
           values (%L, 'X', 'y@example.com', '"x"')$$, test_util.h(3)),
  'the snapshot is an object');

-- The postcode lock: the same shape as customer_lead_briefs.base_postcode.
update public.funnel_sessions set base_postcode_locked = 'YO10 5DD' where token_hash = test_util.h(1);
update public.funnel_sessions set base_postcode_locked = 'YO10' where token_hash = test_util.h(1);
select test_util.assert_raises(
  format($$update public.funnel_sessions set base_postcode_locked = 'yo10 5dd' where token_hash = %L$$,
         test_util.h(1)),
  'the locked postcode is upper-case canonical');
select test_util.assert_raises(
  format($$update public.funnel_sessions set base_postcode_locked = 'YO10  5DD' where token_hash = %L$$,
         test_util.h(1)),
  'the locked postcode has one space');

update public.funnel_sessions set plan_selected = 10 where token_hash = test_util.h(1);
update public.funnel_sessions set plan_selected = 20 where token_hash = test_util.h(1);
select test_util.assert_raises(
  format($$update public.funnel_sessions set plan_selected = 15 where token_hash = %L$$, test_util.h(1)),
  'the plan is 10 or 20');
select test_util.assert_raises(
  format($$update public.funnel_sessions set step = 'abandoned' where token_hash = %L$$, test_util.h(1)),
  'an unknown step is refused');
select test_util.assert_raises(
  format($$update public.funnel_sessions set step = 'paid' where token_hash = %L$$, test_util.h(1)),
  'paid needs paid_at');
select test_util.assert_raises(
  format($$update public.funnel_sessions set paid_at = now() where token_hash = %L$$, test_util.h(1)),
  'paid_at needs step paid');
select test_util.assert_raises(
  format($$update public.funnel_sessions set preview_count = -1 where token_hash = %L$$, test_util.h(1)),
  'the preview count is never negative');

-- updated_at is stamped by the trigger.
update public.funnel_sessions set updated_at = now() - interval '1 day' where token_hash = test_util.h(1);
update public.funnel_sessions set step = 'questions_done' where token_hash = test_util.h(1);
select test_util.assert_eq(
  (select updated_at > now() - interval '1 minute' from public.funnel_sessions where token_hash = test_util.h(1)),
  true, 'updated_at is stamped on update');

-- A paid session leaves the open-per-email index, so the same email can start again.
update public.funnel_sessions set step = 'paid', paid_at = now() where token_hash = test_util.h(1);
insert into public.funnel_sessions (token_hash, name, email)
values (test_util.h(4), 'Ann Again', 'ann@example.com');
select test_util.assert_eq(
  (select count(*)::int from public.funnel_sessions where email = 'ann@example.com'),
  2, 'a paid session does not block a new one for the same email');

-- ---------------------------------------------------------------------------
-- 2 — consume_funnel_preview
-- ---------------------------------------------------------------------------
insert into public.funnel_sessions (id, token_hash, name, email)
values ('00000000-0000-0000-0000-0000000f0002', test_util.h(5), 'Bob', 'bob@example.com');

select test_util.assert_eq(
  (public.consume_funnel_preview('00000000-0000-0000-0000-0000000f0002', 86400) ->> 'count')::int,
  1, 'the first preview counts 1');

do $$
begin
  for i in 2..20 loop
    perform public.consume_funnel_preview('00000000-0000-0000-0000-0000000f0002', 86400);
  end loop;
end $$;

select test_util.assert_eq(
  (select preview_count from public.funnel_sessions where id = '00000000-0000-0000-0000-0000000f0002'),
  20, 'twenty previews count 20');
select test_util.assert_eq(
  (public.consume_funnel_preview('00000000-0000-0000-0000-0000000f0002', 86400) ->> 'count')::int,
  21, 'the 21st preview returns 21 (the caller refuses above 20)');

-- After the window, the next preview opens a new one at 1.
update public.funnel_sessions
   set preview_window_started_at = now() - interval '25 hours'
 where id = '00000000-0000-0000-0000-0000000f0002';
select test_util.assert_eq(
  (public.consume_funnel_preview('00000000-0000-0000-0000-0000000f0002', 86400) ->> 'count')::int,
  1, 'a preview after the window starts a new one at 1');
select test_util.assert_eq(
  (select preview_window_started_at > now() - interval '1 minute'
     from public.funnel_sessions where id = '00000000-0000-0000-0000-0000000f0002'),
  true, 'the new window starts now');

select test_util.assert_eq(
  public.consume_funnel_preview('00000000-0000-0000-0000-00000000dead', 86400),
  null::jsonb, 'an unknown session returns null');

-- ---------------------------------------------------------------------------
-- 3 — customers.signup_source and password_set_at
-- ---------------------------------------------------------------------------
insert into public.customers (id, business_name, contact_name, email)
values ('00000000-0000-0000-0000-0000000c0001', 'Ann Co', 'Ann', 'ann-customer@example.com');

select test_util.assert_eq(
  (select signup_source || ':' || (password_set_at is null)::text
     from public.customers where id = '00000000-0000-0000-0000-0000000c0001'),
  'call:true', 'a new customer defaults to call, with no password stamp');

update public.customers set signup_source = 'funnel' where id = '00000000-0000-0000-0000-0000000c0001';
select test_util.assert_raises(
  $$update public.customers set signup_source = 'web' where id = '00000000-0000-0000-0000-0000000c0001'$$,
  'signup_source is call or funnel');
select test_util.assert_raises(
  $$update public.customers set signup_source = null where id = '00000000-0000-0000-0000-0000000c0001'$$,
  'signup_source is never null');

-- A session can point at the customer, and deleting the customer nulls it.
update public.funnel_sessions set customer_id = '00000000-0000-0000-0000-0000000c0001'
 where id = '00000000-0000-0000-0000-0000000f0002';

-- ---------------------------------------------------------------------------
-- 4 — post_call_offers.source gains 'funnel'
-- ---------------------------------------------------------------------------
insert into public.post_call_offers
  (id, prospect_email, stripe_promo_code_id, promo_code_string, expires_at, source)
values ('00000000-0000-0000-0000-0000000d0001', 'bob@example.com', 'promo_1', 'FOUNDING10-AAAA',
        now() + interval '24 hours', 'funnel');

select test_util.assert_raises(
  $$insert into public.post_call_offers
      (prospect_email, stripe_promo_code_id, promo_code_string, expires_at, source)
    values ('carl@example.com', 'promo_2', 'FOUNDING10-BBBB', now() + interval '24 hours', 'website')$$,
  'an unknown offer source is still refused');
select test_util.assert_raises(
  $$insert into public.post_call_offers
      (prospect_email, stripe_promo_code_id, promo_code_string, expires_at, source)
    values ('BOB@example.com', 'promo_3', 'FOUNDING10-CCCC', now() + interval '24 hours', 'manual')$$,
  'one live code per person across both routes');

update public.funnel_sessions set discount_offer_id = '00000000-0000-0000-0000-0000000d0001'
 where id = '00000000-0000-0000-0000-0000000f0002';

-- Deleting the offer and the customer nulls the session's pointers.
delete from public.post_call_offers where id = '00000000-0000-0000-0000-0000000d0001';
delete from public.customers where id = '00000000-0000-0000-0000-0000000c0001';
select test_util.assert_eq(
  (select (customer_id is null and discount_offer_id is null)
     from public.funnel_sessions where id = '00000000-0000-0000-0000-0000000f0002'),
  true, 'deleting the customer or the offer nulls the session pointers');

-- ---------------------------------------------------------------------------
-- 5 — duplicate_subscriptions
-- ---------------------------------------------------------------------------
insert into public.duplicate_subscriptions
  (subscription_id, stripe_customer_id, kept_subscription_id, detected_from)
values ('sub_new', 'cus_1', 'sub_old', 'subscription_created');

select test_util.assert_raises(
  $$insert into public.duplicate_subscriptions
      (subscription_id, stripe_customer_id, kept_subscription_id, detected_from)
    values ('sub_new', 'cus_1', 'sub_old', 'invoice_paid')$$,
  'a duplicate is claimed once (the primary key)');
select test_util.assert_raises(
  $$insert into public.duplicate_subscriptions
      (subscription_id, stripe_customer_id, kept_subscription_id, detected_from)
    values ('sub_x', 'cus_1', 'sub_x', 'invoice_paid')$$,
  'a subscription cannot duplicate itself');
select test_util.assert_raises(
  $$insert into public.duplicate_subscriptions
      (subscription_id, stripe_customer_id, kept_subscription_id, detected_from)
    values ('sub_y', 'cus_1', 'sub_old', 'portal')$$,
  'detected_from is one of the two webhook paths');

-- ---------------------------------------------------------------------------
-- 6 — RLS, ACL and invariant 7
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select string_agg(relname || ':' || relrowsecurity::text, ',' order by relname)
     from pg_class
    where relnamespace = 'public'::regnamespace
      and relname in ('funnel_sessions', 'duplicate_subscriptions')),
  'duplicate_subscriptions:true,funnel_sessions:true', 'RLS is on for both new tables');
select test_util.assert_eq(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename in ('funnel_sessions', 'duplicate_subscriptions')),
  0, 'and neither has a policy (deny-all to the browser)');

select test_util.assert_eq(
  (select has_function_privilege('anon', 'public.consume_funnel_preview(uuid, integer)', 'execute')
       or has_function_privilege('authenticated', 'public.consume_funnel_preview(uuid, integer)', 'execute')),
  false, 'consume_funnel_preview is not executable by anon or authenticated');
select test_util.assert_eq(
  (select has_function_privilege('service_role', 'public.consume_funnel_preview(uuid, integer)', 'execute')),
  true, 'consume_funnel_preview is executable by service_role');
select test_util.assert_eq(
  (select count(*)::int || ':' || bool_and(prosecdef)::text || ':' || max(pronargdefaults)::text
     from pg_proc
    where proname = 'consume_funnel_preview' and pronamespace = 'public'::regnamespace),
  '1:true:0', 'one signature, security definer, no defaults');

-- Invariant 7: exactly four SECURITY DEFINER functions are callable by authenticated.
select test_util.assert_eq(
  (select count(distinct p.proname)::int
     from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.prosecdef
      and has_function_privilege('authenticated', p.oid, 'execute')),
  4, 'invariant 7 still holds');

-- ---------------------------------------------------------------------------
-- 7 — the switch
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select value from public.system_settings where key = 'funnel_enabled'),
  'false', 'funnel_enabled ships false');

-- ---------------------------------------------------------------------------
delete from public.funnel_sessions;
delete from public.duplicate_subscriptions;
delete from public.post_call_offers;
delete from public.customers;
drop function test_util.h(int);

\o
select '0165 BEHAVIOURAL TESTS PASSED' as result;
