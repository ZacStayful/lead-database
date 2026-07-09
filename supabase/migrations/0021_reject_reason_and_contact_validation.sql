-- ============================================================================
-- Reject reason + automated contact verification.
--
-- Adds a required rejection reason and, for the 'invalid_contact' reason, an
-- audit record of a live phone/email verification. lead_assignments already
-- holds BOTH management and guaranteed_rent leads (distinguished by the joined
-- leads.lead_type), so this single migration covers both product lines — there
-- is no separate GR assignments table to replicate onto.
--
-- Business model note: 0019 made reject a status-marker only (every delivered
-- lead is chargeable — no refund, no replacement). This migration reintroduces
-- a balance restore + slot reopen, but ONLY for the invalid_contact path where
-- the contact details genuinely fail (or can't be verified). A lead with bad
-- contact details was never a real delivered lead, so it must not be charged.
-- 'not_a_fit' rejections stay chargeable, matching 0019.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------
alter table public.lead_assignments
  add column if not exists rejection_reason text
    check (rejection_reason in ('not_a_fit', 'invalid_contact'));

alter table public.lead_assignments
  add column if not exists contact_validation_result jsonb;

alter table public.lead_assignments
  add column if not exists claim_denied boolean not null default false;

-- Partial index for querying auto-denied claims later (small, denials are rare).
create index if not exists idx_lead_assignments_claim_denied
  on public.lead_assignments (claim_denied)
  where claim_denied = true;

-- ---------------------------------------------------------------------------
-- apply_lead_rejection — atomic reason capture + (conditional) balance restore.
--
-- One function handles all three outcomes so the reason columns, the balance
-- refund, the monthly-counter rollback and the slot reopen all commit together
-- (or not at all). The API route runs the external verification and reassignment
-- around this; only the state mutation below is atomic.
--
--   p_restore = true  -> refund balance, roll back the monthly counter, reopen
--                        the slot, and flip status to 'rejected'. Used for
--                        invalid_contact when the claim is confirmed or the
--                        contact could not be verified (favoured_customer).
--   p_restore = false, p_claim_denied = false -> just flip to 'rejected' with no
--                        balance effect. Used for 'not_a_fit' (chargeable).
--   p_claim_denied = true -> record the denial but leave the lead assigned
--                        ('new', chargeable) with no balance effect.
--
-- Idempotency: the row is locked FOR UPDATE and only mutated while
-- rejection_reason IS NULL. A duplicate/retried request finds it already set and
-- returns applied = false with the stored claim_denied, so the caller can return
-- the original outcome without re-running anything.
-- ---------------------------------------------------------------------------
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

  -- Already processed: idempotent no-op. Return the stored outcome.
  if v_existing_reason is not null then
    return query select false, v_existing_denied;
    return;
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
