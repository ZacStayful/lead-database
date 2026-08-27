-- ==========================================================================
-- 0110 — ADMIN FORCE-ASSIGN MUST RESPECT THE CUSTOMER'S LEAD FILTER
-- ==========================================================================
--
-- 0109 closed the swap. This closes the last two routes that can put a lead in
-- front of a customer who filtered it out: POST /api/admin/assign and
-- /api/admin/assign/bulk. Both send the ordinary new-lead email and text, so
-- the customer cannot tell a force-assign from a lead the engine chose for
-- them — the same argument 0109 makes about a replacement.
--
-- ---------------------------------------------------------------------------
-- §1 — BOTH ROUTES TAKE TWO PATHS, AND ONLY GUARDING ONE CLOSES HALF THE HOLE
-- ---------------------------------------------------------------------------
-- Each route branches on `override`:
--
--   override = false  ->  assign_lead_to_customer   (spends a credit)
--   override = true   ->  admin_assign_lead         (bypasses the credit gate)
--
-- So the guard goes in both.
--
-- ---------------------------------------------------------------------------
-- §2 — WHY THE GUARD SITS INSIDE THE MONEY PATH, AND WHY THAT IS INERT
-- ---------------------------------------------------------------------------
-- assign_lead_to_customer is the single money path, and this puts the filter
-- rule under its row lock — exactly where invariant 11 already asserts
-- lead_retired_from_allocation, and for the same stated reason: it is the only
-- place under a lock, and anything that acquires a lead id from elsewhere
-- arrives here.
--
-- It is a NO-OP for every automatic path, and that is a claim to verify rather
-- than assert:
--
--   * get_filtered_candidates_for_lead inlines this same predicate, so every
--     candidate it returns already passes.
--   * get_unfiltered_candidates_for_lead selects filter_status = 'off'
--     customers, and lead_matches_customer_filter returns TRUE for them — no
--     filter is not an empty filter. That is what keeps a lead with an
--     unparseable postcode or bedroom count flowing to the unfiltered pool.
--   * Inactivity escalation routes through those same two pools.
--   * claim_pool_lead does not call this function at all, and checks the filter
--     itself through customer_can_see_pool_lead (§19.4).
--
-- ---------------------------------------------------------------------------
-- §3 — ⚠️  NEITHER NEW ARGUMENT HAS A DEFAULT, AND THAT IS LOAD-BEARING
-- ---------------------------------------------------------------------------
-- The same trap 0109 records, and it bites harder here: both functions ALREADY
-- carry `p_lead_type ... default 'management'`. A defaulted fifth argument
-- would therefore make every four-argument call — including the ones running in
-- production right now — fail with "function is not unique".
--
-- With no default on the new argument, a five-argument call resolves only to
-- the new function and a three- or four-argument call only to the old one. The
-- four-argument forms are kept as shims delegating FALSE, which is what lets
-- this migration land ahead of the code: ingest, escalation, the sync top-up
-- and both admin routes keep working the moment it applies, enforcing the
-- filter with no override.
--
-- ---------------------------------------------------------------------------
-- §4 — allow_filter_mismatch IS NOT `override`
-- ---------------------------------------------------------------------------
-- `override` means "bypass the credit gate". This means "bypass what the
-- customer asked for". They are separate flags because folding them would make
-- every credit override silently a filter override too — and the credit
-- override is the routine one.
-- ==========================================================================


-- ---------------------------------------------------------------------------
-- 1 — assign_lead_to_customer, with the filter guard
--
-- Body reproduced from 0107 with one clause inserted, per this repo's
-- convention for redefining a function.
-- ---------------------------------------------------------------------------
create or replace function public.assign_lead_to_customer(
  p_lead_id uuid,
  p_customer_id uuid,
  p_price numeric,
  p_lead_type lead_type,
  p_allow_filter_mismatch boolean
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

  -- The uploader is never sold their own lead. The duplicate check above
  -- catches this only while they still hold their assignment row, and
  -- delete-own-copy (0107) is exactly the case where they do not.
  if v_lead.owner_customer_id is not null
     and v_lead.owner_customer_id = p_customer_id then
    raise exception 'Lead % was added by customer % and cannot be sold back to them',
      p_lead_id, p_customer_id;
  end if;

  -- Invariant 7, asserted at the money path as well as in the ranking queries.
  -- The candidate functions already exclude these leads, but this is the only
  -- place that is under a row lock, and admin_assign_lead is not the only other
  -- caller — anything that acquires a lead id from elsewhere arrives here.
  if public.lead_retired_from_allocation(p_lead_id) then
    raise exception 'Lead % has passed to the expired leads pool and cannot be allocated',
      p_lead_id;
  end if;

  -- Capacity = ordinary cap + any reclaim slot granted and not yet consumed.
  v_capacity := v_lead.max_assignments
                + public.lead_open_reclaim_slots(p_lead_id);

  -- A customer's own lead reaches the uploader plus AT MOST ONE other operator,
  -- and that ceiling is absolute (§32). Two things are asserted here rather
  -- than trusted:
  --
  --   * `least(..., 2)` — max_assignments is writable from admin and from the
  --     contention branch in ingest.ts, neither of which is under this lock.
  --   * reclaim slots are ignored entirely. They are added to capacity above,
  --     so a lead carrying one would otherwise reach three.
  if v_lead.owner_customer_id is not null then
    v_capacity := least(v_lead.max_assignments, 2);
  end if;

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

  -- 0110. The customer chose which leads they want. lead_matches_customer_filter
  -- is the same predicate allocation, the pool and the swap use, and it returns
  -- true for an unfiltered customer -- so this is inert for anyone who has not
  -- set a filter, and inert for automatic routing, whose candidates have already
  -- passed it.
  --
  -- coalesce, not a bare NOT: a null must read as "does not match", never as
  -- permission. Both rows are locked and proven to exist above, so it cannot be
  -- null in practice; failing open is simply not the direction to fail in here.
  if not p_allow_filter_mismatch
     and not coalesce(
       public.lead_matches_customer_filter(p_lead_id, p_customer_id, p_lead_type),
       false)
  then
    raise exception 'Lead % does not match customer %''s lead filter',
      p_lead_id, p_customer_id;
  end if;

  insert into public.lead_assignments (lead_id, customer_id, price_paid)
    values (p_lead_id, p_customer_id, p_price)
    returning id into v_assignment_id;

  update public.leads
    set assignment_count = assignment_count + 1,
        -- Placed, so it is no longer open stock. Only ever true of the
        -- 'unassigned' basis: the 'ignored' basis is terminal and the guard
        -- above has already refused it.
        pool_entered_at  = case when pool_entry_basis = 'unassigned'
                                then null else pool_entered_at end,
        pool_entry_basis = case when pool_entry_basis = 'unassigned'
                                then null else pool_entry_basis end
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
revoke execute on function public.assign_lead_to_customer(uuid, uuid, numeric, public.lead_type, boolean)
  from public, anon, authenticated;
grant execute on function public.assign_lead_to_customer(uuid, uuid, numeric, public.lead_type, boolean)
  to service_role;


-- ---------------------------------------------------------------------------
-- 2 — The four-argument shim. Never overrides.
--
-- Every existing caller — ingest, escalation, the sync top-up path, the two
-- admin routes — lands here and gets the guard without changing.
-- ---------------------------------------------------------------------------
create or replace function public.assign_lead_to_customer(
  p_lead_id uuid,
  p_customer_id uuid,
  p_price numeric,
  p_lead_type lead_type default 'management'::lead_type
)
returns uuid
language sql
security definer
set search_path to 'public'
as $$
  select public.assign_lead_to_customer(
    p_lead_id, p_customer_id, p_price, p_lead_type, false);
$$;

revoke execute on function public.assign_lead_to_customer(uuid, uuid, numeric, public.lead_type)
  from public, anon, authenticated;
grant execute on function public.assign_lead_to_customer(uuid, uuid, numeric, public.lead_type)
  to service_role;


-- ---------------------------------------------------------------------------
-- 3 — admin_assign_lead, same insertion, same shim
-- ---------------------------------------------------------------------------
create or replace function public.admin_assign_lead(
  p_lead_id uuid,
  p_customer_id uuid,
  p_price numeric,
  p_lead_type lead_type,
  p_allow_filter_mismatch boolean
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

  -- A customer's own lead belongs to them. There is no override for this: it
  -- was never ours to sell, and handing it to a competitor is the one outcome
  -- the whole feature must make impossible.
  -- Named separately from the refusal below so the error says what is actually
  -- wrong. An admin trying to hand a customer their OWN lead has made a
  -- different mistake from one trying to hand it to somebody else.
  if v_lead.owner_customer_id is not null
     and v_lead.owner_customer_id = p_customer_id then
    raise exception 'Customer % already owns lead %', p_customer_id, p_lead_id;
  end if;

  if v_lead.owner_customer_id is not null then
    raise exception 'Lead % was added by a customer and cannot be assigned to anyone else',
      p_lead_id
      using detail = format('owner=%s source=%s', v_lead.owner_customer_id, v_lead.owner_source);
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

  -- 0110. The customer chose which leads they want. lead_matches_customer_filter
  -- is the same predicate allocation, the pool and the swap use, and it returns
  -- true for an unfiltered customer -- so this is inert for anyone who has not
  -- set a filter, and inert for automatic routing, whose candidates have already
  -- passed it.
  --
  -- coalesce, not a bare NOT: a null must read as "does not match", never as
  -- permission. Both rows are locked and proven to exist above, so it cannot be
  -- null in practice; failing open is simply not the direction to fail in here.
  if not p_allow_filter_mismatch
     and not coalesce(
       public.lead_matches_customer_filter(p_lead_id, p_customer_id, p_lead_type),
       false)
  then
    raise exception 'Lead % does not match customer %''s lead filter',
      p_lead_id, p_customer_id;
  end if;

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
revoke execute on function public.admin_assign_lead(uuid, uuid, numeric, public.lead_type, boolean)
  from public, anon, authenticated;
grant execute on function public.admin_assign_lead(uuid, uuid, numeric, public.lead_type, boolean)
  to service_role;


-- ---------------------------------------------------------------------------
-- 4 — The four-argument shim for the override path.
-- ---------------------------------------------------------------------------
create or replace function public.admin_assign_lead(
  p_lead_id uuid,
  p_customer_id uuid,
  p_price numeric,
  p_lead_type lead_type default 'management'::lead_type
)
returns uuid
language sql
security definer
set search_path to 'public'
as $$
  select public.admin_assign_lead(
    p_lead_id, p_customer_id, p_price, p_lead_type, false);
$$;

revoke execute on function public.admin_assign_lead(uuid, uuid, numeric, public.lead_type)
  from public, anon, authenticated;
grant execute on function public.admin_assign_lead(uuid, uuid, numeric, public.lead_type)
  to service_role;


-- ---------------------------------------------------------------------------
-- 5 — Which of these customers does this lead's filter reach?
--
-- The admin lead page offers ONE lead to MANY customers, so the filter question
-- is per customer and worth answering inline rather than letting the assign
-- fail. Answering it in TypeScript would be a fifth hand-written copy of the
-- predicate — the trap 0109 avoided with get_swap_candidates_for_assignment —
-- so it is a function, and one round trip for the whole list.
--
-- A customer with no active filter on this product comes back TRUE, which is
-- what lets the picker fall back to its pre-0110 rendering with no extra
-- branch. An id that does not resolve to a customer is simply absent.
-- ---------------------------------------------------------------------------
create or replace function public.customers_matching_lead_filter(
  p_lead_id      uuid,
  p_customer_ids uuid[]
)
returns table (customer_id uuid, matches boolean)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.id,
    coalesce(
      public.lead_matches_customer_filter(l.id, c.id, l.lead_type),
      false
    )
  from public.leads l
  join public.customers c on c.id = any (p_customer_ids)
  where l.id = p_lead_id;
$$;

revoke execute on function public.customers_matching_lead_filter(uuid, uuid[])
  from public, anon, authenticated;
grant execute on function public.customers_matching_lead_filter(uuid, uuid[])
  to service_role;
