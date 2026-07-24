-- ============================================================================
-- Admin force-assign OVERRIDE: place a lead with a customer while bypassing the
-- paid-credit / subscription gate that assign_lead_to_customer enforces.
--
-- assign_lead_to_customer refuses when the customer has no remaining
-- lead_balance / gr_lead_balance. That is correct for automatic ingest — you
-- never give away a paid lead by accident — but it blocks the admin "Override
-- credit limit" tool, whose whole purpose is to place a lead with a real,
-- active customer who has used up this cycle's credits (or, for GR, has no
-- active subscription).
--
-- This override still:
--   * locks the lead and customer rows,
--   * enforces the lead's max_assignments capacity,
--   * enforces the MANAGEMENT pause block (a paused customer must never receive
--     a management lead through ANY path — mirrors 0039),
--   * relies on the (lead_id, customer_id) unique constraint against duplicates.
-- It SKIPS only the balance / subscription check, and spends a credit only when
-- one exists (greatest(balance-1, 0)) so an override never drives a balance
-- negative. SECURITY DEFINER; per 0024's locked-down default privileges it is
-- executable only by the service role (the admin server route).
-- ============================================================================
create or replace function public.admin_assign_lead(
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

  -- Capacity still applies. Raise max_assignments to add more recipients.
  if v_lead.assignment_count >= v_lead.max_assignments then
    raise exception 'Lead % is at max assignments (%/%)',
      p_lead_id, v_lead.assignment_count, v_lead.max_assignments;
  end if;

  -- Pause is management-only and airtight: even an override must not place a
  -- management lead with a paused customer (mirrors 0039).
  if p_lead_type <> 'guaranteed_rent' and v_customer.paused_at is not null then
    raise exception 'Customer % is paused and cannot receive management leads', p_customer_id;
  end if;

  -- NB: no balance / subscription gate here — this is the admin override path.

  insert into public.lead_assignments (lead_id, customer_id, price_paid)
    values (p_lead_id, p_customer_id, p_price)
    returning id into v_assignment_id;

  update public.leads
    set assignment_count = assignment_count + 1
    where id = p_lead_id;

  -- Spend a credit only if one is available, so an override never goes negative.
  if p_lead_type = 'guaranteed_rent' then
    update public.customers
      set gr_lead_balance = greatest(gr_lead_balance - 1, 0),
          gr_leads_received_this_month = gr_leads_received_this_month + 1,
          gr_last_assignment_at = now(),
          updated_at = now()
      where id = p_customer_id;
  else
    update public.customers
      set lead_balance = greatest(lead_balance - 1, 0),
          leads_received_this_month = leads_received_this_month + 1,
          last_assignment_at = now(),
          updated_at = now()
      where id = p_customer_id;
  end if;

  return v_assignment_id;
end;
$$;

revoke execute on function public.admin_assign_lead(uuid, uuid, numeric, public.lead_type)
  from public, anon, authenticated;
grant execute on function public.admin_assign_lead(uuid, uuid, numeric, public.lead_type)
  to service_role;
