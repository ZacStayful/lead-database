-- ============================================================================
-- account_status — capacity-management state, independent of Stripe billing.
--
--   waitlisted — signed up, no capacity available, awaiting activation
--   invited    — activated by admin, invitation email sent, awaiting payment
--   active     — paying subscriber, eligible to receive leads
--   cancelled  — subscription ended
--
-- subscription_status continues to mirror Stripe (payment currency); the two
-- columns serve different purposes and are maintained independently.
-- ============================================================================

alter table public.customers
  add column if not exists account_status text not null default 'waitlisted'
  check (account_status in ('waitlisted', 'invited', 'active', 'cancelled'));

-- Existing customers predate capacity management and are already live — backfill
-- them to active so they keep receiving leads.
update public.customers set account_status = 'active' where is_active = true;

-- Lead routing must only reach approved, paying customers. Add the
-- account_status gate to the eligibility filter (signature unchanged from 0006).
create or replace function public.get_next_customers_for_lead(
  p_lead_id uuid,
  p_max integer,
  p_exclude_customer_ids uuid[] default '{}'::uuid[]
)
returns table (customer_id uuid)
language sql
security definer
set search_path = public
as $$
  select c.id
  from public.customers c
  where c.is_active = true
    and c.account_status = 'active'
    and c.subscription_status = 'active'
    and c.lead_balance > 0
    and not (c.id = any (coalesce(p_exclude_customer_ids, '{}'::uuid[])))
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
