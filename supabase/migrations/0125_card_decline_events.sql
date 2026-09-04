-- 0125_card_decline_events.sql
--
-- One row per FAILED payment attempt on a subscription invoice, and the record
-- of what we told the customer about it.
--
-- WHY THIS TABLE EXISTS
-- ---------------------
-- Until now invoice.payment_failed wrote a `payments` row with status 'failed',
-- set (gr_)subscription_status = 'past_due', pushed the Monday label "Wants to
-- pay card declined" — and told the customer nothing at all. Nothing in the
-- codebase read last_payment_error, decline_code, outcome or
-- hosted_invoice_url, so nobody could answer "why was it declined" without
-- opening the Stripe dashboard.
--
-- THE UNIQUE INDEX IS THE FEATURE, not bookkeeping.
-- -------------------------------------------------
-- The email is claimed by INSERT before it is sent — the credit_invoice /
-- announcement_deliveries discipline. Checking "have we already sent?" and then
-- sending leaves a window; claiming by write does not.
--
--   * (stripe_invoice_id, attempt_count), and DELIBERATELY NOT keyed on
--     customer_id. A Stripe invoice belongs to exactly one Stripe customer, so
--     adding the customer buys no uniqueness and actively weakens the guard:
--     customerMatchFilter() resolves GR through an .or() across two columns, so
--     if that lookup ever landed on a different row between a delivery and its
--     retry, a customer-scoped key would not collide and a second email would
--     go out. The narrower key makes the stronger claim — this attempt on this
--     invoice has been handled, by whoever.
--
--   * attempt_count MUST be in the key. Stripe Smart Retries makes ~4 attempts
--     over 2-3 weeks and each one is a genuinely new event worth an email.
--     Production has already seen it: invoice in_1U9po1CpQPIFzv4rWgNYnQ8I
--     failed on 29 Aug, 30 Aug and 1 Sep. Keying on the invoice alone would
--     have emailed once and swallowed the other two.
--
--   * BOTH columns are NOT NULL. A unique index treats NULLs as distinct, so a
--     nullable half would silently disable the very guard this exists for.
--
-- Why a second layer at all, given stripe_events already dedupes by event id:
-- the webhook's outer catch DELETES its stripe_events claim on any throw so
-- Stripe retries. That is not hypothetical — credit_invoice throws by design on
-- the sibling invoice.paid path. Without this index one webhook wobble equals a
-- duplicate decline email.
--
-- EVERY RAW CODE HERE IS MERCHANT-FACING.
-- ---------------------------------------
-- outcome_seller_message in particular is Stripe's own name for a string
-- written for the merchant, and it spells out suppressed decline codes in plain
-- English ("The bank returned the decline code lost_card"). What the CUSTOMER
-- was told is reason_key, resolved by src/lib/declineReason.ts, which collapses
-- the fraud-flavoured codes to a neutral message. Storing the truth and saying
-- less is the entire point of the split.

create table if not exists public.card_decline_events (
  id                        uuid primary key default gen_random_uuid(),
  customer_id               uuid not null references public.customers(id) on delete cascade,
  lead_type                 text not null,

  -- The claim key. See the header on why both are NOT NULL.
  stripe_invoice_id         text not null,
  attempt_count             integer not null,

  stripe_subscription_id    text,
  stripe_payment_intent_id  text,
  stripe_charge_id          text,

  -- Raw Stripe, exactly as returned. Merchant-facing, all of it.
  decline_code              text,
  failure_code              text,
  failure_message           text,
  outcome_type              text,
  outcome_reason            text,
  outcome_network_status    text,
  outcome_seller_message    text,
  outcome_risk_level        text,

  card_brand                text,
  card_last4                text,
  card_exp_month            integer,
  card_exp_year             integer,
  card_funding              text,
  card_country              text,

  amount_due_pence          integer not null default 0,
  currency                  text,
  next_payment_attempt_at   timestamptz,
  hosted_invoice_url        text,

  -- What we actually told them. reason_suppressed records "we chose not to
  -- say" separately from "we did not know", which are different facts.
  reason_key                text not null,
  reason_suppressed         boolean not null default false,

  pi_resolved               boolean not null default false,
  stripe_lookup_error       text,

  emailed_to                text,
  email_id                  text,
  email_error               text,

  resolved_at               timestamptz,
  failed_at                 timestamptz not null default now(),
  created_at                timestamptz not null default now(),

  constraint card_decline_events_lead_type_valid
    check (lead_type in ('management', 'guaranteed_rent')),
  constraint card_decline_events_attempt_sane
    check (attempt_count >= 0)
);

-- THE dedupe. The second layer behind stripe_events, and the only one that
-- survives the outer catch deleting the event claim on a throw.
create unique index if not exists card_decline_events_attempt_key
  on public.card_decline_events (stripe_invoice_id, attempt_count);

create index if not exists idx_card_decline_events_customer
  on public.card_decline_events (customer_id, failed_at desc);

-- Serves the admin badge: the open declines for a customer and product.
create index if not exists idx_card_decline_events_open
  on public.card_decline_events (customer_id, lead_type)
  where resolved_at is null;

-- Service-role only, as subscription_pauses and subscription_cancellations:
-- RLS on with NO policies is deny-all to the browser. Nothing a customer sees
-- reads this table — they get the email.
alter table public.card_decline_events enable row level security;

comment on table public.card_decline_events is
  'One row per FAILED payment attempt on an invoice, claimed by insert on '
  '(stripe_invoice_id, attempt_count) BEFORE the email is sent. Every raw code '
  'here is merchant-facing; reason_key is the only thing the customer was told. '
  'resolved_at is a best-effort stamp from invoice.paid - the admin badge gates '
  'on the live (gr_)subscription_status, never on this column.';

comment on column public.card_decline_events.reason_key is
  'DeclineReasonKey from src/lib/declineReason.ts. DELIBERATELY NOT constrained '
  'by a CHECK: at the call site a 23514 is indistinguishable from the 23505 that '
  'means "already sent", and the claim-then-send discipline would read it as '
  '"skip" - so one forgotten key in a SQL list would mean no email ever sent for '
  'that decline code. The TS union is the contract and the unit test over '
  'DECLINE_COPY is the enforcement.';

comment on column public.card_decline_events.outcome_seller_message is
  'Stripe MERCHANT-facing text. Never render to a customer: it names the '
  'suppressed decline code in plain English. sendCardDeclinedEmail has no '
  'parameter for it, which makes that a compile-time guarantee.';
