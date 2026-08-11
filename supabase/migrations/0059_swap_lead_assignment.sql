-- ============================================================================
-- Swap a lead out of a customer's pipeline and put another in its place.
--
-- Neither existing path fits. discard_lead_assignment (0010) refuses anything
-- that is not status='new' with no notes, which excludes exactly the case this
-- exists for: a lead the operator worked before it turned out to be bad.
-- admin_assign_lead (0040) spends a credit and bumps the monthly counter,
-- which is wrong for a replacement — the customer already paid for this slot.
--
-- THE SWAP MOVES NO MONEY. No credit is spent, lead_balance and
-- gr_lead_balance are untouched, the monthly counters do not move, and the new
-- assignment inherits the OLD assignment's price_paid so revenue attribution
-- follows the lead that was actually delivered. Invariant 1 is intact because
-- nothing extra was delivered: one slot, one credit, still.
--
-- management_lifetime_leads_received is likewise untouched. The odometer means
-- "leads received and workable" (CLAUDE.md §13); a swap leaves that count the
-- same, so bumping it would overstate delivery and lengthen nothing.
-- ============================================================================

-- Audit only. The lead is taken out of circulation by the max_assignments
-- clamp below; this column records that it was pulled deliberately rather than
-- filled up naturally, which is otherwise indistinguishable in the admin view.
alter table public.leads
  add column if not exists withdrawn_at timestamptz;

comment on column public.leads.withdrawn_at is
  'Set when a lead was withdrawn from circulation by an admin swap. Display and audit only — the max_assignments clamp is what actually stops it being re-offered.';

-- ---------------------------------------------------------------------------
-- admin_swap_lead_assignment
--
-- Atomic, following assign_lead_to_customer's lock-then-check-then-mutate
-- shape. Either the whole swap happens or none of it does — a half-applied
-- swap would leave the customer short a lead they had paid for.
--
-- TAKING THE OLD LEAD OUT OF CIRCULATION
-- --------------------------------------
-- assignment_count is decremented, because the assignment genuinely no longer
-- exists and the count must stay truthful. max_assignments is then clamped
-- DOWN to the new count, which is what actually withdraws the lead: every
-- selection path in the codebase asks `assignment_count < max_assignments`
-- (ingest.ts, /api/admin/leads/assign-pending, and admin_assign_lead's own
-- capacity guard), so a clamped lead is skipped by all of them without a line
-- of application code changing. That matters — the alternative was editing the
-- ingest money path to understand a new flag.
-- ---------------------------------------------------------------------------
create or replace function public.admin_swap_lead_assignment(
  p_assignment_id uuid,
  p_new_lead_id   uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old        public.lead_assignments%rowtype;
  v_old_lead   public.leads%rowtype;
  v_new_lead   public.leads%rowtype;
  v_customer   public.customers%rowtype;
  v_new_id     uuid;
begin
  select * into v_old from public.lead_assignments
    where id = p_assignment_id for update;
  if not found then
    raise exception 'Assignment % not found', p_assignment_id;
  end if;

  -- A won lead is a conversion record. Swapping it out would delete the only
  -- evidence the customer signed anybody, and every win figure counts
  -- status='won' (CLAUDE.md §6A).
  if v_old.status = 'won' then
    raise exception 'This lead is marked won and cannot be swapped out';
  end if;

  if v_old.lead_id = p_new_lead_id then
    raise exception 'The replacement is the same lead';
  end if;

  select * into v_old_lead from public.leads
    where id = v_old.lead_id for update;
  if not found then
    raise exception 'Lead % not found', v_old.lead_id;
  end if;

  select * into v_new_lead from public.leads
    where id = p_new_lead_id for update;
  if not found then
    raise exception 'Replacement lead % not found', p_new_lead_id;
  end if;

  select * into v_customer from public.customers
    where id = v_old.customer_id for update;
  if not found then
    raise exception 'Customer % not found', v_old.customer_id;
  end if;

  -- Clearer than letting the (lead_id, customer_id) unique index fire, for the
  -- same reason 0053 gave the assign functions an explicit guard.
  if exists (
    select 1 from public.lead_assignments
    where lead_id = p_new_lead_id and customer_id = v_old.customer_id
  ) then
    raise exception 'Customer already has the replacement lead';
  end if;

  -- The replacement must have room, the same as any other placement.
  if v_new_lead.assignment_count >= v_new_lead.max_assignments then
    raise exception 'Replacement lead is at max assignments (%/%)',
      v_new_lead.assignment_count, v_new_lead.max_assignments;
  end if;

  -- Pause is management-only and airtight: no path may place a management lead
  -- with a paused customer (mirrors 0039 and 0040).
  if v_new_lead.lead_type <> 'guaranteed_rent' and v_customer.paused_at is not null then
    raise exception 'Customer is paused and cannot receive management leads';
  end if;

  -- Products must match. Swapping a management lead for a guaranteed rent one
  -- would move a delivery between two independent balances and pipelines.
  if v_new_lead.lead_type is distinct from v_old_lead.lead_type then
    raise exception 'Replacement must be the same product as the lead being removed';
  end if;

  -- Remove. lead_notes and lead_files cascade with the assignment; the caller
  -- is responsible for warning about that before getting here.
  delete from public.lead_assignments where id = p_assignment_id;

  update public.leads
    set assignment_count = greatest(assignment_count - 1, 0),
        withdrawn_at     = now()
    where id = v_old_lead.id;

  -- The clamp. Read after the decrement so it lands on the true count.
  update public.leads
    set max_assignments = assignment_count
    where id = v_old_lead.id;

  -- Place the replacement at the SAME price. No credit is spent and no counter
  -- moves: this is the slot the customer already paid for.
  insert into public.lead_assignments (lead_id, customer_id, price_paid)
    values (p_new_lead_id, v_old.customer_id, v_old.price_paid)
    returning id into v_new_id;

  update public.leads
    set assignment_count = assignment_count + 1
    where id = p_new_lead_id;

  return v_new_id;
end;
$$;

-- Service role only — called from an admin server route. Asserted explicitly
-- because a later CREATE OR REPLACE discards the ACL (the 0049 lesson).
revoke all on function public.admin_swap_lead_assignment(uuid, uuid) from public;
revoke all on function public.admin_swap_lead_assignment(uuid, uuid) from anon;
revoke all on function public.admin_swap_lead_assignment(uuid, uuid) from authenticated;
