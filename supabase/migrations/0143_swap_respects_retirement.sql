-- ==========================================================================
-- 0143 — A SWAPPED-IN LEAD MUST NOT BE ONE ALLOCATION HAS RETIRED
-- ==========================================================================
--
-- Invariant 11 names public.lead_retired_from_allocation() as the single
-- expression of "may this lead be handed out", and asserts it in all three
-- candidate functions, in get_escalation_candidates, and inside
-- assign_lead_to_customer under its row lock. 0141 added it to the customer's
-- own replacement picker.
--
-- The ADMIN swap was the one route it never reached. 0109 built its candidate
-- list out of the rules it could see — same product, room left, not already
-- held, not withdrawn, not customer-owned — and 0111's quality gate and 0073's
-- pool retirement both landed after it without anybody joining them up.
-- CLAUDE.md §53.7 records this as outstanding; this closes it.
--
-- Measured on production the morning this was written, over the leads the
-- picker would offer (its own WHERE, minus the per-assignment clauses):
--
--                      offerable   retired   pooled 'ignored'   quality-blocked
--   management               77        11                  5                 6
--   guaranteed rent         258        31                  8                23
--
-- So 42 of 335 leads on offer today are ones ordinary routing has already
-- refused to sell. §53.7 named the 29 quality-blocked; the 13 pooled on the
-- 'ignored' basis are additional and were not.
--
-- A swap IS a delivery from the customer's side — 0109's own header says so,
-- and the route calls the same completeAssignment as ingest, so the customer
-- gets the ordinary new-lead email and text and cannot tell it apart. Every
-- reason those leads are retired applies to a swap exactly as it applies to an
-- allocation: a dead phone number is dead whichever route it arrives by, and a
-- lead the pool retired is one nobody worked when it was offered round.
--
-- ---------------------------------------------------------------------------
-- §1 — ⚠️  NO OVERRIDE, UNLIKE 0109'S FILTER GUARD
-- ---------------------------------------------------------------------------
-- 0109 gave the filter an explicit p_allow_filter_mismatch because a customer
-- with a narrow filter may have NOTHING matching in stock at the moment they
-- are owed a replacement, and a hard refusal would leave the admin unable to
-- make them whole. That argument does not carry here, for two reasons.
--
-- First, the stock: 66 management and 227 guaranteed-rent leads remain
-- offerable after this, so refusing 42 is not an empty dropdown.
--
-- Second, and the real one: a per-swap flag would be a FOURTH way to hand out a
-- retired lead, and invariant 11 says there is exactly one expression of that
-- rule. The escape hatches already exist, they are per LEAD rather than per
-- swap, and each leaves a record:
--
--   * quality-blocked → POST /api/admin/leads/[id]/quality with "override",
--     which stamps lead_quality_override_at (§36.4). The verdict and the
--     admin's decision both survive, and clearing it restores the block.
--   * pooled 'ignored' → POST /api/admin/pool with action "out", which runs
--     admin_pool_force_out: it nulls pool_entered_at AND pool_entry_basis and
--     stamps pool_excluded_at so the next morning's sweep cannot undo it
--     (§19.8).
--
-- Both un-retire the lead everywhere rather than for one swap, which is the
-- better shape: the admin is asserting something about the LEAD, and every
-- other path then agrees. A pool CLAIM has no hatch and must not have one —
-- that lead belongs to whoever claimed it and §19.6 is explicit the slot never
-- reopens.
--
-- ---------------------------------------------------------------------------
-- §2 — THE OUTGOING LEAD IS DELIBERATELY NOT TESTED
-- ---------------------------------------------------------------------------
-- Only the INCOMING lead is guarded. A quality-blocked lead sitting in a
-- customer's pipeline is precisely the one an admin reaches for this control
-- to remove, and refusing to swap it OUT would block the case the feature
-- exists for. The outgoing side keeps exactly the guards 0109 gave it.
--
-- ---------------------------------------------------------------------------
-- §3 — IT ALSO CLOSES A RACE IN THE CUSTOMER'S OWN PATH
-- ---------------------------------------------------------------------------
-- customer_swap_dead_lead (0141) already filters its candidate list on this
-- predicate, but nothing re-asserted it at the commit — so a lead the nightly
-- pool sweep retired between the page loading and the operator pressing Swap
-- would still have gone through. Putting the guard inside
-- admin_swap_lead_assignment, which that function calls, re-asserts it under
-- the row lock: the §5E discipline of eligibility living in one place so the
-- caller and the function cannot disagree.
--
-- resolve_dead_lead_claim_with_swap (0139) inherits it for the same reason.
--
-- ---------------------------------------------------------------------------
-- §4 — THE MESSAGE NAMES NO BASIS, ON PURPOSE
-- ---------------------------------------------------------------------------
-- The exception says the lead is retired and stops there. Listing the reasons
-- in prose would be a second, unmaintained copy of the predicate — the trap
-- §11 records — and it would go stale the first time an arm is added. The
-- picker no longer offers these at all, so the only way to see this message is
-- to hand-pick an id, at which point /admin/leads and /admin/pool say why.
--
-- Bodies are 0109's verbatim with ONE clause added each. A diff against 0109 is
-- that clause and nothing else.
-- ==========================================================================


-- ---------------------------------------------------------------------------
-- 1 — The swap itself
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

  -- 0143. Invariant 11's single expression of "may this lead be handed out",
  -- asserted here under the row lock exactly as assign_lead_to_customer
  -- asserts it.
  --
  -- ⚠️ IT HAS TO SIT BELOW THE `for update` ON v_new_lead. The predicate reads
  -- that lead's pool and quality columns, and holding its row lock is what
  -- stops the verdict changing between this test and the insert below — the
  -- same reason invariant 11 names assign_lead_to_customer's locked section as
  -- where it is asserted rather than anywhere earlier.
  --
  -- Below the OWNER check is a weaker claim and only about the MESSAGE: an
  -- unqualified owned lead satisfies both tests, and the owner one says
  -- something specific where this one says only "retired". A qualified owned
  -- lead is refused by the owner check either way, since 0108 took those out
  -- of this predicate — so the order is not what keeps §32.6 true.
  --
  -- coalesce for the same reason 0109 gives below: a null reads as retired,
  -- never as permission. Defensive rather than reachable — the helper is a
  -- `language sql` function returning `exists(...) or exists(...)`, which is
  -- never null.
  if coalesce(public.lead_retired_from_allocation(p_new_lead_id), true) then
    raise exception
      'Replacement lead % is retired from allocation and cannot be swapped in',
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
-- 2 — The candidate list
--
-- The route's rule is that the picker can never offer something the swap would
-- then refuse, so the same predicate goes here. Excluded outright rather than
-- returned and flagged, unlike matches_filter: a filter mismatch is the
-- admin's to override (0109 §2) and this is not.
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
    -- 0143. Last of the cheap column tests so the function call runs on as few
    -- rows as possible, and written as the helper rather than by hand: this is
    -- invariant 11's one predicate, and a fifth copy of its arms is the trap
    -- §34 and §35 exist to avoid.
    and not public.lead_retired_from_allocation(l.id)
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
