-- ============================================================================
-- 0154 — A fresh lead skips the pacing curve, never the cap (CLAUDE.md §63)
--
-- §54 hands each customer one lead per UK working day, and the 07:30 morning
-- pass fills that slot from BANKED stock before any new lead has arrived. So a
-- lead that lands at 11am — now within minutes of appearing on the board, via
-- the five-minute poll this migration also switches — would bank until the
-- next morning for almost everyone, and "notified the moment it comes in"
-- would rarely be felt.
--
-- The rule gains one clause: a lead younger than `release_fresh_hours` skips
-- the curve check (`received >= allowance`) and NOTHING ELSE. The hold, the
-- entitlement (`received + balance <= 0`) and the daily cap
-- (`release_max_per_day`) still refuse. The candidate WHERE clauses still
-- require `lead_balance > 0`. A fresh lead can therefore reach anyone with
-- credit and a slot left today, and the daily cap is what bounds it.
--
-- ⚠️ INERT ON APPLY. `release_fresh_hours` is seeded '0', which means OFF, and
-- at 0 the three-argument body is 0148's body line for line. The deployed
-- code keeps calling the two-argument form, which is now a shim passing NULL
-- — and NULL is never fresh. So production behaviour is byte-identical from
-- the moment this applies until an admin sets the window, whichever order
-- the code and the migration land in (§1.1). 24 is the recommended value, set
-- from /admin/allocation, never seeded.
--
-- ⚠️ ZERO DEFAULTS ON THE THREE-ARGUMENT FORM. The 0148 suite calls
-- `customer_release_allows('<uuid>')` with ONE argument, which resolves
-- through the two-argument form's `default 'management'`. A default on the
-- new form's second argument would make that call `function is not unique`
-- — §34's and §35's overload trap, one layer down. `pronargdefaults` is
-- asserted 0 on the new form and 1 on the shim.
--
-- Also seeds `lead_sync_enabled` = 'false' for the five-minute poll
-- (/api/cron/monday-lead-sync), which reads it by name and treats a missing
-- row as off.
--
-- Applied to production with comments stripped OUTSIDE function bodies only,
-- so every prosrc matches this file (§48.9, §51.10).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Settings. Both ship OFF.
-- ---------------------------------------------------------------------------
insert into public.system_settings (key, value)
values
  ('release_fresh_hours', '0'),
  ('lead_sync_enabled', 'false')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. The rule, three-argument form. 0148's body with the fresh clause added.
--    ⚠️ NO DEFAULT ON ANY ARGUMENT — see the header.
-- ---------------------------------------------------------------------------
create or replace function public.customer_release_allows(
  p_customer_id     uuid,
  p_lead_type       public.lead_type,
  p_lead_created_at timestamptz
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_enabled     boolean;
  v_max_per_day integer;
  v_cycle_days  integer;
  v_fresh_hours integer;
  v_fresh       boolean := false;
  v_c           public.customers%rowtype;
  v_anchor      date;
  v_hold        date;
  v_received    integer;
  v_balance     integer;
  v_today       date := (now() at time zone 'Europe/London')::date;
  v_w           integer;
  v_k           integer;
  v_e           integer;
  v_allowance   integer;
  v_today_n     integer;
begin
  select coalesce(btrim(value) = 'true', false) into v_enabled
    from public.system_settings where key = 'release_enabled';
  if not coalesce(v_enabled, false) then
    return true;
  end if;

  select * into v_c from public.customers where id = p_customer_id;
  if not found then
    return false;
  end if;
  if v_c.release_mode = 'immediate' then
    return true;
  end if;

  v_max_per_day := greatest(public.pool_setting_int('release_max_per_day', 2), 1);
  v_cycle_days  := greatest(public.pool_setting_int('release_cycle_days', 30), 1);

  -- 0 (the seeded value, and a missing row) means OFF: nothing is ever fresh.
  v_fresh_hours := greatest(public.pool_setting_int('release_fresh_hours', 0), 0);
  v_fresh := p_lead_created_at is not null
         and v_fresh_hours > 0
         and p_lead_created_at > now() - make_interval(hours => v_fresh_hours);

  if p_lead_type = 'guaranteed_rent' then
    v_anchor   := coalesce(v_c.gr_billing_cycle_anchor, v_c.created_at::date);
    v_hold     := v_c.gr_release_hold_until;
    v_received := coalesce(v_c.gr_leads_received_this_month, 0);
    v_balance  := coalesce(v_c.gr_lead_balance, 0);
  else
    v_anchor   := coalesce(v_c.billing_cycle_anchor, v_c.created_at::date);
    v_hold     := v_c.release_hold_until;
    v_received := coalesce(v_c.leads_received_this_month, 0);
    v_balance  := coalesce(v_c.lead_balance, 0);
  end if;

  -- A hold refuses outright; the day it names is the day leads resume.
  -- ⚠️ A fresh lead does NOT bypass a hold — "hold my leads" means all of them.
  if v_hold is not null and v_today < v_hold then
    return false;
  end if;

  v_e := v_received + v_balance;
  if v_e <= 0 then
    return false;
  end if;

  v_w := greatest(public.working_days_between(v_anchor, v_anchor + (v_cycle_days - 1)), 1);
  v_k := public.working_days_between(v_anchor, v_today);
  v_allowance := least(v_e, ceil((v_k::numeric * v_e) / v_w)::integer);

  -- The curve, bypassed for a fresh lead. NEVER the hold above, NEVER the
  -- entitlement above, NEVER the daily cap below.
  if not v_fresh and v_received >= v_allowance then
    return false;
  end if;

  select count(*)::integer into v_today_n
    from public.lead_assignments la
    join public.leads l on l.id = la.lead_id
   where la.customer_id = p_customer_id
     and l.lead_type = p_lead_type
     and (la.assigned_at at time zone 'Europe/London')::date = v_today;

  return v_today_n < v_max_per_day;
end;
$$;

revoke execute on function public.customer_release_allows(uuid, public.lead_type, timestamptz) from public, anon, authenticated;
grant execute on function public.customer_release_allows(uuid, public.lead_type, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- 3. The two-argument form becomes a shim. It keeps its default so the
--    one-argument call in the 0148 suite (and any older caller) resolves to
--    it, and it passes NULL, which is never fresh — so old code sees 0148's
--    behaviour exactly.
-- ---------------------------------------------------------------------------
create or replace function public.customer_release_allows(
  p_customer_id uuid,
  p_lead_type public.lead_type default 'management'
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.customer_release_allows(p_customer_id, p_lead_type, null::timestamptz);
$$;

revoke execute on function public.customer_release_allows(uuid, public.lead_type) from public, anon, authenticated;
grant execute on function public.customer_release_allows(uuid, public.lead_type) to service_role;

-- ---------------------------------------------------------------------------
-- 4. The two ordinary-routing candidate functions — 0148's bodies verbatim
--    with ONE change each: the release call passes the lead's created_at.
--    Signatures unchanged, so no overload. ACLs re-asserted (§11).
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
