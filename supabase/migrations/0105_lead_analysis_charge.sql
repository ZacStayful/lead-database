-- ============================================================================
-- 0105 — Paying for lead analysis.
--
-- 0104 built the queue and left it unreachable: a job is created
-- `awaiting_payment`, and claim_lead_analysis_rows only ever looks at jobs that
-- are `running`. This migration is what moves a job between those two states,
-- and it does so in exactly one place — record_lead_analysis_success — so
-- "nothing is analysed before it is paid for" is a property of the schema
-- rather than a rule somebody has to remember in a route.
--
-- ── A sibling of the top-up, not a copy ─────────────────────────────────────
--
-- The token/claim/finalise shape is 0041's, including 0042's correction, and
-- for the same reasons: the claim is the single-charge guard, and a charge
-- whose outcome is UNKNOWN releases rather than finalises, because a Stripe
-- connection error can be thrown after the money was taken.
--
-- Three things deliberately differ.
--
--   1. The active-token index is per JOB, not per (customer, product).
--      uq_lead_topup_tokens_active exists to stop us emailing a second offer
--      while one is live. That is the wrong rule here: a customer may hold an
--      unredeemed top-up offer AND buy analysis, and may buy two batches ten
--      minutes apart. What must not happen twice is one JOB being charged, and
--      that is what this indexes.
--
--   2. Nothing touches lead_balance. A top-up buys leads; this buys analysis of
--      leads the customer already owns. Crediting a balance here would hand
--      them marketplace leads they did not pay for, and would corrupt the
--      pacing counters §13 measures delivery by. `credits_added` is 0 on every
--      row this writes.
--
--   3. There is a refund path, because some rows produce nothing. See §4.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 — The token.
--
-- Minted per job and claimed immediately; it is never emailed and never
-- browsed, so unlike a top-up token it needs no browsing window. It exists at
-- all because the CLAIM is what makes the charge single: two concurrent
-- submits race for one row, the loser gets nothing back, and the card is
-- charged once.
-- ---------------------------------------------------------------------------
create table if not exists public.lead_analysis_tokens (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid not null references public.customers(id) on delete cascade,
  job_id        uuid not null references public.lead_analysis_jobs(id) on delete cascade,
  lead_type     text not null,
  token_hash    text not null,
  row_count     integer not null,
  amount_pence  integer not null,
  expires_at    timestamptz not null,
  used_at       timestamptz,
  charge_status text,
  payment_id    uuid references public.payments(id),
  created_at    timestamptz not null default now()
);

alter table public.lead_analysis_tokens drop constraint if exists lead_analysis_tokens_lead_type_check;
alter table public.lead_analysis_tokens
  add constraint lead_analysis_tokens_lead_type_check
  check (lead_type in ('management', 'guaranteed_rent'));

alter table public.lead_analysis_tokens drop constraint if exists lead_analysis_tokens_charge_status_check;
alter table public.lead_analysis_tokens
  add constraint lead_analysis_tokens_charge_status_check
  check (charge_status is null or charge_status in ('paid', 'failed'));

create unique index if not exists uq_lead_analysis_tokens_token_hash
  on public.lead_analysis_tokens (token_hash);

-- One live token per JOB — see the header for why this is not keyed on the
-- customer the way the top-up's is.
create unique index if not exists uq_lead_analysis_tokens_active
  on public.lead_analysis_tokens (job_id)
  where used_at is null;

create index if not exists idx_lead_analysis_tokens_customer
  on public.lead_analysis_tokens (customer_id, created_at desc);

alter table public.lead_analysis_tokens enable row level security;

comment on table public.lead_analysis_tokens is
  'One purchase attempt for a lead-analysis job. The CLAIM is the single-charge '
  'guard. Never credits lead_balance — this buys analysis, not leads.';


-- ---------------------------------------------------------------------------
-- 2 — Refund bookkeeping on payments.
--
-- A partial unique index rather than a plain column, so a replayed webhook or a
-- re-run worker cannot record the same refund twice. The predicate keeps every
-- non-refund payment row out of the index entirely.
-- ---------------------------------------------------------------------------
alter table public.payments
  add column if not exists stripe_refund_id text;

create unique index if not exists uq_payments_stripe_refund
  on public.payments (stripe_refund_id)
  where stripe_refund_id is not null;


-- ---------------------------------------------------------------------------
-- 3 — claim / success / failure / release.
--
-- Bodies transcribed from 0041 and 0042 with the balance moves removed and the
-- job flip put in their place. Read those two migrations for the reasoning
-- behind each guard; what follows is only what differs.
-- ---------------------------------------------------------------------------
create or replace function public.claim_lead_analysis_token(p_token_hash text)
returns table (
  token_id           uuid,
  customer_id        uuid,
  job_id             uuid,
  lead_type          text,
  row_count          integer,
  amount_pence       integer,
  stripe_customer_id text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tok public.lead_analysis_tokens%rowtype;
begin
  select * into v_tok
    from public.lead_analysis_tokens
    where token_hash = p_token_hash
    for update;

  if not found then return; end if;
  if v_tok.used_at is not null then return; end if;
  if v_tok.expires_at <= now() then return; end if;

  update public.lead_analysis_tokens set used_at = now() where id = v_tok.id;

  return query
    select v_tok.id, v_tok.customer_id, v_tok.job_id, v_tok.lead_type,
           v_tok.row_count, v_tok.amount_pence, c.stripe_customer_id
    from public.customers c
    where c.id = v_tok.customer_id;
end;
$$;


-- The one place a job becomes workable.
--
-- Carries 0042's failed → paid promotion: the payment_intent.succeeded webhook
-- is the safety net for a charge that landed after an indeterminate error
-- finalised the token as failed, and a guard on `charge_status is not null`
-- would have made that net do nothing. The guard is on 'paid' alone, so the
-- work starts exactly once.
create or replace function public.record_lead_analysis_success(
  p_token_id uuid,
  p_payment_intent_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tok        public.lead_analysis_tokens%rowtype;
  v_payment_id uuid;
begin
  select * into v_tok
    from public.lead_analysis_tokens
    where id = p_token_id
    for update;

  if not found then return false; end if;
  if v_tok.charge_status = 'paid' then return false; end if;

  insert into public.payments (
    customer_id, stripe_payment_intent_id, amount_pence, credits_added,
    payment_type, status, lead_type
  ) values (
    v_tok.customer_id, p_payment_intent_id, v_tok.amount_pence,
    -- ZERO. This buys analysis of leads they already own, not leads.
    0,
    'lead_analysis', 'paid', v_tok.lead_type
  )
  returning id into v_payment_id;

  update public.lead_analysis_tokens
    set charge_status = 'paid',
        payment_id    = v_payment_id,
        used_at       = coalesce(used_at, now())
    where id = v_tok.id;

  -- ── The gate ──────────────────────────────────────────────────
  --
  -- 'cancelled' is included, and that is the whole point of the promotion
  -- path. record_lead_analysis_failure cancels a job when a charge is
  -- DEFINITIVELY declined — but the webhook can still arrive afterwards saying
  -- the payment succeeded, because an intent left 'processing' can settle late.
  -- The money is then genuinely gone from the customer's account, and leaving
  -- the job cancelled would mean charging somebody and doing nothing.
  --
  -- 'completed' is deliberately NOT included: that job already ran, and its
  -- refund may already have been paid.
  update public.lead_analysis_jobs
    set status       = 'running',
        confirmed_at = coalesce(confirmed_at, now()),
        finished_at  = null,
        paused_reason = null
    where id = v_tok.job_id
      and status in ('awaiting_payment', 'cancelled');

  -- Rows cancelled alongside the job come back with them. Guarded on
  -- 'cancelled' so a row that legitimately failed on its own is untouched.
  update public.lead_analysis_rows
    set status = 'pending', attempts = 0, claim_token = null, claimed_at = null
    where job_id = v_tok.job_id
      and status = 'cancelled'
      and exists (
        select 1 from public.lead_analysis_jobs j
         where j.id = v_tok.job_id and j.status = 'running'
      );

  return true;
end;
$$;


-- A DEFINITIVE failure: the card was declined, or Stripe rejected the request.
-- Cancels the job and its rows, because a batch nobody paid for must not sit in
-- the queue waiting for a worker that would spend real money on it.
create or replace function public.record_lead_analysis_failure(
  p_token_id uuid,
  p_payment_intent_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tok public.lead_analysis_tokens%rowtype;
begin
  select * into v_tok
    from public.lead_analysis_tokens
    where id = p_token_id
    for update;

  if not found then return; end if;
  if v_tok.charge_status is not null then return; end if;

  insert into public.payments (
    customer_id, stripe_payment_intent_id, amount_pence, credits_added,
    payment_type, status, lead_type
  ) values (
    v_tok.customer_id, p_payment_intent_id, v_tok.amount_pence, 0,
    'lead_analysis', 'failed', v_tok.lead_type
  );

  update public.lead_analysis_tokens
    set charge_status = 'failed'
    where id = v_tok.id;

  update public.lead_analysis_jobs
    set status = 'cancelled', finished_at = now()
    where id = v_tok.job_id
      and status = 'awaiting_payment';

  update public.lead_analysis_rows
    set status = 'cancelled'
    where job_id = v_tok.job_id
      and status = 'pending';
end;
$$;


-- Undo a claim whose outcome is UNKNOWN.
--
-- 0042's body verbatim. This is the rule the whole module is built around: a
-- Stripe connection error or timeout can be thrown AFTER the charge was
-- captured, so treating it as a failure would take the money and give nothing
-- back. Releasing lets the customer retry the same token, and the Stripe
-- idempotency key derived from the token id makes the retry return the original
-- intent rather than charging again. A token already finalised is never
-- reopened.
create or replace function public.release_lead_analysis_token(p_token_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tok public.lead_analysis_tokens%rowtype;
begin
  select * into v_tok
    from public.lead_analysis_tokens
    where id = p_token_id
    for update;

  if not found then return false; end if;
  if v_tok.charge_status is not null then return false; end if;

  update public.lead_analysis_tokens set used_at = null where id = v_tok.id;
  return true;
end;
$$;


-- ---------------------------------------------------------------------------
-- 4 — Recording a refund.
--
-- Only ever called once finalise_lead_analysis_job has set refund_status =
-- 'due' and the money has actually moved at Stripe. Idempotent twice over: on
-- refund_status here, and on the partial unique index above, so a replayed
-- worker cannot write a second refund row even if it somehow got past the
-- first check.
--
-- The asymmetry with the charge is deliberate. A charge whose outcome is
-- unknown releases so it can be retried; a refund whose outcome is unknown is
-- simply LEFT 'due' and re-attempted, because the failure direction that costs
-- us money is safer than the one that quietly keeps the customer's.
-- ---------------------------------------------------------------------------
create or replace function public.record_lead_analysis_refund(
  p_job_id       uuid,
  p_refund_id    text,
  p_amount_pence integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.lead_analysis_jobs%rowtype;
begin
  select * into v_job
    from public.lead_analysis_jobs
    where id = p_job_id
    for update;

  if not found then return false; end if;
  if v_job.refund_status = 'refunded' then return false; end if;
  if p_amount_pence <= 0 then return false; end if;

  insert into public.payments (
    customer_id, stripe_payment_intent_id, stripe_refund_id, amount_pence,
    credits_added, payment_type, status, lead_type
  ) values (
    v_job.customer_id, null, p_refund_id, p_amount_pence, 0,
    'lead_analysis_refund', 'refunded', v_job.lead_type::text
  )
  on conflict (stripe_refund_id) where stripe_refund_id is not null do nothing;

  update public.lead_analysis_jobs
    set refund_status = 'refunded',
        refund_pence  = p_amount_pence
    where id = p_job_id;

  update public.lead_analysis_rows
    set refunded_at = now()
    where job_id = p_job_id
      and status <> 'succeeded'
      and chargeable
      and refunded_at is null;

  return true;
end;
$$;


-- ---------------------------------------------------------------------------
-- 5 — Access.
--
-- Every function here moves money or decides whether work may start. Supabase
-- exposes public functions at /rest/v1/rpc/<name> and EXECUTE defaults to
-- PUBLIC, so without these revokes `anon` could flip a job to running with
-- nothing but the publishable key. 0024 is the precedent; §11 records that a
-- `create or replace` discards the ACL, which is why these run unconditionally
-- rather than only on first install.
-- ---------------------------------------------------------------------------
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.claim_lead_analysis_token(text)',
    'public.record_lead_analysis_success(uuid, text)',
    'public.record_lead_analysis_failure(uuid, text)',
    'public.release_lead_analysis_token(uuid)',
    'public.record_lead_analysis_refund(uuid, text, integer)'
  ] loop
    execute format('revoke all on function %s from public', fn);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function %s from anon', fn);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on function %s from authenticated', fn);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', fn);
    end if;
  end loop;
end $$;
