-- ============================================================================
-- Lead accept/reject.
--
-- A customer may reject an assignment while its status is 'new'. Rejection is
-- atomic: it flips the assignment to 'rejected', restores one lead credit,
-- decrements the monthly counter, and reopens the lead's assignment slot. The
-- API route then reassigns the lead to the next eligible customer, excluding
-- the rejector.
--
-- Acceptance is implicit: setting any status other than 'rejected' (contacted,
-- in_discussion, won, not_relevant) closes the rejection window permanently.
-- ============================================================================

-- Normalise existing status values onto the canonical set before constraining.
-- The original schema defaulted new assignments to 'active'; map those to 'new'.
update public.lead_assignments
  set status = 'new'
  where status is null
     or status not in
        ('new', 'contacted', 'in_discussion', 'won', 'not_relevant', 'rejected');

alter table public.lead_assignments
  alter column status set default 'new';

alter table public.lead_assignments
  drop constraint if exists lead_assignments_status_check;
alter table public.lead_assignments
  add constraint lead_assignments_status_check
  check (status in ('new', 'contacted', 'in_discussion', 'won', 'not_relevant', 'rejected'));

-- Atomic rejection function.
create or replace function public.reject_lead_assignment(
  p_assignment_id uuid,
  p_customer_id uuid
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

  update public.customers
    set lead_balance = lead_balance + 1,
        leads_received_this_month = greatest(leads_received_this_month - 1, 0),
        updated_at = now()
    where id = p_customer_id;

  update public.leads
    set assignment_count = greatest(assignment_count - 1, 0)
    where id = v_lead_id;
end;
$$;

-- Add an exclusion list to the routing function so a rejected lead is never
-- re-offered to the customer who rejected it. Redefine with the extra
-- (defaulted) parameter; drop the two-arg version first so a single overload
-- remains and existing two-arg callers resolve to it via the default.
drop function if exists public.get_next_customers_for_lead(uuid, integer);
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
