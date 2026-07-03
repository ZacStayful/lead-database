-- ============================================================================
-- lead_balance — a running lead credit per customer.
--
--   +20 on every successful subscription payment (Stripe invoice.paid).
--   -1  on every lead assignment.
--   +1  on rejection (see 0006_add_reject.sql).
--
-- It never resets, so shortfalls from previous months accumulate automatically.
-- This replaces the old "remaining allocation OR overflow" gate: lead_balance is
-- now the single source of truth for whether a customer may receive a lead.
-- leads_received_this_month remains an independent monthly counter used only for
-- pacing/display and is reset by reset_monthly_counts().
-- ============================================================================

alter table public.customers
  add column if not exists lead_balance integer not null default 0;

-- Add lead credit for a customer, keyed on their Stripe customer id so the
-- webhook can call it without a prior lookup.
create or replace function public.increment_lead_balance(
  p_stripe_customer_id text,
  p_amount integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.customers
    set lead_balance = lead_balance + p_amount,
        updated_at = now()
    where stripe_customer_id = p_stripe_customer_id;
end;
$$;

-- assign_lead_to_customer: gated on lead_balance now that overflow is gone.
-- Decrements lead_balance in the same transaction as the assignment insert, so
-- the credit is only spent when the assignment actually succeeds.
create or replace function public.assign_lead_to_customer(
  p_lead_id uuid,
  p_customer_id uuid,
  p_price numeric
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead     public.leads%rowtype;
  v_customer public.customers%rowtype;
  v_assignment_id uuid;
begin
  -- Lock the lead and customer rows for the duration of the transaction.
  select * into v_lead from public.leads
    where id = p_lead_id for update;
  if not found then
    raise exception 'Lead % not found', p_lead_id;
  end if;

  select * into v_customer from public.customers
    where id = p_customer_id for update;
  if not found then
    raise exception 'Customer % not found', p_customer_id;
  end if;

  -- Lead capacity check.
  if v_lead.assignment_count >= v_lead.max_assignments then
    raise exception 'Lead % is at max assignments (%/%)',
      p_lead_id, v_lead.assignment_count, v_lead.max_assignments;
  end if;

  -- Lead balance is the sole allocation gate.
  if v_customer.lead_balance <= 0 then
    raise exception 'Customer % has no remaining lead balance', p_customer_id;
  end if;

  -- Insert the assignment (unique constraint guards against duplicates).
  insert into public.lead_assignments (lead_id, customer_id, price_paid)
    values (p_lead_id, p_customer_id, p_price)
    returning id into v_assignment_id;

  -- Increment lead capacity counter.
  update public.leads
    set assignment_count = assignment_count + 1
    where id = p_lead_id;

  -- Spend one lead credit and bump the monthly counter.
  update public.customers
    set leads_received_this_month = leads_received_this_month + 1,
        lead_balance = lead_balance - 1,
        last_assignment_at = now(),
        updated_at = now()
    where id = p_customer_id;

  return v_assignment_id;
end;
$$;

-- get_next_customers_for_lead: eligible customers now require a positive
-- lead_balance (overflow_enabled removed). Ordering is unchanged deficit-first
-- pacing so customers behind pace are served first.
create or replace function public.get_next_customers_for_lead(
  p_lead_id uuid,
  p_max integer
)
returns table (customer_id uuid)
language sql
security definer
set search_path = public
as $$
  select c.id
  from public.customers c
  where c.is_active = true
    and c.subscription_status = 'active'
    and c.lead_balance > 0
    and not exists (
      select 1 from public.lead_assignments la
      where la.lead_id = p_lead_id
        and la.customer_id = c.id
    )
  order by
    round(
      (least(greatest(
        extract(day from now() - coalesce(c.billing_cycle_anchor, c.created_at::date)),
        0), 30) / 30.0)
      * c.monthly_allocation
    ) - c.leads_received_this_month desc,
    c.last_assignment_at asc nulls first,
    c.created_at asc
  limit p_max;
$$;
