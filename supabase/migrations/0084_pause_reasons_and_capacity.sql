-- ============================================================================
-- Pause: reasons, chosen duration, departure tracking, and capacity correction.
--
-- OBJECTIVE
-- ---------
-- Understand why customers leave, and separate paused customers who are likely
-- to come back from those who are not.
--
-- Zero customers have ever cancelled and there is no pause history, so nothing
-- here is a model. get_paused_customer_facts() returns FACTS and the banding
-- rules live in TypeScript where they can be read and argued with — the same
-- decision get_customer_risk() made in 0066 for the same reason.
--
-- WHY AN EPISODE TABLE AND NOT MORE COLUMNS ON customers
-- ------------------------------------------------------
-- Both resume paths null the pause columns (the resume cron and the Stripe
-- webhook's resume-detection block), so a reason stored on customers dies on
-- resume. pause_count already assumes re-pausing, so columns would also
-- overwrite the previous reason on the second pause — losing exactly the data
-- this feature exists to collect.
--
-- It also avoids a webhook change. When a paused customer's subscription is
-- finally deleted, the resume-detection block clears paused_at (a cancelled
-- subscription reports no pause_collection, and only the EMAIL is status-guarded
-- there, not the write). That erases the fact they were ever paused. Gating the
-- write on status='active' would preserve it but strand the row paused forever,
-- with the resume cron retrying a dead subscription every morning. The episode
-- table records the history instead, so the webhook is left alone.
--
-- LIVE pause state remains customers.paused_at / pause_resumes_at. Nothing here
-- is read to decide whether a customer is paused; ended_at is a best-effort
-- historical stamp and a missed stamp is a reporting gap, never a stuck pause.
--
-- CORRECTS 0038's HEADER, which claims the app enforces a one-time pause
-- allowance. It never has — the route has no such check and its own docblock
-- describes pausing as repeatable. Repeatable is the behaviour that has shipped.
--
-- MANAGEMENT-ONLY (invariant 6). No GR column is read or written, and the
-- capacity changes below touch the management branch only: 0038 is explicit that
-- a paused management customer who also holds GR keeps receiving GR leads.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 — Pause episodes.
-- ---------------------------------------------------------------------------
create table if not exists public.subscription_pauses (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references public.customers(id) on delete cascade,

  -- Mirrors customers.paused_at / pause_resumes_at at the moment of pausing.
  -- Denormalised deliberately: a resume clears those columns, and this row must
  -- still say what was asked for.
  paused_at    timestamptz not null default now(),
  resumes_at   timestamptz not null,
  months       integer not null check (months in (1, 2, 3)),

  reasons      text[] not null,
  note         text,

  ended_at     timestamptz,
  created_at   timestamptz not null default now(),

  -- A pause with no reason is the one thing this table exists to prevent.
  --
  -- array_position(reasons, null) is null rejects a NULL element. Without it a
  -- NULL member makes the <@ subset test evaluate to NULL rather than false,
  -- and a CHECK passes on NULL.
  --
  -- 'unknown_pre_0077' is the backfill sentinel for the customers who were
  -- already paused when this migration ran. Deliberately not a plausible-looking
  -- reason: "we never asked" must stay visibly different from "they told us" the
  -- moment anyone counts reasons.
  constraint subscription_pauses_reasons_valid check (
    cardinality(reasons) >= 1
    and array_position(reasons, null) is null
    and reasons <@ array[
      'too_expensive',
      'not_enough_leads',
      'lead_quality',
      'at_capacity',
      'seasonal',
      'other',
      'unknown_pre_0077'
    ]::text[]
  ),

  -- "Something else" with no explanation teaches nothing, which is the same
  -- reasoning as case_studies_loss_reason_matches_outcome (0058).
  constraint subscription_pauses_other_needs_note check (
    not ('other' = any (reasons))
    or (note is not null and char_length(btrim(note)) > 0)
  ),

  constraint subscription_pauses_note_length check (
    note is null or char_length(note) <= 500
  ),

  constraint subscription_pauses_resumes_after_pause check (resumes_at > paused_at)
);

create index if not exists idx_subscription_pauses_customer
  on public.subscription_pauses (customer_id, paused_at desc);

create index if not exists idx_subscription_pauses_open
  on public.subscription_pauses (customer_id) where ended_at is null;

-- Service-role only, like customer_engagement_snapshots (0064). A customer has
-- no business reading pause reasons, including their own.
alter table public.subscription_pauses enable row level security;

comment on table public.subscription_pauses is
  'One row per pause episode. Written at pause time; ended_at is a best-effort '
  'stamp. Live pause state is customers.paused_at, never this table.';

comment on column public.customers.pause_count is
  'How many times this customer has paused. Reporting counter only — pausing is '
  'repeatable and nothing enforces a cap. Per-episode detail lives in '
  'public.subscription_pauses (0084).';

-- ---------------------------------------------------------------------------
-- 2 — Backfill customers who are already paused.
--
-- Without this they read as "—" on the new admin tab forever, and since they are
-- currently the entire paused population the feature would ship looking broken.
--
-- Written as insert…select…where not exists so it is idempotent and picks up
-- whoever is genuinely paused at apply time, rather than hardcoding ids that may
-- be stale by then. months is derived from the real dates and clamped to the
-- CHECK domain.
-- ---------------------------------------------------------------------------
insert into public.subscription_pauses (customer_id, paused_at, resumes_at, months, reasons)
select
  c.id,
  c.paused_at,
  coalesce(c.pause_resumes_at, c.paused_at + interval '3 months'),
  greatest(1, least(3, round(
    extract(epoch from (coalesce(c.pause_resumes_at, c.paused_at + interval '3 months') - c.paused_at))
    / 86400.0 / 30.0
  )::integer)),
  array['unknown_pre_0077']::text[]
from public.customers c
where c.paused_at is not null
  and not exists (
    select 1 from public.subscription_pauses sp where sp.customer_id = c.id
  );

-- ---------------------------------------------------------------------------
-- 3 — Departure reasons, captured from Stripe at cancellation.
--
-- Pause is the soft exit; cancellation is the real one, and until now it
-- recorded only cancelled_at. The Stripe billing portal can collect a reason at
-- cancellation and returns it on the subscription as cancellation_details
-- (feedback = Stripe's fixed enum, comment = free text). Both are written by the
-- management branch of the subscription webhook with the same coalesce semantics
-- as cancelled_at, so the first cancellation's reason is never overwritten.
--
-- Management-only, matching cancelled_at: GR cancellations write gr_ columns and
-- there is no GR pause to explain.
-- ---------------------------------------------------------------------------
alter table public.customers
  add column if not exists cancellation_feedback text,
  add column if not exists cancellation_comment  text;

comment on column public.customers.cancellation_feedback is
  'Stripe cancellation_details.feedback (their enum) captured at cancellation. '
  'First cancellation wins, matching cancelled_at.';

-- ---------------------------------------------------------------------------
-- 4 — Pause outcomes, DERIVED not stored.
--
-- A reason with no outcome cannot answer "which reasons predict leaving".
--
-- Derived because the answer changes with time: a customer who resumed last week
-- is retained today and may have left by next month. A stored column would
-- freeze the first reading and quietly go stale — the same reason
-- get_customer_risk() derives its bands live.
-- ---------------------------------------------------------------------------
create or replace function public.get_pause_outcomes()
returns table (
  pause_id      uuid,
  customer_id   uuid,
  business_name text,
  reasons       text[],
  note          text,
  months        integer,
  paused_at     timestamptz,
  resumes_at    timestamptz,
  ended_at      timestamptz,
  outcome       text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    sp.id, sp.customer_id, c.business_name,
    sp.reasons, sp.note, sp.months,
    sp.paused_at, sp.resumes_at, sp.ended_at,
    case
      -- Still running: the customer IS paused, and this is their most recent
      -- episode.
      --
      -- Not keyed on "ended_at is null" alone, because that stamp is
      -- best-effort: a customer who pauses again after a missed stamp carries
      -- two open episodes, and the older one would read as still running
      -- forever. Not keyed on sp.paused_at = c.paused_at either — the two are
      -- written from one value today, but that is an invisible coupling a
      -- future writer could break with a fresh now(), and the failure mode is a
      -- LIVE pause silently reporting as ended.
      when c.paused_at is not null
       and sp.ended_at is null
       and sp.paused_at = (
             select max(sp2.paused_at) from public.subscription_pauses sp2
             where sp2.customer_id = sp.customer_id
           )
      then 'active'

      -- Ended, but we do not know when: the stamp was missed. Given its own
      -- outcome rather than being guessed into one of the three below, all of
      -- which are decided by comparing cancelled_at against ended_at. Reporting
      -- it as 'active' would inflate the paused count with pauses that are long
      -- over; reporting it as 'resumed_retained' would silently claim a
      -- retention we never observed.
      when sp.ended_at is null then 'ended_untracked'

      when c.cancelled_at is not null
       and c.cancelled_at between sp.paused_at and sp.ended_at
                                                           then 'left_during_pause'
      when c.cancelled_at is not null and c.cancelled_at > sp.ended_at
                                                           then 'resumed_then_left'
      else 'resumed_retained'
    end
  from public.subscription_pauses sp
  join public.customers c on c.id = sp.customer_id
  order by sp.paused_at desc;
$$;

revoke execute on function public.get_pause_outcomes() from public, anon, authenticated;
grant execute on function public.get_pause_outcomes() to service_role;

-- ---------------------------------------------------------------------------
-- 5 — Facts behind the return-likelihood banding.
--
-- FACTS ONLY. The rules that turn these into a band live in
-- src/lib/pauseOutlook.ts, where they can be read and edited by whoever
-- disagrees with them — the same split serviceHealth.ts already uses.
--
-- Engagement is measured from EVENTS AND NOTES, never from status='contacted'
-- or first_contacted_at. The PATCH route lets an operator set contacted by hand
-- and CLAUDE.md §18 records that 31 of 87 assignments sit there that way; both
-- live paused customers have all 10 assignments marked contacted while one has
-- 31 engagement events and 15 notes and the other has 3 and 1. It measures
-- record-keeping, not work — the same trap §10 flags for win rate.
-- ---------------------------------------------------------------------------
create or replace function public.get_paused_customer_facts()
returns table (
  customer_id           uuid,
  has_wins              boolean,
  wins                  integer,
  lifetime_delivered    integer,
  engagement_before     integer,
  notes_before          integer,
  worked_rate           numeric,
  pause_count           integer,
  tenure_days           integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.id,
    (select count(*) from public.lead_assignments la
       join public.leads l on l.id = la.lead_id
      where la.customer_id = c.id and l.lead_type = 'management'
        and la.status = 'won') > 0,
    (select count(*) from public.lead_assignments la
       join public.leads l on l.id = la.lead_id
      where la.customer_id = c.id and l.lead_type = 'management'
        and la.status = 'won')::integer,
    (select count(*) from public.lead_assignments la
       join public.leads l on l.id = la.lead_id
      where la.customer_id = c.id and l.lead_type = 'management')::integer,
    -- Operator-generated events only (ENGAGEMENT_EVENT_TYPES). nudge_sent is
    -- excluded for the usual reason: our own reminders must not read as their
    -- engagement.
    (select count(*) from public.lead_events e
       join public.lead_assignments la on la.id = e.assignment_id
      where la.customer_id = c.id
        and e.event_type in ('detail_opened', 'tel_click', 'mailto_click')
        and e.created_at >= c.paused_at - interval '30 days'
        and e.created_at <= c.paused_at)::integer,
    (select count(*) from public.lead_notes n
       join public.lead_assignments la on la.id = n.lead_assignment_id
      where la.customer_id = c.id
        and n.created_at >= c.paused_at - interval '30 days'
        and n.created_at <= c.paused_at)::integer,
    -- Lifetime share of management leads that saw any real work.
    (select case when count(*) > 0 then round(
        count(*) filter (where
          exists (select 1 from public.lead_events e
                   where e.assignment_id = la.id
                     and e.event_type in ('detail_opened','tel_click','mailto_click'))
          or exists (select 1 from public.lead_notes n where n.lead_assignment_id = la.id)
          or exists (select 1 from public.lead_files f where f.lead_assignment_id = la.id)
        )::numeric / count(*), 3) end
     from public.lead_assignments la
     join public.leads l on l.id = la.lead_id
     where la.customer_id = c.id and l.lead_type = 'management'),
    c.pause_count,
    (current_date - c.created_at::date)::integer
  from public.customers c
  where c.paused_at is not null;
$$;

revoke execute on function public.get_paused_customer_facts() from public, anon, authenticated;
grant execute on function public.get_paused_customer_facts() to service_role;

-- ---------------------------------------------------------------------------
-- 6 — Capacity: paused customers are not committed volume.
--
-- 0038 leaves account_status='active' during a pause so the SLOT is reserved,
-- and that is still right for routing. It is wrong for the metrics: a paused
-- customer receives no leads and is owed none, so counting their allocation as
-- committed volume understates how many customers we can actually serve.
--
-- The same exclusion already exists twice in this codebase for the same reason —
-- capacity.ts excludes is_active=false because "an account switched off receives
-- no leads from any routing path, so it commits no monthly volume", and the
-- admin supply-problem banner excludes paused because "their delivery is stopped
-- deliberately, which is not a supply problem".
--
-- paused_customers / paused_demand are returned SEPARATELY and must never be
-- added to the headline. Excluding them without reporting them would show
-- headroom that a returning customer silently reclaims, and selling into it
-- over-commits us. Same rule §18.1 applies to supply, on the demand side.
--
-- A NOTE ON fully_served, deliberately not asserted in code: `got` counts
-- assignments since coalesce(billing_cycle_anchor, created_at), and both live
-- paused customers took their full 10 of 10 before pausing, so they currently
-- read as fully served rather than un-served. Whether that then freezes or flips
-- depends on whether billing_cycle_anchor advances during a pause —
-- invoice.paid cannot move it (invoices are voided, so the event never fires)
-- but customer.subscription.updated sets it from current_period_start and the
-- Stripe period keeps rolling. Neither customer has reached their next anchor
-- date yet, so this is UNVERIFIED. Either way it is a stale reading of a
-- customer owed nothing, which is the argument for excluding them.
-- ---------------------------------------------------------------------------
drop function if exists public.get_service_capacity();

create or replace function public.get_service_capacity()
returns table (
  lead_type            public.lead_type,
  leads_per_month      numeric,
  slots_per_month      numeric,
  recycled_slots_per_month numeric,
  serviceable_slots_per_month numeric,
  recycling_basis      text,
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
  room_for_customers   integer,
  -- New in 0084. Reported beside the headline, never added to it.
  paused_customers     integer,
  paused_demand        integer
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
  -- Deliberately NOT filtered on paused customers. Leads sitting with a paused
  -- operator genuinely are passable — escalation and the pool will recover them
  -- — so excluding them would understate real supply. This is the supply side;
  -- the pause exclusion belongs on the demand side only.
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
        -- 0084: a paused customer is owed nothing this cycle.
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
      -- NO pause predicate here, ever: pause is management-only and a paused
      -- management customer who also holds GR keeps receiving GR leads (0038).
      where c.is_active and c.gr_subscription_status = 'active'
    ) g
  ),
  -- What comes back when the pauses end. Reported, never added.
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
      round(s.slots_in_window * 30.0 / (select days from w), 1) as slots_pm,
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
    join delivered d  on d.lead_type = s.lead_type
    join served sv    on sv.lead_type = s.lead_type
    join paused_side ps on ps.lead_type = s.lead_type
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
         else 0 end,
    s.paused_n,
    s.paused_demand
  from scored s;
$$;

-- Re-assert the ACL. A drop discards it, and CLAUDE.md §11 records the last time
-- that was forgotten: 0038 recreated a routing function and left it callable by
-- anon until 0049 caught it.
revoke execute on function public.get_service_capacity() from public, anon, authenticated;
grant execute on function public.get_service_capacity() to service_role;

-- ---------------------------------------------------------------------------
-- 7 — Snapshot the new columns.
--
-- NULLABLE, and deliberately not backfilled: every row captured before today was
-- computed on the paused-inclusive definition. A zero would read as "nobody was
-- paused" rather than "we were not measuring". 0072's header already states
-- these rows cannot be recomputed, so the series carries a definition change at
-- this date — recorded in CLAUDE.md §18.2 so a step change is not read as a
-- business event.
-- ---------------------------------------------------------------------------
alter table public.service_capacity_snapshots
  add column if not exists paused_customers integer,
  add column if not exists paused_demand    integer;

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
    paused_customers, paused_demand
  )
  select
    current_date, c.lead_type, c.leads_per_month, c.slots_per_month,
    c.recycled_slots_per_month, c.serviceable_slots_per_month, c.recycling_basis,
    c.recycled_slots_now, c.unworked_rate, c.recycling_sample,
    c.inventory_slots_now, c.unsold_leads_now, c.demand_per_month,
    c.delivered_per_month, c.active_customers, c.fully_served, c.avg_allocation,
    c.sustainable_customers, c.sustainable_customers_new_only, c.room_for_customers,
    c.paused_customers, c.paused_demand
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
    paused_demand         = excluded.paused_demand;
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke execute on function public.capture_service_capacity()
  from public, anon, authenticated;
grant execute on function public.capture_service_capacity() to service_role;

-- ---------------------------------------------------------------------------
-- 8 — Churn risk: a paused customer is not a churn signal.
--
-- Every risk band is defined on days-since-activity, so a paused customer
-- inevitably marches watch → medium → high while they are away — and lands on
-- "Customers who may leave" with their full plan price counted into
-- revenue_at_risk, even though Stripe collection is paused and they are billing
-- nothing. Whether they are actually leaving is what the pause outlook (§5)
-- answers, on evidence rather than silence.
--
-- Only the management half is excluded. A paused management customer who also
-- holds GR still appears here via the GR branch, with holds_management false —
-- their GR engagement is real and still worth watching.
--
-- Definition otherwise verbatim from 0066.
-- ---------------------------------------------------------------------------
create or replace function public.get_customer_risk()
returns table (
  customer_id              uuid,
  business_name            text,
  email                    text,
  monthly_allocation       integer,
  gr_monthly_allocation    integer,
  holds_management         boolean,
  holds_gr                 boolean,
  days_since_last_activity integer,
  tenure_days              integer,
  paying_days              integer,
  lifetime_delivered       integer,
  lifetime_worked          integer,
  lifetime_worked_rate     numeric,
  risk_band                text,
  risk_reason              text
)
language sql
stable
security definer
set search_path = public
as $$
  with base as (
    select
      c.id, c.business_name, c.email,
      c.monthly_allocation, c.gr_monthly_allocation,
      (c.account_status = 'active' and c.subscription_status = 'active'
        and c.paused_at is null)                                         as holds_mgmt,
      (c.gr_subscription_status = 'active')                              as holds_gr,
      (current_date - c.created_at::date)::integer                       as tenure_days,
      (current_date - coalesce(c.billing_cycle_anchor, c.gr_billing_cycle_anchor))::integer
                                                                         as paying_days,
      (current_date - greatest(
        (select max(e.created_at)::date from public.lead_events e
           join public.lead_assignments la on la.id = e.assignment_id
          where la.customer_id = c.id
            and e.event_type in ('detail_opened', 'tel_click', 'mailto_click')),
        (select max(n.created_at)::date from public.lead_notes n where n.customer_id = c.id),
        (select max(nt.read_at)::date from public.notifications nt where nt.customer_id = c.id),
        (select u.last_sign_in_at::date from auth.users u where u.id = c.user_id)
      ))::integer                                                        as quiet_days,
      (select count(*) from public.lead_assignments la where la.customer_id = c.id)::integer
                                                                         as delivered,
      (select count(*) from public.lead_assignments la
         where la.customer_id = c.id
           and (exists (select 1 from public.lead_events e
                         where e.assignment_id = la.id
                           and e.event_type in ('detail_opened','tel_click','mailto_click'))
             or exists (select 1 from public.lead_notes n where n.lead_assignment_id = la.id)
             or exists (select 1 from public.lead_files f where f.lead_assignment_id = la.id))
      )::integer                                                         as worked
    from public.customers c
    where c.is_active = true
      and (
        (c.account_status = 'active' and c.subscription_status = 'active'
          and c.paused_at is null)
        or c.gr_subscription_status = 'active'
      )
  ),
  rated as (
    select b.*,
      case when b.delivered > 0
           then round(b.worked::numeric / b.delivered, 3) end as worked_rate
    from base b
  )
  select
    r.id, r.business_name, r.email,
    r.monthly_allocation, r.gr_monthly_allocation,
    r.holds_mgmt, r.holds_gr,
    r.quiet_days, r.tenure_days, r.paying_days,
    r.delivered, r.worked, r.worked_rate,
    case
      when r.delivered >= 5 and r.worked = 0 and r.tenure_days >= 10 then 'critical'
      when r.quiet_days is null then 'critical'
      when r.quiet_days >= 21 then 'high'
      when r.quiet_days >= 14 and coalesce(r.worked_rate, 0) < 0.25 then 'high'
      when r.quiet_days >= 14 then 'medium'
      when r.quiet_days >= 10 and coalesce(r.worked_rate, 0) < 0.25 then 'medium'
      when r.quiet_days >= 7 then 'watch'
      else 'ok'
    end,
    case
      when r.delivered >= 5 and r.worked = 0 and r.tenure_days >= 10
        then 'Has never worked a single lead of ' || r.delivered || ' delivered'
      when r.quiet_days is null then 'No recorded activity ever'
      when r.quiet_days >= 21 then 'No activity for ' || r.quiet_days || ' days'
      when r.quiet_days >= 14 and coalesce(r.worked_rate, 0) < 0.25
        then 'Quiet ' || r.quiet_days || ' days, and has worked only '
             || round(coalesce(r.worked_rate, 0) * 100) || '% of leads sent'
      when r.quiet_days >= 14 then 'No activity for ' || r.quiet_days || ' days'
      when r.quiet_days >= 10 and coalesce(r.worked_rate, 0) < 0.25
        then 'Quiet ' || r.quiet_days || ' days, working '
             || round(coalesce(r.worked_rate, 0) * 100) || '% of leads sent'
      when r.quiet_days >= 7 then 'Quiet for ' || r.quiet_days || ' days'
      else 'Active in the last week'
    end
  from rated r;
$$;

revoke execute on function public.get_customer_risk() from public, anon, authenticated;
grant execute on function public.get_customer_risk() to service_role;
