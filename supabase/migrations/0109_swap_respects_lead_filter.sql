-- ==========================================================================
-- 0109 — A SWAPPED-IN LEAD MUST MATCH THE CUSTOMER'S LEAD FILTER
-- ==========================================================================
--
-- Every other route a lead can reach a customer by honours their filter:
-- ordinary allocation through get_filtered_candidates_for_lead, inactivity
-- escalation through the same function, and the expired pool through
-- customer_can_see_pool_lead. The admin swap did not. Its guards stopped at
-- won / duplicate / capacity / paused / product / customer-owned, so a
-- customer who filtered to "3+ beds in BS, GL" — and was quoted a volume
-- forecast and a cost per lead on exactly that selection (CLAUDE.md §28) —
-- could be handed a one-bed in Sheffield as a replacement, and would get the
-- ordinary new-lead email and text for it.
--
-- A swap IS a delivery from the customer's side. It calls the same
-- completeAssignment as ingest and the admin force-assign, and the customer
-- has no way to tell a replacement from any other lead. So it has to obey the
-- same rule.
--
-- ---------------------------------------------------------------------------
-- §1 — THE PREDICATE IS NOT WRITTEN AGAIN HERE
-- ---------------------------------------------------------------------------
-- public.lead_matches_customer_filter (0074) is the single expression of "does
-- this lead pass this customer's filter", and it is what
-- customer_can_see_pool_lead already delegates to. Two of its properties are
-- exactly what this needs, and neither is an accident:
--
--   * filter_status = 'off' returns TRUE — no filter is not an empty filter.
--     So an unfiltered customer's swap behaves precisely as it did before this
--     migration, with no branch anywhere saying so.
--   * 'pending_lift' counts as filtered, and a lead whose postcode area or
--     bedroom count will not parse matches NO filtered customer. Same
--     semantics as allocation and the pool (§19.4).
--
-- The inlined copy in get_filtered_candidates_for_lead is deliberately NOT the
-- one to call: it answers "is this customer in the filtered pool", which
-- excludes 'off' customers entirely. The helper answers "does this lead pass
-- their filter", which is the question a swap asks.
--
-- ---------------------------------------------------------------------------
-- §2 — WHY THE OVERRIDE EXISTS, AND WHAT MAKES IT DELIBERATE
-- ---------------------------------------------------------------------------
-- A swap is a support action. It is what an admin reaches for when a lead
-- turned out to have a dead phone number or a landlord who had already sold,
-- and the customer is owed a replacement TODAY. A customer with a narrow
-- filter may have no matching lead in stock at that moment, and a hard refusal
-- would leave the admin with an empty dropdown and no way to make them whole.
--
-- So the refusal is the default and the override is explicit:
-- p_allow_filter_mismatch must be passed TRUE by the caller. The route only
-- sends it when the admin has ticked a box that names the filter being missed.
-- Nothing defaults it to true, and nothing infers it.
--
-- ---------------------------------------------------------------------------
-- §3 — ⚠️  THE NEW ARGUMENT HAS NO DEFAULT, AND THAT IS LOAD-BEARING
-- ---------------------------------------------------------------------------
-- Adding `p_allow_filter_mismatch boolean default false` to the existing
-- function would NOT replace it. Postgres would create a second, overloaded
-- function, and every two-argument call — including the one on production
-- right now — would then fail with "function is not unique".
--
-- Two distinct signatures, neither carrying a default, are unambiguous. The
-- two-argument form is kept as a shim that delegates with FALSE, which is also
-- what makes migration-before-code safe here: the currently deployed route
-- calls the two-argument form and keeps working the moment this is applied,
-- enforcing the filter with no override. That is the safe direction for the
-- window between apply and deploy.
--
-- ---------------------------------------------------------------------------
-- §4 — THE PICKER CANNOT OFFER WHAT THE FUNCTION WOULD REFUSE
-- ---------------------------------------------------------------------------
-- The swap route's own rule. get_swap_candidates_for_assignment below returns
-- the eligible leads with a matches_filter flag on each, so the route needs to
-- know nothing about filters and no fifth hand-written copy of the predicate
-- appears in TypeScript. It also moves `assignment_count < max_assignments`
-- into SQL, where it belongs — it only lived in a post-fetch filter because
-- PostgREST cannot compare two columns.
-- ==========================================================================


-- ---------------------------------------------------------------------------
-- 1 — admin_swap_lead_assignment, with the filter guard
--
-- Body reproduced from 0107 with one clause inserted, per this repo's
-- convention for redefining a function.
-- ---------------------------------------------------------------------------
create or replace function public.admin_swap_lead_assignment(
  p_assignment_id           uuid,
  p_new_lead_id             uuid,
  p_allow_filter_mismatch   boolean
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

  -- 0109. The customer chose which leads they want, and a replacement reaches
  -- them exactly as an allocated lead does. lead_matches_customer_filter is the
  -- same predicate the pool uses and returns true for an unfiltered customer,
  -- so this costs nothing for anyone who has not set a filter.
  --
  -- coalesce, not a bare NOT: a null must read as "does not match", never as
  -- permission. Both rows are locked and proven to exist above so it cannot be
  -- null in practice, but failing open is not the direction to fail in here.
  if not p_allow_filter_mismatch
     and not coalesce(
       public.lead_matches_customer_filter(
         p_new_lead_id, v_old.customer_id, v_new_lead.lead_type
       ), false)
  then
    raise exception
      'Replacement lead does not match this customer''s lead filter';
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

revoke execute on function public.admin_swap_lead_assignment(uuid, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.admin_swap_lead_assignment(uuid, uuid, boolean)
  to service_role;


-- ---------------------------------------------------------------------------
-- 2 — The two-argument shim
--
-- Never overrides. Kept so that applying this migration ahead of the code —
-- the standing deployment order — leaves the live route working rather than
-- erroring on a missing function, and so any future caller that does not want
-- an override does not have to pass one.
-- ---------------------------------------------------------------------------
create or replace function public.admin_swap_lead_assignment(
  p_assignment_id uuid,
  p_new_lead_id   uuid
)
returns uuid
language sql
security definer
set search_path = public
as $$
  select public.admin_swap_lead_assignment(p_assignment_id, p_new_lead_id, false);
$$;

revoke execute on function public.admin_swap_lead_assignment(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_swap_lead_assignment(uuid, uuid)
  to service_role;


-- ---------------------------------------------------------------------------
-- 3 — The candidate list, with the filter verdict attached
--
-- Every eligibility rule the swap enforces that can be expressed as a query is
-- expressed here, so the picker can never offer something the function then
-- refuses. matches_filter is advisory rather than exclusionary: a mismatch is
-- returned and labelled, because §2 above is the whole reason.
--
-- Not enforced here, deliberately: the won check (a fact about the OUTGOING
-- assignment, which the UI already gates on) and the management pause (the
-- customer page does not offer a swap without loading the customer, and the
-- function raises in plain language either way).
-- ---------------------------------------------------------------------------
create or replace function public.get_swap_candidates_for_assignment(
  p_assignment_id uuid,
  p_search        text    default null,
  p_limit         integer default 50
)
returns table (
  id               uuid,
  lead_name        text,
  postcode         text,
  bedrooms         text,
  assignment_count integer,
  max_assignments  integer,
  created_at       timestamptz,
  matches_filter   boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with a as (
    select la.customer_id, la.lead_id, l.lead_type
    from public.lead_assignments la
    join public.leads l on l.id = la.lead_id
    where la.id = p_assignment_id
  )
  select
    l.id,
    l.lead_name,
    l.postcode,
    l.bedrooms,
    l.assignment_count,
    l.max_assignments,
    l.created_at,
    coalesce(
      public.lead_matches_customer_filter(l.id, a.customer_id, l.lead_type),
      false
    ) as matches_filter
  from public.leads l, a
  where l.lead_type = a.lead_type
    and l.id <> a.lead_id
    -- A customer's own lead belongs to whoever added it, and the swap refuses
    -- one in either direction (0107).
    and l.owner_customer_id is null
    and l.withdrawn_at is null
    and l.assignment_count < l.max_assignments
    and not exists (
      select 1 from public.lead_assignments la2
      where la2.lead_id = l.id and la2.customer_id = a.customer_id
    )
    and (
      p_search is null
      or p_search = ''
      or l.lead_name ilike '%' || p_search || '%'
      or l.postcode  ilike '%' || p_search || '%'
    )
  -- Matching leads first, then newest. The route does not re-sort.
  order by matches_filter desc, l.created_at desc
  limit p_limit;
$$;

revoke execute on function public.get_swap_candidates_for_assignment(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.get_swap_candidates_for_assignment(uuid, text, integer)
  to service_role;
