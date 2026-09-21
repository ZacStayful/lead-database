-- ---------------------------------------------------------------------------
-- 0156 — The Facebook ad builder, part 1 (§65)
--
-- Customers buy leads at £15 each because generating their own is work they
-- cannot do. The landlord ad template pack (spec v1, 2026-09-20) defines ten
-- ad templates; this migration carries the four with no claims gate, the
-- drafts a customer builds from them, the PNGs that come out, and the ledger
-- that bounds what the model is asked to write.
--
-- ⚠️ IT STOPS SHORT OF PUBLISHING. Nothing here reaches Meta. Publishing needs
-- `ads_management` App Review, App Review needs a working demo to submit, and
-- this is that demo — gated to one owner email in the application layer.
--
-- Entirely additive: four new tables, two new columns, one trigger function,
-- one storage bucket. No function is replaced, no constraint is widened, and
-- nothing touches a balance, counter, pacing or capacity column, so a lagging
-- migration cannot affect lead allocation.
--
-- ⚠️ "ADDITIVE AND INERT" NEEDS ONE QUALIFICATION, AND IT IS `ad_profile`.
-- `customers_select_own` (0001) grants every signed-in customer `select` on
-- their own row, so from apply time `ad_profile` is readable over PostgREST
-- where before it answered "column does not exist". It holds nothing secret —
-- the boundary is `ad_drafts` and `ad_creatives`, both deny-all — but §27's
-- posture is that a surface cannot be probed, and this is a door no route gate
-- covers. Stated here rather than discovered later. It also rides in every
-- customer's RSC payload through getCurrentCustomer()'s select("*"), so the
-- blob stays small; past a few hundred bytes it moves to its own table.
--
-- ⚠️ The four template ids below are duplicated in src/lib/ads/templates.ts
-- and a file-text guard asserts set-equality, because a CHECK and a TypeScript
-- union that drift apart fail at the insert, after the model has been paid for.
-- Stage 2 of the spec WIDENS this constraint to the photo templates; that is a
-- planned widening, not a prohibition.
-- ---------------------------------------------------------------------------


-- ===========================================================================
-- 1. The business profile the ads are built from
--
-- A column on `customers` rather than a table, for §37's reason: the dashboard
-- reads this row with select("*"), so a column needs no join and no RLS work.
-- Its own timestamp, separate from presentation_settings_updated_at, because
-- §37.5 records what sharing one costs — that column is the "have they set
-- their terms up yet" test, and answering it by uploading an ad logo would
-- silently stop prompting somebody about terms they have never looked at.
--
-- ⚠️ MERGED IN SQL, NEVER READ-MODIFY-WRITE. Two writers exist — the answers
-- route and the profile PUT — so a tab race loses whichever edit landed first,
-- and the edit most likely to be lost is the fee, which decides whether a
-- price appears on a published ad. `ad_profile || $1::jsonb` is atomic per
-- key. It is SHALLOW: a nested array replaces wholesale, which is the §26.7
-- trap and is the wanted behaviour for the multi-selects.
--
-- Every field is an OVERRIDE, never a copy (§41.6): NULL means "use what the
-- account already has" — company_name from referral_business_name then
-- business_name, fee from presentation_settings, areas from filter_areas,
-- landing_url from messaging_booking_link then website_url, accent and logo
-- from presentation_brand. One value per fact, and a difference exists only
-- where somebody chose one on purpose.
-- ===========================================================================

alter table public.customers
  add column if not exists ad_profile jsonb not null default '{}'::jsonb;

alter table public.customers
  add column if not exists ad_profile_updated_at timestamptz;

alter table public.customers
  drop constraint if exists customers_ad_profile_object_check;
alter table public.customers
  add constraint customers_ad_profile_object_check
  check (jsonb_typeof(ad_profile) = 'object');

comment on column public.customers.ad_profile is
  'Overrides for the ad builder, merged with || and never read-modify-write. A '
  'NULL key means "use the account value" — see resolveSlots.ts for the chain. '
  'Holds the multi-selects (included, handled, councils, property_types), the '
  'fee treatment (fee_vat, fee_public), the trust figures, and the review '
  'quote with its provenance. Readable by the customer over PostgREST via '
  'customers_select_own, so nothing secret goes in it.';

comment on column public.customers.ad_profile_updated_at is
  'Last edit to ad_profile. Deliberately NOT presentation_settings_updated_at: '
  'that column is the "have they configured their terms" test (§37.5), and '
  'answering it as a side effect of an ad edit would stop the presentation '
  'prompting somebody who has never set their terms.';


-- ===========================================================================
-- 2. A draft — one ad being built
-- ===========================================================================

create table if not exists public.ad_drafts (
  id                uuid primary key default gen_random_uuid(),
  customer_id       uuid not null references public.customers(id) on delete cascade,

  -- What the customer pressed Send on. The pre-written prompt is editable, so
  -- this is their words and not a constant.
  prompt            text not null,

  -- Which template the model picked, and the sentence it gave for picking it.
  -- The reason is shown beside "Use a different angle" — a choice made on the
  -- customer's behalf that cannot explain itself reads as the product being
  -- arbitrary.
  template_id       text,
  template_reason   text,

  -- ⚠️ NOT NULL with an array default. jsonb_array_length(null) is NULL, and
  -- the simplify budget is DERIVED from this length — so a null here does not
  -- fail, it silently evaporates the budget, which is the exact
  -- desynchronisation deriving it was meant to prevent.
  questions         jsonb not null default '[]'::jsonb,

  -- Bumped whenever the question set is replaced, so a stale tab answering the
  -- previous set loses the race instead of writing answers to questions
  -- nobody was asked.
  questions_version integer not null default 0,

  -- The finished ad, shaped for ads_create_creative: message, headline,
  -- description, call_to_action_type, link_url. Not one blob — Meta takes four
  -- separate fields with four different maxima.
  copy              jsonb,

  -- The resolved slot values the copy and the image were built from. Kept so
  -- the figure check can be re-run against what was actually promised, and so
  -- a re-render a week later cannot quietly use different numbers.
  slots             jsonb,

  status            text not null default 'collecting',
  model_id          text,
  prompt_version    text,

  -- ⚠️ A BOUNDED CODE, NEVER A MODEL RESPONSE. Nothing in this feature logs a
  -- prompt or a completion, here or anywhere else.
  error             text,

  -- Discrete events with nothing to derive from, bounded by a CHECK and spent
  -- by a conditional UPDATE. This is NOT the simplify budget, which is derived
  -- from the per-question depth already stored in `questions`.
  template_switches integer not null default 0,
  regenerations     integer not null default 0,
  renders           integer not null default 0,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table public.ad_drafts
  drop constraint if exists ad_drafts_template_id_check;
alter table public.ad_drafts
  add constraint ad_drafts_template_id_check
  check (template_id is null or template_id in (
    'never-see-the-messages',
    'rules-keep-changing',
    'what-would-it-earn',
    'years-properties-review'
  ));

alter table public.ad_drafts
  drop constraint if exists ad_drafts_status_check;
alter table public.ad_drafts
  add constraint ad_drafts_status_check
  check (status in ('collecting', 'generating', 'ready', 'failed'));

alter table public.ad_drafts
  drop constraint if exists ad_drafts_budget_check;
alter table public.ad_drafts
  add constraint ad_drafts_budget_check
  check (template_switches between 0 and 3
     and regenerations     between 0 and 3
     and renders           between 0 and 10
     and questions_version >= 0);

alter table public.ad_drafts
  drop constraint if exists ad_drafts_shape_check;
alter table public.ad_drafts
  add constraint ad_drafts_shape_check
  check (
        jsonb_typeof(questions) = 'array'
    and jsonb_array_length(questions) <= 12
    and (copy  is null or jsonb_typeof(copy)  = 'object')
    and (slots is null or jsonb_typeof(slots) = 'object')
    and length(btrim(prompt)) between 1 and 2000
    and (template_reason is null or length(btrim(template_reason)) between 1 and 500)
    and (model_id        is null or length(btrim(model_id))        between 1 and 80)
    and (prompt_version  is null or length(btrim(prompt_version))  between 1 and 40)
    and (error           is null or length(btrim(error))           between 1 and 500)
  );

-- ⚠️ A 'ready' draft with no copy is a result page rendering nothing, and a
-- 'failed' one with no error is a dead end the customer cannot act on.
alter table public.ad_drafts
  drop constraint if exists ad_drafts_terminal_shape_check;
alter table public.ad_drafts
  add constraint ad_drafts_terminal_shape_check
  check (
        (status <> 'ready'  or (copy is not null and slots is not null))
    and (status <> 'failed' or error is not null)
  );

-- Declared separately, never inline: `create table if not exists` silently
-- skips an inline index on a re-apply, so the second run leaves the table
-- looking right and the index missing.
create index if not exists ad_drafts_customer_recent_idx
  on public.ad_drafts (customer_id, created_at desc);

comment on table public.ad_drafts is
  'One ad being built. status is the state machine the answers route claims '
  'against: collecting -> generating is a conditional UPDATE, so a '
  'double-tapped Send runs synthesis once. Deletable by the customer, which is '
  'why the draft cap counts ad_generation_requests instead.';

comment on column public.ad_drafts.questions is
  'The question ladder, each entry carrying its own depth. NOT NULL because '
  'the simplify budget is derived from the array length, and a NULL length '
  'would make that budget vanish rather than fail.';

comment on column public.ad_drafts.copy is
  'Shaped for Meta ads_create_creative — message, headline, description, '
  'call_to_action_type, link_url — so part 2 maps it without a migration. No '
  'AI-disclosure value is set: the field declares AI-generated MEDIA, and ours '
  'is a Satori card with no model in it.';

comment on column public.ad_drafts.error is
  'A bounded code. Never a prompt, never a completion, never a provider body.';


-- ===========================================================================
-- 3. The rendered creatives
-- ===========================================================================

create table if not exists public.ad_creatives (
  id          uuid primary key default gen_random_uuid(),
  draft_id    uuid   not null references public.ad_drafts(id) on delete cascade,
  customer_id uuid   not null references public.customers(id) on delete cascade,
  ratio       text   not null,
  path        text   not null,
  size_bytes  bigint not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.ad_creatives
  drop constraint if exists ad_creatives_ratio_check;
alter table public.ad_creatives
  add constraint ad_creatives_ratio_check
  check (ratio in ('4x5', '9x16', '1x1'));

-- ⚠️ size_bytes > 0 is not decoration. ImageResponse does its work inside the
-- stream's start(), so a failed render is a clean 200 with an EMPTY body
-- rather than a throw — and without this the zero-byte result would upsert
-- straight over a good render. The route checks the length and the PNG magic
-- number before uploading; this is the second stop.
alter table public.ad_creatives
  drop constraint if exists ad_creatives_shape_check;
alter table public.ad_creatives
  add constraint ad_creatives_shape_check
  check (size_bytes > 0 and length(btrim(path)) between 1 and 400);

-- ⚠️ A UNIQUE INDEX DOES NOT OVERWRITE, IT RAISES 23505. Re-rendering is an
-- ordinary action — the customer presses Regenerate — so the writer must use
-- `on conflict (draft_id, ratio) do update`, or the second render of any draft
-- fails AFTER its PNGs have already been uploaded.
create unique index if not exists ad_creatives_draft_ratio_key
  on public.ad_creatives (draft_id, ratio);

create index if not exists ad_creatives_customer_idx
  on public.ad_creatives (customer_id);

comment on table public.ad_creatives is
  'One rendered PNG per (draft, ratio), pointing into the ad-creative bucket. '
  'The image route looks the row up by (draft_id, ratio) and redirects to the '
  'stored path — never a path rebuilt from the URL segment.';


-- ===========================================================================
-- 4. The ledger — append-only, one row per model call
--
-- ⚠️ THE DRAFT CAP COUNTS THIS TABLE, NOT ad_drafts. A customer may delete a
-- draft, so a cap counted there is a cap that resets itself.
--
-- ⚠️ draft_id carries NO FOREIGN KEY, deliberately. The record of what we
-- spent has to outlive the draft it was spent on, and this is also the only
-- thing that can answer what the demo exists to answer: which guardrail fires
-- most, how often the single retry succeeds, and how often we fall back to the
-- template's own default text.
-- ===========================================================================

create table if not exists public.ad_generation_requests (
  id             uuid primary key default gen_random_uuid(),
  customer_id    uuid not null references public.customers(id) on delete cascade,
  draft_id       uuid,
  kind           text not null,
  outcome        text not null,
  reject_reason  text,
  model_id       text,
  prompt_version text,
  attempt        integer not null default 1,
  -- ⚠️ usage.cache_read_input_tokens, so the prompt cache is a MEASUREMENT
  -- rather than an argument. The pack carries a cache breakpoint and clears
  -- the ~1024-token minimum on paper; whether a real customer's calls land
  -- inside the five-minute window is a question only live rows can answer,
  -- and a write costs 25% more than plain input when they do not.
  cache_read_tokens integer,
  created_at     timestamptz not null default now()
);

alter table public.ad_generation_requests
  drop constraint if exists ad_generation_requests_kind_check;
alter table public.ad_generation_requests
  add constraint ad_generation_requests_kind_check
  check (kind in ('questions', 'simplify', 'template', 'copy'));

alter table public.ad_generation_requests
  drop constraint if exists ad_generation_requests_outcome_check;
alter table public.ad_generation_requests
  add constraint ad_generation_requests_outcome_check
  check (outcome in ('ok', 'rejected', 'error'));

alter table public.ad_generation_requests
  drop constraint if exists ad_generation_requests_shape_check;
alter table public.ad_generation_requests
  add constraint ad_generation_requests_shape_check
  check (
        attempt between 1 and 5
    and (reject_reason  is null or length(btrim(reject_reason))  between 1 and 200)
    and (model_id       is null or length(btrim(model_id))       between 1 and 80)
    and (prompt_version is null or length(btrim(prompt_version)) between 1 and 40)
    and (cache_read_tokens is null or cache_read_tokens >= 0)
  );

-- Serves the 24-hour draft cap, which is the read on the request path.
create index if not exists ad_generation_requests_customer_recent_idx
  on public.ad_generation_requests (customer_id, created_at desc);

comment on table public.ad_generation_requests is
  'Append-only, one row per model call. The source for the per-customer draft '
  'cap — counted here rather than on ad_drafts, which the customer can delete '
  '— and the only record of which guardrail rejects what.';

comment on column public.ad_generation_requests.draft_id is
  'No foreign key on purpose: the record of a spend must survive the draft it '
  'was spent on.';

comment on column public.ad_generation_requests.cache_read_tokens is
  'Tokens served from the prompt cache on this call. Null means the provider '
  'reported none. The pack clears the cache minimum on paper; this is how we '
  'find out whether real calls land inside the window.';


-- ===========================================================================
-- 5. The tombstone
--
-- ⚠️ ad-creative IS THE FIRST BUCKET HERE WHERE AN OBJECT CAN OUTLIVE ITS ONLY
-- POINTER. 0092 and 0112 get "nothing to garbage-collect" from ONE OBJECT PER
-- OWNER at a fixed path, not from determinism — ask for the path and you have
-- it. Here objects accumulate per draft, and ad_creatives cascades from
-- ad_drafts, so deleting a draft destroys the only list of which objects exist.
--
-- The real fix is the route ordering — delete the objects, THEN the row — and
-- this is what makes that provable and what catches a delete that fails
-- halfway. A row trigger fires on cascade deletes at every level, so the
-- customer-delete path is covered too; that case is defensive, because this
-- system ARCHIVES customers (§18D) rather than deleting them.
--
-- Nothing drains it automatically. Deleting somebody's ad files on a timer is
-- a decision, not a default (§65 Deferred).
-- ===========================================================================

create table if not exists public.deleted_storage_objects (
  id           uuid primary key default gen_random_uuid(),
  bucket_id    text not null,
  object_path  text not null,
  requested_at timestamptz not null default now(),
  deleted_at   timestamptz,
  last_error   text
);

alter table public.deleted_storage_objects
  drop constraint if exists deleted_storage_objects_shape_check;
alter table public.deleted_storage_objects
  add constraint deleted_storage_objects_shape_check
  check (
        length(btrim(bucket_id))   between 1 and 80
    and length(btrim(object_path)) between 1 and 400
    and (last_error is null or length(btrim(last_error)) between 1 and 300)
  );

create index if not exists deleted_storage_objects_pending_idx
  on public.deleted_storage_objects (requested_at)
  where deleted_at is null;

comment on table public.deleted_storage_objects is
  'Objects whose only database pointer has gone. Written by trigger on '
  'ad_creatives delete, including cascades. Nothing drains it automatically.';


-- ===========================================================================
-- 6. Triggers
--
-- ⚠️ SECURITY INVOKER WITH NO ACL STATEMENTS, a verbatim copy of 0104's
-- touch_lead_analysis_updated_at. `security definer` on `new.updated_at :=
-- now()` buys nothing, and a revoke/grant pair here would be INERT anyway:
-- Postgres checks EXECUTE at CREATE TRIGGER time, not per row. search_path is
-- pinned regardless, because Supabase's linter flags a mutable one on any
-- function and a new warning left in the list is how the list stops being read.
-- ===========================================================================

create or replace function public.touch_ad_builder_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_ad_drafts_touch on public.ad_drafts;
create trigger trg_ad_drafts_touch
  before update on public.ad_drafts
  for each row execute function public.touch_ad_builder_updated_at();

drop trigger if exists trg_ad_creatives_touch on public.ad_creatives;
create trigger trg_ad_creatives_touch
  before update on public.ad_creatives
  for each row execute function public.touch_ad_builder_updated_at();

create or replace function public.record_deleted_ad_creative()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  insert into public.deleted_storage_objects (bucket_id, object_path)
  values ('ad-creative', old.path);
  return old;
end;
$$;

drop trigger if exists trg_ad_creatives_tombstone on public.ad_creatives;
create trigger trg_ad_creatives_tombstone
  after delete on public.ad_creatives
  for each row execute function public.record_deleted_ad_creative();


-- ===========================================================================
-- 7. Deny-all to the browser
--
-- RLS on with zero policies, the posture this schema already shares with some
-- fifty tables. Every read and write goes through a server route on the
-- service role, behind adsEnabledFor().
-- ===========================================================================

alter table public.ad_drafts              enable row level security;
alter table public.ad_creatives           enable row level security;
alter table public.ad_generation_requests enable row level security;
alter table public.deleted_storage_objects enable row level security;


-- ===========================================================================
-- 8. The bucket
--
-- Private, PNG only, 2 MB — the limit pairs to AD_CREATIVE_MAX_BYTES the way
-- 0092's pairs to MAX_REPORT_BYTES. Zero storage.objects policies: a creative
-- belongs to a DRAFT, read by our own route on the service role and by nobody
-- else, so a signature is the whole authorisation story and a policy would be
-- a second one to keep in step. That is 0092's and 0112's shape, not
-- lead-files', whose every policy keys on auth.uid() because each object there
-- belongs to exactly one customer.
--
-- ⚠️ THE MIME ALLOWLIST IS NOT A SAFETY PROPERTY. 0112 says it plainly: it
-- checks the same client-supplied string the caller sent, so neither is
-- evidence. What guarantees PNG is that the bytes come out of ImageResponse
-- and the route checks the magic number. What the allowlist DOES do is reject
-- an upload whose contentType was left unset — supabase-js defaults a Buffer
-- to text/plain — and because a failed upload degrades silently by design, the
-- symptom of forgetting it is "no images, ever".
--
-- Path: <customer_id>/<draft_id>/<ratio>.png, upsert true.
-- ===========================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ad-creative', 'ad-creative', false, 2097152, array['image/png'])
on conflict (id) do update
  set public             = false,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
