-- 0107_owned_lead_resale_guards.sql
--
-- Tightening, ahead of letting a customer's own lead be sold to one other
-- operator (0108). THIS MIGRATION ENABLES NOTHING. Every clause it adds either
--
--   * excludes the customer who UPLOADED a lead from receiving it — and they are
--     already excluded today, by the `not exists (lead_assignments …)` test that
--     every candidate function carries, because they hold their own assignment
--     row; or
--   * refuses an operation on an owned lead that is already refused today by
--     `lead_retired_from_allocation()`.
--
-- So it can be applied, verified to have changed nothing, and left sitting.
-- That is the whole reason it is separate from 0108. If the guards and the
-- relaxation landed together, a transcription slip in an exclusion clause would
-- go live at the same instant as the thing it is guarding against — and the
-- symptom would be a customer's private lead sold to a competitor, which is not
-- a bug you get to fix quietly.
--
-- WHY THE EXCLUSIONS BECOME NECESSARY AT ALL
--
-- Today the uploader is excluded from their own lead as a side effect: they
-- hold an assignment row for it, and every candidate function skips a customer
-- who already has one. `delete_owner_lead_copy` below breaks that. Once a lead
-- has been sold, deleting it outright would cascade away the BUYER's assignment,
-- notes and files — a lead they paid £15 for — so the uploader's delete removes
-- only their own copy, and their assignment row goes with it. From that moment
-- the incidental exclusion is gone and they are an ordinary candidate for their
-- own lead. Hence an explicit owner test, in all three candidate functions and
-- under the row lock in the money path.
--
-- THE CAP OF ONE, AND EVERY PLACE IT COULD BREAK
--
-- An owned lead reaches its uploader plus at most one other operator. Six paths
-- can raise or bypass `max_assignments`, and each is stopped here:
--
--   escalate_lead_assignment       raises the column by one — refused outright
--   get_escalation_candidates      feeds it — owned leads excluded explicitly,
--                                  NOT via lead_retired_from_allocation, which
--                                  0108 relaxes
--   get_reclaim_candidates         a reclaim slot is ADDED to max_assignments
--                                  inside assign_lead_to_customer
--   assign_lead_to_customer        caps owned leads at 2 under the lock, and
--                                  ignores reclaim slots for them
--   admin_swap_lead_assignment     rewrites max_assignments on the outgoing lead
--   discard_lead_assignment        decrements assignment_count, reopening a slot
--
-- Two more live outside SQL and are handled in the application: the contention
-- branch in `ingest.ts`, which writes max_assignments straight through
-- PostgREST, and the admin PATCH on /api/admin/leads/[id].
--
-- The pool is not on that list because owned leads never enter it:
-- `lead_pool_barred()` keeps its `owner_customer_id is not null` clause and 0108
-- deliberately does not relax it. `customer_can_see_pool_lead` still gains the
-- owner exclusion below — a second, independent bar that holds if the first is
-- ever loosened, and the one that answers "the uploader must never be offered
-- their own lead back; they already have it on their system".
--
-- EVERY FUNCTION BODY BELOW IS THE VERBATIM TEXT OF THE MIGRATION THAT OWNS IT,
-- with one clause added. The sources are:
--
--   0046  get_reclaim_candidates
--   0059  admin_swap_lead_assignment
--   0062  escalate_lead_assignment
--   0073  assign_lead_to_customer, get_escalation_candidates
--   0074  get_filtered_candidates_for_lead, get_unfiltered_candidates_for_lead,
--         get_next_customers_for_lead, customer_can_see_pool_lead,
--         discard_lead_assignment
--   0102  admin_assign_lead
--
-- They were copied programmatically rather than retyped, and each result was
-- diffed against its source to confirm the change is pure insertion — eleven
-- hand-copied bodies is eleven chances to silently revert an unrelated fix, and
-- §11 records that production has already drifted from these files once.
--
-- Grants are re-asserted after every definition. CREATE OR REPLACE preserves an
-- existing ACL, but the convention here is to state it anyway (the 0049 lesson,
-- where a DROP discarded one and left a routing function callable by anon).

-- ==========================================================================
-- 1. Candidate selection — the uploader is never a candidate
-- ==========================================================================
--
-- The three ranking queries that decide who a lead is offered to. All
-- three carry the same clause, written the same way, so a reader comparing them
-- can see at a glance that none was missed.

create or replace function public.get_filtered_candidates_for_lead(
  p_lead_id uuid,
  p_max integer,
  p_lead_type public.lead_type default 'management'
)
returns table (customer_id uuid, priority_score numeric)
language sql
security definer
set search_path = public
as $$
  with l as (
    select
      postcode_area as area,
      nullif(substring(coalesce(bedrooms, '') from '\d+'), '')::int as bed
    from public.leads
    where id = p_lead_id
  )
  select
    c.id,
    case
      when p_lead_type = 'guaranteed_rent' then
        round(
          (least(greatest(
            extract(day from now() - coalesce(c.gr_billing_cycle_anchor, c.created_at::date)),
            0), 30) / 30.0)
          * public.effective_allocation(c.gr_monthly_allocation, c.gr_pool_debit)
        ) - c.gr_leads_received_this_month
      else
        round(
          (least(greatest(
            extract(day from now() - coalesce(c.billing_cycle_anchor, c.created_at::date)),
            0), 30) / 30.0)
          * public.effective_allocation(c.monthly_allocation, c.pool_debit)
        ) - c.leads_received_this_month
    end as priority_score
  from public.customers c, l
  where not public.lead_retired_from_allocation(p_lead_id)
    and c.is_active = true
    and l.area is not null
    and l.bed is not null
    and not exists (
      select 1 from public.lead_assignments la
      where la.lead_id = p_lead_id and la.customer_id = c.id
    )
    -- The customer who UPLOADED a lead is never a candidate for it: they
    -- already have it on their own system. Their own assignment row used to
    -- cover this through the `not exists` above, but delete-own-copy (0107)
    -- lets them remove that row while the lead lives on with its buyer — so
    -- without this clause they would become eligible for their own lead.
    -- `is distinct from` leaves marketplace leads (owner null) untouched.
    and c.id is distinct from (
      select l_owner.owner_customer_id
      from public.leads l_owner
      where l_owner.id = p_lead_id
    )
    and (
      (
        p_lead_type = 'management'
        and c.account_status = 'active'
        and c.subscription_status = 'active'
        and c.lead_balance > 0
        and c.paused_at is null
        and c.filter_status in ('active', 'pending_lift')
        and (
          c.filter_areas is null
          or array_length(c.filter_areas, 1) is null
          or l.area = any (c.filter_areas)
        )
        and (c.filter_min_bedrooms is null or l.bed >= c.filter_min_bedrooms)
        and (c.filter_max_bedrooms is null or l.bed <= c.filter_max_bedrooms)
      )
      or
      (
        p_lead_type = 'guaranteed_rent'
        and c.gr_subscription_status = 'active'
        and c.gr_lead_balance > 0
        and c.gr_filter_status in ('active', 'pending_lift')
        and (
          c.gr_filter_areas is null
          or array_length(c.gr_filter_areas, 1) is null
          or l.area = any (c.gr_filter_areas)
        )
        and (c.gr_filter_min_bedrooms is null or l.bed >= c.gr_filter_min_bedrooms)
        and (c.gr_filter_max_bedrooms is null or l.bed <= c.gr_filter_max_bedrooms)
      )
    )
  order by
    priority_score desc,
    case when p_lead_type = 'guaranteed_rent' then c.gr_last_assignment_at
         else c.last_assignment_at end asc nulls first,
    c.created_at asc
  limit p_max;
$$;

revoke execute on function public.get_filtered_candidates_for_lead(uuid, integer, public.lead_type) from public, anon, authenticated;
grant execute on function public.get_filtered_candidates_for_lead(uuid, integer, public.lead_type) to service_role;

create or replace function public.get_unfiltered_candidates_for_lead(
  p_lead_id uuid,
  p_max integer,
  p_lead_type public.lead_type default 'management'
)
returns table (customer_id uuid, deficit numeric)
language sql
security definer
set search_path = public
as $$
  select
    c.id,
    case
      when p_lead_type = 'guaranteed_rent' then
        round(
          (least(greatest(
            extract(day from now() - coalesce(c.gr_billing_cycle_anchor, c.created_at::date)),
            0), 30) / 30.0)
          * public.effective_allocation(c.gr_monthly_allocation, c.gr_pool_debit)
        ) - c.gr_leads_received_this_month
      else
        round(
          (least(greatest(
            extract(day from now() - coalesce(c.billing_cycle_anchor, c.created_at::date)),
            0), 30) / 30.0)
          * public.effective_allocation(c.monthly_allocation, c.pool_debit)
        ) - c.leads_received_this_month
    end as deficit
  from public.customers c
  where not public.lead_retired_from_allocation(p_lead_id)
    and c.is_active = true
    and not exists (
      select 1 from public.lead_assignments la
      where la.lead_id = p_lead_id and la.customer_id = c.id
    )
    -- The customer who UPLOADED a lead is never a candidate for it: they
    -- already have it on their own system. Their own assignment row used to
    -- cover this through the `not exists` above, but delete-own-copy (0107)
    -- lets them remove that row while the lead lives on with its buyer — so
    -- without this clause they would become eligible for their own lead.
    -- `is distinct from` leaves marketplace leads (owner null) untouched.
    and c.id is distinct from (
      select l_owner.owner_customer_id
      from public.leads l_owner
      where l_owner.id = p_lead_id
    )
    and (
      (
        p_lead_type = 'management'
        and c.account_status = 'active'
        and c.subscription_status = 'active'
        and c.lead_balance > 0
        and c.paused_at is null
        and c.filter_status = 'off'
      )
      or (
        p_lead_type = 'guaranteed_rent'
        and c.gr_subscription_status = 'active'
        and c.gr_lead_balance > 0
        and c.gr_filter_status = 'off'
      )
    )
  order by
    deficit desc,
    case when p_lead_type = 'guaranteed_rent' then c.gr_last_assignment_at
         else c.last_assignment_at end asc nulls first,
    c.created_at asc
  limit p_max;
$$;

revoke execute on function public.get_unfiltered_candidates_for_lead(uuid, integer, public.lead_type) from public, anon, authenticated;
grant execute on function public.get_unfiltered_candidates_for_lead(uuid, integer, public.lead_type) to service_role;

create or replace function public.get_next_customers_for_lead(
  p_lead_id uuid,
  p_max integer,
  p_exclude_customer_ids uuid[] default '{}'::uuid[],
  p_lead_type public.lead_type default 'management'
)
returns table (customer_id uuid)
language sql
security definer
set search_path = public
as $$
  select c.id
  from public.customers c
  where not public.lead_retired_from_allocation(p_lead_id)
    and c.is_active = true
    and not (c.id = any (coalesce(p_exclude_customer_ids, '{}'::uuid[])))
    and not exists (
      select 1 from public.lead_assignments la
      where la.lead_id = p_lead_id
        and la.customer_id = c.id
    )
    -- The customer who UPLOADED a lead is never a candidate for it: they
    -- already have it on their own system. Their own assignment row used to
    -- cover this through the `not exists` above, but delete-own-copy (0107)
    -- lets them remove that row while the lead lives on with its buyer — so
    -- without this clause they would become eligible for their own lead.
    -- `is distinct from` leaves marketplace leads (owner null) untouched.
    and c.id is distinct from (
      select l_owner.owner_customer_id
      from public.leads l_owner
      where l_owner.id = p_lead_id
    )
    and (
      (
        p_lead_type = 'management'
        and c.account_status = 'active'
        and c.subscription_status = 'active'
        and c.lead_balance > 0
        and c.paused_at is null
      )
      or (
        p_lead_type = 'guaranteed_rent'
        and c.gr_subscription_status = 'active'
        and c.gr_lead_balance > 0
      )
    )
  order by
    case
      when p_lead_type = 'guaranteed_rent' then
        round(
          (least(greatest(
            extract(day from now() - coalesce(c.gr_billing_cycle_anchor, c.created_at::date)),
            0), 30) / 30.0)
          * public.effective_allocation(c.gr_monthly_allocation, c.gr_pool_debit)
        ) - c.gr_leads_received_this_month
      else
        round(
          (least(greatest(
            extract(day from now() - coalesce(c.billing_cycle_anchor, c.created_at::date)),
            0), 30) / 30.0)
          * public.effective_allocation(c.monthly_allocation, c.pool_debit)
        ) - c.leads_received_this_month
    end desc,
    case
      when p_lead_type = 'guaranteed_rent' then c.gr_last_assignment_at
      else c.last_assignment_at
    end asc nulls first,
    c.created_at asc
  limit p_max;
$$;

revoke execute on function public.get_next_customers_for_lead(uuid, integer, uuid[], public.lead_type) from public, anon, authenticated;
grant execute on function public.get_next_customers_for_lead(uuid, integer, uuid[], public.lead_type) to service_role;

-- ==========================================================================
-- 2. Pool visibility — shared by the listing and the claim
-- ==========================================================================
--
-- One definition, called by get_customer_pool_leads AND by
-- claim_pool_lead before it locks and inserts (§19.4), so a lead can never be
-- listed to somebody the claim would then refuse.

create or replace function public.customer_can_see_pool_lead(
  p_lead_id     uuid,
  p_customer_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.leads l, public.customers c
    where l.id = p_lead_id
      and c.id = p_customer_id
      and l.pool_entered_at is not null
      and l.pool_expired_at is null
      and c.is_active = true
      and (
        (l.lead_type = 'management'
          and c.subscription_status = 'active'
          and c.paused_at is null)
        or
        (l.lead_type = 'guaranteed_rent'
          and c.gr_subscription_status = 'active')
      )
      and not exists (
        select 1 from public.lead_assignments la
        where la.lead_id = p_lead_id and la.customer_id = p_customer_id
      )
      -- The uploader of a lead never sees it in their own pool. They already
      -- have it on their system, so offering it back is nonsense at best and a
      -- second charge for their own data at worst. claim_pool_lead calls this
      -- same function before it locks and inserts, so one clause covers the
      -- listing and the claim (§19.4's single definition).
      --
      -- Owned leads should never reach the pool at all — lead_pool_barred keeps
      -- them out and 0108 deliberately does not relax it — so this is the second
      -- of two independent bars, and the one that still holds if the first is
      -- ever loosened.
      and c.id is distinct from l.owner_customer_id
      and public.lead_matches_customer_filter(p_lead_id, p_customer_id, l.lead_type)
  );
$$;

revoke execute on function public.customer_can_see_pool_lead(uuid, uuid) from public, anon, authenticated;
grant execute on function public.customer_can_see_pool_lead(uuid, uuid) to service_role;

-- ==========================================================================
-- 3. The money paths — under the row lock
-- ==========================================================================
--
-- The candidate functions are ranking queries; these are where a
-- lead is actually handed over, and they are the only place the check happens
-- while the row is locked.

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

revoke execute on function public.assign_lead_to_customer(uuid, uuid, numeric, public.lead_type) from public, anon, authenticated;
grant execute on function public.assign_lead_to_customer(uuid, uuid, numeric, public.lead_type) to service_role;

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

revoke execute on function public.admin_assign_lead(uuid, uuid, numeric, public.lead_type) from public, anon, authenticated;
grant execute on function public.admin_assign_lead(uuid, uuid, numeric, public.lead_type) to service_role;

-- ==========================================================================
-- 4. The paths that would raise the cap
-- ==========================================================================
--
-- Escalation and soft reclaim both widen a lead's reach — one by
-- incrementing max_assignments, the other by adding a derived slot on top of it
-- inside assign_lead_to_customer. Owned leads are excluded from both, at the
-- candidate query and again at the function that does the writing.

create or replace function public.get_escalation_candidates(
  p_cutoff       timestamptz,
  p_stage        integer,
  p_min_age_days integer
)
returns table (
  assignment_id   uuid,
  lead_id         uuid,
  customer_id     uuid,
  lead_type       public.lead_type,
  assigned_at     timestamptz,
  max_assignments integer,
  lead_age_days   integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    la.id,
    la.lead_id,
    la.customer_id,
    l.lead_type,
    la.assigned_at,
    l.max_assignments,
    (extract(epoch from now() - la.assigned_at) / 86400)::integer
  from public.lead_assignments la
  join public.leads l on l.id = la.lead_id
  where
    la.assigned_at > p_cutoff
    and la.assigned_at <= now() - make_interval(days => p_min_age_days)
    and la.inactivity_escalation_stage = p_stage - 1
    and la.status not in ('won', 'rejected')
    and l.max_assignments < 5
    -- Owned leads never escalate, and this clause is REQUIRED rather than
    -- precautionary. The gate beside it is lead_retired_from_allocation, which
    -- 0108 relaxes for a qualified lead — leaving only `max_assignments < 5`,
    -- which a qualified lead at 2 satisfies. Without this, the day-10 rung would
    -- take it to 3 and the day-20 rung to 4, breaching the cap of one through
    -- the single path that raises that column by design.
    and l.owner_customer_id is null

    -- The lead has passed to the pool (or been claimed out of it). Escalation
    -- and the pool are two routes to the same place; a lead must not travel
    -- both.
    and not public.lead_retired_from_allocation(la.lead_id)
    and l.pool_entered_at is null

    -- This operator has filed the lead. Escalating it would be chasing them
    -- about a lead they have already told us the outcome of.
    and la.closed_at is null

    -- ANY operator has reported the landlord as done. Selling a lead that has
    -- already said no is how a lead source earns a bad name — and it is exactly
    -- the outcome this whole feature exists to avoid.
    and not exists (
      select 1 from public.lead_assignments closed
      where closed.lead_id = la.lead_id
        and closed.closed_at is not null
    );
$$;

revoke execute on function public.get_escalation_candidates(timestamptz, integer, integer) from public, anon, authenticated;
grant execute on function public.get_escalation_candidates(timestamptz, integer, integer) to service_role;

create or replace function public.get_reclaim_candidates(
  p_cutoff        timestamptz,
  p_min_age_days  integer default 3
)
returns table (
  assignment_id uuid,
  lead_id       uuid,
  customer_id   uuid,
  lead_type     public.lead_type,
  assigned_at   timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select la.id, la.lead_id, la.customer_id, l.lead_type, la.assigned_at
  from public.lead_assignments la
  join public.leads l on l.id = la.lead_id
  where
    -- Never retroactive.
    la.assigned_at > p_cutoff
    and la.assigned_at <= now() - make_interval(days => p_min_age_days)

    -- The original assignment only; a reclaimed copy is never re-reclaimed.
    and la.is_reclaimed = false
    and la.reclaimed_at is null

    -- Once per lead, EVER: no assignment of this lead has ever been reclaimed.
    and not exists (
      select 1 from public.lead_assignments prior
      where prior.lead_id = la.lead_id
        and (prior.reclaimed_at is not null or prior.is_reclaimed)
    )

    -- Untouched: the operator has done nothing with it. status is deliberately
    -- NOT the test — it is self-reported. These are the passive signals.
    and not exists (
      select 1 from public.lead_events e
      where e.assignment_id = la.id
        and e.event_type in ('detail_opened', 'tel_click', 'mailto_click')
    )
    and not exists (
      select 1 from public.lead_notes n where n.lead_assignment_id = la.id
    )
    and not exists (
      select 1 from public.lead_files f where f.lead_assignment_id = la.id
    )

    -- A rejected lead has been consciously passed on and is settled under 0019
    -- (chargeable, no replacement). Reclaiming it would contradict that, so it
    -- is left alone. Flagged for review — resale may in fact be the right
    -- outcome for a rejected lead, but that is a pricing decision, not a bug.
    and la.status <> 'rejected'

    -- Still capacity-bound in the ordinary sense.
    -- Soft reclaim is retired (§7) and its functions are kept only so the rows
    -- carrying reclaim columns keep their meaning. Excluded here anyway,
    -- because a reclaim SLOT is added on top of max_assignments inside
    -- assign_lead_to_customer — so a granted slot would put an owned lead at
    -- three holders through a path nobody is watching any more.
    and l.owner_customer_id is null
    and l.assignment_count >= l.max_assignments;
$$;

revoke execute on function public.get_reclaim_candidates(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.get_reclaim_candidates(timestamptz, integer) to service_role;

create or replace function public.escalate_lead_assignment(
  p_assignment_id   uuid,
  p_new_customer_id uuid,
  p_price           numeric,
  p_lead_type       public.lead_type,
  p_stage           integer
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_original      public.lead_assignments%rowtype;
  v_lead          public.leads%rowtype;
  v_new_assignment_id uuid;
begin
  if p_stage not in (1, 2) then
    raise exception 'Escalation stage must be 1 or 2, got %', p_stage;
  end if;

  select * into v_original from public.lead_assignments
    where id = p_assignment_id for update;
  if not found then
    raise exception 'Assignment % not found', p_assignment_id;
  end if;

  if v_original.inactivity_escalation_stage <> p_stage - 1 then
    raise exception 'Assignment % is at escalation stage %, cannot fire stage %',
      p_assignment_id, v_original.inactivity_escalation_stage, p_stage;
  end if;

  -- Re-assert eligibility under the lock. status is what can genuinely change
  -- between the sweep and here — an operator winning or rejecting the lead in
  -- that window settles it, and a settled lead must not be escalated out from
  -- under them. Engagement itself is not re-scored here: the window is ten days
  -- wide, so a signal arriving in the seconds between the sweep and this call
  -- cannot meaningfully change the answer, and re-scoring under a row lock would
  -- hold it for the length of the score query.
  if v_original.status in ('won', 'rejected') then
    raise exception 'Assignment % is settled (status %) and cannot be escalated',
      p_assignment_id, v_original.status;
  end if;

  select * into v_lead from public.leads
    where id = v_original.lead_id for update;

  -- Owned leads never escalate. get_escalation_candidates already excludes
  -- them, but this is the function that actually writes max_assignments + 1,
  -- and a caller reaching it with an id from anywhere else must not get past.
  if v_lead.owner_customer_id is not null then
    raise exception 'Lead % was added by a customer and cannot be escalated',
      v_original.lead_id;
  end if;

  if v_lead.max_assignments >= 5 then
    raise exception 'Lead % is at the escalation ceiling (max_assignments = %)',
      v_original.lead_id, v_lead.max_assignments;
  end if;

  update public.leads
    set max_assignments = v_lead.max_assignments + 1
    where id = v_original.lead_id;

  -- Standard assignment path, no bypass: same capacity check, same per-product
  -- balance gate, same credit spend, same monthly counter, same odometer bump.
  v_new_assignment_id := public.assign_lead_to_customer(
    v_original.lead_id, p_new_customer_id, p_price, p_lead_type
  );

  update public.lead_assignments
    set inactivity_escalation_stage = p_stage,
        escalation_stage_1_at = case when p_stage = 1 then now()
                                     else escalation_stage_1_at end,
        escalation_stage_2_at = case when p_stage = 2 then now()
                                     else escalation_stage_2_at end
    where id = p_assignment_id;

  return v_new_assignment_id;
end;
$$;

revoke execute on function public.escalate_lead_assignment(uuid, uuid, numeric, public.lead_type, integer) from public, anon, authenticated;
grant execute on function public.escalate_lead_assignment(uuid, uuid, numeric, public.lead_type, integer) to service_role;

-- ==========================================================================
-- 5. The paths that would reopen a slot
-- ==========================================================================
--
-- A swap rewrites max_assignments on the lead it swaps out; a
-- discard decrements assignment_count. Either one, applied to a lead already
-- sold to its single buyer, puts it back under its cap with nothing recording
-- that it has been sold — and ordinary routing sells it again.

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

  -- Neither side of a swap may be a customer's own lead, and the two directions
  -- are refused for different reasons.
  --
  -- Swapping one OUT rewrites max_assignments to assignment_count further down,
  -- which would silently un-qualify a lead already sold to its one buyer and
  -- reopen the slot. Swapping one IN hands somebody else's private lead to a
  -- customer, which is the thing §32's cap exists to bound.
  if v_old_lead.owner_customer_id is not null then
    raise exception 'Lead % was added by a customer and cannot be swapped out',
      v_old.lead_id;
  end if;

  if v_new_lead.owner_customer_id is not null then
    raise exception 'Lead % was added by a customer and cannot be swapped in',
      p_new_lead_id;
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

revoke execute on function public.admin_swap_lead_assignment(uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_swap_lead_assignment(uuid, uuid) to service_role;

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
  v_notes   integer;
  v_claimed timestamptz;
begin
  select lead_id, status, claimed_from_pool_at
    into v_lead_id, v_status, v_claimed
    from public.lead_assignments
    where id = p_lead_assignment_id
    for update;

  if not found then
    raise exception 'Assignment % not found', p_lead_assignment_id;
  end if;

  -- Discard is refused on an owned lead, for BOTH parties, and the reasons
  -- differ.
  --
  -- For the uploader: discard deletes the assignment row, which is the only
  -- thing making the lead visible to them under leads_select_assigned. They
  -- would be left with a row they own, cannot see, and cannot reach the delete
  -- control for. `DELETE /api/customer/my-leads/[id]` is the verb for a lead
  -- you own.
  --
  -- For the BUYER of a resold lead: discard decrements assignment_count, which
  -- reopens the slot while nothing records that the lead has already been sold
  -- once — so ordinary routing would sell it a second time and the cap of one
  -- would be breached by the single path that destroys the evidence (§19.6's
  -- argument, in its original form). They have reject and close instead.
  if exists (
    select 1 from public.leads l
    where l.id = v_lead_id and l.owner_customer_id is not null
  ) then
    raise exception 'Assignment % is on a customer-added lead and cannot be discarded',
      p_lead_assignment_id;
  end if;

  if v_status <> 'new' then
    raise exception 'Assignment % is not discardable (status = %)',
      p_lead_assignment_id, v_status;
  end if;

  select count(*) into v_notes
    from public.lead_notes
    where lead_assignment_id = p_lead_assignment_id;

  if v_notes > 0 then
    raise exception 'Assignment % has notes and cannot be discarded',
      p_lead_assignment_id;
  end if;

  delete from public.lead_assignments where id = p_lead_assignment_id;

  -- Only an ordinary assignment returns its slot.
  if v_claimed is null then
    update public.leads
      set assignment_count = greatest(assignment_count - 1, 0)
      where id = v_lead_id;
  else
    -- The lead stays retired. pool_expired_at is what carries that now the
    -- claim marker has gone with the row: it bars re-entry to the pool
    -- (lead_pool_barred) and retires it from allocation
    -- (lead_retired_from_allocation) in one column.
    update public.leads
      set pool_expired_at = coalesce(pool_expired_at, now())
      where id = v_lead_id;
  end if;
end;
$$;

revoke execute on function public.discard_lead_assignment(uuid) from public, anon, authenticated;
grant execute on function public.discard_lead_assignment(uuid) to service_role;

-- ==========================================================================
-- 6. Deleting a lead you uploaded, once somebody else holds it
-- ==========================================================================
--
-- `DELETE /api/customer/my-leads/[id]` currently removes the `leads` row and
-- lets the 0001 cascade take everything hanging off it. That is right while the
-- uploader is the only holder — nothing was charged and it was never offered to
-- anyone — and it becomes destructive the moment the lead has been sold: the
-- cascade would take the BUYER's assignment, their notes, their files and their
-- events, for a lead they paid £15 for.
--
-- So delete has two modes, and this function is where the choice is made.
--
-- IT IS AN RPC BECAUSE OF THE LOCK. Reading "does anyone else hold this?" in
-- TypeScript and then deleting lets a resale land in between, and the route then
-- destroys a lead somebody bought a moment earlier. The lead row is locked
-- before the question is asked.
--
-- Two things it deliberately does NOT do when it removes only the copy:
--
--   * `assignment_count` is not decremented. §19.6's argument, exactly: the
--     freed slot would outlive the deleted row, so ordinary routing would top
--     the lead back up to its cap and sell it a second time — breaching the cap
--     of one through the single path that also destroys the evidence.
--   * `owner_customer_id` is not nulled. It is the provenance, and it is what
--     `get_filtered_candidates_for_lead` and friends read to make sure the lead
--     is never sold back to the person who uploaded it. Clearing it would turn
--     their own lead into an ordinary marketplace lead they are eligible for.
--
-- The uploader loses sight of the lead through the existing
-- `leads_select_assigned` RLS policy (0014), which exposes a lead only where an
-- assignment joins it to the caller. That is the intended effect and needs no
-- new policy.
--
-- Returns 'lead_deleted', 'copy_deleted' or 'not_found'. The caller maps
-- 'not_found' onto the same indistinguishable 404 it already returns for a lead
-- that does not exist and for one belonging to somebody else, so the endpoint
-- cannot be used to discover which leads exist.

create or replace function public.delete_owner_lead_copy(
  p_lead_id     uuid,
  p_customer_id uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner  uuid;
  v_others integer;
begin
  select owner_customer_id into v_owner
    from public.leads
    where id = p_lead_id
    for update;

  -- One answer for "no such lead", "not yours" and "not an owned lead". The
  -- caller cannot tell them apart and neither can anybody probing it.
  if not found or v_owner is null or v_owner <> p_customer_id then
    return 'not_found';
  end if;

  select count(*) into v_others
    from public.lead_assignments
    where lead_id = p_lead_id
      and customer_id <> p_customer_id;

  if v_others > 0 then
    -- Somebody bought this. Take the uploader's copy only; their notes, files,
    -- events and notifications go with their assignment row by cascade.
    delete from public.lead_assignments
      where lead_id = p_lead_id
        and customer_id = p_customer_id;

    return 'copy_deleted';
  end if;

  -- Nobody else holds it, so there is nothing to preserve. The 0001 cascade
  -- takes the assignment, notes, files, events and notifications.
  delete from public.leads where id = p_lead_id;

  return 'lead_deleted';
end;
$$;

revoke execute on function public.delete_owner_lead_copy(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_owner_lead_copy(uuid, uuid) to service_role;

