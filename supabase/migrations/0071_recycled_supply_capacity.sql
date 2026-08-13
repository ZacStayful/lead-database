-- ---------------------------------------------------------------------------
-- 0071 — Recycled supply counts toward capacity
--
-- 0066 answered "how many customers can we carry?" almost entirely from lead
-- INFLOW: new leads in the window times their assignment caps. The only
-- recognition of unused leads was inventory_slots_now, deliberately walled off
-- as a one-off buffer that must never seat a customer permanently.
--
-- That understates the answer, and it understates it in the direction that
-- causes real harm — it says "room for 0 more customers" and invites a supply
-- panic when the actual position is comfortable.
--
-- The gap: a lead sitting untouched with an operator is SUPPLY. Escalation
-- (§18) is the machine that recovers it, and unlike inventory that recovery
-- RECURS — a predictable share of everything delivered each month comes back
-- and can be sold again. 0066's comment claimed slots_per_month "rises by
-- itself" as escalation raises max_assignments, which is true only for leads
-- that escalate inside their first 28 days. Every recycled slot on an older
-- lead falls outside the window and was invisible.
--
-- Measured, not assumed: 36.4% of management assignments that reached day 10
-- had never been worked (76 of 209 over 90 days).
--
-- ---------------------------------------------------------------------------
-- Three decisions taken here, all deliberate:
--
-- 1. Recycled supply RAISES the customer ceiling — it is not merely reported
--    alongside. sustainable_customers is now derived from serviceable slots
--    (inflow + recycled). The inflow-only figure survives as
--    sustainable_customers_new_only so the split stays visible and nobody has
--    to take the combined number on trust.
--
-- 2. It is counted at FACE VALUE, with no safety discount.
--
--    The obvious objection is that recycled supply is highest when customers
--    are least engaged, so capacity looks best right before churn — hold two
--    thirds back and you are insured against engagement improving.
--
--    Rejected, because the insurance costs more than the risk. Holding
--    capacity back means leads sit unsold for longer, and a lead going cold is
--    a permanent loss where a short month is not: the guarantee ROLLS OVER.
--    lead_balance carries forward and only leads_received_this_month resets
--    (invariant 2), so an undelivered lead stays as an unspent credit and is
--    made good next cycle. Under-delivering one month is recoverable. Letting
--    a landlord go cold while we sat on the lead for safety is not.
--
-- 3. No cap on how much of a customer's month may be recycled leads. The
--    landlord has not been contacted by anyone, so the lead is untouched from
--    their side; what it needs is somebody to ring it.
--
-- Both products, identical treatment. GR's sample is thin (one subscriber) and
-- its rate will read extreme, so recycling_sample is returned for every row and
-- the panel says so rather than quietly presenting a rate built on ten rows as
-- though it were solid.
-- ---------------------------------------------------------------------------

-- Return signature changes, so the old function must go first.
drop function if exists public.get_service_capacity();

create or replace function public.get_service_capacity()
returns table (
  lead_type            public.lead_type,
  leads_per_month      numeric,
  -- Sustainable slots from NEW leads only — 0066's slots_per_month, unchanged
  -- in meaning so the two halves of the ceiling stay separable.
  slots_per_month      numeric,
  -- Recurring slots from leads nobody worked, recovered by escalation.
  recycled_slots_per_month numeric,
  -- inflow + recycled. The number the customer ceiling is built from.
  serviceable_slots_per_month numeric,
  -- Share of delivered assignments that reached day 10 unworked, and the
  -- number of assignments that share was measured over.
  unworked_rate        numeric,
  recycling_sample     integer,
  -- One-off: aged assignments that would escalate today, backlog included.
  -- Sits beside inventory_slots_now and is never added to the recurring rate.
  recycling_backlog_now integer,
  inventory_slots_now  integer,
  unsold_leads_now     integer,
  demand_per_month     integer,
  delivered_per_month  numeric,
  active_customers     integer,
  fully_served         integer,
  avg_allocation       numeric,
  sustainable_customers integer,
  -- What the ceiling would be on new leads alone. Shown beside the headline.
  sustainable_customers_new_only integer,
  room_for_customers   integer
)
language sql
stable
security definer
set search_path = public
as $$
  with w as (select 28 as days),
  -- 90 days for the behavioural rates: an assignment must be 20 days old to
  -- have faced both rungs, so the 28-day supply window is far too short to
  -- measure recycling over.
  rw as (select 90 as days),
  supply as (
    select
      lt.lead_type,
      count(l.id)                         as leads_in_window,
      coalesce(sum(l.max_assignments), 0) as slots_in_window,
      -- Physical bound on recycling: escalation stops at 5, so a lead can only
      -- ever throw off (5 − its cap at ingest) extra slots. Keeps the estimate
      -- honest once caps drift upward, without hard-coding today's numbers.
      coalesce(sum(greatest(5 - l.max_assignments, 0)), 0) as escalation_headroom
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
  -- How often a delivered lead comes back.
  --
  -- Measured with ESCALATION'S OWN test, not a convenient proxy. If this
  -- disagreed with the cron, capacity would promise slots escalation never
  -- creates. Two things must match, and both are easy to get wrong:
  --
  -- a) WHICH SIGNALS COUNT. The same set as passive_only in
  --    get_assignment_engagement_scores: a contact click, a note, a stage move,
  --    or a status advance. detail_opened, a read notification and a login are
  --    excluded — looking at a lead is not working it, which is the entire case
  --    escalation exists for. Files are excluded too, because the scorer has no
  --    weight for them. Marking a lead contacted DOES count: an operator only
  --    does that to organise their own pipeline, so it reports real work done
  --    off-platform.
  --
  --    One documented inexactness: a lone mailto_click scores 0.30, just under
  --    the 0.35 day-10 threshold, so escalation would recycle it where this
  --    test reads it as active. Left alone deliberately — reproducing the full
  --    weighted score here would duplicate logic that lives in one place today
  --    and drift the moment a weight is edited from admin. The error is one
  --    signal wide and it UNDERSTATES recycling, which is the safe direction.
  --
  -- b) WHEN IT IS ASKED. Escalation asks over a trailing 10-day window, so each
  --    assignment is judged on its own first ten days — never on its whole life.
  --    A note written on day 1 must not shield a lead on day 40.
  --
  --    This is also what separates the RECURRING rate from a one-off. Asking
  --    "which aged assignments look dead right now" sweeps in a backlog of
  --    long-abandoned leads and answers ~76%; that wave escalates once and is
  --    gone. Asking "was this assignment worked inside its own first ten days"
  --    answers ~41%, and that is the rate a fresh cohort repeats every month.
  --    Same inflow-versus-inventory distinction as the rest of this function,
  --    one level down — and the backlog is reported separately below, never
  --    added to the recurring rate.
  --
  -- Closed, won and rejected assignments are excluded: escalation skips them
  -- (§18), so they generate no slot and must not dilute the rate either.
  recycling as (
    select
      lt.lead_type,
      count(la.id) filter (where la.age_days >= 10)::integer as sample_10,
      count(la.id) filter (where la.age_days >= 10 and not la.active_by_10)::integer
        as escalates_at_10,
      -- Rung 2 is CONDITIONAL on rung 1: get_escalation_candidates only offers
      -- stage 2 to assignments already at stage 1. Measuring it over everything
      -- 20 days old would count leads that never reached the first rung.
      count(la.id) filter (where la.age_days >= 20 and not la.active_by_10)::integer
        as reached_rung_2,
      count(la.id) filter (where la.age_days >= 20
                             and not la.active_by_10
                             and not la.active_10_to_20)::integer as escalates_at_20
    from (select unnest(enum_range(null::public.lead_type)) as lead_type) lt
    left join (
      select
        a.id, l.lead_type,
        (current_date - a.assigned_at::date) as age_days,
        (exists (select 1 from public.lead_events e
                  where e.assignment_id = a.id
                    and e.event_type in ('tel_click', 'mailto_click', 'stage_changed')
                    and e.created_at < a.assigned_at + interval '10 days')
         or exists (select 1 from public.lead_notes n
                     where n.lead_assignment_id = a.id
                       and n.created_at < a.assigned_at + interval '10 days')
         or (a.status <> 'new'
             and a.last_status_change_at < a.assigned_at + interval '10 days')
        ) as active_by_10,
        (exists (select 1 from public.lead_events e
                  where e.assignment_id = a.id
                    and e.event_type in ('tel_click', 'mailto_click', 'stage_changed')
                    and e.created_at >= a.assigned_at + interval '10 days'
                    and e.created_at <  a.assigned_at + interval '20 days')
         or exists (select 1 from public.lead_notes n
                     where n.lead_assignment_id = a.id
                       and n.created_at >= a.assigned_at + interval '10 days'
                       and n.created_at <  a.assigned_at + interval '20 days')
         or (a.status <> 'new'
             and a.last_status_change_at >= a.assigned_at + interval '10 days'
             and a.last_status_change_at <  a.assigned_at + interval '20 days')
        ) as active_10_to_20
      from public.lead_assignments a
      join public.leads l on l.id = a.lead_id
      where a.assigned_at <= now() - interval '10 days'
        and a.assigned_at >= now() - make_interval(days => (select days from rw))
        and a.closed_at is null
        and a.status not in ('won', 'rejected')
    ) la on la.lead_type = lt.lead_type
    group by lt.lead_type
  ),
  -- The one-off wave: aged assignments that would escalate if tested today,
  -- including the long-abandoned backlog. Sits beside inventory_slots_now as
  -- the other thing that can seat a customer once and never again.
  backlog as (
    select
      lt.lead_type,
      count(a.id)::integer as n
    from (select unnest(enum_range(null::public.lead_type)) as lead_type) lt
    left join public.leads l on l.lead_type = lt.lead_type
    left join public.lead_assignments a
      on a.lead_id = l.id
     and a.assigned_at <= now() - interval '10 days'
     and a.closed_at is null
     and a.status not in ('won', 'rejected')
     and a.inactivity_escalation_stage < 2
     and l.max_assignments < 5
     and not (
       exists (select 1 from public.lead_events e
                where e.assignment_id = a.id
                  and e.event_type in ('tel_click', 'mailto_click', 'stage_changed')
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
      r.sample_10 as sample,
      case when r.sample_10 > 0
           then round(r.escalates_at_10::numeric / r.sample_10, 4) end as rate_10,
      case when r.reached_rung_2 > 0
           then round(r.escalates_at_20::numeric / r.reached_rung_2, 4) end as rate_20_cond,
      round(s.escalation_headroom * 30.0 / (select days from w), 1) as headroom_pm,
      sv.demand, sv.customers, sv.fully_served, sv.avg_alloc,
      i.open_slots, i.unsold, b.n as backlog_now
    from supply s
    join delivered d  on d.lead_type = s.lead_type
    join served sv    on sv.lead_type = s.lead_type
    join inventory i  on i.lead_type = s.lead_type
    join recycling r  on r.lead_type = s.lead_type
    join backlog b    on b.lead_type = s.lead_type
  ),
  scored as (
    select
      c.*,
      -- Both rungs count, the second conditioned on the first:
      --
      --   slots per delivered lead = rate_10 × (1 + rate_20_given_rung_1)
      --
      -- Measured rather than assumed, and the measurement is stark: of the
      -- management assignments that went quiet by day 10, 53 of 53 were still
      -- quiet at day 20, and 10 of 10 on GR. Abandonment is permanent — nobody
      -- who ignored a lead for ten days ever came back to it. So a recycled
      -- lead yields two slots, not one, and the conditional term is ~1.0.
      --
      -- It is still expressed as a measured rate rather than hard-coded at 2,
      -- because the day-20 term is the part most likely to move once nudges and
      -- escalation start changing behaviour.
      --
      -- Bounded by escalation_headroom: the estimate can never claim more
      -- recycled slots than the ceiling of 5 physically permits.
      least(
        round(
          c.delivered_pm * coalesce(c.rate_10, 0) * (1 + coalesce(c.rate_20_cond, 0)),
          1),
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
    s.rate_10,
    s.sample,
    s.backlog_now,
    s.open_slots,
    s.unsold,
    s.demand,
    s.delivered_pm,
    s.customers,
    s.fully_served,
    s.avg_alloc,
    -- The ceiling, now built on serviceable slots. Inventory is still excluded:
    -- it seats a customer once and never again. Recycled supply is different in
    -- kind — it arrives every month for as long as leads go unworked — which is
    -- the whole reason it belongs here and inventory does not.
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
         else 0 end
  from scored s;
$$;

revoke execute on function public.get_service_capacity() from public, anon, authenticated;
grant execute on function public.get_service_capacity() to service_role;
