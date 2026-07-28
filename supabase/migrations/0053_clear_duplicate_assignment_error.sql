-- 0053 — say "already has this lead" instead of leaking a constraint name.
--
-- assign_lead_to_customer and admin_assign_lead both validated lead, customer,
-- capacity and balance and then inserted blind. Re-assigning a (lead, customer)
-- pair that already existed let the unique index throw, so admin bulk-assign
-- reported:
--
--   duplicate key value violates unique constraint
--   "lead_assignments_lead_id_customer_id_key"
--
-- which reads as a broken feature rather than "this customer already has that
-- lead". Nothing was ever corrupted — the insert and the counter updates share a
-- transaction, so a duplicate rolls the whole pair back and assignment_count
-- stays truthful — but the message was unusable to whoever hit it.
--
-- The guard goes FIRST, ahead of the capacity check, on purpose. A lead sitting
-- at max_assignments *because this very customer already holds it* should say so
-- rather than report a cap, which sends the reader off diagnosing the wrong
-- thing. Lead ids move to DETAIL so the surfaced message stays human-readable
-- while the ids remain in the Postgres log for debugging.
--
-- Behaviour is otherwise untouched: same gates, same order, same counters. Only
-- the failure message for an already-assigned pair changes.

create or replace function public.assign_lead_to_customer(
  p_lead_id uuid,
  p_customer_id uuid,
  p_price numeric,
  p_lead_type lead_type default 'management'::lead_type
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_lead     public.leads%rowtype;
  v_customer public.customers%rowtype;
  v_assignment_id uuid;
  v_capacity integer;
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

  -- Before capacity: an already-held lead must not be reported as a cap breach.
  if exists (
    select 1 from public.lead_assignments
    where lead_id = p_lead_id and customer_id = p_customer_id
  ) then
    raise exception 'Customer already has this lead'
      using detail = format('customer=%s lead=%s', p_customer_id, p_lead_id);
  end if;

  -- Capacity = ordinary cap + any reclaim slot granted and not yet consumed.
  v_capacity := v_lead.max_assignments
                + public.lead_open_reclaim_slots(p_lead_id);

  if v_lead.assignment_count >= v_capacity then
    raise exception 'Lead % is at max assignments (%/%)',
      p_lead_id, v_lead.assignment_count, v_capacity;
  end if;

  if p_lead_type = 'guaranteed_rent' then
    if v_customer.gr_lead_balance <= 0 then
      raise exception 'Customer % has no remaining GR lead balance', p_customer_id;
    end if;
  else
    if v_customer.paused_at is not null then
      raise exception 'Customer % is paused and cannot receive management leads', p_customer_id;
    end if;
    if v_customer.lead_balance <= 0 then
      raise exception 'Customer % has no remaining lead balance', p_customer_id;
    end if;
  end if;

  insert into public.lead_assignments (lead_id, customer_id, price_paid)
    values (p_lead_id, p_customer_id, p_price)
    returning id into v_assignment_id;

  update public.leads
    set assignment_count = assignment_count + 1
    where id = p_lead_id;

  if p_lead_type = 'guaranteed_rent' then
    -- GR branch: unchanged. No lifetime odometer exists for this product.
    update public.customers
      set gr_lead_balance = gr_lead_balance - 1,
          gr_leads_received_this_month = gr_leads_received_this_month + 1,
          gr_last_assignment_at = now(),
          updated_at = now()
      where id = p_customer_id;
  else
    update public.customers
      set leads_received_this_month = leads_received_this_month + 1,
          management_lifetime_leads_received =
            management_lifetime_leads_received + 1,
          lead_balance = lead_balance - 1,
          last_assignment_at = now(),
          updated_at = now()
      where id = p_customer_id;
  end if;

  return v_assignment_id;
end;
$function$;

create or replace function public.admin_assign_lead(
  p_lead_id uuid,
  p_customer_id uuid,
  p_price numeric,
  p_lead_type lead_type default 'management'::lead_type
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
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

  -- Same guard, same reason. An override may bypass the credit gate but it must
  -- not be able to give one customer the same lead twice.
  if exists (
    select 1 from public.lead_assignments
    where lead_id = p_lead_id and customer_id = p_customer_id
  ) then
    raise exception 'Customer already has this lead'
      using detail = format('customer=%s lead=%s', p_customer_id, p_lead_id);
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
          management_lifetime_leads_received =
            management_lifetime_leads_received + 1,
          last_assignment_at = now(),
          updated_at = now()
      where id = p_customer_id;
  end if;

  return v_assignment_id;
end;
$function$;

-- Re-assert the ACL. `create or replace` preserves grants, unlike drop+create
-- (which is how get_next_customers_for_lead silently became anon-executable in
-- 0038 — see CLAUDE.md §11). Stated explicitly so the intended grants are
-- visible here rather than inherited invisibly.
revoke all on function public.assign_lead_to_customer(uuid, uuid, numeric, lead_type) from public, anon, authenticated;
revoke all on function public.admin_assign_lead(uuid, uuid, numeric, lead_type) from public, anon, authenticated;
grant execute on function public.assign_lead_to_customer(uuid, uuid, numeric, lead_type) to service_role;
grant execute on function public.admin_assign_lead(uuid, uuid, numeric, lead_type) to service_role;
