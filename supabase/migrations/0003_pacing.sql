-- ============================================================================
-- Lead pacing system.
-- Adds billing_cycle_anchor and switches lead assignment from round-robin to
-- deficit-first ordering so leads are distributed proportionally across the
-- billing cycle. Customers behind pace are served first.
-- ============================================================================

alter table public.customers
  add column if not exists billing_cycle_anchor date;

-- Deficit-first assignment. Still returns just customer_id so the webhook
-- contract is unchanged; the pacing deficit is used only for ordering.
--
--   days_elapsed = today - billing_cycle_anchor   (clamped 0..30)
--   expected     = ROUND((days_elapsed / 30) * monthly_allocation)
--   deficit      = expected - leads_received_this_month
--
-- Highest deficit (most behind pace) wins; ties fall back to
-- last_assignment_at ascending for fairness. billing_cycle_anchor falls back to
-- created_at for customers whose subscription webhook hasn't landed yet.
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
    and not exists (
      select 1 from public.lead_assignments la
      where la.lead_id = p_lead_id
        and la.customer_id = c.id
    )
    and (
      c.leads_received_this_month < c.monthly_allocation
      or c.overflow_enabled = true
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
