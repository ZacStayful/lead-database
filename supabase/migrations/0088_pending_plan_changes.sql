-- ============================================================================
-- Self-serve plan upgrade / downgrade: the pending change, and its history.
--
-- OBJECTIVE
-- ---------
-- Let a subscriber move between the 10-lead and 20-lead tier of a product they
-- already hold, from /dashboard/packages and /dashboard/settings, without an
-- admin editing Stripe by hand.
--
-- WHY THE ALLOCATION CANNOT MOVE WHEN THE PRICE DOES
-- --------------------------------------------------
-- invoice.paid credits planForAllocation(customers.monthly_allocation).leads —
-- the ROW, never the price on the invoice (CLAUDE.md §17). The same column also
-- drives deficit-first pacing and weighted capacity.
--
-- Stripe applies an item price swap IMMEDIATELY, even with
-- proration_behavior:'none'; only the billing waits for the next invoice. So
-- writing the allocation at the moment of the swap would pace a customer at
-- 20 leads through a cycle they paid £150 for, or starve a customer who has
-- already paid £300 down to 10. The new allocation therefore sits PENDING and
-- is applied by the webhook at the next paid invoice — which is exactly the
-- moment credit_invoice() grants the leads it sizes.
--
-- LIVE STATE LIVES ON customers, HISTORY LIVES IN THE TABLE
-- ---------------------------------------------------------
-- The same split as pause (§21): customers.pending_monthly_allocation is the
-- one authority on "is a change outstanding, and to what", and
-- subscription_plan_changes is a best-effort audit trail that nothing reads to
-- decide anything. A failed insert there must never fail a customer's request.
--
-- Both products, in parallel (invariant 6). Neither column gates allocation:
-- (gr_)lead_balance remains the only gate (invariant 1), and nothing here
-- touches a balance, counter, pacing or capacity column.
--
-- DEPLOYMENT ORDER: apply BEFORE the code. The Stripe webhook selects the
-- pending columns on every invoice.paid, so a lagging migration would break
-- crediting for everybody.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 — Pending tier change, per product.
-- ---------------------------------------------------------------------------
alter table public.customers
  -- The allocation that takes effect at the next paid invoice. NULL = nothing
  -- pending, which is NOT the same as "pending, unchanged" — a request for the
  -- tier already held clears this rather than storing a no-op.
  add column if not exists pending_monthly_allocation integer,
  -- Stripe's current_period_end at the moment the change was requested. Display
  -- only, so the dashboard can name the date without a Stripe round-trip on
  -- every render. Never used to decide when to apply: the invoice is.
  add column if not exists pending_plan_change_at timestamptz,

  add column if not exists gr_pending_monthly_allocation integer,
  add column if not exists gr_pending_plan_change_at timestamptz;

-- > 0 rather than "in (10, 20)": the plan tables live in plans.ts and a third
-- tier must not need a migration to sell. Zero and negative are the values that
-- could actually corrupt crediting.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'customers_pending_monthly_allocation_positive'
  ) then
    alter table public.customers
      add constraint customers_pending_monthly_allocation_positive
      check (pending_monthly_allocation is null or pending_monthly_allocation > 0);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'customers_gr_pending_monthly_allocation_positive'
  ) then
    alter table public.customers
      add constraint customers_gr_pending_monthly_allocation_positive
      check (gr_pending_monthly_allocation is null or gr_pending_monthly_allocation > 0);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2 — The management price id, for symmetry with gr_stripe_price_id.
--
-- OBSERVABILITY ONLY. The GR column has a behaviour attached (the webhook
-- re-sizes gr_monthly_allocation when the subscription's price stops matching
-- it); this one deliberately does NOT, because §17 declined to introduce silent
-- re-sizing on the management side and this migration is not the place to
-- overturn that. What it buys is that admin can finally see which price a
-- management customer is actually billed on, which was invisible.
-- ---------------------------------------------------------------------------
alter table public.customers
  add column if not exists stripe_price_id text;

-- ---------------------------------------------------------------------------
-- 3 — History.
--
-- One row per requested change. applied_at is stamped by the webhook when the
-- invoice that bills the new price is paid; cancelled_at when the customer
-- reverts before that happens, or when a later request supersedes it. A row
-- with neither is the change currently outstanding.
--
-- Denormalises from_allocation / to_allocation deliberately: applying the
-- change overwrites customers.monthly_allocation, and this row must still say
-- what it moved between.
-- ---------------------------------------------------------------------------
create table if not exists public.subscription_plan_changes (
  id              uuid primary key default gen_random_uuid(),
  customer_id     uuid not null references public.customers(id) on delete cascade,
  lead_type       text not null check (lead_type in ('management', 'guaranteed_rent')),

  from_allocation integer not null check (from_allocation > 0),
  to_allocation   integer not null check (to_allocation > 0),

  -- The Stripe price the subscription was moved ONTO.
  stripe_price_id text,
  -- The billing date the change was expected to land on, as Stripe reported it
  -- at request time. Expected, not observed — a customer who changes their
  -- billing date afterwards makes this stale, and applied_at is the fact.
  effective_at    timestamptz,

  requested_at    timestamptz not null default now(),
  applied_at      timestamptz,
  cancelled_at    timestamptz
);

-- The webhook's apply path looks up the open row for one customer and product.
create index if not exists idx_plan_changes_open
  on public.subscription_plan_changes (customer_id, lead_type)
  where applied_at is null and cancelled_at is null;

create index if not exists idx_plan_changes_customer
  on public.subscription_plan_changes (customer_id, requested_at desc);

-- Deny-all to the browser, as subscription_pauses and operator_proof_snapshots.
-- The customer's own view of a pending change comes from the customers columns
-- above, which getCurrentCustomer() already reads on the service role — so no
-- policy is needed for the dashboard to render it.
alter table public.subscription_plan_changes enable row level security;

comment on table public.subscription_plan_changes is
  'Audit trail of self-serve tier changes. Best-effort: LIVE pending state is customers.(gr_)pending_monthly_allocation, never this table.';

comment on column public.customers.pending_monthly_allocation is
  'Management tier awaiting the next paid invoice. NULL = no change pending. Applied by the Stripe webhook, never by application code.';

comment on column public.customers.gr_pending_monthly_allocation is
  'Guaranteed Rent tier awaiting the next paid invoice. NULL = no change pending.';

comment on column public.customers.stripe_price_id is
  'Price the management subscription is billed on. Observability only — nothing gates on it, and unlike gr_stripe_price_id it drives no allocation re-size.';
