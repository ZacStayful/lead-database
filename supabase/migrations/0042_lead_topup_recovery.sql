-- ============================================================================
-- Lead top-up: charge-recovery correctness.
--
-- Two money-safety gaps in 0041, both of the same shape — the charge lands at
-- Stripe but the credit never does, with no way back:
--
--  1. A NON-DEFINITIVE Stripe error (connection reset, API error, function
--     timeout) can be thrown AFTER the PaymentIntent was created and confirmed.
--     The route treated every throw as terminal, so the token was stamped
--     'failed' and used_at stayed set — the customer could not retry and no
--     later event could credit them.
--  2. An intent that settles asynchronously ('processing') was likewise treated
--     as failed, then succeeded at Stripe minutes later.
--
-- The application fix is to only finalise on a DEFINITIVE outcome and otherwise
-- release the claim so the same token can be retried (the Stripe idempotency
-- key `lead_topup_<token_id>` guarantees a retry returns the ORIGINAL intent
-- rather than charging twice). This migration supplies the two database pieces
-- that fix needs.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 — record_lead_topup_success: allow 'failed' → 'paid' promotion.
--
-- 0041 skipped whenever charge_status was non-null, which made the safety net
-- unreachable: a token wrongly marked 'failed' (case 1/2 above) could never be
-- credited even once Stripe confirmed the money had been taken. Only a token
-- already 'paid' is a true replay, so that is now the sole short-circuit.
--
-- Promotion re-runs the credit exactly once: the guard is on charge_status =
-- 'paid', which this function itself sets in the same transaction under the
-- row lock, so two concurrent promotions cannot both credit. The earlier
-- 'failed' payments row is deliberately left in place as audit history — it
-- records a real, distinct attempt — and the new 'paid' row is what carries
-- credits_added.
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
  -- Only an already-PAID token is a replay. A 'failed' token is promoted, so a
  -- charge that actually succeeded can still be credited after the fact.
  if v_tok.charge_status = 'paid' then return false; end if;

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
-- 2 — release_lead_topup_token: undo a claim whose charge outcome is UNKNOWN.
--
-- Called when the charge attempt ended indeterminately (network/API error, or
-- an intent still 'processing'). Clearing used_at returns the token to the
-- active pool so the customer can retry the same link; retrying reuses the
-- Stripe idempotency key, so if the original charge did in fact succeed the
-- retry returns that same intent and credits once — it can never double-charge.
--
-- Refuses to release a token that already has a definitive outcome
-- (charge_status set), so a paid token is never reopened.
--
-- Returns false when the release could not be applied — including the case
-- where another unused token has meanwhile taken this customer+product's active
-- slot (uq_lead_topup_tokens_active), which surfaces as a unique_violation and
-- is caught here rather than propagating as a 500.
-- ---------------------------------------------------------------------------
create or replace function public.release_lead_topup_token(p_token_id uuid)
returns boolean
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

  if not found then return false; end if;
  if v_tok.charge_status is not null then return false; end if;
  if v_tok.used_at is null then return true; end if;

  begin
    update public.lead_topup_tokens
      set used_at = null
      where id = v_tok.id;
  exception when unique_violation then
    return false;
  end;

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3 — Lock down, mirroring 0028/0029/0041.
-- ---------------------------------------------------------------------------
revoke execute on function public.release_lead_topup_token(uuid)
  from public, anon, authenticated;
grant execute on function public.release_lead_topup_token(uuid)
  to service_role;

revoke execute on function public.record_lead_topup_success(uuid, text)
  from public, anon, authenticated;
grant execute on function public.record_lead_topup_success(uuid, text)
  to service_role;
