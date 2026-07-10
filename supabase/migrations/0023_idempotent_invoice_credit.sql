-- ============================================================================
-- Exactly-once invoice crediting.
--
-- Bug this fixes: the Stripe webhook credited lead_balance / gr_lead_balance
-- with an *unconditional* increment (increment_lead_balance / _gr_) and then
-- recorded the payment and updated the customer in separate, non-transactional
-- calls. The webhook's error handler deletes the stripe_events idempotency claim
-- so Stripe can retry — but if a failure landed *after* the credit had already
-- been applied (a lost network response, or a later step throwing), the retry
-- re-ran the increment and credited a second time, with no rollback. The
-- stripe_events claim was the only guard and it was being released post-credit.
--
-- Fix: make the credit itself idempotent at the database level, keyed on the
-- Stripe invoice id. credit_invoice() records the paid invoice and moves the
-- balance in a single transaction; a partial unique index on the 'paid' payment
-- rows means a replayed invoice hits a unique_violation, the credit is skipped,
-- and the function returns false. The webhook can now be retried any number of
-- times and credit lands exactly once — the stripe_events claim becomes a cheap
-- fast-path dedup rather than the sole line of defence.
--
-- The index is partial (status = 'paid') on purpose: invoice.payment_failed
-- rows share the invoice id and must not collide with the later 'paid' row, and
-- multiple failed attempts for one invoice stay allowed.
-- ============================================================================

-- One 'paid' payment per invoice — the idempotency key for crediting.
-- NOTE: if historical duplicate 'paid' rows already exist (from the pre-fix
-- double-credit path) this index creation will fail; de-dupe those rows first.
create unique index if not exists uq_payments_paid_invoice
  on public.payments (stripe_invoice_id)
  where status = 'paid' and stripe_invoice_id is not null;

-- Atomic, idempotent credit for a paid subscription invoice.
--   returns true  -> this call recorded the invoice and applied the credit
--   returns false -> the invoice was already credited (no-op)
-- p_payment_type routes the credit to the matching product balance:
--   'gr_subscription' -> gr_lead_balance, anything else -> lead_balance.
create or replace function public.credit_invoice(
  p_customer_id uuid,
  p_amount integer,
  p_invoice_id text,
  p_payment_intent_id text,
  p_amount_pence integer,
  p_payment_type text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Claim the invoice by inserting its 'paid' payment row. A duplicate means we
  -- already credited it on an earlier delivery of this event — bail without
  -- touching the balance.
  begin
    insert into public.payments (
      customer_id, stripe_invoice_id, stripe_payment_intent_id,
      amount_pence, credits_added, payment_type, status
    ) values (
      p_customer_id, p_invoice_id, p_payment_intent_id,
      p_amount_pence, p_amount, p_payment_type, 'paid'
    );
  exception when unique_violation then
    return false;
  end;

  if p_payment_type = 'gr_subscription' then
    update public.customers
      set gr_lead_balance = gr_lead_balance + p_amount,
          updated_at = now()
      where id = p_customer_id;
  else
    update public.customers
      set lead_balance = lead_balance + p_amount,
          updated_at = now()
      where id = p_customer_id;
  end if;

  return true;
end;
$$;
