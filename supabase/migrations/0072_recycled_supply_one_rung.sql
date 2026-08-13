-- ---------------------------------------------------------------------------
-- 0072 — Recycled supply: one rung ahead, measured not projected
--
-- Supersedes the projection in 0071, which was wrong in a way worth recording
-- because it is an easy mistake to make again.
--
-- 0071 compounded both escalation rungs:
--
--     slots per lead = rate_10 × (1 + rate_20_given_rung_1)
--
-- and measured rate_20_given_rung_1 at 100%, so every lead that went quiet once
-- was immediately counted as producing TWO sellable slots. Management came out
-- at 487.8 slots against a physical maximum of 493 — the model was effectively
-- asserting that every lead gets sold the full five times.
--
-- Two independent faults:
--
-- 1. IT COUNTED A RESALE THAT HAD NOT HAPPENED. When a lead goes out for its
--    first resale, the second is not capacity — the new operator may work it,
--    which ends the ladder there. The fifth allocation is only real once the
--    fourth has happened AND that operator has also gone silent.
--
-- 2. THE 100% WAS MEASURED IN A WORLD WITHOUT ESCALATION. Every assignment in
--    that sample sat with ONE operator who ignored it; no second operator ever
--    existed to engage. Of course it stayed quiet to day 20. That population
--    cannot predict behaviour after the intervention, because the intervention
--    had never been applied to it. Projecting it forward assumed the fix would
--    never work.
--
-- The rule this replaces it with:
--
--   COUNT ONE RUNG AHEAD, ALWAYS. The second rung enters the figures by
--   OBSERVATION — once a lead has actually escalated and its new holder has
--   actually gone quiet past their own ten days, it becomes a live candidate
--   and is counted then, as a fact rather than a forecast.
--
-- So the numbers now come from live per-assignment state, and correct
-- themselves as escalation runs:
--
--   recycled_slots_now  — a COUNT, not a rate. Leads sitting with an operator
--                         who is not working them, passable today. One slot per
--                         LEAD, never per assignment: escalating a lead raises
--                         max_assignments by one, so two silent co-assignees
--                         still only open one slot.
--
--   recycled_slots_per_month — observed escalations per month once escalation
--                         has run; before then, a one-rung estimate
--                         (delivered × unworked_rate). recycling_basis says
--                         which, so an estimate is never mistaken for a count.
--
-- Everything else from 0071 stands: no safety discount (the guarantee rolls
-- over, so a short month is recoverable where a cold landlord is not), the
-- new-leads-only ceiling shown beside the headline, and one-off stock kept out
-- of the recurring figure.
--
-- Also adds service_capacity_snapshots, captured daily by the escalation cron.
-- The gap between the two ceilings is the health signal: as customers engage,
-- recycling shrinks and the base ceiling rises as supply grows. That trend is
-- only visible if it is recorded, and it cannot be backfilled.
-- ---------------------------------------------------------------------------

drop function if exists public.get_service_capacity();

create or replace function public.get_service_capacity()
returns table (
  lead_type            public.lead_type,
  leads_per_month      numeric,
  slots_per_month      numeric,
  recycled_slots_per_month numeric,
  serviceable_slots_per_month numeric,
  -- 'observed' once escalation has run, 'estimated' before then.
  recycling_basis      text,
  -- Leads passable right now: held by someone not working them.
  recycled_slots_now   integer,
  unworked_rate        numeric,
  recycling_sample     integer,
  inventory_slots_now  integer,
  unsold_leads_now     integer,
  demand_per_month     integer,
  delivered_per_month  numeric,
  active_customers     integer,
  fully_served         integer,
  avg_allocation       numeric,
  sustainable_customers integer,
  sustainable_customers_new_only integer,
  room_for_customers   integer
)
language sql
stable
security definer
set search_path = public
as $$
  with w as (select 28 as days),
  rw as (select 90 as days),
  supply as (
    select
      lt.lead_type,
      count(l.id)                         as leads_in_window,
      coalesce(sum(l.max_assignments), 0) as slots_in_window,
      -- One rung of headroom per lead, not the full run to the ceiling of 5 —
      -- the same "count one step ahead" rule the estimate itself obeys.
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
  -- Escalations that have actually happened. Once this is non-zero it replaces
  -- the estimate entirely: a count of what the machine really did beats any
  -- projection of what it might do.
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
  -- The rate a fresh cohort repeats: was this assignment worked inside its OWN
  -- first ten days? Measured with escalation's own signal set (contact click,
  -- note, stage move, status advance — never a bare open), over each
  -- assignment's own window rather than its lifetime, so a note on day 1 cannot
  -- shield a lead on day 40.
  --
  -- Only the FIRST rung is measured. The day-20 rate is deliberately not
  -- modelled: see the header.
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
                    and e.event_type in ('tel_click', 'mailto_click', 'stage_changed')
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
  -- Live count of what could be passed on today.
  --
  -- Mirrors get_escalation_candidates exactly, minus the enabled_from cutoff:
  -- the cutoff is a rollout guard, and this is meant to show the true
  -- operational position rather than what the cron happens to be allowed to
  -- touch this week.
  --
  -- count(distinct lead_id) is the whole point — one slot per LEAD.
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
     -- Silent for the last ten days, the same question each rung asks.
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
      round(o.n * 30.0 / (select days from w), 1)               as observed_pm,
      o.n                                                        as observed_raw,
      r.sample_10 as sample,
      case when r.sample_10 > 0
           then round(r.escalates_at_10::numeric / r.sample_10, 4) end as rate_10,
      round(s.one_rung_headroom * 30.0 / (select days from w), 1) as headroom_pm,
      sv.demand, sv.customers, sv.fully_served, sv.avg_alloc,
      i.open_slots, i.unsold, p.n as passable_now
    from supply s
    join delivered d  on d.lead_type = s.lead_type
    join served sv    on sv.lead_type = s.lead_type
    join inventory i  on i.lead_type = s.lead_type
    join recycling r  on r.lead_type = s.lead_type
    join observed o   on o.lead_type = s.lead_type
    join passable p   on p.lead_type = s.lead_type
  ),
  scored as (
    select
      c.*,
      case when c.observed_raw > 0 then 'observed' else 'estimated' end as basis,
      least(
        case
          when c.observed_raw > 0 then c.observed_pm
          -- ONE rung. No compounding, no assumed second resale.
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

-- ---------------------------------------------------------------------------
-- Daily history.
--
-- Cannot be backfilled — get_service_capacity reads live state, so yesterday's
-- answer is unrecoverable once yesterday has passed. Same reason
-- customer_engagement_snapshots (0064) shipped ahead of anything that read it.
--
-- The trend is the point. As customers who actually use the platform replace
-- those who do not, unworked_rate should fall and recycled supply with it,
-- while slots_per_month rises with lead volume — so the two ceilings converge.
-- A closing gap means the business is getting healthier; a widening one means
-- headroom is increasingly borrowed from customers ignoring their leads.
-- ---------------------------------------------------------------------------
create table if not exists public.service_capacity_snapshots (
  id                    uuid primary key default gen_random_uuid(),
  captured_on           date not null default current_date,
  lead_type             public.lead_type not null,
  leads_per_month       numeric,
  slots_per_month       numeric,
  recycled_slots_per_month numeric,
  serviceable_slots_per_month numeric,
  recycling_basis       text,
  recycled_slots_now    integer,
  unworked_rate         numeric,
  recycling_sample      integer,
  inventory_slots_now   integer,
  unsold_leads_now      integer,
  demand_per_month      integer,
  delivered_per_month   numeric,
  active_customers      integer,
  fully_served          integer,
  avg_allocation        numeric,
  sustainable_customers integer,
  sustainable_customers_new_only integer,
  room_for_customers    integer,
  created_at            timestamptz not null default now(),
  unique (lead_type, captured_on)
);

create index if not exists idx_capacity_snapshots_captured
  on public.service_capacity_snapshots (captured_on desc, lead_type);

alter table public.service_capacity_snapshots enable row level security;

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
    sustainable_customers, sustainable_customers_new_only, room_for_customers
  )
  select
    current_date, c.lead_type, c.leads_per_month, c.slots_per_month,
    c.recycled_slots_per_month, c.serviceable_slots_per_month, c.recycling_basis,
    c.recycled_slots_now, c.unworked_rate, c.recycling_sample,
    c.inventory_slots_now, c.unsold_leads_now, c.demand_per_month,
    c.delivered_per_month, c.active_customers, c.fully_served, c.avg_allocation,
    c.sustainable_customers, c.sustainable_customers_new_only, c.room_for_customers
  from public.get_service_capacity() c
  -- Re-running the cron on the same day refreshes rather than duplicates, so a
  -- retry after a failure is safe.
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
    room_for_customers    = excluded.room_for_customers;
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke execute on function public.capture_service_capacity()
  from public, anon, authenticated;
grant execute on function public.capture_service_capacity() to service_role;

-- Seed today so the series starts now rather than on the next cron run.
select public.capture_service_capacity();
