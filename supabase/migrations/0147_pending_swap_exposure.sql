-- ==========================================================================
-- 0147 — HOW MUCH REPLACEMENT COST IS QUEUED UP AND HAS NOT BEEN TAKEN
-- ==========================================================================
--
-- §53's Deferred list carried this, left open by 0145: "The lag itself is
-- still open. The ceiling reflects the last 28 days of withdrawals where the
-- exposure is the entitlement every customer is holding and has not spent.
-- `withdrawn_slots_per_month` is the number that makes that gap visible;
-- nothing acts on it, and §16 says nothing gates on this panel."
--
-- ---------------------------------------------------------------------------
-- §1 — WHAT THE LAG IS, AND WHY IT IS NOT AN ARITHMETIC ERROR
-- ---------------------------------------------------------------------------
-- 0145 established that the cost of a swap is already inside the ceiling: the
-- clamp lowers `slots_per_month` the instant a lead is withdrawn, and the
-- replacement half is already charged into `avg_allocation_with_swaps`. So
-- nothing here is under-counted. What is missing is TIMING.
--
-- `withdrawn_slots_per_month` reads `observed` once anything has actually been
-- withdrawn inside the 28-day window, and an observation of zero is a perfectly
-- truthful statement about a month in which nobody claimed. It says nothing at
-- all about how many replacements are sitting there waiting to be taken, and
-- those can all land in an afternoon.
--
-- ⚠️ SO THE FIGURE THIS ADDS IS A STANDING STOCK, NOT A RATE, AND IT MUST NEVER
-- BE ADDED TO ANY CEILING. §18.1's rule in its original form: supply that
-- REFILLS decides the ceiling, supply that clears once is reported beside it
-- and never added. This is the demand-side mirror of `inventory_slots_now` —
-- one-off, live, and reported alongside.
--
-- ---------------------------------------------------------------------------
-- §2 — MEASURED FIRST, AND THE MEASUREMENT CHANGED THE SHAPE
-- ---------------------------------------------------------------------------
-- The obvious figure is the unspent entitlement: 31 replacements across the
-- book on the day this was written, against 0 ever claimed. Reporting that
-- would have been wrong by more than a factor of two.
--
--   holders of a product                     23
--   unspent entitlement                      31
--   of those, customers with anything
--     inside the 14-day claim window         11
--   claimable assignments they hold          72
--   REPLACEMENTS ACTUALLY TAKEABLE TODAY     13   (12 management, 1 GR)
--
-- Entitlement with nothing to spend it on is not exposure, and 18 of the 31 is
-- exactly that. The figure is therefore bounded by BOTH halves, per customer:
-- `least(remaining entitlement, claimable assignments of this product)`.
--
-- At today's average withdrawal cost that is about 14.0 management slots and
-- 2.5 GR slots that could leave supply at any moment, against a management
-- inventory of 158 free slots.
--
-- ⚠️ THIS FIGURE AND `withdrawn_slots_per_month` WILL OFTEN DISAGREE, AND THAT
-- IS NOT A FAULT IN EITHER. One is a monthly rate, the other is what is queued
-- right now. Before any swap has happened the rate is an ESTIMATE built from
-- the modelled claim demand (29.3 management slots a month) and reads ABOVE the
-- standing stock; after the first swap it becomes an OBSERVATION and can read
-- far below it. The second case is the lag this exists to make visible.
--
-- ---------------------------------------------------------------------------
-- §3 — NOTHING GATES ON IT, DELIBERATELY
-- ---------------------------------------------------------------------------
-- §16 is explicit that no capacity figure refuses anybody, and §18.1 that this
-- panel is reporting and admin judgement. The real back-pressure already
-- exists and is elsewhere: `replacement_stock_floor` (§53.3) refuses a customer
-- swap when the product's unsold pool runs thin, at the moment of the swap and
-- on the product's own stock. This is the number that tells an admin whether
-- that floor is about to be tested.
-- ==========================================================================


-- ---------------------------------------------------------------------------
-- 1 — The capacity model reports the standing exposure
--
-- ⚠️ DROP AND CREATE, because the return type gains columns and Postgres
-- refuses a `create or replace` that changes RETURNS TABLE. THE DROP DISCARDS
-- THE ACL (§11: 0028 revoked schema-wide, then 0038 dropped a function and
-- handed it back to anon), so the revoke and the grant below are load-bearing
-- — and ⚠️ THE `anon` GRANT MUST NOT COME BACK: 0140 dropped an entire
-- function for exposing exactly these figures to anon.
--
-- 0145's body verbatim with two CTEs added, one join in `calc`, and two
-- columns appended to the return list. Every existing column keeps its
-- position and its expression.
-- ---------------------------------------------------------------------------
drop function if exists public.get_service_capacity();

create or replace function public.get_service_capacity()
returns table (lead_type lead_type, leads_per_month numeric, slots_per_month numeric, recycled_slots_per_month numeric, serviceable_slots_per_month numeric, recycling_basis text, recycled_slots_now integer, unworked_rate numeric, recycling_sample integer, inventory_slots_now integer, unsold_leads_now integer, demand_per_month integer, delivered_per_month numeric, active_customers integer, fully_served integer, avg_allocation numeric, sustainable_customers integer, sustainable_customers_new_only integer, room_for_customers integer, paused_customers integer, paused_demand integer, quality_claim_demand_per_month integer, avg_allocation_with_swaps numeric, sustainable_customers_before_swaps integer, withdrawn_slots_per_month numeric, avg_withdrawal_cost numeric, withdrawal_basis text, swaps_available_now integer, swap_slots_now numeric)
language sql
stable
security definer
set search_path = public
as $function$
  with w as (select 28 as days),
  rw as (select 90 as days),
  supply as (
    select
      lt.lead_type,
      count(l.id)                         as leads_in_window,
      coalesce(sum(l.max_assignments), 0) as slots_in_window,
      count(l.id) filter (where l.max_assignments < 5) as one_rung_headroom
    from (select unnest(enum_range(null::public.lead_type)) as lead_type) lt
    left join public.leads l
      on l.lead_type = lt.lead_type
     and l.created_at >= now() - make_interval(days => (select days from w))
    group by lt.lead_type
  ),
  delivered as (
    select lt.lead_type, count(la.id) as n
    from (select unnest(enum_range(null::public.lead_type)) as lead_type) lt
    left join public.leads l on l.lead_type = lt.lead_type
    left join public.lead_assignments la
      on la.lead_id = l.id
     and la.assigned_at >= now() - make_interval(days => (select days from w))
    group by lt.lead_type
  ),
  observed as (
    select
      lt.lead_type,
      (count(*) filter (where la.escalation_stage_1_at >= now() - make_interval(days => (select days from w)))
       + count(*) filter (where la.escalation_stage_2_at >= now() - make_interval(days => (select days from w))))::integer as n
    from (select unnest(enum_range(null::public.lead_type)) as lead_type) lt
    left join public.leads l on l.lead_type = lt.lead_type
    left join public.lead_assignments la on la.lead_id = l.id
    group by lt.lead_type
  ),
  recycling as (
    select
      lt.lead_type,
      count(la.id)::integer as sample_10,
      count(la.id) filter (where not la.active_by_10)::integer as escalates_at_10
    from (select unnest(enum_range(null::public.lead_type)) as lead_type) lt
    left join (
      select
        a.id, l.lead_type,
        (exists (select 1 from public.lead_events e
                  where e.assignment_id = a.id
                    and e.event_type in ('tel_click', 'mailto_click', 'whatsapp_click', 'stage_changed')
                    and e.created_at < a.assigned_at + interval '10 days')
         or exists (select 1 from public.lead_notes n
                     where n.lead_assignment_id = a.id
                       and n.created_at < a.assigned_at + interval '10 days')
         or (a.status <> 'new'
             and a.last_status_change_at < a.assigned_at + interval '10 days')
        ) as active_by_10
      from public.lead_assignments a
      join public.leads l on l.id = a.lead_id
      where a.assigned_at <= now() - interval '10 days'
        and a.assigned_at >= now() - make_interval(days => (select days from rw))
        and a.closed_at is null
        and a.status not in ('won', 'rejected')
    ) la on la.lead_type = lt.lead_type
    group by lt.lead_type
  ),
  passable as (
    select
      lt.lead_type,
      count(distinct a.lead_id)::integer as n
    from (select unnest(enum_range(null::public.lead_type)) as lead_type) lt
    left join public.leads l on l.lead_type = lt.lead_type
    left join public.lead_assignments a
      on a.lead_id = l.id
     and a.assigned_at <= now() - interval '10 days'
     and a.inactivity_escalation_stage < 2
     and a.status not in ('won', 'rejected')
     and a.closed_at is null
     and l.max_assignments < 5
     and not exists (
       select 1 from public.lead_assignments closed
       where closed.lead_id = a.lead_id and closed.closed_at is not null
     )
     and not (
       exists (select 1 from public.lead_events e
                where e.assignment_id = a.id
                  and e.event_type in ('tel_click', 'mailto_click', 'whatsapp_click', 'stage_changed')
                  and e.created_at >= now() - interval '10 days')
       or exists (select 1 from public.lead_notes n
                   where n.lead_assignment_id = a.id
                     and n.created_at >= now() - interval '10 days')
       or (a.status <> 'new'
           and a.last_status_change_at >= now() - interval '10 days')
     )
    group by lt.lead_type
  ),
  served as (
    select
      'management'::public.lead_type as lead_type,
      count(*)::integer as customers,
      count(*) filter (where got >= promised)::integer as fully_served,
      coalesce(round(avg(promised), 1), 0) as avg_alloc,
      coalesce(sum(promised), 0)::integer as demand,
      coalesce(round(avg(promised * (1 + coalesce(pct, 0.10))), 1), 0) as avg_alloc_with_swaps,
      coalesce(round(sum(promised * coalesce(pct, 0.10))), 0)::integer as swap_demand
    from (
      select c.id, c.monthly_allocation as promised,
        c.quality_allowance_pct as pct,
        (select count(*) from public.lead_assignments la
           join public.leads l on l.id = la.lead_id
          where la.customer_id = c.id and l.lead_type = 'management'
            and la.assigned_at >= coalesce(c.billing_cycle_anchor, c.created_at::date)
        ) as got
      from public.customers c
      where c.is_active and c.account_status = 'active'
        and c.subscription_status = 'active'
        and c.paused_at is null
    ) m
    union all
    select
      'guaranteed_rent'::public.lead_type,
      count(*)::integer,
      count(*) filter (where got >= promised)::integer,
      coalesce(round(avg(promised), 1), 0),
      coalesce(sum(promised), 0)::integer,
      coalesce(round(avg(promised * (1 + coalesce(pct, 0.10))), 1), 0),
      coalesce(round(sum(promised * coalesce(pct, 0.10))), 0)::integer
    from (
      select c.id, c.gr_monthly_allocation as promised,
        c.quality_allowance_pct as pct,
        (select count(*) from public.lead_assignments la
           join public.leads l on l.id = la.lead_id
          where la.customer_id = c.id and l.lead_type = 'guaranteed_rent'
            and la.assigned_at >= coalesce(c.gr_billing_cycle_anchor, c.created_at::date)
        ) as got
      from public.customers c
      where c.is_active and c.gr_subscription_status = 'active'
    ) g
  ),
  paused_side as (
    select
      'management'::public.lead_type as lead_type,
      count(*)::integer as n,
      coalesce(sum(c.monthly_allocation), 0)::integer as demand
    from public.customers c
    where c.is_active and c.account_status = 'active'
      and c.subscription_status = 'active'
      and c.paused_at is not null
    union all
    select 'guaranteed_rent'::public.lead_type, 0, 0
  ),
  -- 0147. THE STANDING EXPOSURE — replacements customers could take TODAY.
  --
  -- ⚠️ REPORTED, NEVER ADDED, on the same rule 0145 states one CTE below. The
  -- replacement half of a swap is already charged into avg_alloc_with_swaps and
  -- the withdrawn half lands inside slots_pm the instant it happens, so this
  -- figure is a LABEL ON TIMING and not a third supply term. What it answers is
  -- the one thing neither of those can: how much of that cost is queued up and
  -- has not been taken yet.
  --
  -- ⚠️ THIS IS A SECOND READING OF THE ALLOWANCE INSIDE ONE FUNCTION, and the
  -- two are deliberately different rather than drifted. `swap_demand` in the
  -- served CTE models the recurring monthly RATE over the population the
  -- ceiling is about (active, unpaused, per product). This one is the standing
  -- STOCK over the population that can actually claim, and it is the faithful
  -- transcription of `claimBudget()` in src/lib/quality/deadLeadPolicy.ts —
  -- `holdsProduct`'s OR, both allocations under one budget, and 0142's earned
  -- bonus. If they are ever reconciled, THIS is the one to keep.
  entitlement as (
    select
      c.id,
      c.paused_at,
      greatest(
        greatest(round((
          (case when (c.account_status = 'active'
                   or c.subscription_status in ('active', 'past_due'))
                then coalesce(c.monthly_allocation, 0) else 0 end)
          + (case when c.gr_subscription_status in ('active', 'past_due')
                then coalesce(c.gr_monthly_allocation, 0) else 0 end)
        ) * coalesce(c.quality_allowance_pct, 0.10))::integer, 0)
        + least(floor(coalesce(c.clean_leads_streak, 0) / 10)::integer, 2)
        - coalesce(c.quality_claims_this_cycle, 0),
      0)::integer as remaining
    from public.customers c
    where c.is_active
      and (c.account_status = 'active'
        or c.subscription_status in ('active', 'past_due')
        or c.gr_subscription_status in ('active', 'past_due'))
  ),
  -- ⚠️ BOUNDED BY BOTH HALVES, and the second half is what makes the figure
  -- worth having. Entitlement alone reads 31 across the book; only 13 of it
  -- sits with a customer who also has something inside the claim window, and
  -- quoting 31 would be an alarm about leads that cannot be reported.
  --
  -- ⚠️ CALLS claimable_dead_lead_assignments RATHER THAN RESTATING IT, with its
  -- own default window, so the claim rule has no second copy here and the
  -- 14 is not written down twice (§34, §35). The window is the longest of the
  -- six reasons — `already_with_operator` is 7 — so this is an upper bound on
  -- the count, which is the safe direction for an exposure figure.
  --
  -- ⚠️ A PAUSED MANAGEMENT CUSTOMER IS EXCLUDED FROM THE MANAGEMENT ROW ONLY.
  -- admin_swap_lead_assignment raises on one, so their entitlement is not
  -- exposure — they cannot spend it. §21 excludes paused customers from every
  -- allocation metric on exactly this reasoning, management branch only
  -- (invariant 6): GR keeps flowing to a paused management customer, and GR has
  -- no pause of its own.
  --
  -- A dual-product customer's one budget is counted against BOTH rows, as
  -- swap_demand already does. There are none today; it overstates rather than
  -- understates, which is the safe direction here too.
  pending as (
    select
      lt.lead_type,
      coalesce(sum(least(x.remaining, x.n)), 0)::integer as swaps_now
    from (select unnest(enum_range(null::public.lead_type)) as lead_type) lt
    left join (
      select l.lead_type, e.id, e.remaining, count(*) as n
      from entitlement e
      cross join lateral public.claimable_dead_lead_assignments(e.id) cda
      join public.leads l on l.id = cda.lead_id
      -- ⚠️ NO `remaining > 0` SHORT-CIRCUIT HERE, deliberately. It would save a
      -- lateral call per spent customer and it would also make the zero clamp
      -- above unobservable — a guard no test could ever fail, which is §50.9's
      -- shape and what the mutation run on this migration actually found. The
      -- clamp is the rule (a reviewed uphold can push the counter past the
      -- entitlement, §53), so the clamp stays and the short-circuit goes.
      where (l.lead_type = 'guaranteed_rent' or e.paused_at is null)
      group by l.lead_type, e.id, e.remaining
    ) x on x.lead_type = lt.lead_type
    group by lt.lead_type
  ),
  -- 0145. What swaps have actually destroyed inside the supply window.
  --
  -- Measured on withdrawn_at, not created_at: this is a flow of destruction
  -- events, where every other CTE here is a flow of arrivals.
  --
  -- ⚠️ Rows withdrawn before 0145 carry a NULL and are INVISIBLE here rather
  -- than counted as zero. Their caps were overwritten by the clamp and cannot
  -- be recovered, and a zero would read as "that swap cost nothing" — the one
  -- reading this column exists to prevent. It self-clears 28 days after apply.
  withdrawn as (
    select
      lt.lead_type,
      coalesce(sum(l.withdrawn_slots), 0)::numeric as slots_lost,
      count(l.id)::integer                         as n
    from (select unnest(enum_range(null::public.lead_type)) as lead_type) lt
    left join public.leads l
      on l.lead_type = lt.lead_type
     and l.withdrawn_slots is not null
     and l.withdrawn_at >= now() - make_interval(days => (select days from w))
    group by lt.lead_type
  ),
  -- What withdrawing a lead somebody holds right now would cost, averaged per
  -- ASSIGNMENT because a report is made by an assignment: a lead held by three
  -- operators is three chances to incur a cost of one each, where a lead held
  -- by one is a single chance to incur three. Per lead would over-weight the
  -- expensive singly-held ones.
  --
  -- ⚠️ DELIBERATELY NOT A COPY OF claimable_dead_lead_assignments, and it must
  -- never become one. That predicate decides whether money moves; this feeds an
  -- estimate labelled `estimated`. §34 and §35 both record what a hand-written
  -- second copy of a live rule costs, so this population is defined by the
  -- WITHDRAWAL mechanics instead — an open assignment on a lead that can still
  -- be withdrawn — and shares no clause with the claim rule beyond what those
  -- mechanics require.
  --
  -- The known skew, stated rather than hidden: reports arrive within days of
  -- assignment and this averages over every held lead, including older ones
  -- that have since filled up and cost less to withdraw. So it reads LOW —
  -- 1.17 against 1.53 over the 14-day claim window for management at the time
  -- of writing.
  withdrawal_cost as (
    select
      lt.lead_type,
      coalesce(round(avg(h.cost), 2), 0) as avg_cost
    from (select unnest(enum_range(null::public.lead_type)) as lead_type) lt
    left join (
      select
        l.lead_type,
        greatest(l.max_assignments - greatest(l.assignment_count - 1, 0), 0) as cost
      from public.lead_assignments la
      join public.leads l on l.id = la.lead_id
      where la.status not in ('won', 'rejected')
        and la.closed_at is null
        and l.withdrawn_at is null
        and l.owner_customer_id is null
    ) h on h.lead_type = lt.lead_type
    group by lt.lead_type
  ),
  inventory as (
    select
      lt.lead_type,
      coalesce(sum(greatest(l.max_assignments - l.assignment_count, 0)), 0)::integer as open_slots,
      count(l.id) filter (where l.assignment_count = 0)::integer                     as unsold
    from (select unnest(enum_range(null::public.lead_type)) as lead_type) lt
    left join public.leads l on l.lead_type = lt.lead_type
    group by lt.lead_type
  ),
  calc as (
    select
      s.lead_type,
      round(s.leads_in_window * 30.0 / (select days from w), 1) as leads_pm,
      round(s.slots_in_window * 30.0 / (select days from w), 1) as slots_pm,
      round(d.n * 30.0 / (select days from w), 1)               as delivered_pm,
      round(o.n * 30.0 / (select days from w), 1)               as observed_pm,
      o.n                                                        as observed_raw,
      r.sample_10 as sample,
      case when r.sample_10 > 0
           then round(r.escalates_at_10::numeric / r.sample_10, 4) end as rate_10,
      round(s.one_rung_headroom * 30.0 / (select days from w), 1) as headroom_pm,
      sv.demand, sv.customers, sv.fully_served, sv.avg_alloc,
      sv.avg_alloc_with_swaps, sv.swap_demand,
      i.open_slots, i.unsold, p.n as passable_now,
      ps.n as paused_n, ps.demand as paused_demand,
      wd.slots_lost, wd.n as withdrawn_n, wc.avg_cost as withdrawal_cost,
      pg.swaps_now
    from supply s
    join delivered d  on d.lead_type = s.lead_type
    join served sv    on sv.lead_type = s.lead_type
    join paused_side ps on ps.lead_type = s.lead_type
    join inventory i  on i.lead_type = s.lead_type
    join recycling r  on r.lead_type = s.lead_type
    join observed o   on o.lead_type = s.lead_type
    join passable p   on p.lead_type = s.lead_type
    join withdrawn wd on wd.lead_type = s.lead_type
    join withdrawal_cost wc on wc.lead_type = s.lead_type
    join pending pg  on pg.lead_type = s.lead_type
  ),
  scored as (
    select
      c.*,
      case when c.observed_raw > 0 then 'observed' else 'estimated' end as basis,
      least(
        case
          when c.observed_raw > 0 then c.observed_pm
          else round(c.delivered_pm * coalesce(c.rate_10, 0), 1)
        end,
        c.headroom_pm
      ) as recycled_pm
    from calc c
  )
  select
    s.lead_type,
    s.leads_pm,
    s.slots_pm,
    s.recycled_pm,
    round(s.slots_pm + s.recycled_pm, 1),
    s.basis,
    s.passable_now,
    s.rate_10,
    s.sample,
    s.open_slots,
    s.unsold,
    s.demand,
    s.delivered_pm,
    s.customers,
    s.fully_served,
    s.avg_alloc,
    case when s.avg_alloc_with_swaps > 0
         then floor((s.slots_pm + s.recycled_pm) / s.avg_alloc_with_swaps)::integer
         else 0 end,
    case when s.avg_alloc_with_swaps > 0
         then floor(s.slots_pm / s.avg_alloc_with_swaps)::integer
         else 0 end,
    case when s.avg_alloc_with_swaps > 0
         then greatest(
           floor((s.slots_pm + s.recycled_pm) / s.avg_alloc_with_swaps)::integer - s.customers,
           0)
         else 0 end,
    s.paused_n,
    s.paused_demand,
    s.swap_demand,
    s.avg_alloc_with_swaps,
    case when s.avg_alloc > 0
         then floor((s.slots_pm + s.recycled_pm) / s.avg_alloc)::integer
         else 0 end,
    -- 0145. ⚠️ REPORTED, NEVER ADDED TO ANY CEILING ABOVE, and never folded
    -- into avg_alloc_with_swaps. slots_pm is sum(max_assignments) over the
    -- window and the swap's clamp lowers it the instant a withdrawal happens,
    -- so the cost is already inside serviceable_slots_per_month. Charging it a
    -- second time in the divisor would double-count it. What this figure is
    -- for is the LAG: the ceiling reflects the last 28 days of withdrawals, not
    -- the entitlement every customer is holding and has not yet spent.
    case when s.withdrawn_n > 0
         then round(s.slots_lost * 30.0 / (select days from w), 1)
         else round(s.swap_demand * s.withdrawal_cost, 1) end,
    s.withdrawal_cost,
    -- §18.2's rule: an estimate must never be read as a count.
    case when s.withdrawn_n > 0 then 'observed' else 'estimated' end,
    -- 0147. A live count, so no basis column: it is observed by construction,
    -- and a third basis that could only ever read 'observed' would be noise.
    s.swaps_now,
    -- What those would take out of supply if every one were taken today. It
    -- carries a decimal because avg_withdrawal_cost is a modelled average —
    -- which is the whole of §18.2's rule applied without a second label.
    --
    -- ⚠️ THE REPLACEMENT LEAD ITSELF IS NOT COUNTED HERE. Each swap also takes
    -- one lead out of stock, and that half is already charged into
    -- avg_alloc_with_swaps. Adding it would be the double-count §53.11 exists
    -- to stop.
    round(s.swaps_now * s.withdrawal_cost, 1)
  from scored s;
$function$;

revoke execute on function public.get_service_capacity() from public, anon, authenticated;
grant execute on function public.get_service_capacity() to service_role;


-- ---------------------------------------------------------------------------
-- 2 — The daily series carries it too
--
-- Nullable and NOT backfilled (0084's rule, restated by §53.4 and §53.11): a
-- zero on an older row would read as "nothing was queued that day" rather than
-- "we were not measuring". §18.2 adds that these rows cannot be recomputed —
-- get_service_capacity reads live state, so a missed day is gone. The series
-- has a definition change at this date; a step there is not a business event.
--
-- The trend is the point here more than the level: as swaps actually start
-- happening, `withdrawn_slots_per_month` should rise toward `swap_slots_now`
-- and the gap between them is how much of the cost is still queued.
-- ---------------------------------------------------------------------------
alter table public.service_capacity_snapshots
  add column if not exists swaps_available_now integer,
  add column if not exists swap_slots_now      numeric;

-- 0145's body carried forward with the two names added to ALL THREE lists.
--
-- ⚠️ THE `on conflict ... do update` LIST IS THE ONE THAT GETS FORGOTTEN, and
-- forgetting it fails silently: the day's FIRST capture writes the new columns
-- and every same-day re-run leaves them stale, with no error. The escalation
-- cron does re-run.
create or replace function public.capture_service_capacity()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  insert into public.service_capacity_snapshots (
    captured_on, lead_type, leads_per_month, slots_per_month,
    recycled_slots_per_month, serviceable_slots_per_month, recycling_basis,
    recycled_slots_now, unworked_rate, recycling_sample,
    inventory_slots_now, unsold_leads_now, demand_per_month, delivered_per_month,
    active_customers, fully_served, avg_allocation,
    sustainable_customers, sustainable_customers_new_only, room_for_customers,
    paused_customers, paused_demand,
    quality_claim_demand_per_month, avg_allocation_with_swaps,
    sustainable_customers_before_swaps,
    withdrawn_slots_per_month, avg_withdrawal_cost, withdrawal_basis,
    swaps_available_now, swap_slots_now
  )
  select
    current_date, c.lead_type, c.leads_per_month, c.slots_per_month,
    c.recycled_slots_per_month, c.serviceable_slots_per_month, c.recycling_basis,
    c.recycled_slots_now, c.unworked_rate, c.recycling_sample,
    c.inventory_slots_now, c.unsold_leads_now, c.demand_per_month,
    c.delivered_per_month, c.active_customers, c.fully_served, c.avg_allocation,
    c.sustainable_customers, c.sustainable_customers_new_only, c.room_for_customers,
    c.paused_customers, c.paused_demand,
    c.quality_claim_demand_per_month, c.avg_allocation_with_swaps,
    c.sustainable_customers_before_swaps,
    -- ⚠️ The column is integer and the function returns numeric, so this
    -- rounds rather than truncating. A silent floor would make every daily
    -- snapshot read low against the live panel beside it.
    round(c.withdrawn_slots_per_month)::integer,
    c.avg_withdrawal_cost, c.withdrawal_basis,
    c.swaps_available_now, c.swap_slots_now
  from public.get_service_capacity() c
  on conflict (lead_type, captured_on) do update set
    leads_per_month       = excluded.leads_per_month,
    slots_per_month       = excluded.slots_per_month,
    recycled_slots_per_month = excluded.recycled_slots_per_month,
    serviceable_slots_per_month = excluded.serviceable_slots_per_month,
    recycling_basis       = excluded.recycling_basis,
    recycled_slots_now    = excluded.recycled_slots_now,
    unworked_rate         = excluded.unworked_rate,
    recycling_sample      = excluded.recycling_sample,
    inventory_slots_now   = excluded.inventory_slots_now,
    unsold_leads_now      = excluded.unsold_leads_now,
    demand_per_month      = excluded.demand_per_month,
    delivered_per_month   = excluded.delivered_per_month,
    active_customers      = excluded.active_customers,
    fully_served          = excluded.fully_served,
    avg_allocation        = excluded.avg_allocation,
    sustainable_customers = excluded.sustainable_customers,
    sustainable_customers_new_only = excluded.sustainable_customers_new_only,
    room_for_customers    = excluded.room_for_customers,
    paused_customers      = excluded.paused_customers,
    paused_demand         = excluded.paused_demand,
    quality_claim_demand_per_month = excluded.quality_claim_demand_per_month,
    avg_allocation_with_swaps      = excluded.avg_allocation_with_swaps,
    sustainable_customers_before_swaps = excluded.sustainable_customers_before_swaps,
    withdrawn_slots_per_month = excluded.withdrawn_slots_per_month,
    avg_withdrawal_cost       = excluded.avg_withdrawal_cost,
    withdrawal_basis          = excluded.withdrawal_basis,
    swaps_available_now       = excluded.swaps_available_now,
    swap_slots_now            = excluded.swap_slots_now;
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke execute on function public.capture_service_capacity()
  from public, anon, authenticated;
grant execute on function public.capture_service_capacity() to service_role;
