-- ============================================================================
-- Tidy up the "denied invalid_contact claim" half-state.
--
-- When a customer rejects a lead as invalid_contact but live verification finds
-- BOTH the phone and email valid, apply_lead_rejection (0021) records the
-- outcome as claim_denied = true and leaves the assignment status = 'new' with
-- rejection_reason = 'invalid_contact' on file. That adjudicated-but-still-new
-- state had two rough edges:
--
--   1. discard_lead_assignment only checked status = 'new', so the customer
--      could DISCARD (release for resale) a lead the system just told them is
--      valid and chargeable — offloading a lead they were told to keep.
--   2. apply_lead_rejection treated any non-null rejection_reason as terminal,
--      so the customer could never re-reject that lead as not_a_fit — even
--      though not_a_fit is a legitimate, non-refunding rejection.
--
-- This migration closes (1) and enables (2).
-- ============================================================================

-- (1) Refuse to discard a lead that already carries a recorded rejection. A
-- denied invalid_contact claim is adjudicated and chargeable; it must not be
-- offloaded via discard.
create or replace function public.discard_lead_assignment(
  p_lead_assignment_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead_id uuid;
  v_status  text;
  v_reason  text;
  v_notes   integer;
begin
  select lead_id, status, rejection_reason
    into v_lead_id, v_status, v_reason
    from public.lead_assignments
    where id = p_lead_assignment_id
    for update;

  if not found then
    raise exception 'Assignment % not found', p_lead_assignment_id;
  end if;

  if v_status <> 'new' then
    raise exception 'Assignment % is not discardable (status = %)',
      p_lead_assignment_id, v_status;
  end if;

  if v_reason is not null then
    raise exception 'Assignment % has a recorded rejection and cannot be discarded',
      p_lead_assignment_id;
  end if;

  select count(*) into v_notes
    from public.lead_notes
    where lead_assignment_id = p_lead_assignment_id;

  if v_notes > 0 then
    raise exception 'Assignment % has notes and cannot be discarded',
      p_lead_assignment_id;
  end if;

  delete from public.lead_assignments where id = p_lead_assignment_id;

  update public.leads
    set assignment_count = greatest(assignment_count - 1, 0)
    where id = v_lead_id;
end;
$$;

-- (2) Allow a not_a_fit rejection to supersede a previously DENIED
-- invalid_contact claim (lead still 'new'). not_a_fit never restores balance,
-- so there is no double-refund risk; every other already-processed case stays
-- an idempotent no-op, preserving the double-refund protection from 0021.
create or replace function public.apply_lead_rejection(
  p_assignment_id uuid,
  p_customer_id uuid,
  p_lead_type public.lead_type,
  p_reason text,
  p_validation_result jsonb,
  p_restore boolean,
  p_claim_denied boolean
)
returns table (applied boolean, denied boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead_id          uuid;
  v_status           text;
  v_existing_reason  text;
  v_existing_denied  boolean;
begin
  select lead_id, status, rejection_reason, claim_denied
    into v_lead_id, v_status, v_existing_reason, v_existing_denied
    from public.lead_assignments
    where id = p_assignment_id
      and customer_id = p_customer_id
    for update;

  if not found then
    raise exception 'Assignment not found or not owned by this customer';
  end if;

  -- Already processed: idempotent no-op — EXCEPT a not_a_fit rejection is
  -- allowed to supersede a denied invalid_contact claim (still 'new').
  if v_existing_reason is not null then
    if not (
      v_existing_denied
      and v_status = 'new'
      and p_reason = 'not_a_fit'
      and not p_restore
    ) then
      return query select false, v_existing_denied;
      return;
    end if;
  end if;

  if v_status <> 'new' then
    raise exception 'Assignment is not rejectable (status = %)', v_status;
  end if;

  update public.lead_assignments
    set rejection_reason = p_reason,
        contact_validation_result = p_validation_result,
        claim_denied = p_claim_denied,
        -- A denied claim leaves the lead assigned; every other outcome rejects it.
        status = case when p_claim_denied then status else 'rejected' end
    where id = p_assignment_id;

  if p_restore then
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
  end if;

  return query select true, p_claim_denied;
end;
$$;
