-- ---------------------------------------------------------------------------
-- 0100 — Cancellations become a durable episode record
--
-- `customers.cancelled_at` / `gr_cancelled_at` are single columns, and the
-- Stripe webhook NULLS THEM when a subscription returns to active — the same
-- branch that clears `cancellation_feedback` / `cancellation_comment`. So a
-- customer who cancels, comes back, and cancels again leaves no trace of the
-- first departure, and the reason they first gave is gone.
--
-- That is the one thing a retention series cannot work without, and it is the
-- one thing that becomes unrecoverable the moment it happens.
--
-- ZERO CUSTOMERS HAVE EVER CANCELLED, so nothing has been lost yet. This ships
-- ahead of anything that reads it for exactly the reason 0064 did: it is the
-- part that cannot be reconstructed later.
--
-- Mirrors subscription_pauses (§21) with one deliberate difference: it is PER
-- PRODUCT. Pause is management-only, but GR cancels independently and already
-- has its own `gr_cancelled_at` column (invariant 6).
--
-- ⚠️ LIVE STATE REMAINS `customers.cancelled_at` / `gr_cancelled_at`, never
-- this table — the same rule §21 states for `paused_at`. Nothing here decides
-- whether a customer has cancelled; it records what happened for reporting.
-- ---------------------------------------------------------------------------

create table if not exists public.subscription_cancellations (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  lead_type   public.lead_type not null,

  -- The subscription this episode is about. Part of the open-episode key: a
  -- customer who re-subscribes gets a NEW Stripe subscription, so a later
  -- cancellation is genuinely a separate episode rather than a repeat.
  stripe_subscription_id text,

  -- First time cancel_at_period_end went true. First request wins, matching
  -- cancelled_at's documented rule and first_contacted_at's coalesce (§6).
  requested_at timestamptz,
  -- Stripe reported status 'canceled'.
  cancelled_at timestamptz,
  -- When service actually ends: sub.cancel_at, else the period end (§23.3).
  effective_at timestamptz,
  -- A change of mind, or a re-subscribe. Closes the episode.
  reinstated_at timestamptz,

  -- From Stripe's cancellation_details, captured on the *updated* event at the
  -- moment the customer gives it — §21 explains why reading it only on
  -- 'canceled' discards it and recovers it a billing period later.
  feedback text,
  comment  text,

  -- What this departure was worth, priced at the moment it was requested.
  -- Stored because monthly_allocation is overwritten and the plan may change
  -- between the request and the effective date.
  mrr_at_request_pence bigint,

  source text not null default 'stripe_webhook'
    check (source in ('stripe_webhook', 'backfill', 'admin')),

  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- ⚠️ IDEMPOTENCY IS THE INDEX, NOT A STATUS COLUMN.
--
-- A cancellation is not one event like a pause — it is a SEQUENCE, and several
-- of its steps repeat. `customer.subscription.updated` with
-- cancel_at_period_end: true fires many times before the period ends, then
-- 'canceled' arrives, then possibly active-and-not-cancelling. A blind insert
-- duplicates the episode; a read-then-write leaves a window.
--
-- So the open episode is claimed by a partial unique index and upserted onto,
-- the discipline credit_invoice() uses against Stripe redelivery (§19.5) and
-- announcement_deliveries uses against a double-clicked send (§21.2). Stamping
-- reinstated_at takes the row out of the index, so a later cancellation on a
-- new subscription inserts cleanly.
--
-- Mirrors idx_subscription_pauses_open.
-- ---------------------------------------------------------------------------
create unique index if not exists uniq_open_cancellation_episode
  on public.subscription_cancellations (customer_id, lead_type)
  where reinstated_at is null;

create index if not exists idx_subscription_cancellations_customer
  on public.subscription_cancellations (customer_id, lead_type, created_at desc);

alter table public.subscription_cancellations enable row level security;

-- ---------------------------------------------------------------------------
-- Backfill: an insert...select...where not exists, as 0084's.
--
-- It matches nothing today — no customer has ever cancelled — and that is the
-- point of writing it this way rather than skipping it: it is idempotent, and
-- it picks up anybody who cancels between this being written and being applied.
--
-- `source = 'backfill'` keeps a reconstructed episode countable separately from
-- an observed one, the same instinct as 0084's `unknown_pre_0077` sentinel:
-- "we inferred this" must never be silently indistinguishable from "we watched
-- it happen".
-- ---------------------------------------------------------------------------
insert into public.subscription_cancellations
  (customer_id, lead_type, stripe_subscription_id, cancelled_at, feedback, comment, source)
select c.id, 'management', c.stripe_subscription_id, c.cancelled_at,
       c.cancellation_feedback, c.cancellation_comment, 'backfill'
from public.customers c
where c.cancelled_at is not null
  and not exists (
    select 1 from public.subscription_cancellations s
    where s.customer_id = c.id and s.lead_type = 'management'
  );

insert into public.subscription_cancellations
  (customer_id, lead_type, stripe_subscription_id, cancelled_at, source)
select c.id, 'guaranteed_rent', c.gr_stripe_subscription_id, c.gr_cancelled_at, 'backfill'
from public.customers c
where c.gr_cancelled_at is not null
  and not exists (
    select 1 from public.subscription_cancellations s
    where s.customer_id = c.id and s.lead_type = 'guaranteed_rent'
  );
