-- ============================================================================
-- 0163 — Lead Brief routing (Phase 4)
--
-- Brief customers are routed by their brief, AFTER the legacy pools ("brief
-- last", approved in the Phase 0 report, §2 and C1–C3):
--
--   1. The two legacy candidate functions gain ONE predicate each, in their
--      MANAGEMENT arm only: `and not c.lead_brief_required`. Every other line is
--      the live body verbatim (get_filtered_candidates_for_lead from 0159,
--      get_unfiltered_candidates_for_lead from 0154). The column is false on
--      every customer that exists today, so both functions return exactly what
--      they returned before. GR is untouched (invariant 6).
--
--      ⚠️ ONE PREDICATE, NOT A NEW PARAMETER. Same signatures, so no overload
--      (§34, §35, §63.3), and the grants are re-asserted below (§11): a
--      `create or replace` keeps the ACL, but the re-assertion is the house rule.
--
--   2. get_brief_candidates_for_lead(lead, max, include_pace): the brief pool.
--      The same gates as the legacy pools — not retired (invariant 11), active,
--      balance, unpaused, not already holding the lead, not its uploader, the
--      release curve (0148/0154) — plus the brief: a CONFIRMED brief
--      (lead_brief_completed_at set, one ACTIVE row), the lead's outcode in the
--      service area or the first-pick areas, and every essential met. A lead
--      with no figure for an essential does not meet it.
--
--      Behind-pace widening (A11, D9): with include_pace, a lead in the
--      customer's pace_outcodes is admitted only while they are behind pace —
--      deficit at least ceil(monthly_allocation × lead_brief_pace_deficit_pct /
--      100). The stored service area never changes because of it.
--
--      Scoring and labels happen in TypeScript (src/lib/leadBrief/score.ts);
--      this returns the facts they need, ordered in-area first, then deficit.
--
-- What this migration does NOT do:
--   - change assign_lead_to_customer, lead_matches_customer_filter or
--     customer_release_allows (all prohibited, and none needs it: brief
--     customers sit at filter_status 'off', so the assign guard passes);
--   - route anything by itself. TypeScript calls the new function only while
--     lead_brief_enabled (0162) is 'true', and it ships 'false';
--   - flag anybody. lead_brief_required is false everywhere until go-live.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The legacy pools: exclude brief customers (management arm only)
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
        -- 0163: a Lead Brief customer is routed by their brief, never here.
        and not c.lead_brief_required
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
        -- 0163: a Lead Brief customer is routed by their brief, never here.
        and not c.lead_brief_required
        and c.filter_status = 'off'
      )
      or (
        p_lead_type = 'guaranteed_rent'
        and c.gr_subscription_status = 'active'
        and c.gr_lead_balance > 0
        and c.gr_filter_status = 'off'
      )
    )
    -- 0148: one lead a working day. Inert while release_enabled is false.
    -- 0154: a fresh lead skips the curve, never the cap. An uncorrelated
    -- scalar subquery rather than a join: this function has no lead CTE, and
    -- a join would change what an unknown lead id returns.
    and public.customer_release_allows(
      c.id,
      p_lead_type,
      (select l2.created_at from public.leads l2 where l2.id = p_lead_id)
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

-- ---------------------------------------------------------------------------
-- 2. The brief pool
--
-- ⚠️ NO DEFAULTS. Three required arguments, so there is exactly one way to call
-- it and no overload can ever be created by adding a defaulted parameter later
-- (§34/§35's trap).
-- ---------------------------------------------------------------------------
create or replace function public.get_brief_candidates_for_lead(
  p_lead_id uuid,
  p_max integer,
  p_include_pace boolean
)
returns table (
  customer_id        uuid,
  brief_id           uuid,
  deficit            numeric,
  last_assignment_at timestamptz,
  in_service         boolean,
  in_first_pick      boolean,
  pace_only          boolean,
  allocation         integer,
  travel_limit_miles integer,
  base_outcode       text,
  priority_outcodes  text[],
  similar_areas      text[],
  priorities         jsonb
)
language sql
security definer
set search_path = public
as $$
  with l as (
    select
      id,
      lead_type,
      outcode,
      nullif(substring(coalesce(bedrooms, '') from '\d+'), '')::int as bed,
      gross_annual_income as gross,
      created_at,
      owner_customer_id
    from public.leads
    where id = p_lead_id
  ),
  pace_pct as (
    -- A malformed setting reads as the shipped 20, never as an error.
    select coalesce(
      (select case when trim(value) ~ '^[0-9]+(\.[0-9]+)?$' then trim(value)::numeric end
         from public.system_settings
        where key = 'lead_brief_pace_deficit_pct'),
      20
    ) as pct
  ),
  cand as (
    select
      c.id as customer_id,
      b.id as brief_id,
      -- The management deficit, exactly as the legacy pools compute it.
      round(
        (least(greatest(
          extract(day from now() - coalesce(c.billing_cycle_anchor, c.created_at::date)),
          0), 30) / 30.0)
        * public.effective_allocation(c.monthly_allocation, c.pool_debit)
      ) - c.leads_received_this_month as deficit,
      c.last_assignment_at,
      c.created_at as customer_created_at,
      c.monthly_allocation,
      l.outcode = any (b.service_outcodes) as in_service,
      l.outcode = any (b.first_pick_outcodes) as in_first_pick,
      l.outcode = any (b.pace_outcodes) as in_pace,
      b.allocation,
      b.travel_limit_miles,
      b.base_outcode,
      b.priority_outcodes,
      b.similar_areas,
      b.priorities
    from public.customers c
    join public.customer_lead_briefs b
      on b.customer_id = c.id and b.status = 'active'
    cross join l
    where not public.lead_retired_from_allocation(p_lead_id)
      and l.lead_type = 'management'
      and l.outcode is not null
      and c.is_active = true
      and c.account_status = 'active'
      and c.subscription_status = 'active'
      and c.lead_balance > 0
      and c.paused_at is null
      and c.lead_brief_required
      and c.lead_brief_completed_at is not null
      and not exists (
        select 1 from public.lead_assignments la
        where la.lead_id = p_lead_id and la.customer_id = c.id
      )
      and c.id is distinct from l.owner_customer_id
      -- Essentials: the only hard exclusions besides the area (locked
      -- decision 6). No figure means not met — never a promise on a guess.
      and (b.min_bedrooms is null or (l.bed is not null and l.bed >= b.min_bedrooms))
      and (b.min_gross is null or (l.gross is not null and l.gross >= b.min_gross))
      -- 0148/0154: the release curve and daily cap apply exactly as to everyone.
      and public.customer_release_allows(c.id, 'management', l.created_at)
  )
  select
    cand.customer_id,
    cand.brief_id,
    cand.deficit,
    cand.last_assignment_at,
    cand.in_service,
    cand.in_first_pick,
    not (cand.in_service or cand.in_first_pick) as pace_only,
    cand.allocation,
    cand.travel_limit_miles,
    cand.base_outcode,
    cand.priority_outcodes,
    cand.similar_areas,
    cand.priorities
  from cand, pace_pct
  where cand.in_service
     or cand.in_first_pick
     or (
       p_include_pace
       and cand.in_pace
       and cand.deficit >= ceil(cand.monthly_allocation * pace_pct.pct / 100.0)
     )
  order by
    not (cand.in_service or cand.in_first_pick) asc,
    cand.deficit desc,
    cand.last_assignment_at asc nulls first,
    cand.customer_created_at asc
  limit greatest(p_max, 0);
$$;

revoke execute on function public.get_brief_candidates_for_lead(uuid, integer, boolean) from public, anon, authenticated;
grant execute on function public.get_brief_candidates_for_lead(uuid, integer, boolean) to service_role;
