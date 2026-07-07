-- ============================================================================
-- Reject is now a status marker only — no refund, no replacement.
--
-- Business rule: every delivered lead is chargeable. When a customer rejects a
-- lead it still counts toward their leads for the month, no credit is refunded,
-- and no replacement is assigned. Rejection is only a pipeline/feedback signal.
--
-- This replaces the refund-and-reopen behaviour from 0006 (and the lead-type
-- aware refund from 0015): reject_lead_assignment now just flips status to
-- 'rejected'. It no longer touches lead_balance / gr_lead_balance, the monthly
-- counters, or leads.assignment_count. The reassignment step is removed from
-- the API route. The p_lead_type parameter is dropped as it is no longer used.
-- ============================================================================

drop function if exists public.reject_lead_assignment(uuid, uuid, public.lead_type);
drop function if exists public.reject_lead_assignment(uuid, uuid);

create or replace function public.reject_lead_assignment(
  p_assignment_id uuid,
  p_customer_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.lead_assignments
    set status = 'rejected'
    where id = p_assignment_id
      and customer_id = p_customer_id
      and status = 'new';

  if not found then
    raise exception 'Assignment not found, not owned by this customer, or not rejectable';
  end if;
end;
$$;
