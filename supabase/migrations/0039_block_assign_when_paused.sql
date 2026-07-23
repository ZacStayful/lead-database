-- ============================================================================
-- Make the pause airtight: block ALL lead allocation to a paused customer,
-- including the admin force-assign path.
--
-- The candidate-selection functions (0038) already exclude paused customers
-- from automatic routing. But the admin "force-assign" tool calls
-- assign_lead_to_customer directly, which only checked lead_balance — so a
-- paused customer could still be assigned a lead by hand. This redefines the
-- function (verbatim from 0015) with one added guard: a MANAGEMENT assignment
-- to a customer with paused_at set raises, so no path — automatic or manual —
-- can allocate a management lead to a paused customer. Guaranteed-rent
-- assignment is unaffected (pause is management-only).
-- ============================================================================
create or replace function public.assign_lead_to_customer(
  p_lead_id uuid,
  p_customer_id uuid,
  p_price numeric,
  p_lead_type public.lead_type default 'management'
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

  -- Lead capacity check (applies to both product types).
  if v_lead.assignment_count >= v_lead.max_assignments then
    raise exception 'Lead % is at max assignments (%/%)',
      p_lead_id, v_lead.assignment_count, v_lead.max_assignments;
  end if;

  -- Allocation gate, per product type.
  if p_lead_type = 'guaranteed_rent' then
    if v_customer.gr_lead_balance <= 0 then
      raise exception 'Customer % has no remaining GR lead balance', p_customer_id;
    end if;
  else
    -- Pause is management-only: a paused customer must not receive management
    -- leads through ANY path (this also covers the admin force-assign tool).
    if v_customer.paused_at is not null then
      raise exception 'Customer % is paused and cannot receive management leads', p_customer_id;
    end if;
    if v_customer.lead_balance <= 0 then
      raise exception 'Customer % has no remaining lead balance', p_customer_id;
    end if;
  end if;

  -- Insert the assignment (unique constraint guards against duplicates).
  insert into public.lead_assignments (lead_id, customer_id, price_paid)
    values (p_lead_id, p_customer_id, p_price)
    returning id into v_assignment_id;

  -- Increment lead capacity counter (both product types).
  update public.leads
    set assignment_count = assignment_count + 1
    where id = p_lead_id;

  -- Spend one credit and bump the relevant monthly counter.
  if p_lead_type = 'guaranteed_rent' then
    update public.customers
      set gr_lead_balance = gr_lead_balance - 1,
          gr_leads_received_this_month = gr_leads_received_this_month + 1,
          gr_last_assignment_at = now(),
          updated_at = now()
      where id = p_customer_id;
  else
    update public.customers
      set leads_received_this_month = leads_received_this_month + 1,
          lead_balance = lead_balance - 1,
          last_assignment_at = now(),
          updated_at = now()
      where id = p_customer_id;
  end if;

  return v_assignment_id;
end;
$$;
