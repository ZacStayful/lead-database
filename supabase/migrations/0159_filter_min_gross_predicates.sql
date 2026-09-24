-- ============================================================================
-- The filter predicates read the revenue floor (0158, CLAUDE.md §68).
--
-- ⚠️ THIS ONE IS NOT INERT. 0158 added the column and nothing read it; from
-- here a customer carrying a floor is routed on it. Nobody carries one today
-- (verified: 0 of 61 rows), so the behaviour change is latent until the UI
-- ships — but the predicates move the moment this applies.
--
-- FOUR BODIES, AND ONLY ONE SIGNATURE CHANGES. Ten other functions delegate
-- to lead_matches_customer_filter and inherit the clause for free
-- (admin_assign_lead, admin_swap_lead_assignment, assign_lead_to_customer,
-- customer_can_see_pool_lead, customers_matching_lead_filter,
-- fulfil_owed_from_stock, fulfil_owed_replacement,
-- get_customer_replacement_candidates, get_swap_candidates_for_assignment,
-- open_owed_replacements_for_lead). Enumerated against production's own
-- pg_get_functiondef, not the migration files (§11's rule).
--
-- ⚠️ get_unfiltered_candidates_for_lead is correctly ABSENT. It selects
-- customers whose filter_status is 'off', who have no predicate to test. Do
-- not "complete the set" by adding it — an off customer takes every lead,
-- which is what makes a lead with no gross figure reachable at all.
--
-- ⚠️ NULL IS NOT FALSE IN SQL, and the clause is spelled to survive it:
--
--     (c.filter_min_gross is null
--      or (l.gross is not null and l.gross >= c.filter_min_gross))
--
-- Without the not-null guard, `NULL >= 50000` is NULL, the AND chain returns
-- NULL rather than false, and the function returns NULL. The two money-path
-- callers coalesce to false and the where-clause callers fail closed — but
-- get_swap_candidates_for_assignment returns `matches_filter` as a COLUMN,
-- and a NULL there renders in §34's picker as neither "Matches" nor
-- "Outside". Written this way the chain is `false and NULL` = false.
--
-- ⚠️ THE GR BRANCH OF EVERY FUNCTION IS UNTOUCHED, and that is invariant 6
-- satisfied structurally rather than by a clause somebody must remember:
-- there is no gr_filter_min_gross column to read even by mistake (0158).
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1 — lead_matches_customer_filter: the canonical predicate.
--
-- 0074's body verbatim, plus the CTE gaining `gross_annual_income` and the
-- MANAGEMENT branch gaining one clause. Signature unchanged, so none of the
-- ten delegating callers needs an edit and none can resolve to a different
-- overload (§34's trap).
-- ---------------------------------------------------------------------------
create or replace function public.lead_matches_customer_filter(
  p_lead_id     uuid,
  p_customer_id uuid,
  p_lead_type   public.lead_type
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with l as (
    select
      postcode_area as area,
      nullif(substring(coalesce(bedrooms, '') from '\d+'), '')::int as bed,
      gross_annual_income as gross
    from public.leads where id = p_lead_id
  )
  select case
    when p_lead_type = 'guaranteed_rent' then
      case
        when c.gr_filter_status not in ('active', 'pending_lift') then true
        else l.area is not null
         and l.bed is not null
         and (
           c.gr_filter_areas is null
           or array_length(c.gr_filter_areas, 1) is null
           or l.area = any (c.gr_filter_areas)
         )
         and (c.gr_filter_min_bedrooms is null or l.bed >= c.gr_filter_min_bedrooms)
         and (c.gr_filter_max_bedrooms is null or l.bed <= c.gr_filter_max_bedrooms)
      end
    else
      case
        when c.filter_status not in ('active', 'pending_lift') then true
        else l.area is not null
         and l.bed is not null
         and (
           c.filter_areas is null
           or array_length(c.filter_areas, 1) is null
           or l.area = any (c.filter_areas)
         )
         and (c.filter_min_bedrooms is null or l.bed >= c.filter_min_bedrooms)
         and (c.filter_max_bedrooms is null or l.bed <= c.filter_max_bedrooms)
         -- 0159: the revenue floor. A lead with NO figure matches no floored
         -- customer, exactly as an unparseable area or bedroom count does.
         and (
           c.filter_min_gross is null
           or (l.gross is not null and l.gross >= c.filter_min_gross)
         )
      end
  end
  from public.customers c, l
  where c.id = p_customer_id;
$$;

revoke execute on function public.lead_matches_customer_filter(uuid, uuid, public.lead_type)
  from public, anon, authenticated;
grant execute on function public.lead_matches_customer_filter(uuid, uuid, public.lead_type)
  to service_role;


-- ---------------------------------------------------------------------------
-- 2 — get_filtered_candidates_for_lead: its own INLINED copy.
--
-- §35 explains why this function inlines the predicate rather than calling
-- lead_matches_customer_filter: it is the routing hot path and answers a
-- different question ("is this customer in the FILTERED pool"), which
-- excludes filter_status = 'off' customers entirely where the shared
-- predicate returns true for them.
--
-- 0154's body verbatim, plus `gross_annual_income` on the CTE and one clause
-- in the MANAGEMENT arm. The GR arm is byte-identical to 0154.
-- ---------------------------------------------------------------------------
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
      nullif(substring(coalesce(bedrooms, '') from '\d+'), '')::int as bed,
      gross_annual_income as gross,
      created_at
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
        -- 0159: the revenue floor. NULL-safe by the not-null guard — without
        -- it `NULL >= 50000` is NULL and the whole arm returns NULL.
        and (
          c.filter_min_gross is null
          or (l.gross is not null and l.gross >= c.filter_min_gross)
        )
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
    -- 0148: one lead a working day. Inert while release_enabled is false.
    -- 0154: a fresh lead skips the curve, never the cap.
    and public.customer_release_allows(c.id, p_lead_type, l.created_at)
  order by
    priority_score desc,
    case when p_lead_type = 'guaranteed_rent' then c.gr_last_assignment_at
         else c.last_assignment_at end asc nulls first,
    c.created_at asc
  limit p_max;
$$;

revoke execute on function public.get_filtered_candidates_for_lead(uuid, integer, public.lead_type)
  from public, anon, authenticated;
grant execute on function public.get_filtered_candidates_for_lead(uuid, integer, public.lead_type)
  to service_role;


-- ---------------------------------------------------------------------------
-- 3 — releasable_filter_assignments: the one function that gains an argument.
--
-- ⚠️ IT TAKES THE PROPOSED CRITERIA AS ARGUMENTS, which is 0114's whole
-- reason for existing: the customer must be asked what to do with their
-- untouched non-matching leads BEFORE the filter is saved, so a function
-- reading the STORED columns cannot answer it. A proposed revenue floor is
-- one more proposed criterion.
--
-- ⚠️ NO DEFAULT ON p_min_gross, AND THE FIVE-ARGUMENT FORM IS KEPT AS A SHIM.
-- The apply route calls this through PostgREST with NAMED arguments, and
-- PostgREST resolves by name-compatibility: a defaulted sixth makes BOTH
-- candidates compatible with a five-name call, which is PGRST203 "could not
-- choose the best candidate function" on every filter apply on the platform.
-- With no default, five names resolve only to the shim and six only to the
-- new form. That is also what makes migration-before-code safe here: the
-- route deployed at apply time keeps working, proposing no floor, which is
-- the safe direction.
--
-- 0114's body verbatim otherwise. Every untouched-ness clause above is
-- load-bearing (invariant 4) and none of them moves.
-- ---------------------------------------------------------------------------
create or replace function public.releasable_filter_assignments(
  p_customer_id   uuid,
  p_lead_type     public.lead_type,
  p_areas         text[],
  p_min_bedrooms  integer,
  p_max_bedrooms  integer,
  p_min_gross     integer
)
returns table (
  assignment_id uuid,
  lead_id       uuid,
  postcode_area text,
  bedrooms      text,
  assigned_at   timestamptz,
  price_paid    numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    la.id,
    l.id,
    l.postcode_area,
    l.bedrooms,
    la.assigned_at,
    la.price_paid
  from public.lead_assignments la
  join public.leads l on l.id = la.lead_id
  where la.customer_id = p_customer_id
    and l.lead_type = p_lead_type

    -- ---------------------------------------------------------------------
    -- UNTOUCHED. Every clause here is load-bearing (§3) — this is what makes
    -- the refund an undelivery rather than a refund on worked-for value.
    -- ---------------------------------------------------------------------
    and la.viewed_at is null              -- never expanded the card
    and la.status = 'new'                 -- never contacted, won, rejected, closed
    and la.pipeline_stage = 'cold'        -- nothing built on it
    -- Reported as done — the landlord said no, or sorted it elsewhere (0067).
    -- `status = 'new'` already excludes this, because closing sets
    -- 'not_relevant', but closing is somebody having WORKED the lead and this
    -- predicate is the whole basis for calling the refund an undelivery (§3).
    -- Stating it outright costs nothing and survives a future close path that
    -- leaves status alone.
    and la.closed_at is null
    -- §19.6: a pool claim must never reopen its slot. discard_lead_assignment
    -- sets pool_expired_at instead of decrementing for exactly this reason;
    -- rather than reproduce that branch, a claimed lead is simply not
    -- releasable. The customer rang the landlord before keeping it, which is
    -- the opposite of untouched anyway.
    and la.claimed_from_pool_at is null
    and not exists (
      select 1 from public.lead_notes n where n.lead_assignment_id = la.id
    )
    and not exists (
      select 1 from public.lead_files f where f.lead_assignment_id = la.id
    )
    -- Any operator-generated telemetry at all. nudge_sent is EXCLUDED for the
    -- usual reason (CLAUDE.md §3): it is system-generated, and counting it
    -- would lock exactly the leads nobody has touched — the ones this feature
    -- exists to recover.
    and not exists (
      select 1 from public.lead_events e
      where e.assignment_id = la.id and e.event_type <> 'nudge_sent'
    )

    -- ---------------------------------------------------------------------
    -- NOT SOMEBODY ELSE'S TO GIVE BACK.
    -- ---------------------------------------------------------------------
    -- A lead the customer added themselves (§30). Releasing it would return
    -- their own lead to the marketplace and refund them for it.
    and l.owner_customer_id is null
    -- ⚠️ A lead an admin WITHDREW on a swap (0059). The swap withdraws it by
    -- clamping max_assignments DOWN to assignment_count, so every selection
    -- path skips it. Releasing another holder's copy decrements
    -- assignment_count while the clamp stays put — which puts the lead back
    -- UNDER its cap and hands a deliberately-withdrawn lead straight back into
    -- ordinary routing. Barring it here is cheaper and safer than re-clamping
    -- after the fact.
    and l.withdrawn_at is null

    -- ---------------------------------------------------------------------
    -- FAILS THE PROPOSED FILTER. An unparseable postcode area or bedroom
    -- count matches no filtered customer (0026/0074), so such a lead FAILS
    -- and is releasable.
    -- ---------------------------------------------------------------------
    and not (
      l.postcode_area is not null
      and nullif(substring(coalesce(l.bedrooms, '') from '\d+'), '')::int is not null
      and (
        p_areas is null
        or array_length(p_areas, 1) is null
        or l.postcode_area = any (p_areas)
      )
      and (
        p_min_bedrooms is null
        or nullif(substring(coalesce(l.bedrooms, '') from '\d+'), '')::int >= p_min_bedrooms
      )
      and (
        p_max_bedrooms is null
        or nullif(substring(coalesce(l.bedrooms, '') from '\d+'), '')::int <= p_max_bedrooms
      )
      -- 0159: the proposed revenue floor. A lead with NO gross figure fails a
      -- floor, so it is RELEASABLE — the same rule an unparseable postcode
      -- area or bedroom count already follows.
      and (
        p_min_gross is null
        or (l.gross_annual_income is not null and l.gross_annual_income >= p_min_gross)
      )
    )
  -- Stalest first, so a partial release (the keep-at-quota case) gives back
  -- the leads that have sat longest rather than the ones that just arrived.
  order by la.assigned_at asc, la.id asc;
$$;

-- The five-argument form, kept so the deployed route keeps working between
-- this apply and its deploy. Delegates with no floor — exactly what a caller
-- that does not know about floors means.
create or replace function public.releasable_filter_assignments(
  p_customer_id   uuid,
  p_lead_type     public.lead_type,
  p_areas         text[],
  p_min_bedrooms  integer,
  p_max_bedrooms  integer
)
returns table (
  assignment_id uuid,
  lead_id       uuid,
  postcode_area text,
  bedrooms      text,
  assigned_at   timestamptz,
  price_paid    numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select * from public.releasable_filter_assignments(
    p_customer_id, p_lead_type, p_areas, p_min_bedrooms, p_max_bedrooms, null
  );
$$;

revoke execute on function public.releasable_filter_assignments(
  uuid, public.lead_type, text[], integer, integer
) from public, anon, authenticated;
grant execute on function public.releasable_filter_assignments(
  uuid, public.lead_type, text[], integer, integer
) to service_role;
revoke execute on function public.releasable_filter_assignments(
  uuid, public.lead_type, text[], integer, integer, integer
) from public, anon, authenticated;
grant execute on function public.releasable_filter_assignments(
  uuid, public.lead_type, text[], integer, integer, integer
) to service_role;


-- ---------------------------------------------------------------------------
-- 4 — release_unmatched_assignments: reads the floor that is now IN FORCE.
--
-- ⚠️ NO SIGNATURE CHANGE. It already reads the stored filter off the locked
-- customer row, so the floor is one more column on `v_customer` — which
-- means none of §34's overload trap applies, and the apply route needs no
-- edit for this half.
--
-- The consequence is the one invariant 4 already carries: a customer who
-- applies a £75k floor can give back every untouched lead that fails it,
-- refunded. §39.1 is why that is an undelivery and not a refund on
-- worked-for value — `releasable_filter_assignments` above is unchanged in
-- every untouched-ness clause.
--
-- ⚠️ IT CAN NOW RELEASE FAR MORE AT ONCE. A revenue floor makes most of a
-- narrow customer's untouched stock non-matching, where areas and bedrooms
-- typically excluded a handful. The loop is 1 DELETE + 2 UPDATEs + 1 INSERT
-- per lead, and `p_max` is what bounds it — the caller sizes it from the
-- forecast, exactly as before. Watch it once real floors exist.
--
-- 0114's body verbatim otherwise.
-- ---------------------------------------------------------------------------
create or replace function public.release_unmatched_assignments(
  p_customer_id           uuid,
  p_lead_type             public.lead_type,
  p_max                   integer,
  p_mode                  text,
  p_clamp_to_allocation   boolean default false
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer   public.customers%rowtype;
  v_areas      text[];
  v_min        integer;
  v_max        integer;
  v_min_gross  integer;
  v_allocation integer;
  v_released   integer := 0;
  r            record;
begin
  if p_mode is null or p_mode not in ('discard', 'quota_refill') then
    raise exception 'Unknown release mode %', p_mode;
  end if;

  select * into v_customer from public.customers
    where id = p_customer_id for update;
  if not found then
    raise exception 'Customer % not found', p_customer_id;
  end if;

  -- Read the filter that is now in force, per product (invariant 6).
  if p_lead_type = 'guaranteed_rent' then
    v_areas      := v_customer.gr_filter_areas;
    v_min        := v_customer.gr_filter_min_bedrooms;
    v_max        := v_customer.gr_filter_max_bedrooms;
    -- ⚠️ Always null on GR, and there is no column to read (0158). Invariant 6
    -- holds structurally rather than by a clause somebody must remember.
    v_min_gross  := null;
    v_allocation := coalesce(v_customer.gr_monthly_allocation, 0);
  else
    v_areas      := v_customer.filter_areas;
    v_min        := v_customer.filter_min_bedrooms;
    v_max        := v_customer.filter_max_bedrooms;
    v_min_gross  := v_customer.filter_min_gross;
    v_allocation := coalesce(v_customer.monthly_allocation, 0);
  end if;

  -- The fresh-enable clamp, under the lock. Applied BEFORE the refunds below,
  -- so a customer never has credits confiscated that they were just given back
  -- for leads they returned in this same call.
  if p_clamp_to_allocation then
    if p_lead_type = 'guaranteed_rent' then
      update public.customers
        set gr_lead_balance = least(coalesce(gr_lead_balance, 0), v_allocation),
            updated_at = now()
        where id = p_customer_id;
    else
      update public.customers
        set lead_balance = least(coalesce(lead_balance, 0), v_allocation),
            updated_at = now()
        where id = p_customer_id;
    end if;
  end if;

  -- ⚠️ The early return sits HERE, below the clamp, not at the top. A fresh
  -- enable has always clamped the balance to the allocation, and the route
  -- skips this RPC when there is nothing to release — so returning early on
  -- p_max = 0 before the clamp would quietly drop that behaviour for every
  -- customer with no releasable leads. Clamp first, then decide there is
  -- nothing to do.
  if p_max is null or p_max <= 0 then
    return 0;
  end if;

  for r in
    select *
    from public.releasable_filter_assignments(
      p_customer_id, p_lead_type, v_areas, v_min, v_max, v_min_gross
    )
    limit p_max
  loop
    -- Same disposal as discard_lead_assignment: the row goes. Every existing
    -- reader — dashboard, analytics, admin, exports, leaderboard, engagement
    -- scoring, the public API — then behaves exactly as it does for a discard,
    -- with no change anywhere. Notes and files would cascade; the untouched
    -- predicate guarantees there are none. Notifications cascade thanks to
    -- 0060 (§5) — without it this DELETE raises a foreign-key violation.
    delete from public.lead_assignments where id = r.assignment_id;

    -- Reopen the slot so ordinary redistribution can place it (§4 of
    -- CLAUDE.md). No re-offer happens here; the daily sync and
    -- /api/admin/leads/assign-pending do that.
    update public.leads
      set assignment_count = greatest(assignment_count - 1, 0)
      where id = r.lead_id;

    -- The refund. Exactly the shape 0017 used before 0019 withdrew it from
    -- reject: give the credit back and roll the pacing counter back with it,
    -- mirroring the spend assign_lead_to_customer made. Rolling the counter
    -- back matters as much as the credit — leaving it would read the customer
    -- as having received leads they no longer hold, and the deficit-first
    -- router would deprioritise them for the rest of the cycle.
    --
    -- (gr_)pool_debit is deliberately NOT touched: invariant 12 settles it
    -- only inside credit_invoice. management_lifetime_leads_received is not
    -- touched either — invariant 9, it only ever counts up.
    if p_lead_type = 'guaranteed_rent' then
      update public.customers
        set gr_lead_balance = coalesce(gr_lead_balance, 0) + 1,
            gr_leads_received_this_month =
              greatest(coalesce(gr_leads_received_this_month, 0) - 1, 0),
            updated_at = now()
        where id = p_customer_id;
    else
      update public.customers
        set lead_balance = coalesce(lead_balance, 0) + 1,
            leads_received_this_month =
              greatest(coalesce(leads_received_this_month, 0) - 1, 0),
            updated_at = now()
        where id = p_customer_id;
    end if;

    insert into public.filter_lead_releases (
      customer_id, lead_id, lead_type, mode, credit_refunded,
      price_paid, areas, min_bedrooms, max_bedrooms
    ) values (
      p_customer_id, r.lead_id, p_lead_type, p_mode, true,
      r.price_paid, v_areas, v_min, v_max
    );

    v_released := v_released + 1;
  end loop;

  return v_released;
end;
$$;

revoke execute on function public.release_unmatched_assignments(
  uuid, public.lead_type, integer, text, boolean
) from public, anon, authenticated;
grant execute on function public.release_unmatched_assignments(
  uuid, public.lead_type, integer, text, boolean
) to service_role;


-- ---------------------------------------------------------------------------
-- 5 — execute_filter_lift: the floor is nulled with everything else.
--
-- ⚠️ THE RISKIEST OF THE FIVE, because forgetting it fails SILENTLY.
--
-- ⚠️ create or replace, NEVER drop and create. §11 records 0038 doing exactly
-- that and discarding the ACL — and this function is security definer, takes
-- a customer id and performs NO caller check, so an anon grant would let
-- anyone null a pending_lift customer's filter, zero their monthly counter
-- and reset their billing anchor. The grants are re-asserted below anyway.
--
-- ⚠️ NO NEW PARAMETER, DEFAULTED OR OTHERWISE. Its signature already carries
-- `p_lead_type ... default 'management'`, and the Stripe webhook calls it
-- through PostgREST with NAMED arguments. A defaulted third makes both
-- candidates name-compatible → PGRST203 → the webhook logs and RETURNS, and
-- the lift SILENTLY NEVER EXECUTES: the customer sits in pending_lift for
-- ever, still treated as filtered, and nobody is told.
--
-- ⚠️ The body is 0026's verbatim apart from ONE added line in the management
-- branch. The `where ... and filter_status = 'pending_lift'` predicate IS the
-- idempotency claim, and `v_executed := found` is what the webhook reads to
-- decide whether to email — loosen either and every invoice.paid re-anchors
-- the cycle and re-emails. The GR branch is byte-identical to 0026.
-- ---------------------------------------------------------------------------
create or replace function public.execute_filter_lift(
  p_customer_id uuid,
  p_lead_type public.lead_type default 'management'
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_executed boolean := false;
begin
  if p_lead_type = 'guaranteed_rent' then
    update public.customers
      set gr_filter_status = 'off',
          gr_filter_areas = null,
          gr_filter_min_bedrooms = null,
          gr_filter_max_bedrooms = null,
          gr_filter_lift_effective_date = null,
          gr_filter_enabled_at = null,
          -- Fresh deficit baseline from this renewal moment.
          gr_leads_received_this_month = 0,
          gr_billing_cycle_anchor = current_date,
          updated_at = now()
      where id = p_customer_id and gr_filter_status = 'pending_lift';
    v_executed := found;
  else
    update public.customers
      set filter_status = 'off',
          filter_areas = null,
          filter_min_bedrooms = null,
          filter_max_bedrooms = null,
          -- ⚠️ 0159. The floor MUST be nulled with the other criteria. 0094
          -- deliberately declined to touch this function for the radius
          -- METADATA — a create-or-replace of a privileged function for a
          -- nicety — and the opposite applies here: a revenue floor is a live
          -- predicate input, so forgetting it strands a floor behind a lifted
          -- filter and NOTHING ERRORS. The customer's filter reads "off"
          -- everywhere while routing still excludes every lead under it.
          filter_min_gross = null,
          filter_lift_effective_date = null,
          filter_enabled_at = null,
          leads_received_this_month = 0,
          billing_cycle_anchor = current_date,
          updated_at = now()
      where id = p_customer_id and filter_status = 'pending_lift';
    v_executed := found;
  end if;

  return v_executed;
end;
$$;

revoke execute on function public.execute_filter_lift(uuid, public.lead_type)
  from public, anon, authenticated;
grant execute on function public.execute_filter_lift(uuid, public.lead_type)
  to service_role;

