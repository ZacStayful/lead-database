-- ============================================================================
-- Post-call discount offers.
--
-- A single-use, 24-hour, 10%-off (first month only) Stripe Promotion Code
-- generated per prospect after a web meeting — either manually (admin button)
-- or automatically (Monday.com "Web meeting sat" group → n8n → bearer-token
-- door). The same code works on BOTH Management Payment Links (10-lead and
-- 20-lead) because the underlying coupon is percentage-based and not
-- price-restricted, so no plan is chosen at generation time.
--
-- A prospect may not have a customers row yet (offer is pre-signup), so
-- prospect_email is the primary handle. matched_customer_id is backfilled once
-- the discount is redeemed and the Stripe webhook can tie it to a real customer.
--
-- This table is independent of lead allocation, monthly_allocation, pacing and
-- GR logic — it touches none of them.
-- ============================================================================

create table if not exists public.post_call_offers (
  id                    uuid primary key default gen_random_uuid(),
  prospect_email        text not null,
  prospect_phone        text,
  prospect_name         text,
  stripe_promo_code_id  text not null,
  promo_code_string     text not null,
  offer_created_at      timestamptz not null default now(),
  expires_at            timestamptz not null,          -- offer_created_at + 24h
  redeemed_at           timestamptz,
  redeemed_plan         text check (redeemed_plan in ('10', '20')),
  source                text not null check (source in ('manual', 'auto_monday')),
  reminder_12h_sent_at  timestamptz,
  reminder_4h_sent_at   timestamptz,
  reminder_1h_sent_at   timestamptz,
  created_by            uuid references auth.users(id),      -- null when source = auto_monday
  matched_customer_id   uuid references public.customers(id),
  created_at            timestamptz not null default now()
);

-- At most one UNREDEEMED offer per prospect email at any time. `now()` is not
-- IMMUTABLE so the full "active" predicate (expires_at > now()) can't live in a
-- partial-index predicate; keying on `redeemed_at is null` is the durable half
-- and, combined with the route's behaviour, gives the same guarantee:
--   * an existing UNEXPIRED unredeemed row → returned as-is (duplicate short
--     circuit), so no second live code is ever minted;
--   * an existing EXPIRED unredeemed row → reused in place (its promo code id,
--     code, timestamps and reminder flags are overwritten with the fresh
--     offer), so re-offering after an unused expiry works without ever holding
--     two unredeemed rows for one email;
--   * concurrent generation attempts race on this index (23505) rather than
--     both creating a live offer.
-- Redeemed rows drop out of the predicate, preserving full redemption history.
create unique index if not exists uq_post_call_offers_unredeemed_email
  on public.post_call_offers (lower(prospect_email))
  where redeemed_at is null;

-- Reminder-cron scan support: unredeemed, still-live offers.
create index if not exists idx_post_call_offers_active
  on public.post_call_offers (expires_at)
  where redeemed_at is null;

-- Webhook redemption lookup by Stripe promo code id.
create index if not exists idx_post_call_offers_promo_code_id
  on public.post_call_offers (stripe_promo_code_id);

create index if not exists idx_post_call_offers_matched_customer
  on public.post_call_offers (matched_customer_id);

-- All reads/writes go through server routes using the service-role client, so
-- no browser-facing policy is exposed. RLS on with no policy = deny to
-- anon/authenticated, allow to service_role (which bypasses RLS).
alter table public.post_call_offers enable row level security;
