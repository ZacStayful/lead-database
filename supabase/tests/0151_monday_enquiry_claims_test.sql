-- ============================================================================
-- Behavioural tests for 0151 — Facebook lead ads become enquiries (§57).
--
-- Three guarantees, and everything else is boundary-checking around them:
--
--   1. ⚠️ ONE DECISION PER BOARD ITEM, EVER. The sync polls every minute, so
--      seeing the same item twice is the ordinary case rather than a rare one.
--      The unique index on monday_item_id is what turns the second look into a
--      23505 instead of a second customer and a second chase ladder.
--
--   2. ⚠️ THE CLAIM OUTLIVES ITS CUSTOMER. `on delete set null`, never cascade.
--      Under a cascade, deleting a customer takes the record that we already
--      handled their board item with them — and the next tick re-creates the
--      customer and starts a NEW ladder, sending an unattended WhatsApp to
--      somebody who was deleted from the database.
--
--   3. Nothing here touches money. 0151 is additive: a table, a defaulted
--      column, two widened CHECKs and a switch that ships false.
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

-- ⚠️ Cleared UP FRONT, not only at the end. Mutation-testing this suite aborts
-- it partway by design, which leaves the fixed-uuid customers below behind —
-- and the next run then dies on customers_pkey rather than on the assertion it
-- was meant to make. A suite that is not re-runnable reports the wrong failure.
delete from public.monday_enquiry_claims;
delete from public.prospect_booking_nudges
 where customer_id in ('00000000-0000-0000-0000-00000000f001',
                       '00000000-0000-0000-0000-00000000f002');
delete from public.customers
 where id in ('00000000-0000-0000-0000-00000000f001',
              '00000000-0000-0000-0000-00000000f002');

-- ---------------------------------------------------------------------------
-- 1. The migration is inert, and the switch ships off
-- ---------------------------------------------------------------------------
do $$
begin
  perform test_util.assert_eq(
    (select relrowsecurity from pg_class where relname = 'monday_enquiry_claims'),
    true, 'RLS is on');

  -- Deny-all to the browser. The house posture, shared with ~50 tables: every
  -- read and write goes through a server route on the service role.
  perform test_util.assert_eq(
    (select count(*)::int from pg_policies where tablename = 'monday_enquiry_claims'),
    0, 'and carries zero policies');

  perform test_util.assert_eq(
    (select value from public.system_settings where key = 'enquiry_sync_enabled'),
    'false', 'the switch ships false');

  -- ⚠️ Fail-closed depends on this being a parseable instant. A blank or
  -- unparseable cutoff must mean INGEST NOTHING, and the reader can only make
  -- that distinction if the seeded shape is known-good.
  perform test_util.assert_eq(
    (select value ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$'
       from public.system_settings where key = 'enquiry_sync_from'),
    true, 'the cutoff is seeded as a parseable UTC instant');

  -- Raised from 30 by this migration: the cap is global, and Facebook volume
  -- would otherwise starve website enquirers out of the same budget.
  perform test_util.assert_eq(
    (select value from public.system_settings where key = 'prospect_nudge_daily_cap'),
    '200', 'the shared daily cap was raised');
end $$;

-- ---------------------------------------------------------------------------
-- 2. ⚠️ GUARANTEE 1 — one decision per board item
-- ---------------------------------------------------------------------------
insert into public.monday_enquiry_claims (monday_item_id, monday_board_id)
values ('13049622496', '18420649520');

do $$
begin
  perform test_util.assert_raises(
    $q$insert into public.monday_enquiry_claims (monday_item_id, monday_board_id)
       values ('13049622496', '18420649520')$q$,
    'a second claim on the same board item is refused');

  -- A different item is of course fine — the guard is per item, not a lock on
  -- the table.
  insert into public.monday_enquiry_claims (monday_item_id, monday_board_id)
  values ('13028756392', '18420649520');

  perform test_util.assert_eq(
    (select count(*)::int from public.monday_enquiry_claims), 2,
    'a different item claims independently');

  perform test_util.assert_eq(
    (select status from public.monday_enquiry_claims where monday_item_id = '13049622496'),
    'pending', 'a fresh claim is pending, not settled');

  perform test_util.assert_eq(
    (select attempts from public.monday_enquiry_claims where monday_item_id = '13049622496'),
    1::smallint, 'and carries its first attempt');
end $$;

-- ---------------------------------------------------------------------------
-- 3. The closed vocabularies
-- ---------------------------------------------------------------------------
do $$
declare
  v text;
begin
  foreach v in array array['customer_created','customer_matched','already_linked',
                           'ambiguous_phone','junk','bad_email','stale_incomplete','error']
  loop
    update public.monday_enquiry_claims set outcome = v where monday_item_id = '13049622496';
  end loop;
  perform test_util.assert_eq(true, true, 'every documented outcome is accepted');

  perform test_util.assert_raises(
    $q$update public.monday_enquiry_claims set outcome = 'invented'
        where monday_item_id = '13049622496'$q$,
    'an outcome outside the vocabulary is refused');

  perform test_util.assert_raises(
    $q$update public.monday_enquiry_claims set status = 'halfway'
        where monday_item_id = '13049622496'$q$,
    'a status outside the vocabulary is refused');

  -- Null is the pending state and must stay writable.
  update public.monday_enquiry_claims set outcome = null where monday_item_id = '13049622496';
  perform test_util.assert_eq(
    (select outcome from public.monday_enquiry_claims where monday_item_id = '13049622496'),
    null::text, 'a null outcome is the pending state');
end $$;

-- ---------------------------------------------------------------------------
-- 4. ⚠️ GUARANTEE 2 — the claim outlives its customer
--
-- The mutation this catches is changing `on delete set null` to the cascade
-- that is the reflex everywhere else in this schema. Under a cascade the row
-- disappears with the customer, the next tick sees an unclaimed item, and the
-- prospect is re-created and chased again.
-- ---------------------------------------------------------------------------
insert into public.customers (id, business_name, contact_name, email, phone,
                              account_status, subscription_status)
values ('00000000-0000-0000-0000-00000000f001', 'Claim Co', 'Claim Co',
        'claim-test@example.com', '+447700900001', 'waitlisted', 'inactive');

update public.monday_enquiry_claims
   set customer_id = '00000000-0000-0000-0000-00000000f001',
       status = 'settled', outcome = 'customer_created', settled_at = now()
 where monday_item_id = '13049622496';

delete from public.customers where id = '00000000-0000-0000-0000-00000000f001';

do $$
begin
  perform test_util.assert_eq(
    (select count(*)::int from public.monday_enquiry_claims
      where monday_item_id = '13049622496'),
    1, 'deleting the customer LEAVES THE CLAIM STANDING');

  perform test_util.assert_eq(
    (select customer_id from public.monday_enquiry_claims
      where monday_item_id = '13049622496'),
    null::uuid, 'and nulls the pointer rather than cascading');

  -- The outcome survives too, so the run report can still say what happened.
  perform test_util.assert_eq(
    (select outcome from public.monday_enquiry_claims
      where monday_item_id = '13049622496'),
    'customer_created', 'and keeps what we decided about it');
end $$;

-- ---------------------------------------------------------------------------
-- 5. Where a ladder came from
-- ---------------------------------------------------------------------------
insert into public.customers (id, business_name, contact_name, email, phone,
                              account_status, subscription_status)
values ('00000000-0000-0000-0000-00000000f002', 'Source Co', 'Source Co',
        'source-test@example.com', '+447700900002', 'waitlisted', 'inactive');

insert into public.prospect_booking_nudges (customer_id)
values ('00000000-0000-0000-0000-00000000f002');

do $$
begin
  -- Every row that existed before 0151 reads 'website', which is true of all
  -- of them: /api/enquiry was the only creator until now.
  perform test_util.assert_eq(
    (select source from public.prospect_booking_nudges
      where customer_id = '00000000-0000-0000-0000-00000000f002'),
    'website', 'a ladder defaults to website, preserving every existing row');

  perform test_util.assert_raises(
    $q$update public.prospect_booking_nudges set source = 'facebook'
        where customer_id = '00000000-0000-0000-0000-00000000f002'$q$,
    'a source outside the vocabulary is refused');

  update public.prospect_booking_nudges set source = 'monday_sync'
   where customer_id = '00000000-0000-0000-0000-00000000f002';
  perform test_util.assert_eq(
    (select source from public.prospect_booking_nudges
      where customer_id = '00000000-0000-0000-0000-00000000f002'),
    'monday_sync', 'and monday_sync is accepted');
end $$;

-- ---------------------------------------------------------------------------
-- 6. A link we neither created nor guessed at
-- ---------------------------------------------------------------------------
do $$
begin
  update public.customers set monday_link_matched_by = 'monday_sync'
   where id = '00000000-0000-0000-0000-00000000f002';
  perform test_util.assert_eq(
    (select monday_link_matched_by from public.customers
      where id = '00000000-0000-0000-0000-00000000f002'),
    'monday_sync', 'monday_sync is now a legal link provenance');

  -- The widening must not have opened the column to anything at all.
  perform test_util.assert_raises(
    $q$update public.customers set monday_link_matched_by = 'guesswork'
        where id = '00000000-0000-0000-0000-00000000f002'$q$,
    'and the CHECK still refuses an unknown provenance');

  -- Every 0086 value still works — a widening that broke one would be a
  -- silent regression on 48 linked rows in production.
  update public.customers set monday_link_matched_by = 'created'
   where id = '00000000-0000-0000-0000-00000000f002';
  update public.customers set monday_link_matched_by = 'email'
   where id = '00000000-0000-0000-0000-00000000f002';
  update public.customers set monday_link_matched_by = 'phone'
   where id = '00000000-0000-0000-0000-00000000f002';
  update public.customers set monday_link_matched_by = 'name'
   where id = '00000000-0000-0000-0000-00000000f002';
  update public.customers set monday_link_matched_by = 'manual'
   where id = '00000000-0000-0000-0000-00000000f002';
  perform test_util.assert_eq(true, true, 'and every 0086 value still applies');
end $$;

-- ---------------------------------------------------------------------------
-- 7. ⚠️ GUARANTEE 3 — 0151 moves no money
-- ---------------------------------------------------------------------------
do $$
begin
  perform test_util.assert_eq(
    (select count(*)::int from information_schema.columns
      where table_schema = 'public'
        and table_name = 'monday_enquiry_claims'
        and column_name in ('lead_balance','gr_lead_balance','price_paid',
                            'leads_received_this_month','pool_debit')),
    0, 'the claims table carries no balance, counter or price column');

  perform test_util.assert_eq(
    (select count(*)::int from pg_indexes
      where indexname = 'monday_enquiry_claims_pending_idx'),
    1, 'the stuck report has its index — a pending claim is a lost lead');
end $$;

delete from public.prospect_booking_nudges
 where customer_id = '00000000-0000-0000-0000-00000000f002';
delete from public.customers where id = '00000000-0000-0000-0000-00000000f002';
delete from public.monday_enquiry_claims;

\o
select '0151 BEHAVIOURAL TESTS PASSED' as result;
