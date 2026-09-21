-- ============================================================================
-- Behavioural tests for 0156 — the Facebook ad builder, part 1 (§65).
--
-- Four guarantees, and everything else is boundary-checking around them:
--
--   1. ⚠️ A FAILED RENDER IS A CLEAN 200 WITH AN EMPTY BODY, NOT A THROW.
--      ImageResponse does the satori work inside the stream's start(), so
--      nothing rejects — and a zero-byte object would otherwise upsert
--      straight over a good creative. `size_bytes > 0` is the second stop
--      behind the route's own length and magic-number check.
--
--   2. ⚠️ RE-RENDERING IS ORDINARY, so the unique index must be written
--      through `on conflict (draft_id, ratio) do update`. A plain insert
--      raises 23505 on the second Regenerate — AFTER the PNGs have uploaded.
--
--   3. ⚠️ AN OBJECT MUST NEVER OUTLIVE ITS LAST POINTER SILENTLY. This is the
--      first bucket here where that is possible: creatives accumulate per
--      draft and cascade away with it, so deleting a draft destroys the only
--      list of what exists in storage. The tombstone trigger is what makes a
--      half-finished delete recoverable, and it has to fire on CASCADES.
--
--   4. 0156 moves no money. It is additive: four tables, two columns, one
--      trigger function, one bucket. An ordinary lead must still allocate and
--      still spend exactly one credit.
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

-- ⚠️ Cleared UP FRONT as well as at the end. Mutation-testing this suite
-- aborts it partway by design, which leaves the fixed-uuid rows behind — and
-- the next run then dies on customers_pkey rather than on the assertion it was
-- meant to make. A suite that is not re-runnable reports the wrong failure.
-- Children before parents, even though the cascades would do it, because an
-- ordering that relies on a cascade cannot then be used to TEST that cascade.
delete from public.deleted_storage_objects where bucket_id = 'ad-creative';
delete from public.ad_creatives           where customer_id in ('a0000000-0000-0000-0000-0000000000a1','a0000000-0000-0000-0000-0000000000a2');
delete from public.ad_generation_requests where customer_id in ('a0000000-0000-0000-0000-0000000000a1','a0000000-0000-0000-0000-0000000000a2');
delete from public.ad_drafts              where customer_id in ('a0000000-0000-0000-0000-0000000000a1','a0000000-0000-0000-0000-0000000000a2');
delete from public.lead_assignments       where customer_id in ('a0000000-0000-0000-0000-0000000000a1','a0000000-0000-0000-0000-0000000000a2');
delete from public.leads                  where id = 'adde0000-0000-0000-0000-0000000000a1'::uuid;
delete from public.customers              where id in ('a0000000-0000-0000-0000-0000000000a1','a0000000-0000-0000-0000-0000000000a2');

insert into public.customers
  (id, business_name, contact_name, email, monthly_allocation, lead_balance,
   leads_received_this_month, management_lifetime_leads_received,
   billing_cycle_anchor, account_status, subscription_status,
   gr_subscription_status, filter_status, gr_filter_status)
values
  ('a0000000-0000-0000-0000-0000000000a1','Adco','Zac','ads1@x.com',20,10,2,5,
   current_date - 3,'active','active','inactive','off','off'),
  ('a0000000-0000-0000-0000-0000000000a2','Adco Two','Other','ads2@x.com',20,10,2,5,
   current_date - 3,'active','active','inactive','off','off');


-- ---------------------------------------------------------------------------
-- 1. The posture: RLS on, zero policies, and the bucket as declared
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['ad_drafts','ad_creatives','ad_generation_requests','deleted_storage_objects'] loop
    perform test_util.assert_eq(
      (select relrowsecurity from pg_class where relname = t and relnamespace = 'public'::regnamespace),
      true, format('RLS is on for %s', t));
    perform test_util.assert_eq(
      (select count(*)::integer from pg_policies where schemaname = 'public' and tablename = t),
      0, format('%s is deny-all — zero policies', t));
  end loop;
end $$;

select test_util.assert_eq(
  (select public from storage.buckets where id = 'ad-creative'),
  false, 'the ad-creative bucket is private');
select test_util.assert_eq(
  (select file_size_limit from storage.buckets where id = 'ad-creative'),
  2097152::bigint, 'the size limit is AD_CREATIVE_MAX_BYTES (2 MB)');
select test_util.assert_eq(
  (select allowed_mime_types from storage.buckets where id = 'ad-creative'),
  array['image/png'], 'PNG only — a missing contentType is rejected, which is what makes a silent upload failure loud');

-- ⚠️ Zero storage.objects policies naming this bucket. A creative belongs to a
-- DRAFT, read by our route on the service role and by nobody else, so a
-- signature is the whole authorisation story (0092, 0112) — unlike lead-files,
-- whose every policy keys on auth.uid() because each object has one owner.
select test_util.assert_eq(
  (select count(*)::integer from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and (coalesce(qual, '') like '%ad-creative%' or coalesce(with_check, '') like '%ad-creative%')),
  0, 'no storage.objects policy names ad-creative');


-- ---------------------------------------------------------------------------
-- 2. ad_profile — the one column that is readable by the customer
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select ad_profile from public.customers where id = 'a0000000-0000-0000-0000-0000000000a1'),
  '{}'::jsonb, 'ad_profile defaults to an empty object, never null');
select test_util.assert_eq(
  (select ad_profile_updated_at from public.customers where id = 'a0000000-0000-0000-0000-0000000000a1'),
  null::timestamptz, 'ad_profile_updated_at is null until the profile is saved (the §37.5 NULL-is-not-empty test)');

select test_util.assert_raises($$
  update public.customers set ad_profile = '[]'::jsonb where id = 'a0000000-0000-0000-0000-0000000000a1'
$$, 'an array is refused — ad_profile is an object');
select test_util.assert_raises($$
  update public.customers set ad_profile = '"nope"'::jsonb where id = 'a0000000-0000-0000-0000-0000000000a1'
$$, 'a scalar is refused');

-- ⚠️ THE MERGE IS SHALLOW AND ATOMIC PER KEY. Two writers exist — the answers
-- route and the profile PUT — and read-modify-write loses whichever edit
-- landed first. The one most likely to be lost is the fee, which decides
-- whether a price appears on a published ad.
update public.customers
   set ad_profile = ad_profile || '{"fee_pct": 15, "included": ["messaging","cleaning"]}'::jsonb
 where id = 'a0000000-0000-0000-0000-0000000000a1';
update public.customers
   set ad_profile = ad_profile || '{"city": "Leeds"}'::jsonb
 where id = 'a0000000-0000-0000-0000-0000000000a1';
select test_util.assert_eq(
  (select ad_profile from public.customers where id = 'a0000000-0000-0000-0000-0000000000a1'),
  '{"fee_pct": 15, "included": ["messaging","cleaning"], "city": "Leeds"}'::jsonb,
  'a second || keeps the first writer''s keys');
update public.customers
   set ad_profile = ad_profile || '{"included": ["linen"]}'::jsonb
 where id = 'a0000000-0000-0000-0000-0000000000a1';
select test_util.assert_eq(
  (select ad_profile -> 'included' from public.customers where id = 'a0000000-0000-0000-0000-0000000000a1'),
  '["linen"]'::jsonb,
  '⚠️ a nested array REPLACES wholesale (the §26.7 trap) — which is what the multi-selects want');


-- ---------------------------------------------------------------------------
-- 3. ad_drafts — every CHECK on its boundaries
-- ---------------------------------------------------------------------------
insert into public.ad_drafts (id, customer_id, prompt)
values ('d0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-0000000000a1','Build me a Facebook ad');

select test_util.assert_eq(
  (select questions from public.ad_drafts where id = 'd0000000-0000-0000-0000-000000000001'),
  '[]'::jsonb, 'questions defaults to an empty array');
select test_util.assert_eq(
  (select status from public.ad_drafts where id = 'd0000000-0000-0000-0000-000000000001'),
  'collecting', 'a new draft is collecting');

-- ⚠️ questions must refuse NULL. jsonb_array_length(null) is NULL, and the
-- simplify budget is DERIVED from that length — so a null would not fail, it
-- would silently evaporate the budget, which is the exact desynchronisation
-- the derivation exists to prevent.
select test_util.assert_raises($$
  update public.ad_drafts set questions = null where id = 'd0000000-0000-0000-0000-000000000001'
$$, 'questions refuses null');
select test_util.assert_raises($$
  update public.ad_drafts set questions = '{}'::jsonb where id = 'd0000000-0000-0000-0000-000000000001'
$$, 'questions refuses an object — it is an array');

-- The four template ids, and nothing else. These are duplicated in
-- templates.ts and a file-text guard asserts set-equality.
do $$
declare t text;
begin
  foreach t in array array['never-see-the-messages','rules-keep-changing','what-would-it-earn','years-properties-review'] loop
    update public.ad_drafts set template_id = t where id = 'd0000000-0000-0000-0000-000000000001';
    perform test_util.assert_eq(
      (select template_id from public.ad_drafts where id = 'd0000000-0000-0000-0000-000000000001'),
      t, format('template %s is accepted', t));
  end loop;
end $$;
select test_util.assert_raises($$
  update public.ad_drafts set template_id = 'your-worst-case' where id = 'd0000000-0000-0000-0000-000000000001'
$$, 'a stage-2 photo template is refused until the constraint is widened');
select test_util.assert_raises($$
  update public.ad_drafts set status = 'rendering' where id = 'd0000000-0000-0000-0000-000000000001'
$$, 'an unknown status is refused');

-- The budget counters. Discrete events, bounded by a CHECK, spent by a
-- conditional UPDATE — NOT the simplify budget, which is derived per question.
select test_util.assert_raises($$
  update public.ad_drafts set renders = 11 where id = 'd0000000-0000-0000-0000-000000000001'
$$, 'renders stops at 10');
select test_util.assert_raises($$
  update public.ad_drafts set regenerations = 4 where id = 'd0000000-0000-0000-0000-000000000001'
$$, 'regenerations stops at 3');
select test_util.assert_raises($$
  update public.ad_drafts set template_switches = -1 where id = 'd0000000-0000-0000-0000-000000000001'
$$, 'a counter cannot go negative');
update public.ad_drafts set renders = 10, regenerations = 3, template_switches = 3
 where id = 'd0000000-0000-0000-0000-000000000001';
select test_util.assert_eq(
  (select renders from public.ad_drafts where id = 'd0000000-0000-0000-0000-000000000001'),
  10, 'the ceilings themselves are accepted');
update public.ad_drafts set renders = 0, regenerations = 0, template_switches = 0
 where id = 'd0000000-0000-0000-0000-000000000001';

select test_util.assert_raises($$
  insert into public.ad_drafts (customer_id, prompt)
  values ('a0000000-0000-0000-0000-0000000000a1', '   ')
$$, 'a blank prompt is refused');
select test_util.assert_raises($$
  insert into public.ad_drafts (customer_id, prompt)
  values ('a0000000-0000-0000-0000-0000000000a1', repeat('x', 2001))
$$, 'a 2001-character prompt is refused');
insert into public.ad_drafts (id, customer_id, prompt)
values ('d0000000-0000-0000-0000-0000000000ff','a0000000-0000-0000-0000-0000000000a1', repeat('x', 2000));
select test_util.assert_eq(
  (select length(prompt) from public.ad_drafts where id = 'd0000000-0000-0000-0000-0000000000ff'),
  2000, 'and 2000 is accepted');
delete from public.ad_drafts where id = 'd0000000-0000-0000-0000-0000000000ff';

select test_util.assert_raises($$
  update public.ad_drafts set error = repeat('x', 501) where id = 'd0000000-0000-0000-0000-000000000001'
$$, '⚠️ error is bounded at 500 — it stores a CODE, never a model response');

-- ⚠️ A terminal state that cannot be rendered. 'ready' with no copy is a
-- result page showing nothing; 'failed' with no error is a dead end the
-- customer cannot act on.
select test_util.assert_raises($$
  update public.ad_drafts set status = 'ready' where id = 'd0000000-0000-0000-0000-000000000001'
$$, 'ready with no copy is refused');
select test_util.assert_raises($$
  update public.ad_drafts set status = 'failed', error = null where id = 'd0000000-0000-0000-0000-000000000001'
$$, 'failed with no error is refused');
update public.ad_drafts
   set status = 'ready',
       copy  = '{"message":"x","headline":"y","description":"z","call_to_action_type":"LEARN_MORE","link_url":"https://e.com"}'::jsonb,
       slots = '{"city":"Leeds"}'::jsonb
 where id = 'd0000000-0000-0000-0000-000000000001';
select test_util.assert_eq(
  (select status from public.ad_drafts where id = 'd0000000-0000-0000-0000-000000000001'),
  'ready', 'ready with copy AND slots is accepted');


-- ---------------------------------------------------------------------------
-- 4. ⚠️ GUARANTEE 1 and 2 — the zero-byte bar, and re-rendering
-- ---------------------------------------------------------------------------
select test_util.assert_raises($$
  insert into public.ad_creatives (draft_id, customer_id, ratio, path, size_bytes)
  values ('d0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-0000000000a1','4x5','a/b/4x5.png', 0)
$$, '⚠️ a ZERO-BYTE creative is refused — a failed render is a clean 200 with an empty body, not a throw');
select test_util.assert_raises($$
  insert into public.ad_creatives (draft_id, customer_id, ratio, path, size_bytes)
  values ('d0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-0000000000a1','2x3','a/b/2x3.png', 100)
$$, 'an unknown ratio is refused');
select test_util.assert_raises($$
  insert into public.ad_creatives (draft_id, customer_id, ratio, path, size_bytes)
  values ('d0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-0000000000a1','4x5','   ', 100)
$$, 'a blank path is refused');

insert into public.ad_creatives (draft_id, customer_id, ratio, path, size_bytes)
values
  ('d0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-0000000000a1','4x5', 'a0000000-0000-0000-0000-0000000000a1/d0000000-0000-0000-0000-000000000001/4x5.png',  85604),
  ('d0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-0000000000a1','9x16','a0000000-0000-0000-0000-0000000000a1/d0000000-0000-0000-0000-000000000001/9x16.png', 91081),
  ('d0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-0000000000a1','1x1', 'a0000000-0000-0000-0000-0000000000a1/d0000000-0000-0000-0000-000000000001/1x1.png',  71655);
select test_util.assert_eq(
  (select count(*)::integer from public.ad_creatives where draft_id = 'd0000000-0000-0000-0000-000000000001'),
  3, 'three ratios stored');

select test_util.assert_raises($$
  insert into public.ad_creatives (draft_id, customer_id, ratio, path, size_bytes)
  values ('d0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-0000000000a1','4x5','x.png', 10)
$$, '⚠️ a PLAIN re-insert raises 23505 — which is why the writer must upsert');

-- The re-render path the route actually takes.
insert into public.ad_creatives (draft_id, customer_id, ratio, path, size_bytes)
values ('d0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-0000000000a1','4x5',
        'a0000000-0000-0000-0000-0000000000a1/d0000000-0000-0000-0000-000000000001/4x5.png', 90000)
on conflict (draft_id, ratio) do update
  set path = excluded.path, size_bytes = excluded.size_bytes, updated_at = now();
select test_util.assert_eq(
  (select size_bytes from public.ad_creatives
    where draft_id = 'd0000000-0000-0000-0000-000000000001' and ratio = '4x5'),
  90000::bigint, 'on conflict do update re-renders in place');
select test_util.assert_eq(
  (select count(*)::integer from public.ad_creatives where draft_id = 'd0000000-0000-0000-0000-000000000001'),
  3, 'and does not add a fourth row');

-- Two customers may hold the same ratio; the key is (draft, ratio).
insert into public.ad_drafts (id, customer_id, prompt)
values ('d0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000a2','Another ad');
insert into public.ad_creatives (draft_id, customer_id, ratio, path, size_bytes)
values ('d0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000a2','4x5','other/4x5.png', 500);
select test_util.assert_eq(
  (select count(*)::integer from public.ad_creatives where ratio = '4x5'),
  2, 'a different draft may hold the same ratio');


-- ---------------------------------------------------------------------------
-- 5. The ledger — append-only, and deliberately unhooked from the draft
-- ---------------------------------------------------------------------------
insert into public.ad_generation_requests (customer_id, draft_id, kind, outcome, model_id, prompt_version)
values ('a0000000-0000-0000-0000-0000000000a1','d0000000-0000-0000-0000-000000000001','questions','ok','claude-x','ad_questions_v1');
insert into public.ad_generation_requests (customer_id, draft_id, kind, outcome, reject_reason, attempt)
values ('a0000000-0000-0000-0000-0000000000a1','d0000000-0000-0000-0000-000000000001','copy','rejected','figure_not_in_slots',2);

select test_util.assert_raises($$
  insert into public.ad_generation_requests (customer_id, kind, outcome)
  values ('a0000000-0000-0000-0000-0000000000a1','headline','ok')
$$, 'an unknown kind is refused');
select test_util.assert_raises($$
  insert into public.ad_generation_requests (customer_id, kind, outcome)
  values ('a0000000-0000-0000-0000-0000000000a1','copy','maybe')
$$, 'an unknown outcome is refused');
select test_util.assert_raises($$
  insert into public.ad_generation_requests (customer_id, kind, outcome, attempt)
  values ('a0000000-0000-0000-0000-0000000000a1','copy','ok',6)
$$, 'attempt is bounded');

-- ⚠️ draft_id carries NO FOREIGN KEY. It must be insertable against a draft
-- that never existed, because the record of a spend has to outlive the draft.
insert into public.ad_generation_requests (customer_id, draft_id, kind, outcome)
values ('a0000000-0000-0000-0000-0000000000a1','d0000000-0000-0000-0000-00000000dead','copy','error');
select test_util.assert_eq(
  (select count(*)::integer from public.ad_generation_requests
    where draft_id = 'd0000000-0000-0000-0000-00000000dead'),
  1, '⚠️ the ledger accepts a draft_id with no draft — no FK, on purpose');


-- ---------------------------------------------------------------------------
-- 6. The updated_at trigger, asserted BEHAVIOURALLY
--
-- ⚠️ These are separate top-level statements on purpose. now() is transaction
-- time, so an insert and an update inside one do-block share it and the test
-- passes whether the trigger exists or not.
-- ---------------------------------------------------------------------------
insert into public.ad_drafts (id, customer_id, prompt)
values ('d0000000-0000-0000-0000-00000000f1f1','a0000000-0000-0000-0000-0000000000a1','touch me');
select pg_sleep(0.05);
update public.ad_drafts set prompt = 'touched' where id = 'd0000000-0000-0000-0000-00000000f1f1';
select test_util.assert_eq(
  (select updated_at > created_at from public.ad_drafts where id = 'd0000000-0000-0000-0000-00000000f1f1'),
  true, 'the ad_drafts trigger moves updated_at');

select pg_sleep(0.05);
update public.ad_creatives set size_bytes = 91000
 where draft_id = 'd0000000-0000-0000-0000-000000000001' and ratio = '9x16';
select test_util.assert_eq(
  (select updated_at > created_at from public.ad_creatives
    where draft_id = 'd0000000-0000-0000-0000-000000000001' and ratio = '9x16'),
  true, 'the ad_creatives trigger moves updated_at');

-- SECURITY INVOKER with no ACL statements, a verbatim copy of 0104's. A
-- revoke/grant pair here would be inert: Postgres checks EXECUTE at CREATE
-- TRIGGER time, not per row.
select test_util.assert_eq(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('touch_ad_builder_updated_at','record_deleted_ad_creative')
      and p.prosecdef),
  0, 'both trigger functions are SECURITY INVOKER');
select test_util.assert_eq(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('touch_ad_builder_updated_at','record_deleted_ad_creative')
      and p.proconfig @> array['search_path=public']),
  2, 'and both pin search_path, so the linter list stays readable');


-- ---------------------------------------------------------------------------
-- 7. ⚠️ GUARANTEE 3 — the tombstone, including on a cascade
-- ---------------------------------------------------------------------------
delete from public.deleted_storage_objects where bucket_id = 'ad-creative';

-- (a) deleting the row directly
delete from public.ad_creatives
 where draft_id = 'd0000000-0000-0000-0000-000000000002' and ratio = '4x5';
select test_util.assert_eq(
  (select count(*)::integer from public.deleted_storage_objects
    where bucket_id = 'ad-creative' and object_path = 'other/4x5.png'),
  1, 'a direct delete leaves a tombstone naming the object');
select test_util.assert_eq(
  (select deleted_at from public.deleted_storage_objects where object_path = 'other/4x5.png'),
  null::timestamptz, 'and it is pending — nothing drains it automatically');

-- (b) ⚠️ the one that matters: a CASCADE from the customer, two levels up.
-- Row triggers fire at every level, which is what makes a half-finished
-- delete recoverable instead of silently orphaning three objects in storage.
delete from public.deleted_storage_objects where bucket_id = 'ad-creative';
delete from public.customers where id = 'a0000000-0000-0000-0000-0000000000a1';
select test_util.assert_eq(
  (select count(*)::integer from public.deleted_storage_objects where bucket_id = 'ad-creative'),
  3, '⚠️ deleting the CUSTOMER cascades through ad_drafts to ad_creatives and tombstones all three');
select test_util.assert_eq(
  (select count(distinct object_path)::integer from public.deleted_storage_objects where bucket_id = 'ad-creative'),
  3, 'and each tombstone names a distinct object path');

-- The cascades themselves
select test_util.assert_eq(
  (select count(*)::integer from public.ad_drafts where customer_id = 'a0000000-0000-0000-0000-0000000000a1'),
  0, 'drafts cascade from the customer');
select test_util.assert_eq(
  (select count(*)::integer from public.ad_creatives where customer_id = 'a0000000-0000-0000-0000-0000000000a1'),
  0, 'creatives cascade from the customer');
select test_util.assert_eq(
  (select count(*)::integer from public.ad_generation_requests where customer_id = 'a0000000-0000-0000-0000-0000000000a1'),
  0, 'the ledger cascades from the customer — it outlives the DRAFT, not the account');

-- draft -> creatives, on its own
insert into public.ad_creatives (draft_id, customer_id, ratio, path, size_bytes)
values ('d0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000a2','1x1','other/1x1.png', 500);
insert into public.ad_generation_requests (customer_id, draft_id, kind, outcome)
values ('a0000000-0000-0000-0000-0000000000a2','d0000000-0000-0000-0000-000000000002','copy','ok');
delete from public.ad_drafts where id = 'd0000000-0000-0000-0000-000000000002';
select test_util.assert_eq(
  (select count(*)::integer from public.ad_creatives where draft_id = 'd0000000-0000-0000-0000-000000000002'),
  0, 'creatives cascade from the draft');
select test_util.assert_eq(
  (select count(*)::integer from public.ad_generation_requests
    where draft_id = 'd0000000-0000-0000-0000-000000000002'),
  1, '⚠️ but the LEDGER row survives its draft — that is what the missing FK buys');


-- ---------------------------------------------------------------------------
-- 8. ⚠️ GUARANTEE 4 — 0156 moves no money
-- ---------------------------------------------------------------------------
select test_util.assert_eq(
  (select count(*)::integer from information_schema.columns
    where table_schema = 'public'
      and table_name in ('ad_drafts','ad_creatives','ad_generation_requests','deleted_storage_objects')
      and column_name in ('lead_balance','gr_lead_balance','price_paid','credits_added',
                          'leads_received_this_month','pool_debit','replacement_balance')),
  0, 'no ad table carries a balance, counter or price column');

insert into public.leads
  (id, monday_item_id, lead_name, postcode, postcode_area, bedrooms,
   max_assignments, assignment_count, lead_quality_status)
values ('adde0000-0000-0000-0000-0000000000a1','m-ads-regression','Regression lead',
        'LS1 1AA','LS','3 bedrooms',3,0,'passed');
select public.assign_lead_to_customer(
  'adde0000-0000-0000-0000-0000000000a1', 'a0000000-0000-0000-0000-0000000000a2', 15.00);
select test_util.assert_eq(
  (select lead_balance from public.customers where id = 'a0000000-0000-0000-0000-0000000000a2'),
  9, 'an ordinary lead still allocates and still spends exactly one credit');
select test_util.assert_eq(
  (select leads_received_this_month from public.customers where id = 'a0000000-0000-0000-0000-0000000000a2'),
  3, 'and still moves the monthly counter');


-- ---------------------------------------------------------------------------
-- Teardown
-- ---------------------------------------------------------------------------
delete from public.deleted_storage_objects where bucket_id = 'ad-creative';
delete from public.ad_creatives           where customer_id in ('a0000000-0000-0000-0000-0000000000a1','a0000000-0000-0000-0000-0000000000a2');
delete from public.ad_generation_requests where customer_id in ('a0000000-0000-0000-0000-0000000000a1','a0000000-0000-0000-0000-0000000000a2');
delete from public.ad_drafts              where customer_id in ('a0000000-0000-0000-0000-0000000000a1','a0000000-0000-0000-0000-0000000000a2');
delete from public.lead_assignments       where customer_id in ('a0000000-0000-0000-0000-0000000000a1','a0000000-0000-0000-0000-0000000000a2');
delete from public.leads                  where id = 'adde0000-0000-0000-0000-0000000000a1';
delete from public.customers              where id in ('a0000000-0000-0000-0000-0000000000a1','a0000000-0000-0000-0000-0000000000a2');

\o
select '0156 BEHAVIOURAL TESTS PASSED' as result;
