-- ============================================================================
-- Stripe webhook idempotency.
--
-- Stripe delivers events at-least-once and retries on any non-2xx or timeout,
-- so invoice.paid (which grants lead credit) can arrive more than once. A dedup
-- table keyed on the Stripe event id lets the handler claim each event exactly
-- once and skip repeats, preventing double-crediting of lead_balance /
-- gr_lead_balance.
--
-- NOTE: the leads RLS tightening that previously lived here is already applied
-- by 0014_bugfixes (policy leads_select_assigned), so it is not repeated.
-- ============================================================================
create table if not exists public.stripe_events (
  id           text primary key,          -- Stripe event id (evt_...)
  type         text,
  processed_at timestamptz not null default now()
);

-- Service-role only: RLS on with no policies, never touched by the browser.
alter table public.stripe_events enable row level security;
