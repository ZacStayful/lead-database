-- ============================================================================
-- Self-serve cancellation: the audit trail, the pending end date, and the
-- pause-ending notice stamp.
--
-- OBJECTIVE
-- ---------
-- Until now a customer had NO working way to cancel. The settings page pointed
-- at "Manage billing", but the Stripe billing portal was not offering
-- cancellation, and there was no in-app route. The failure mode that makes this
-- urgent is the pause: a paused customer is re-billed automatically when their
-- pause ends, and a customer who wanted OUT but could only pause is exactly the
-- person who complains — with some justice — that we billed them against their
-- wishes. The feature this migration supports is the evidence trail against
-- that: a real cancel flow with reason capture, a confirmation email stating
-- the exact end-of-service date, a durable record of the request, an undo, and
-- an advance warning before a pause resumes billing.
--
-- LIVE STATE STAYS ON customers, HISTORY LIVES HERE — the same split as
-- subscription_pauses (0084) and subscription_plan_changes (0088). Whether a
-- cancellation is pending is customers.(gr_)cancel_at_period_end (0087), and
-- NOTHING reads subscription_cancellations to decide it. reverted_at is a
-- best-effort stamp; a missed stamp is a reporting gap, never a stuck state.
--
-- BOTH PRODUCTS (invariant 6). lead_type routes each row; the GR path reads no
-- management column. The webhook's cancellation_feedback capture is
-- management-only (0084) and DISCARDS the reason on a GR cancellation — this
-- table is the only place a GR customer's reason survives, which is half the
-- reason it exists.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 — Cancellation requests.
-- ---------------------------------------------------------------------------
create table if not exists public.subscription_cancellations (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid not null references public.customers(id) on delete cascade,
  lead_type     text not null,

  requested_at  timestamptz not null default now(),
  -- When the subscription actually ends (Stripe's cancel_at, falling back to
  -- the current period end). Nullable: subscriptionPeriodEnd() can return null
  -- on an unexpected API shape, and a missing date must not lose the record.
  effective_at  timestamptz,

  reasons       text[] not null,
  note          text,

  -- The single value passed to Stripe as cancellation_details.feedback (their
  -- enum takes one). The full multi-reason truth is `reasons`.
  stripe_feedback         text,
  -- Which subscription this was asked against — evidence, matching what Stripe
  -- shows, and stable even if the customer later re-subscribes on a new id.
  stripe_subscription_id  text not null,
  -- Resend message id of the confirmation email, written best-effort after the
  -- send. Evidence that the exact end date was communicated, and when.
  confirmation_email_id   text,

  -- Stamped when the customer chooses "Keep my subscription". Best-effort and
  -- REPORTING ONLY: live state is customers.(gr_)cancel_at_period_end, never
  -- this column. Stamped on the LATEST open row only, per stampEpisodeEnded's
  -- reasoning — a blanket update would close an older un-stamped row with
  -- today's date and invent an undo that never happened.
  reverted_at   timestamptz,

  created_at    timestamptz not null default now(),

  constraint subscription_cancellations_lead_type_valid check (
    lead_type in ('management', 'guaranteed_rent')
  ),

  -- A cancellation with no reason is the one thing this table exists to
  -- prevent. array_position(reasons, null) is null rejects a NULL element —
  -- without it a NULL member makes the <@ subset test evaluate to NULL rather
  -- than false, and a CHECK passes on NULL (the 0084 lesson).
  --
  -- ⚠️ This list must match CANCEL_REASONS in src/lib/cancelOptions.ts
  -- character-for-character. Nothing enforces that mechanically; a mismatch
  -- shows up as a 500 on submit, not as a build error.
  constraint subscription_cancellations_reasons_valid check (
    cardinality(reasons) >= 1
    and array_position(reasons, null) is null
    and reasons <@ array[
      'too_expensive',
      'not_enough_leads',
      'lead_quality',
      'at_capacity',
      'switched_provider',
      'closing_business',
      'other'
    ]::text[]
  ),

  -- "Something else" with no explanation teaches nothing (0084's rule).
  constraint subscription_cancellations_other_needs_note check (
    not ('other' = any (reasons))
    or (note is not null and char_length(btrim(note)) > 0)
  ),

  constraint subscription_cancellations_note_length check (
    note is null or char_length(note) <= 500
  )
);

create index if not exists idx_subscription_cancellations_customer
  on public.subscription_cancellations (customer_id, requested_at desc);

-- Serves the "latest open request for this customer and product" lookup the
-- undo path runs.
create index if not exists idx_subscription_cancellations_open
  on public.subscription_cancellations (customer_id, lead_type)
  where reverted_at is null;

-- Service-role only, like subscription_pauses: RLS on with no policies is
-- deny-all to the browser. The customer reads their own pending state from
-- customers.(gr_)cancel_at_period_end via getCurrentCustomer().
alter table public.subscription_cancellations enable row level security;

comment on table public.subscription_cancellations is
  'One row per cancellation request from the in-app cancel flow. Written at '
  'request time; reverted_at is a best-effort stamp on undo. Live state is '
  'customers.(gr_)cancel_at_period_end, never this table.';

-- ---------------------------------------------------------------------------
-- 2 — When the pending cancellation lands, on the customer row.
--
-- 0087 stored WHETHER a cancellation is pending; this stores WHEN it takes
-- effect, so the settings page can say "ends on 14 September 2026" from
-- getCurrentCustomer()'s select("*") with no Stripe round trip. Written by the
-- cancel route (for immediate UI freshness) and by the webhook's subscription
-- branch (the source of truth, converging seconds later), cleared by the same
-- change-of-mind rule as the 0087 flags. Gates nothing.
-- ---------------------------------------------------------------------------
alter table public.customers
  add column if not exists cancel_effective_at    timestamptz,
  add column if not exists gr_cancel_effective_at timestamptz;

comment on column public.customers.cancel_effective_at is
  'When the pending management cancellation takes effect (Stripe cancel_at, '
  'falling back to period end). Set beside cancel_at_period_end, cleared by the '
  'same rule. Display only — gates nothing.';
comment on column public.customers.gr_cancel_effective_at is
  'Guaranteed Rent equivalent of cancel_effective_at. Same writers, same rule.';

-- ---------------------------------------------------------------------------
-- 3 — The pause-ending notice stamp.
--
-- A pause resumes billing automatically, and until now the customer heard
-- nothing between the pause confirmation and the "you're back" email AFTER the
-- first re-bill was already inevitable. The resume cron now emails ~7 days
-- before pause_resumes_at: billing restarts on this date, resume / stay paused
-- / cancel are all in Settings. One notice per pause: the cron stamps this
-- column behind a guarded update (claim-by-write, so a re-run cannot
-- double-send), the pause route nulls it when a NEW pause starts, and both
-- resume paths null it when the pause clears.
--
-- Management-only, like every pause column (invariant 6).
-- ---------------------------------------------------------------------------
alter table public.customers
  add column if not exists pause_ending_notice_sent_at timestamptz;

comment on column public.customers.pause_ending_notice_sent_at is
  'When the "your pause ends soon, billing resumes" email was sent for the '
  'current pause. Nulled when a new pause starts and when a pause clears. '
  'Dedup stamp only — gates nothing.';
