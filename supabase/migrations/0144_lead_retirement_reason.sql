-- ==========================================================================
-- 0144 — SAY WHY A LEAD IS NOT OFFERED, INSTEAD OF SILENTLY DROPPING IT
-- ==========================================================================
--
-- 0143 stopped the admin swap picker offering leads ordinary routing had
-- retired. It did it by exclusion, and §53.9's own Deferred entry recorded the
-- cost: **a withheld candidate is withheld silently.** An admin searching for a
-- lead they know exists is not told why it is missing — which is §52.4's
-- argument for greying a control with its reason rather than hiding it, not
-- followed at the time because saying so needs a column on the return type.
--
-- This adds the column. The leads come back, last, carrying the basis, and the
-- picker renders them as disabled <option>s. **Nothing about the REFUSAL
-- changes**: admin_swap_lead_assignment still raises on a retired lead, with no
-- override, exactly as 0143 left it. What changes is that the picker stops
-- pretending those leads do not exist.
--
-- ---------------------------------------------------------------------------
-- §1 — ⚠️  THE REASON IS THE DEFINITION NOW, AND THE BOOLEAN DELEGATES TO IT
-- ---------------------------------------------------------------------------
-- 0143's own comment said the exception "names no basis, on purpose", because
-- listing the reasons in prose would be a second, unmaintained copy of the
-- predicate — the trap §11 records. That reasoning is why the obvious shape
-- here is wrong: a `lead_retirement_reason()` written BESIDE
-- lead_retired_from_allocation() would be exactly that second copy, of the one
-- predicate invariant 11 says has a single expression.
--
-- So it is not beside it. The reason function carries the arms, and the boolean
-- becomes `lead_retirement_reason(id) is not null`. There is still one place
-- that decides whether a lead may be handed out; it now also says why.
--
-- ⚠️ That makes this migration a rewrite of the most load-bearing predicate in
-- the schema — asserted in all three candidate functions, in
-- get_escalation_candidates, in get_next_customers_for_lead, and inside
-- assign_lead_to_customer under its row lock. The arms are transcribed in the
-- order 0111 wrote them and the equivalence is verified rather than argued:
-- over every lead in production, the boolean's answer before and after this
-- migration must be identical, and the test suite asserts
-- `reason is not null` = `retired` across every seeded shape.
--
-- ⚠️ A LEAD THAT DOES NOT EXIST STAYS FALSE. The old body is
-- `exists(...) or exists(... where l.id = p_lead_id ...)`, so an unknown id is
-- not retired. The new one selects `from public.leads where id = p_lead_id`,
-- returns no row, and a scalar SQL function with no row yields NULL — so
-- `is not null` is false. Same answer, by a different route, and the reason it
-- holds is worth writing down because it is not obvious.
--
-- ---------------------------------------------------------------------------
-- §2 — RETIRED CANDIDATES SORT LAST, AND THAT IS NOT COSMETIC
-- ---------------------------------------------------------------------------
-- The picker is capped (p_limit, 50 from the route). Letting a retired lead
-- sort by created_at alongside the rest would let it consume a slot a
-- selectable lead needed — the picker would show fewer usable options than
-- before, which is a worse outcome than the silence this is fixing.
--
-- `order by (retired_reason is not null)` first guarantees every selectable
-- lead is in the page before any unavailable one is. The consequence, stated so
-- it is not mistaken for a bug: where selectable stock exceeds the cap, no
-- unavailable leads are shown at all, and the search box is what narrows to
-- them.
--
-- ---------------------------------------------------------------------------
-- §3 — ⚠️  DROP AND CREATE, SO THE ACL HAS TO BE RE-ASSERTED
-- ---------------------------------------------------------------------------
-- get_swap_candidates_for_assignment gains a column, and Postgres refuses a
-- `create or replace` that changes RETURNS TABLE. The drop DISCARDS the grants
-- (§11: 0028 revoked schema-wide, then 0038 dropped and recreated a function
-- and handed it back to anon). Both the revoke and the grant below are
-- load-bearing, and the suite asserts anon and authenticated hold neither.
--
-- The other two are `create or replace` — same signature, same return type — so
-- their ACLs survive. They are re-asserted anyway, which is the convention this
-- repo has followed since 0049.
-- ==========================================================================


-- ---------------------------------------------------------------------------
-- 1 — The reason. Arms transcribed from 0111 in the order it wrote them.
-- ---------------------------------------------------------------------------
create or replace function public.lead_retirement_reason(p_lead_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    -- A pool claim. No admin control undoes this and none should: the lead
    -- belongs to whoever claimed it, and §19.6 is explicit the slot never
    -- reopens. Tested first because it is the only permanent one.
    when exists (
      select 1 from public.lead_assignments la
      where la.lead_id = p_lead_id
        and la.claimed_from_pool_at is not null
    ) then 'claimed_from_pool'
    when l.pool_expired_at is not null then 'pool_expired'
    when l.pool_entered_at is not null and l.pool_entry_basis = 'ignored'
      then 'pooled_ignored'
    -- Since 0108 a resale-QUALIFIED owned lead is deliberately absent from
    -- this list. It is still refused by the swap, by its own owner rule
    -- (§32.6), which is a different question from allocation.
    when l.owner_customer_id is not null
     and l.owner_resale_qualified_at is null then 'owner_unqualified'
    when l.lead_quality_status = 'failed'
     and l.lead_quality_override_at is null then 'quality_failed'
    else null
  end
  from public.leads l
  where l.id = p_lead_id;
$$;

revoke execute on function public.lead_retirement_reason(uuid)
  from public, anon, authenticated;
grant execute on function public.lead_retirement_reason(uuid)
  to service_role;


-- ---------------------------------------------------------------------------
-- 2 — Invariant 11's predicate, now derived from the reason
--
-- Behaviour must be bit-for-bit what 0111 gave. See §1 on the missing-lead
-- case, and the verification note on the production fingerprint.
-- ---------------------------------------------------------------------------
create or replace function public.lead_retired_from_allocation(p_lead_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.lead_retirement_reason(p_lead_id) is not null;
$$;

revoke execute on function public.lead_retired_from_allocation(uuid)
  from public, anon, authenticated;
grant execute on function public.lead_retired_from_allocation(uuid)
  to service_role;


-- ---------------------------------------------------------------------------
-- 3 — The candidate list carries the verdict instead of hiding the row
-- ---------------------------------------------------------------------------
drop function if exists public.get_swap_candidates_for_assignment(uuid, text, integer);

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
  matches_filter   boolean,
  retired_reason   text
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
    ) as matches_filter,
    -- 0144. Null means selectable. Non-null is the basis, and the swap will
    -- refuse it — the picker renders those as disabled options rather than
    -- dropping the row, so an admin looking for a specific lead is told why it
    -- cannot be used instead of finding it absent.
    public.lead_retirement_reason(l.id) as retired_reason
  from public.leads l, a
  where l.lead_type = a.lead_type
    and l.id <> a.lead_id
    -- A customer's own lead belongs to whoever added it, and the swap refuses
    -- one in either direction (0107). Still EXCLUDED rather than greyed: an
    -- unqualified one would carry a reason, but a qualified one carries none
    -- and would read as selectable when the swap refuses it. Two different
    -- rules, and only one of them is what retired_reason reports.
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
  -- Selectable leads FIRST, and the cap is why (§2). Then matching, then
  -- newest. The route does not re-sort.
  order by (public.lead_retirement_reason(l.id) is not null),
           matches_filter desc,
           l.created_at desc
  limit p_limit;
$$;

revoke execute on function public.get_swap_candidates_for_assignment(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.get_swap_candidates_for_assignment(uuid, text, integer)
  to service_role;
