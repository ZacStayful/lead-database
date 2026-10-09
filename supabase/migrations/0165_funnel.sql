-- ============================================================================
-- The self-serve funnel and the guarded checkout (batch 02, Phase 1).
-- Management only.
--
-- A Management enquirer can book a call or go through a short funnel at
-- /start/[token]: three questions, a non-binding Lead Brief preview, the
-- objections answered, then payment through ONE guarded checkout shared with
-- the post-call route, so nobody is charged twice. docs/build/02-* holds the
-- prompt and the approved Phase 0 report (decisions C1–C8).
--
-- What it adds:
--   1. funnel_sessions — one row per funnel journey, keyed by a token hash.
--   2. consume_funnel_preview() — the preview rate limit (20 per token per
--      24 hours), increment then compare.
--   3. customers.signup_source — 'call' or 'funnel'. Every existing row is
--      'call', by the column default.
--   4. customers.password_set_at — funnel payers arrive by magic link with no
--      password (C2). Null means the "set a password" prompt may show.
--   5. post_call_offers.source gains 'funnel' — the funnel discount is the
--      same single-use 24-hour code as after a call, one live code per person
--      across both routes (uq_post_call_offers_unredeemed_email, 0037).
--   6. duplicate_subscriptions — the webhook backstop's record of a second
--      Management subscription it cancelled and refunded (C3).
--   7. funnel_enabled — the kill switch, shipping 'false'.
--
-- ⚠️ INERT. Nothing reads any of it until batch 02's code ships, and the
-- funnel stays off until funnel_enabled is switched on. No existing function
-- is created, replaced or re-granted. The only existing objects touched are
-- one CHECK (widened, which cannot reject an existing row) and two new
-- customers columns (one defaulted, one nullable).
--
-- ⚠️ THE PREVIEW SNAPSHOT LIVES HERE, NOT IN customer_lead_briefs (C1).
-- That table needs a customer_id (none exists before payment), its origin
-- CHECK refuses 'funnel' and 0162's own suite asserts that, and
-- pending_confirmation belongs to batch 04's widening confirmation (A10).
-- The onboarding page reads the snapshot from here and the existing confirm
-- route writes the brief, unchanged.
--
-- ⚠️ RLS ON, NO POLICIES, on both new tables: every read and write goes
-- through a server route on the service role (the house posture).
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1 — funnel_sessions
--
-- ⚠️ THE TOKEN IS NEVER STORED, ONLY ITS SHA-256 (C6). The token is derived
-- by HMAC from the row id (src/lib/funnel/token.ts), so n8n asking twice for
-- the same enquirer gets the same URL back without the raw token sitting in
-- the database. The batch-review link does the same (0160, §73.4).
--
-- At most one unpaid session per email: a second request for the same email
-- returns the existing session. A paid session drops out of the index, so a
-- customer who leaves and comes back years later can start again.
-- ---------------------------------------------------------------------------
create table if not exists public.funnel_sessions (
  id                         uuid primary key default gen_random_uuid(),
  token_hash                 text not null,
  monday_item_id             text,
  name                       text not null,
  -- Stored lower-case and trimmed, so the unique index below needs no lower().
  email                      text not null,
  phone                      text,
  -- The raw answers (Q1–Q3) plus the similar areas the visitor ticked: what
  -- the onboarding confirmation is prefilled from (C1). Shape is checked in
  -- TypeScript (src/lib/funnel/answers.ts), which reads it field by field.
  answers                    jsonb not null default '{}',
  -- The first postcode previewed. Locked for the token: changing it means
  -- contacting Zac (02 Phase 2).
  base_postcode_locked       text,
  -- The last preview returned, exactly as the browser saw it
  -- (previewForClient): radii, tiers, labels and the mix as a split of the
  -- allocation. Never area volumes (02 locked decision 7).
  preview_snapshot           jsonb,
  plan_selected              integer,
  step                       text not null default 'started',
  checkout_session_id        text,
  customer_id                uuid references public.customers(id) on delete set null,
  discount_offer_id          uuid references public.post_call_offers(id) on delete set null,
  -- The preview rate limit's counter (consume_funnel_preview below).
  preview_count              integer not null default 0,
  preview_window_started_at  timestamptz,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  paid_at                    timestamptz,

  constraint funnel_sessions_token_hash_format check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint funnel_sessions_name_length check (char_length(btrim(name)) between 1 and 200),
  constraint funnel_sessions_email_format check (
    email = lower(btrim(email))
    and char_length(email) between 3 and 320
    and email like '%_@_%'
  ),
  constraint funnel_sessions_phone_length check (phone is null or char_length(phone) <= 40),
  constraint funnel_sessions_monday_item_format check (
    monday_item_id is null or monday_item_id ~ '^[0-9]{1,20}$'
  ),
  constraint funnel_sessions_answers_object check (jsonb_typeof(answers) = 'object'),
  constraint funnel_sessions_snapshot_object check (
    preview_snapshot is null or jsonb_typeof(preview_snapshot) = 'object'
  ),
  -- The same canonical shape customer_lead_briefs.base_postcode uses (0162):
  -- an "OUT IN" postcode or just the outcode, upper-case, one space.
  constraint funnel_sessions_base_postcode_format check (
    base_postcode_locked is null
    or base_postcode_locked ~ '^[A-Z]{1,2}[0-9][A-Z0-9]?( [0-9][A-Z]{2})?$'
  ),
  constraint funnel_sessions_plan check (plan_selected is null or plan_selected in (10, 20)),
  constraint funnel_sessions_step check (
    step in ('started', 'questions_done', 'previewed', 'checkout_started', 'paid')
  ),
  -- Paid exactly when paid_at is stamped, so neither can be set without the other.
  constraint funnel_sessions_paid_stamp check ((step = 'paid') = (paid_at is not null)),
  constraint funnel_sessions_preview_count check (preview_count >= 0)
);

create unique index if not exists funnel_sessions_token_hash_key
  on public.funnel_sessions (token_hash);

create unique index if not exists funnel_sessions_one_open_per_email
  on public.funnel_sessions (email)
  where step <> 'paid';

-- The webhook's lookup at payment (Phase 5) and the admin view.
create index if not exists funnel_sessions_customer_idx
  on public.funnel_sessions (customer_id)
  where customer_id is not null;

-- The funnel-discount scan (Phase 5): sessions previewed and not yet paid.
create index if not exists funnel_sessions_previewed_idx
  on public.funnel_sessions (updated_at)
  where step = 'previewed' and discount_offer_id is null;

comment on table public.funnel_sessions is
  'Self-serve funnel journeys, Management only (0165, batch 02). Keyed by the '
  'SHA-256 of an HMAC-derived token; the raw token is never stored. Service '
  'role only (RLS on, no policies).';

alter table public.funnel_sessions enable row level security;

-- touch_lead_brief_updated_at (0162) is a plain updated_at stamp; reusing it
-- adds no new function.
drop trigger if exists trg_funnel_sessions_touch on public.funnel_sessions;
create trigger trg_funnel_sessions_touch
  before update on public.funnel_sessions
  for each row execute function public.touch_lead_brief_updated_at();


-- ---------------------------------------------------------------------------
-- 2 — consume_funnel_preview
--
-- INCREMENT THEN COMPARE, NEVER CHECK THEN INCREMENT (consume_reset_budget,
-- 0130). PostgREST cannot express `x = x + 1` (§65.6), so this is a function.
-- It has no opinion about the limit: the caller compares the returned count
-- with its own ceiling (20), so the limit tunes without a migration.
--
-- A rolling window per session: the first preview opens it, and a preview
-- after it has expired opens a new one at a count of 1. An unknown session
-- returns null, which the caller treats as "no such funnel".
-- ---------------------------------------------------------------------------
create or replace function public.consume_funnel_preview(
  p_session_id     uuid,
  p_window_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count   integer;
  v_started timestamptz;
begin
  update public.funnel_sessions
     set preview_count = case
           when preview_window_started_at is null
             or preview_window_started_at
                  <= now() - make_interval(secs => greatest(p_window_seconds, 1))
           then 1
           else preview_count + 1
         end,
         preview_window_started_at = case
           when preview_window_started_at is null
             or preview_window_started_at
                  <= now() - make_interval(secs => greatest(p_window_seconds, 1))
           then now()
           else preview_window_started_at
         end
   where id = p_session_id
  returning preview_count, preview_window_started_at
       into v_count, v_started;

  if not found then
    return null;
  end if;

  return jsonb_build_object('count', v_count, 'window_started_at', v_started);
end;
$$;

-- A create or replace discards the ACL (§11), so the grants are stated here
-- and must be re-stated whenever this function is edited.
revoke execute on function public.consume_funnel_preview(uuid, integer)
  from public, anon, authenticated;
grant  execute on function public.consume_funnel_preview(uuid, integer)
  to service_role;

comment on function public.consume_funnel_preview(uuid, integer) is
  'Preview rate limit for the self-serve funnel (0165): increments the session''s '
  'counter inside a rolling window and returns {count, window_started_at}; null for '
  'an unknown session. The caller compares the count with its ceiling.';


-- ---------------------------------------------------------------------------
-- 3 and 4 — customers.signup_source and customers.password_set_at
--
-- signup_source: 'call' for every existing row (the default does the
-- backfill) and for every row created by the existing paths. Only funnel
-- provisioning (Phase 5) writes 'funnel'. Reporting only: nothing gates on it.
--
-- password_set_at: stamped when a customer sets a password from the
-- dashboard prompt (C2). Null on every existing row, which is harmless: the
-- prompt is shown only to signup_source = 'funnel'.
-- ---------------------------------------------------------------------------
alter table public.customers
  add column if not exists signup_source text not null default 'call',
  add column if not exists password_set_at timestamptz;

alter table public.customers
  drop constraint if exists customers_signup_source_check;
alter table public.customers
  add constraint customers_signup_source_check
  check (signup_source in ('call', 'funnel'));

comment on column public.customers.signup_source is
  'How the customer first bought: ''call'' (invite, Payment Link or post-call) or '
  '''funnel'' (the self-serve funnel, 0165). Reporting only.';
comment on column public.customers.password_set_at is
  'When the customer set a password from the dashboard prompt (0165, C2). Funnel '
  'payers arrive by magic link with no password.';


-- ---------------------------------------------------------------------------
-- 5 — post_call_offers.source gains 'funnel'
--
-- A widened CHECK cannot reject an existing row. The one-live-code-per-email
-- index (0037) is untouched and is what keeps one code per person across
-- both routes (02 locked decision 3).
-- ---------------------------------------------------------------------------
alter table public.post_call_offers
  drop constraint if exists post_call_offers_source_check;
alter table public.post_call_offers
  add constraint post_call_offers_source_check
  check (source in ('manual', 'auto_monday', 'funnel'));


-- ---------------------------------------------------------------------------
-- 6 — duplicate_subscriptions
--
-- The backstop for a second Management subscription that slips past the
-- guarded checkout (C3) — in practice, a raw Payment Link still in someone's
-- inbox. The webhook records the duplicate here FIRST, then cancels it,
-- refunds its first invoice and emails Zac.
--
-- ⚠️ THE ROW IS WHAT STOPS THE CANCELLATION CASCADING. Cancelling the
-- duplicate fires customer.subscription.deleted, and on the same Stripe
-- customer that event would otherwise set the REAL customer to cancelled.
-- The webhook skips any subscription recorded here, and the credit path
-- skips its invoices. The primary key is the idempotency claim: two webhook
-- deliveries cannot both act on one duplicate.
-- ---------------------------------------------------------------------------
create table if not exists public.duplicate_subscriptions (
  subscription_id       text primary key,
  stripe_customer_id    text not null,
  kept_subscription_id  text not null,
  detected_from         text not null,
  invoice_id            text,
  detected_at           timestamptz not null default now(),
  cancelled_at          timestamptz,
  refund_id             text,
  emailed_at            timestamptz,
  error                 text,

  constraint duplicate_subscriptions_detected_from check (
    detected_from in ('subscription_created', 'invoice_paid')
  ),
  constraint duplicate_subscriptions_not_self check (subscription_id <> kept_subscription_id),
  constraint duplicate_subscriptions_error_length check (
    error is null or char_length(error) <= 500
  )
);

comment on table public.duplicate_subscriptions is
  'Second Management subscriptions the Stripe webhook cancelled and refunded '
  '(0165, batch 02). The webhook skips every subscription recorded here. Service '
  'role only (RLS on, no policies).';

alter table public.duplicate_subscriptions enable row level security;


-- ---------------------------------------------------------------------------
-- 7 — Settings
--
-- funnel_enabled ships OFF and is read by TypeScript only. ⚠️ Switching it on
-- is not enough by itself: a funnel payer is lead_brief_required, 0163 keeps
-- such customers out of the legacy pools, and brief routing runs only while
-- lead_brief_enabled is on. The checkout refuses to start a funnel payment
-- unless both are on, so nobody pays for leads routing would never send.
-- ---------------------------------------------------------------------------
insert into public.system_settings (key, value)
values ('funnel_enabled', 'false')
on conflict (key) do nothing;
