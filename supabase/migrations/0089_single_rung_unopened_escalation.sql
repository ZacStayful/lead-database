-- ============================================================================
-- Escalation becomes one rung, triggered by "nobody opened it", ceiling 4.
--
-- WHAT THE RULE WAS
-- -----------------
-- Two rungs, day 10 and day 20, each gated on get_assignment_engagement_scores
-- — a weighted blend of eight signals in the engagement_weights table — against
-- thresholds of 0.35 and 0.45, with a ceiling of max_assignments = 5.
--
-- WHY IT IS BEING REPLACED
-- ------------------------
-- The signals the score weights most heavily barely exist. Across the whole
-- event history there are 2 tel_click and 1 mailto_click against 380
-- detail_opened. A weighted blend of columns that are almost always zero is not
-- a measurement of anything; in practice the score was a noisy proxy for "did
-- somebody open this lead".
--
-- Meanwhile the open itself became a real signal. detail_opened has been
-- recorded since telemetry_from (0047), and since the contact gate (0079) the
-- feed card no longer carries the landlord's phone or email — so opening the
-- detail page is the only route to a number. "Nobody opened it" is now both
-- high-volume and meaningful on its own.
--
-- So: a lead nobody has OPENED within 10 days goes to one more operator, once.
-- No score, no weights, no thresholds, no second rung.
--
-- WHY THE CEILING DROPS TO 4
-- --------------------------
-- One rung on a base of 3 can only ever produce a 4th holder. Leaving the
-- ceiling at 5 would leave a rung's worth of headroom that nothing can reach,
-- and get_service_capacity's clamp reads that ceiling to bound its estimate —
-- so a stale 5 would let the model promise a slot the ladder cannot deliver.
-- The increment stays +1, so a pre-0055 lead capped at 2 escalates to 3.
--
-- WHY "OPENED" IS detail_opened AND NOT viewed_at
-- -----------------------------------------------
-- CLAUDE.md §11 already warns the two are not equivalent, and 0079 is why:
-- viewed_at is set by expanding a card in the feed, which since the contact
-- gate proves nothing at all. 114 of 308 assignments were expanded and never
-- opened. Counting an expand as an open would exempt a lead from escalation on
-- the strength of a click that revealed no contact details.
--
-- get_customer_engagement_scores is a DIFFERENT function and is untouched: it
-- still drives reclaim recipient selection (§10).
--
-- engagement_weights and get_assignment_engagement_scores are left in place,
-- dormant, rather than dropped — nothing else calls them, and keeping them
-- makes a rollback a code change rather than a migration.
--
-- DEPLOYMENT ORDER: apply BEFORE the code. The cron relies on
-- get_escalation_candidates applying the opened test itself.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Candidate selection: cap < 4, and the opened test moves INTO the function.
--
-- The rule lives in one place rather than being split between SQL and the
-- route, for the reason §5E gives about reject: a route-side pre-flight and a
-- function-side gate are two expressions of one rule and will eventually
-- disagree.
--
-- The window is derived from p_min_age_days rather than hard-coded, so the
-- trigger age and the no-open window can never drift apart.
-- ---------------------------------------------------------------------------
create or replace function public.get_escalation_candidates(
  p_cutoff timestamptz,
  p_stage integer,
  p_min_age_days integer
)
returns table (
  assignment_id uuid,
  lead_id uuid,
  customer_id uuid,
  lead_type public.lead_type,
  assigned_at timestamptz,
  max_assignments integer,
  lead_age_days integer
)
language sql
stable security definer
set search_path to 'public'
as $function$
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
    and l.max_assignments < 4
    and not public.lead_retired_from_allocation(la.lead_id)
    and l.pool_entered_at is null
    and la.closed_at is null
    and not exists (
      select 1 from public.lead_assignments closed
      where closed.lead_id = la.lead_id
        and closed.closed_at is not null
    )
    -- The whole rule: nobody opened it inside its own first p_min_age_days.
    and not exists (
      select 1 from public.lead_events e
      where e.assignment_id = la.id
        and e.event_type = 'detail_opened'
        and e.created_at < la.assigned_at + make_interval(days => p_min_age_days)
    );
$function$;

revoke execute on function public.get_escalation_candidates(timestamptz, integer, integer)
  from public, anon, authenticated;
grant execute on function public.get_escalation_candidates(timestamptz, integer, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- 2. One rung, ceiling 4.
--
-- Stage 2 is refused outright rather than quietly ignored. A caller still
-- passing 2 is running against the old ladder, and a silent no-op there would
-- read as "nothing qualified" — the exact ambiguity the escalation cron's kill
-- switch was written to avoid.
-- ---------------------------------------------------------------------------
create or replace function public.escalate_lead_assignment(
  p_assignment_id uuid,
  p_new_customer_id uuid,
  p_price numeric,
  p_lead_type public.lead_type,
  p_stage integer
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_original public.lead_assignments%rowtype;
  v_lead     public.leads%rowtype;
  v_new_assignment_id uuid;
begin
  if p_stage <> 1 then
    raise exception 'Escalation is a single rung; stage must be 1, got %', p_stage;
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

  if v_original.status in ('won', 'rejected') then
    raise exception 'Assignment % is settled (status %) and cannot be escalated',
      p_assignment_id, v_original.status;
  end if;

  -- Lock order matches assign_lead_to_customer and claim_pool_lead: the lead
  -- after the assignment row, never the other way round.
  select * into v_lead from public.leads
    where id = v_original.lead_id for update;

  if v_lead.max_assignments >= 4 then
    raise exception 'Lead % is at the escalation ceiling (max_assignments = %)',
      v_original.lead_id, v_lead.max_assignments;
  end if;

  update public.leads
    set max_assignments = v_lead.max_assignments + 1
    where id = v_original.lead_id;

  v_new_assignment_id := public.assign_lead_to_customer(
    v_original.lead_id, p_new_customer_id, p_price, p_lead_type
  );

  update public.lead_assignments
    set inactivity_escalation_stage = p_stage,
        escalation_stage_1_at = now()
    where id = p_assignment_id;

  return v_new_assignment_id;
end;
$function$;

revoke execute on function public.escalate_lead_assignment(uuid, uuid, numeric, public.lead_type, integer)
  from public, anon, authenticated;
grant execute on function public.escalate_lead_assignment(uuid, uuid, numeric, public.lead_type, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- 3. Service capacity, corrected in four places.
--
-- (a) THE DOUBLE COUNT. slots_in_window summed leads.max_assignments — the
--     CURRENT cap, which escalation increments — and the observed CTE then
--     counted those same escalations again as recycled supply. It has been
--     harmless only because escalation has never fired: every assignment in
--     production sits at stage 0. Under the new rule ~68% of leads escalate
--     within 10 days of assignment, comfortably inside the 28-day window, so
--     almost every escalation would have been counted twice — inflating
--     sustainable_customers by roughly the whole recycled figure. The slot sum
--     now reports the BASE cap by subtracting each lead's own escalations.
--
-- (b) PER LEAD, NOT PER ASSIGNMENT. The estimate was delivered_pm * rate over
--     ASSIGNMENTS, but escalating raises a cap once per LEAD, and escalating
--     leads carry ~1.27 unopened holders each. §18.2 already states the
--     one-per-lead rule for recycled_slots_now; the per-month estimate never
--     followed it. It is now leads_pm * (share of LEADS with an unopened
--     holder), which is the same quantity recycled_slots_now counts.
--
-- (c) THE RATE WINDOW PREDATED THE TELEMETRY. The 90-day lookback reached back
--     before telemetry_from, where no detail_opened event can exist, so every
--     older assignment scored as "never opened" and the rate read a flat 100%.
--     The window is now floored at telemetry_from — the same marker 0047 added
--     and 0077 reasons about. Without this the rate is an artefact, not a
--     measurement.
--
-- (d) THE OLD CEILING. one_rung_headroom clamped on max_assignments < 5 and
--     passable on inactivity_escalation_stage < 2. Both now match the ladder
--     that exists.
--
-- The return signature is UNCHANGED, so serviceHealth.ts, ProductCapacity and
-- ServiceHealthPanel keep working untouched, and the panel keeps reading this
-- live on every /admin load.
-- ---------------------------------------------------------------------------
create or replace function public.get_service_capacity()
returns table (
  lead_type public.lead_type,
  leads_per_month numeric,
  slots_per_month numeric,
  recycled_slots_per_month numeric,
  serviceable_slots_per_month numeric,
  recycling_basis text,
  recycled_slots_now integer,
  unworked_rate numeric,
  recycling_sample integer,
  inventory_slots_now integer,
  unsold_leads_now integer,
  demand_per_month integer,
  delivered_per_month numeric,
  active_customers integer,
  fully_served integer,
  avg_allocation numeric,
  sustainable_customers integer,
  sustainable_customers_new_only integer,
  room_for_customers integer,
  paused_customers integer,
  paused_demand integer
)
language sql
stable security definer
set search_path to 'public'
as $function$
  with w as (select 28 as days),
  rw as (select 90 as days),
  -- The escalation rung, in one place so the CTEs below cannot drift from
  -- get_escalation_candidates.
  rung as (select 10 as days),
  -- Floor for anything measured from detail_opened. A malformed value reads as
  -- "no floor" rather than raising: this function is on the /admin critical
  -- path, and serviceHealth degrades the whole overview if it errors.
  tf as (
    select coalesce(
      (select nullif(trim(s.value), '')::timestamptz
         from public.system_settings s
        where s.key = 'telemetry_from'
          and s.value ~ '^\d{4}-\d{2}-\d{2}'),
      '-infinity'::timestamptz
    ) as ts
  ),
  supply as (
    select
      lt.lead_type,
      count(l.id)                                                as leads_in_window,
      coalesce(sum(l.max_assignments), 0)                        as raw_slots_in_window,
      coalesce(sum(esc.n), 0)                                    as escalated_in_window,
      count(l.id) filter (where l.max_assignments < 4)           as one_rung_headroom
    from (select unnest(enum_range(null::public.lead_type)) as lead_type) lt
    left join public.leads l
      on l.lead_type = lt.lead_type
     and l.created_at >= now() - make_interval(days => (select days from w))
    left join lateral (
      select count(*)::int as n
      from public.lead_assignments la
      where la.lead_id = l.id
        and la.inactivity_escalation_stage >= 1
    ) esc on true
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
      count(*) filter (
        where la.escalation_stage_1_at >= now() - make_interval(days => (select days from w))
      )::integer as n
    from (select unnest(enum_range(null::public.lead_type)) as lead_type) lt
    left join public.leads l on l.lead_type = lt.lead_type
    left join public.lead_assignments la on la.lead_id = l.id
    group by lt.lead_type
  ),
  -- Per LEAD: did it reach its rung with at least one holder who never opened
  -- it? That is exactly one extra slot, whether one holder ignored it or three.
  recycling as (
    select
      lt.lead_type,
      count(pl.lead_id)::integer                              as sample_10,
      count(pl.lead_id) filter (where pl.unopened >= 1)::integer as escalates_at_10
    from (select unnest(enum_range(null::public.lead_type)) as lead_type) lt
    left join (
      select
        l.lead_type,
        a.lead_id,
        count(*) filter (
          where not exists (
            select 1 from public.lead_events e
            where e.assignment_id = a.id
              and e.event_type = 'detail_opened'
              and e.created_at < a.assigned_at + make_interval(days => (select days from rung))
          )
        ) as unopened
      from public.lead_assignments a
      join public.leads l on l.id = a.lead_id
      where a.assigned_at <= now() - make_interval(days => (select days from rung))
        and a.assigned_at >= greatest(
              now() - make_interval(days => (select days from rw)),
              (select ts from tf)
            )
        and a.closed_at is null
        and a.status not in ('won', 'rejected')
      group by l.lead_type, a.lead_id
    ) pl on pl.lead_type = lt.lead_type
    group by lt.lead_type
  ),
  -- Leads passable RIGHT NOW: same test get_escalation_candidates applies,
  -- deduped to one per lead.
  passable as (
    select
      lt.lead_type,
      count(distinct a.lead_id)::integer as n
    from (select unnest(enum_range(null::public.lead_type)) as lead_type) lt
    left join public.leads l on l.lead_type = lt.lead_type
    left join public.lead_assignments a
      on a.lead_id = l.id
     and a.assigned_at <= now() - make_interval(days => (select days from rung))
     and a.inactivity_escalation_stage < 1
     and a.status not in ('won', 'rejected')
     and a.closed_at is null
     and l.max_assignments < 4
     and l.pool_entered_at is null
     and not exists (
       select 1 from public.lead_assignments closed
       where closed.lead_id = a.lead_id and closed.closed_at is not null
     )
     and not exists (
       select 1 from public.lead_events e
       where e.assignment_id = a.id
         and e.event_type = 'detail_opened'
         and e.created_at < a.assigned_at + make_interval(days => (select days from rung))
     )
    group by lt.lead_type
  ),
  served as (
    select
      'management'::public.lead_type as lead_type,
      count(*)::integer as customers,
      count(*) filter (where got >= promised)::integer as fully_served,
      coalesce(round(avg(promised), 1), 0) as avg_alloc,
      coalesce(sum(promised), 0)::integer as demand
    from (
      select c.id, c.monthly_allocation as promised,
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
      coalesce(sum(promised), 0)::integer
    from (
      select c.id, c.gr_monthly_allocation as promised,
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
      -- BASE slots: the cap before escalation touched it (fix a).
      round(greatest(s.raw_slots_in_window - s.escalated_in_window, 0)
              * 30.0 / (select days from w), 1)                 as slots_pm,
      round(d.n * 30.0 / (select days from w), 1)               as delivered_pm,
      round(o.n * 30.0 / (select days from w), 1)               as observed_pm,
      o.n                                                        as observed_raw,
      r.sample_10 as sample,
      case when r.sample_10 > 0
           then round(r.escalates_at_10::numeric / r.sample_10, 4) end as rate_10,
      round(s.one_rung_headroom * 30.0 / (select days from w), 1) as headroom_pm,
      sv.demand, sv.customers, sv.fully_served, sv.avg_alloc,
      i.open_slots, i.unsold, p.n as passable_now,
      ps.n as paused_n, ps.demand as paused_demand
    from supply s
    join delivered d    on d.lead_type = s.lead_type
    join served sv      on sv.lead_type = s.lead_type
    join paused_side ps on ps.lead_type = s.lead_type
    join inventory i    on i.lead_type = s.lead_type
    join recycling r    on r.lead_type = s.lead_type
    join observed o     on o.lead_type = s.lead_type
    join passable p     on p.lead_type = s.lead_type
  ),
  scored as (
    select
      c.*,
      case when c.observed_raw > 0 then 'observed' else 'estimated' end as basis,
      case
        -- OBSERVED IS A COUNT AND IS NEVER CLAMPED (fix e).
        --
        -- 0072 clamped both branches by one_rung_headroom, which is right for a
        -- projection and wrong for a tally: the headroom is "leads still below
        -- the ceiling RIGHT NOW", and escalating a lead is exactly what removes
        -- it from that set. So the more escalations actually happen, the
        -- smaller the bound applied to the count of them becomes. At steady
        -- state — ~68% of leads escalating, leaving ~32% below the ceiling —
        -- that would report roughly half the escalations that really occurred.
        --
        -- It has been harmless only because observed_raw has always been zero.
        -- Escalation firing for the first time is what makes it live.
        when c.observed_raw > 0 then c.observed_pm
        -- The ESTIMATE is still clamped: a projection must not promise more
        -- steps than there are leads with a step left to take (§18.2). Per
        -- LEAD, not per assignment (fix b).
        else least(round(c.leads_pm * coalesce(c.rate_10, 0), 1), c.headroom_pm)
      end as recycled_pm
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
    case when s.avg_alloc > 0
         then floor((s.slots_pm + s.recycled_pm) / s.avg_alloc)::integer
         else 0 end,
    case when s.avg_alloc > 0
         then floor(s.slots_pm / s.avg_alloc)::integer
         else 0 end,
    case when s.avg_alloc > 0
         then greatest(
           floor((s.slots_pm + s.recycled_pm) / s.avg_alloc)::integer - s.customers,
           0)
         else 0 end,
    s.paused_n,
    s.paused_demand
  from scored s;
$function$;

revoke execute on function public.get_service_capacity() from public, anon, authenticated;
grant execute on function public.get_service_capacity() to service_role;

-- ---------------------------------------------------------------------------
-- 4. The score thresholds are dead. Left in place, not deleted.
--
-- Nothing reads them after this migration. They stay so that a rollback to the
-- scored ladder is a code change rather than a data restore, and so the values
-- that were actually in force are still legible when reading back the series in
-- service_capacity_snapshots.
--
-- NOTE ON THE SERIES: rows written before this migration carry the old
-- definition of recycled supply and CANNOT be recomputed — get_service_capacity
-- reads live state, so there is nothing to replay. The same caveat 0072 and
-- 0084 carry. A step change at this date is a definition change, not a
-- business event.
-- ---------------------------------------------------------------------------
comment on column public.leads.max_assignments is
  'How many customers this lead may reach through ordinary routing. DB default '
  '3 (0055). Inactivity escalation raises it by one, once, to a ceiling of 4 '
  '(0089). A pool claim bypasses it entirely (invariant 3).';
