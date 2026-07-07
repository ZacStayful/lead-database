-- ============================================================================
-- Make reject_lead_assignment lead-type aware.
--
-- 0013 made assign_lead_to_customer, get_next_customers_for_lead and
-- reset_monthly_counts GR-aware, but reject_lead_assignment (from 0006) was
-- left management-only. As a result, rejecting a guaranteed_rent lead refunded
-- the management balance (lead_balance += 1) and decremented the management
-- monthly counter, while the gr_lead_balance that was actually spent stayed
-- gone and gr_leads_received_this_month stayed inflated.
--
-- This adds a p_lead_type parameter (default 'management' so existing callers
-- are unaffected) and branches the refund onto the correct product's columns.
-- The old 2-arg signature is dropped first so a single overload remains.
-- ============================================================================

drop function if exists public.reject_lead_assignment(uuid, uuid);
create or replace function public.reject_lead_assignment(
  p_assignment_id uuid,
  p_customer_id uuid,
  p_lead_type public.lead_type default 'management'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead_id uuid;
begin
  select lead_id into v_lead_id
  from public.lead_assignments
  where id = p_assignment_id
    and customer_id = p_customer_id
    and status = 'new';

  if not found then
    raise exception 'Assignment not found, not owned by this customer, or not rejectable';
  end if;

  update public.lead_assignments
    set status = 'rejected'
    where id = p_assignment_id;

  -- Refund the credit and roll back the monthly counter on the matching
  -- product, mirroring the spend done by assign_lead_to_customer.
  if p_lead_type = 'guaranteed_rent' then
    update public.customers
      set gr_lead_balance = gr_lead_balance + 1,
          gr_leads_received_this_month = greatest(gr_leads_received_this_month - 1, 0),
          updated_at = now()
      where id = p_customer_id;
  else
    update public.customers
      set lead_balance = lead_balance + 1,
          leads_received_this_month = greatest(leads_received_this_month - 1, 0),
          updated_at = now()
      where id = p_customer_id;
  end if;

  update public.leads
    set assignment_count = greatest(assignment_count - 1, 0)
    where id = v_lead_id;
end;
$$;
