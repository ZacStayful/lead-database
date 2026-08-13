-- ============================================================================
-- Wins: the case-study record, the scoreboard, and the prompt that asks.
--
-- Three functions, all read-only, all serving the same problem from different
-- ends: the system knows almost nothing about which leads actually converted.
--
-- WHAT THE DATA LOOKS LIKE TODAY
-- ------------------------------
-- Three assignments out of 298 carry status = 'won'. That is not three signed
-- landlords, it is three RECORDED ones, and the surrounding data says the field
-- is barely used:
--
--   * only 22 of 298 assignments have a pipeline_stage other than 'cold',
--     including 126 that are marked 'contacted' while still sitting at 'cold'
--   * one of the three wins is stamped pipeline_stage = 'abandoned' — the
--     operator marked it won on a lead the stage says they gave up on
--
-- Nobody is asked, so nobody answers. That is the gap get_assignments_awaiting_
-- outcome() below exists to close: it finds the leads where the answer is
-- probably yes and worth asking for, rather than hoping somebody volunteers it.
--
-- WHY THIS MATTERS BEYOND REPORTING
-- ---------------------------------
-- status = 'won' is read by the Goals page, the analytics win rate, and the
-- planned escalation review. All three currently rest on a field that 93% of
-- customers never touch. Every conclusion about lead quality eventually reduces
-- to this number, so it is worth collecting properly before it is trusted.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 — Every win, with what a case study needs.
--
-- days_to_win is measured from assignment, not from the enquiry date: it
-- answers "how long did this operator take", which is the number that belongs
-- in a case study and on a future leaderboard. The enquiry date says how long
-- the landlord had been waiting before anyone was sold the lead, which is a
-- different question and not the operator's to answer for.
-- ---------------------------------------------------------------------------
create or replace function public.get_wins()
returns table (
  assignment_id     uuid,
  customer_id       uuid,
  business_name     text,
  lead_id           uuid,
  lead_name         text,
  lead_type         public.lead_type,
  lead_profile      text,
  address           text,
  bedrooms          text,
  income_estimate   numeric,
  assigned_at       timestamptz,
  first_contacted_at timestamptz,
  won_at            timestamptz,
  days_to_win       integer,
  pipeline_stage    text,
  was_escalated     boolean,
  operators_on_lead integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    la.id,
    c.id,
    c.business_name,
    l.id,
    l.lead_name,
    l.lead_type,
    nullif(btrim(coalesce(l.lead_profile, '')), ''),
    l.address,
    l.bedrooms,
    la.income_estimate,
    la.assigned_at,
    la.first_contacted_at,
    -- last_status_change_at is the best available "when did this become won":
    -- both writers of status = 'won' stamp it (the PATCH route and
    -- mark_assignment_won), and there is no dedicated won_at column.
    la.last_status_change_at,
    (la.last_status_change_at::date - la.assigned_at::date)::integer,
    la.pipeline_stage,
    -- Was this win on a lead somebody else had ignored first? The single most
    -- interesting question the escalation feature can be asked, and the reason
    -- the stage columns are worth keeping past their operational life.
    (la.is_reclaimed
      or exists (
        select 1 from public.lead_assignments prior
        where prior.lead_id = la.lead_id
          and prior.inactivity_escalation_stage > 0
          and prior.id <> la.id
      )),
    (select count(*)::integer from public.lead_assignments a2
      where a2.lead_id = la.lead_id)
  from public.lead_assignments la
  join public.customers c on c.id = la.customer_id
  join public.leads l     on l.id = la.lead_id
  where la.status = 'won'
  order by la.last_status_change_at desc;
$$;

revoke execute on function public.get_wins() from public, anon, authenticated;
grant execute on function public.get_wins() to service_role;

-- ---------------------------------------------------------------------------
-- 2 — Per-customer scoreboard.
--
-- The foundation for a leaderboard, deliberately reporting several rates rather
-- than one score. A single ranking number would have to choose between "who
-- converts best" and "who works hardest", and those are different people: an
-- operator sent 20 leads who works 4 and signs 1 has a better win rate and a
-- worse work rate than one who works all 20 and signs 2.
--
-- wins_per_attempted is the fairest conversion measure — a customer is not
-- penalised for leads they were sent and never touched, which is a separate
-- failing already measured by worked_rate.
--
-- Ranking is left to the caller. Publishing a leaderboard changes behaviour, so
-- which column it sorts on is a decision to take deliberately rather than
-- inherit from whatever this function happened to order by.
-- ---------------------------------------------------------------------------
create or replace function public.get_customer_scoreboard()
returns table (
  customer_id        uuid,
  business_name      text,
  monthly_allocation integer,
  delivered          integer,
  worked             integer,
  worked_rate        numeric,
  attempted          integer,
  wins               integer,
  wins_per_attempted numeric,
  wins_per_delivered numeric,
  median_days_to_win numeric,
  first_lead_at      timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with per_assignment as (
    select
      la.customer_id,
      la.id,
      la.assigned_at,
      la.status,
      la.last_status_change_at,
      (exists (select 1 from public.lead_events e
                where e.assignment_id = la.id
                  and e.event_type in ('detail_opened', 'tel_click', 'mailto_click'))
       or exists (select 1 from public.lead_notes n where n.lead_assignment_id = la.id)
       or exists (select 1 from public.lead_files f where f.lead_assignment_id = la.id)
      ) as worked,
      -- "Attempted" is a real contact attempt, not merely opening the lead: the
      -- denominator for a conversion rate has to be leads somebody actually
      -- went after. Closing one counts too — the operator reached a conclusion.
      (exists (select 1 from public.lead_events e
                where e.assignment_id = la.id
                  and e.event_type in ('tel_click', 'mailto_click'))
       or exists (select 1 from public.lead_notes n where n.lead_assignment_id = la.id)
       or la.closed_at is not null
      ) as attempted
    from public.lead_assignments la
  )
  select
    c.id,
    c.business_name,
    c.monthly_allocation,
    count(p.id)::integer,
    count(p.id) filter (where p.worked)::integer,
    case when count(p.id) > 0
         then round(count(p.id) filter (where p.worked)::numeric / count(p.id), 3) end,
    count(p.id) filter (where p.attempted)::integer,
    count(p.id) filter (where p.status = 'won')::integer,
    case when count(p.id) filter (where p.attempted) > 0
         then round(count(p.id) filter (where p.status = 'won')::numeric
                    / count(p.id) filter (where p.attempted), 3) end,
    case when count(p.id) > 0
         then round(count(p.id) filter (where p.status = 'won')::numeric
                    / count(p.id), 3) end,
    percentile_cont(0.5) within group (
      order by (p.last_status_change_at::date - p.assigned_at::date)
    ) filter (where p.status = 'won')::numeric,
    min(p.assigned_at)
  from public.customers c
  left join per_assignment p on p.customer_id = c.id
  where c.is_active = true
  group by c.id, c.business_name, c.monthly_allocation;
$$;

revoke execute on function public.get_customer_scoreboard() from public, anon, authenticated;
grant execute on function public.get_customer_scoreboard() to service_role;

-- ---------------------------------------------------------------------------
-- 3 — Leads that should have an outcome by now, and do not.
--
-- The other half of the close button. Closing captures the two ways a landlord
-- says no; this finds the leads where the answer is most likely YES and nobody
-- has recorded it — an operator who booked a meeting, attended it, and then
-- went quiet either signed them or did not, and both answers are worth more
-- than the silence currently sitting in the column.
--
-- Deliberately NOT every quiet lead. A lead still at 'cold' has no meeting to
-- have an outcome from, and asking about it would be the inactivity nudge
-- again. The stage list is the point: these are leads with real progress
-- recorded against them.
--
-- Covers both products' vocabularies — the management meeting stages and the GR
-- viewing/contract stages — because the question is identical in both.
-- ---------------------------------------------------------------------------
create or replace function public.get_assignments_awaiting_outcome(
  p_quiet_days integer default 7
)
returns table (
  assignment_id  uuid,
  customer_id    uuid,
  business_name  text,
  email          text,
  lead_id        uuid,
  lead_name      text,
  lead_type      public.lead_type,
  pipeline_stage text,
  assigned_at    timestamptz,
  quiet_since    timestamptz,
  quiet_days     integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    la.id, c.id, c.business_name, c.email,
    l.id, l.lead_name, l.lead_type,
    la.pipeline_stage,
    la.assigned_at,
    la.last_status_change_at,
    (current_date - la.last_status_change_at::date)::integer
  from public.lead_assignments la
  join public.customers c on c.id = la.customer_id
  join public.leads l     on l.id = la.lead_id
  where
    la.pipeline_stage in (
      -- Management: a meeting happened, or was booked and then went quiet.
      'web_meeting_booked', 'web_meeting_attended',
      -- Guaranteed rent: the equivalent points in its shorter pipeline.
      'viewing_booked', 'contract_sent'
    )
    -- Already settled one way or the other; nothing to ask.
    and la.status not in ('won', 'rejected', 'not_relevant')
    and la.closed_at is null
    and la.last_status_change_at <= now() - make_interval(days => p_quiet_days)
    and c.is_active = true
  order by la.last_status_change_at;
$$;

revoke execute on function public.get_assignments_awaiting_outcome(integer)
  from public, anon, authenticated;
grant execute on function public.get_assignments_awaiting_outcome(integer)
  to service_role;
