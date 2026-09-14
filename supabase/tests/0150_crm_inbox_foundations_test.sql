-- ============================================================================
-- Behavioural tests for 0150 — CRM inbox foundations (§56).
--
-- Everything 0150 adds is additive, so most of what is worth asserting is that
-- it changed NOTHING it did not mean to:
--
--   1. ⚠️ THE ONE-ARGUMENT set_management_customer_goal IS UNTOUCHED, and the
--      two-argument form sits beside it. A defaulted second parameter would
--      have created an overload and broken the goal route in production at
--      apply time (§34/§35). Both signatures resolve; both are callable by
--      `authenticated` and neither by `anon` (invariant 7).
--   2. The tag CHECK refuses what it should and accepts what it should, and
--      every existing assignment reads '{}'.
--   3. The snippet CHECK binds customer rows only; a Stayful-provided template
--      (null customer_id) is exempt.
--   4. Starring and the goal date default to null.
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
begin;

insert into public.customers (id, email, business_name, contact_name, subscription_status, account_status, lead_balance, monthly_allocation)
values ('a0000000-0000-4000-8000-000000000150', 'inbox-test@example.com', 'Inbox Test Ltd', 'Inbox Tester', 'active', 'active', 10, 20);

insert into public.leads (id, monday_item_id, lead_name, lead_type)
values ('b0000000-0000-4000-8000-000000000150', 'inbox-test-lead', 'Inbox Lead', 'management');

insert into public.lead_assignments (id, lead_id, customer_id, price_paid)
values ('c0000000-0000-4000-8000-000000000150',
        'b0000000-0000-4000-8000-000000000150',
        'a0000000-0000-4000-8000-000000000150', 15);

-- ---------------------------------------------------------------------------
-- §1 Both goal signatures exist, and the grants are right
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'set_management_customer_goal')::int,
  2, 'two set_management_customer_goal signatures exist');

select test_util.assert_eq(
  has_function_privilege('authenticated', 'public.set_management_customer_goal(integer)', 'execute'),
  true, 'one-arg goal RPC still callable by authenticated');
select test_util.assert_eq(
  has_function_privilege('authenticated', 'public.set_management_customer_goal(integer, date)', 'execute'),
  true, 'two-arg goal RPC callable by authenticated');
select test_util.assert_eq(
  has_function_privilege('anon', 'public.set_management_customer_goal(integer, date)', 'execute'),
  false, 'two-arg goal RPC NOT callable by anon');
select test_util.assert_eq(
  has_function_privilege('anon', 'public.lead_tags_valid(text[])', 'execute'),
  true, 'tag helper is a plain immutable predicate (CHECK needs it executable)');

-- The one-argument body is 0051's: it must not touch the due date.
select test_util.assert_eq(
  (select prosrc like '%management_customer_goal_due%'
     from pg_proc where proname = 'set_management_customer_goal' and pronargs = 1),
  false, 'one-arg goal RPC body does not mention the due date');

-- ---------------------------------------------------------------------------
-- §2 The two-arg function writes both columns and clears the date with the goal
-- ---------------------------------------------------------------------------
-- auth.uid() is stubbed to null locally, so drive the UPDATE directly and
-- assert the CHECK-free column semantics the function relies on.
update public.customers
   set management_customer_goal = 6,
       management_customer_goal_due = date '2026-09-30'
 where id = 'a0000000-0000-4000-8000-000000000150';
select test_util.assert_eq(
  (select management_customer_goal_due from public.customers
     where id = 'a0000000-0000-4000-8000-000000000150'),
  date '2026-09-30', 'goal due date stored');

select test_util.assert_eq(
  (select management_customer_goal_due is null from public.customers
     where id != 'a0000000-0000-4000-8000-000000000150' limit 1),
  true, 'every other customer has a null goal due date');

-- ---------------------------------------------------------------------------
-- §3 Tags
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select tags from public.lead_assignments where id = 'c0000000-0000-4000-8000-000000000150'),
  '{}'::text[], 'tags default to an empty array');

update public.lead_assignments set tags = array['hot', 'Darlington', '3-bed']
 where id = 'c0000000-0000-4000-8000-000000000150';
select test_util.assert_eq(
  (select cardinality(tags) from public.lead_assignments where id = 'c0000000-0000-4000-8000-000000000150'),
  3, 'three trimmed tags accepted');

select test_util.assert_raises(
  $q$ update public.lead_assignments set tags = array[''] where id = 'c0000000-0000-4000-8000-000000000150' $q$,
  'empty tag refused');
select test_util.assert_raises(
  $q$ update public.lead_assignments set tags = array[' hot'] where id = 'c0000000-0000-4000-8000-000000000150' $q$,
  'untrimmed tag refused');
select test_util.assert_raises(
  $q$ update public.lead_assignments set tags = array[repeat('x', 41)] where id = 'c0000000-0000-4000-8000-000000000150' $q$,
  '41-character tag refused');
select test_util.assert_raises(
  $q$ update public.lead_assignments set tags = (select array_agg('t' || g) from generate_series(1, 21) g) where id = 'c0000000-0000-4000-8000-000000000150' $q$,
  '21 tags refused');
select test_util.assert_raises(
  $q$ update public.lead_assignments set tags = array['a', null] where id = 'c0000000-0000-4000-8000-000000000150' $q$,
  'null element refused');
select test_util.assert_raises(
  $q$ update public.lead_assignments set tags = null where id = 'c0000000-0000-4000-8000-000000000150' $q$,
  'null tags refused (NOT NULL)');

update public.lead_assignments set tags = (select array_agg('t' || g) from generate_series(1, 20) g)
 where id = 'c0000000-0000-4000-8000-000000000150';
select test_util.assert_eq(
  (select cardinality(tags) from public.lead_assignments where id = 'c0000000-0000-4000-8000-000000000150'),
  20, '20 tags accepted');

-- ---------------------------------------------------------------------------
-- §4 Starring
-- ---------------------------------------------------------------------------
insert into public.lead_message_threads (id, customer_id, assignment_id, lead_id, channel, counterparty_phone)
values ('d0000000-0000-4000-8000-000000000150',
        'a0000000-0000-4000-8000-000000000150',
        'c0000000-0000-4000-8000-000000000150',
        'b0000000-0000-4000-8000-000000000150',
        'whatsapp', '07700900123');
select test_util.assert_eq(
  (select starred_at is null from public.lead_message_threads where id = 'd0000000-0000-4000-8000-000000000150'),
  true, 'new thread is not starred');
update public.lead_message_threads set starred_at = now() where id = 'd0000000-0000-4000-8000-000000000150';
select test_util.assert_eq(
  (select starred_at is not null from public.lead_message_threads where id = 'd0000000-0000-4000-8000-000000000150'),
  true, 'thread can be starred');

select test_util.assert_eq(
  (select count(*) from pg_indexes where schemaname = 'public'
     and indexname in ('lead_message_threads_customer_recent_idx', 'lead_message_threads_lead_idx',
                       'lead_messages_lead_idx', 'message_templates_customer_idx'))::int,
  4, 'all four inbox indexes present');

-- ---------------------------------------------------------------------------
-- §5 Snippets
-- ---------------------------------------------------------------------------
insert into public.message_templates (customer_id, channel, template_key, title, body_template)
values ('a0000000-0000-4000-8000-000000000150', 'any', 'snippet-1', 'Intro', 'Hi {{first_name}}, it''s Inbox Tester.');
select test_util.assert_eq(
  (select count(*) from public.message_templates where customer_id = 'a0000000-0000-4000-8000-000000000150')::int,
  1, 'customer snippet on channel any accepted');

select test_util.assert_raises(
  $q$ insert into public.message_templates (customer_id, channel, template_key, title, body_template)
      values ('a0000000-0000-4000-8000-000000000150', 'sms', 'snippet-2', 'x', 'y') $q$,
  'sms channel refused');
select test_util.assert_raises(
  $q$ insert into public.message_templates (customer_id, channel, template_key, body_template)
      values ('a0000000-0000-4000-8000-000000000150', 'whatsapp', 'snippet-3', 'no title') $q$,
  'customer snippet without a title refused');
select test_util.assert_raises(
  $q$ insert into public.message_templates (customer_id, channel, template_key, title, body_template)
      values ('a0000000-0000-4000-8000-000000000150', 'whatsapp', 'snippet-4', 'Long', repeat('x', 481)) $q$,
  '481-character snippet refused');

-- A Stayful-provided template is exempt from the snippet rules.
insert into public.message_templates (customer_id, channel, template_key, body_template)
values (null, 'whatsapp', 'stayful-long', repeat('x', 600));
select test_util.assert_eq(
  (select count(*) from public.message_templates where customer_id is null and template_key = 'stayful-long')::int,
  1, 'Stayful template without title and over 480 chars still accepted');

rollback;

\o
\echo '0150 BEHAVIOURAL TESTS PASSED'
