-- ============================================================================
-- One-off lead top-up purchase (Management + Guaranteed Rent).
--
-- When a subscriber's balance for a product hits zero they can buy a one-off
-- top-up of 5 leads for £75 flat (£15/lead, both products) charged straight to
-- the card on file — no Checkout redirect. Repeatable every time the balance
-- returns to zero. This migration adds the storage and the atomic redemption
-- RPCs; the trigger (ingest.ts) and the confirmation page/charge routes are
-- application code.
--
-- Parallel-column invariant: everything here branches on lead_type and touches
-- only that product's balance column (lead_balance vs gr_lead_balance), exactly
-- like credit_invoice (0029) and assign_lead_to_customer (0039).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 — payments: make a row attributable to a product.
--
-- payments already carries `payment_type` (so a top-up is distinguishable as
-- payment_type = 'topup'), but has no product column, so a top-up could not be
-- attributed to Management vs GR. Add a nullable lead_type and backfill the
-- existing subscription history from payment_type so the column is meaningful
-- for reporting from day one. Nullable + null-tolerant check so historical rows
-- that predate this column are never rejected.
-- ---------------------------------------------------------------------------
alter table public.payments
  add column if not exists lead_type text;

alter table public.payments
  drop constraint if exists payments_lead_type_check;
alter table public.payments
  add constraint payments_lead_type_check
  check (lead_type is null or lead_type in ('management', 'guaranteed_rent'));

-- Backfill: GR subscription invoices → guaranteed_rent, everything else that
-- has a payment_type → management. Leaves genuinely unknown rows null.
update public.payments
  set lead_type = case
    when payment_type = 'gr_subscription' then 'guaranteed_rent'
    when payment_type in ('subscription', 'topup') then 'management'
    else lead_type
  end
  where lead_type is null and payment_type is not null;

-- ---------------------------------------------------------------------------
-- 2 — lead_topup_tokens: the single-use, hashed, time-limited link.
--
-- The URL carries a high-entropy opaque token (SMS can't carry a session); only
-- its SHA-256 hash is stored, so a leaked DB row cannot reconstruct a usable
-- link. A row is valid while used_at IS NULL and expires_at > now().
--
-- DEDUP (this is the whole dedup mechanism — no separate "notified" flag on
-- customers, mirroring the post_call_offers design at 0037): the partial unique
-- index below permits AT MOST ONE active (unused) token per (customer, product).
-- The trigger tries to insert a token when a balance hits zero; a unique
-- violation means a live link already exists, so no second notification is sent.
-- The slot frees the moment the token is used (redeemed or a failed charge), so
-- a later zero-balance event mints a fresh token — the "hit zero again in the
-- same cycle" repeatability. An expired-but-unused row is reused in place by the
-- trigger (see ingest.ts), so a stale row never blocks a re-offer forever.
-- ---------------------------------------------------------------------------
create table if not exists public.lead_topup_tokens (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid not null references public.customers(id) on delete cascade,
  lead_type     text not null check (lead_type in ('management', 'guaranteed_rent')),
  token_hash    text not null,                       -- sha256 hex of the URL token
  credits       integer not null default 5,
  amount_pence  integer not null default 7500,
  expires_at    timestamptz not null,                -- created_at + 48h
  used_at       timestamptz,                          -- set when claimed (charge attempted)
  charge_status text check (charge_status in ('paid', 'failed')),
  payment_id    uuid references public.payments(id),  -- set on a successful charge
  created_at    timestamptz not null default now()
);

-- Fast, unique lookup by the hashed token (the /topup/[token] route).
create unique index if not exists uq_lead_topup_tokens_token_hash
  on public.lead_topup_tokens (token_hash);

-- At most one ACTIVE (unused) token per customer+product — the dedup guard.
create unique index if not exists uq_lead_topup_tokens_active
  on public.lead_topup_tokens (customer_id, lead_type)
  where used_at is null;

create index if not exists idx_lead_topup_tokens_customer
  on public.lead_topup_tokens (customer_id);

-- All access is via server routes using the service-role client. RLS on with no
-- policy = deny to anon/authenticated, allow to service_role (bypasses RLS).
alter table public.lead_topup_tokens enable row level security;

-- ---------------------------------------------------------------------------
-- 3 — claim_lead_topup_token: atomically reserve a token before charging.
--
-- Locks the token row, verifies it is unused and unexpired, then stamps used_at
-- = now() and returns the data the charge route needs. Two concurrent confirm
-- clicks race here: the first claims it, the second sees used_at already set and
-- gets no row back — so the card is never charged twice. Returns no rows when
-- the token is unknown, already used, or expired.
-- ---------------------------------------------------------------------------
create or replace function public.claim_lead_topup_token(p_token_hash text)
returns table (
  token_id           uuid,
  customer_id        uuid,
  lead_type          text,
  credits            integer,
  amount_pence       integer,
  stripe_customer_id text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tok public.lead_topup_tokens%rowtype;
begin
  select * into v_tok
    from public.lead_topup_tokens
    where token_hash = p_token_hash
    for update;

  if not found then return; end if;
  if v_tok.used_at is not null then return; end if;
  if v_tok.expires_at <= now() then return; end if;

  update public.lead_topup_tokens
    set used_at = now()
    where id = v_tok.id;

  return query
    select v_tok.id, v_tok.customer_id, v_tok.lead_type, v_tok.credits,
           v_tok.amount_pence, c.stripe_customer_id
    from public.customers c
    where c.id = v_tok.customer_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4 — record_lead_topup_success: atomically credit + record a paid top-up.
--
-- Runs after Stripe confirms the off-session PaymentIntent. In one transaction:
-- inserts the 'topup' payment row (attributed by lead_type), moves the matching
-- balance by +credits, and marks the token paid. Idempotent on charge_status:
-- a replayed call (e.g. the confirm route retried) is a no-op and returns false,
-- so credit lands exactly once.
-- ---------------------------------------------------------------------------
create or replace function public.record_lead_topup_success(
  p_token_id uuid,
  p_payment_intent_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tok public.lead_topup_tokens%rowtype;
  v_payment_id uuid;
begin
  select * into v_tok
    from public.lead_topup_tokens
    where id = p_token_id
    for update;

  if not found then return false; end if;
  -- Already finalised (idempotency): do not credit or insert again.
  if v_tok.charge_status is not null then return false; end if;

  insert into public.payments (
    customer_id, stripe_payment_intent_id, amount_pence, credits_added,
    payment_type, status, lead_type
  ) values (
    v_tok.customer_id, p_payment_intent_id, v_tok.amount_pence, v_tok.credits,
    'topup', 'paid', v_tok.lead_type
  )
  returning id into v_payment_id;

  if v_tok.lead_type = 'guaranteed_rent' then
    update public.customers
      set gr_lead_balance = gr_lead_balance + v_tok.credits,
          updated_at = now()
      where id = v_tok.customer_id;
  else
    update public.customers
      set lead_balance = lead_balance + v_tok.credits,
          updated_at = now()
      where id = v_tok.customer_id;
  end if;

  update public.lead_topup_tokens
    set charge_status = 'paid',
        payment_id = v_payment_id,
        used_at = coalesce(used_at, now())
    where id = v_tok.id;

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5 — record_lead_topup_failure: record a failed charge, no credit.
--
-- Marks the token failed (used_at already set at claim, so it can't be retried)
-- and records a 'failed' payment row for the audit trail. Idempotent on
-- charge_status. No balance is touched.
-- ---------------------------------------------------------------------------
create or replace function public.record_lead_topup_failure(
  p_token_id uuid,
  p_payment_intent_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tok public.lead_topup_tokens%rowtype;
begin
  select * into v_tok
    from public.lead_topup_tokens
    where id = p_token_id
    for update;

  if not found then return; end if;
  if v_tok.charge_status is not null then return; end if;

  insert into public.payments (
    customer_id, stripe_payment_intent_id, amount_pence, credits_added,
    payment_type, status, lead_type
  ) values (
    v_tok.customer_id, p_payment_intent_id, v_tok.amount_pence, 0,
    'topup', 'failed', v_tok.lead_type
  );

  update public.lead_topup_tokens
    set charge_status = 'failed',
        used_at = coalesce(used_at, now())
    where id = v_tok.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6 — Lock down the new SECURITY DEFINER functions (mirrors 0028/0029). These
-- are only ever called by the server via the service-role client; the browser
-- must not reach them through PostgREST.
-- ---------------------------------------------------------------------------
revoke execute on function public.claim_lead_topup_token(text)
  from public, anon, authenticated;
grant execute on function public.claim_lead_topup_token(text)
  to service_role;

revoke execute on function public.record_lead_topup_success(uuid, text)
  from public, anon, authenticated;
grant execute on function public.record_lead_topup_success(uuid, text)
  to service_role;

revoke execute on function public.record_lead_topup_failure(uuid, text)
  from public, anon, authenticated;
grant execute on function public.record_lead_topup_failure(uuid, text)
  to service_role;
