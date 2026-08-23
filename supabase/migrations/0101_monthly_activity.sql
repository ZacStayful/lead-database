-- ---------------------------------------------------------------------------
-- 0101 — Activity by month, and an open rate that can actually be compared
--
-- The derived half of the month-over-month series. Everything here comes from
-- durable timestamps — lead_events.created_at, lead_notes.created_at,
-- lead_assignments.assigned_at — so any month can be recomputed at any time and
-- the series can never develop a hole. No table, no cron: §28.4's rule.
--
-- ---------------------------------------------------------------------------
-- ⚠️ THE CENTRAL HAZARD: A MONTH ROW HAS TWO KINDS OF COLUMN.
--
--   COHORT   — keyed on the month a lead was DELIVERED, state read NOW.
--              "Of the leads delivered in July, how many have been worked."
--              It DRIFTS UPWARD FOREVER: a July lead worked in September moves
--              July's number. (§28.2)
--
--   ACTIVITY — keyed on when the activity HAPPENED. "How many leads were opened
--              in July." It settles the moment the month ends and never moves.
--
-- Drafted against production the two halves tell OPPOSITE STORIES:
--
--     Jul 2026   delivered 169  worked 21  won 4   |  opens 101  customers  8
--     Aug 2026   delivered 142  worked 17  won 1   |  opens 347  customers 21
--
-- The cohort half looks like a collapse (it is August being three weeks old).
-- The activity half shows engagement climbing steeply. A reader given one row
-- containing both will average them into a single wrong impression.
--
-- THREE THINGS STOP THAT, in ascending order of how hard they are to ignore:
--
-- (a) TWO FUNCTIONS, NEVER ONE ROW SHAPE. Activity and cohort are separate
--     queries under separate headings. They are never unioned and never joined
--     on month_start in SQL. The temptation to build one wide "month row" IS
--     the bug; refusing it is the fix.
--
-- (b) A `basis` COLUMN on every row, constant per function, mirroring
--     `recycling_basis` (§18.2). It travels with the data, so if anyone ever
--     does build a combined view, the key survives into it.
--
-- (c) BOTH READINGS OF THE DRIFTING SIGNAL. See open_rate_prompt below.
--
-- ---------------------------------------------------------------------------
-- ⚠️ AND THE TWO HALVES DO NOT COVER THE SAME DAYS.
--
-- First assignment: 4 July 2026. First lead_events row: 27 JULY 2026. So in
-- July the cohort columns cover 27 days and the activity columns cover FIVE.
-- Much of August's apparent 3.4x improvement is simply telemetry starting.
-- `activity_days_covered` is returned per month so that cannot be missed.
--
-- ⚠️ `detail_opened` ALSO CHANGES MEANING PARTWAY THROUGH THIS SERIES. 0079
-- stamped `contact_gate_from`: the feed card stopped showing the landlord's
-- phone and email, so getting a number now REQUIRES opening the lead. §20
-- records that 114 of 308 assignments were expanded in the feed and never
-- opened. 0079 noted "nothing reads the marker yet" — this is its first reader,
-- and the break must be rendered, as §21 renders the pre-0084 capacity break.
--
-- ⚠️ `detail_opened` ALONE, never `viewed_at OR detail_opened`. §20's
-- leaderboard uses the union; §11 says never treat them as equivalent, because
-- viewed_at is set only by expanding a feed card and stays null forever on a
-- lead read through a direct link. The two surfaces will therefore disagree
-- about "opened" — acceptable, because they measure different populations, and
-- stated on both.
-- ---------------------------------------------------------------------------

create or replace function public.get_monthly_activity(
  p_lead_type public.lead_type default 'management'
)
returns table (
  month_start           date,
  opens                 integer,
  leads_opened          integer,
  contact_clicks        integer,
  notes_added           integer,
  stage_changes         integer,
  customers_active      integer,
  activity_days_covered integer,
  days_in_month         integer,
  stage_events_available boolean,
  basis                 text
)
language sql
stable
security definer
set search_path = public
as $$
  with bounds as (
    select
      (select min(created_at)::date from public.lead_events)              as first_event,
      (select (value)::date from public.system_settings
        where key = 'stage_events_from')                                  as stage_from
  ),
  months as (
    select generate_series(
             date_trunc('month', coalesce((select first_event from bounds), current_date)),
             date_trunc('month', current_date),
             interval '1 month')::date as month_start
  ),
  ev as (
    select date_trunc('month', e.created_at)::date as month_start,
           e.event_type, e.id, la.id as assignment_id, la.customer_id
    from public.lead_events e
    join public.lead_assignments la on la.id = e.assignment_id
    join public.leads l on l.id = la.lead_id
    where l.lead_type = p_lead_type
  ),
  nt as (
    select date_trunc('month', n.created_at)::date as month_start, n.id
    from public.lead_notes n
    join public.lead_assignments la on la.id = n.lead_assignment_id
    join public.leads l on l.id = la.lead_id
    where l.lead_type = p_lead_type
  )
  select
    m.month_start,
    (select count(*) from ev where ev.month_start = m.month_start
       and ev.event_type = 'detail_opened')::integer,
    -- distinct ASSIGNMENT, not distinct event: `opens` above is the raw count
    -- of times a lead was opened, and this is how many separate leads that was.
    -- Counting distinct event ids would make the two columns identical and the
    -- second one meaningless.
    (select count(distinct ev.assignment_id) from ev where ev.month_start = m.month_start
       and ev.event_type = 'detail_opened')::integer,
    (select count(*) from ev where ev.month_start = m.month_start
       and ev.event_type in ('tel_click','mailto_click'))::integer,
    (select count(*) from nt where nt.month_start = m.month_start)::integer,
    (select count(*) from ev where ev.month_start = m.month_start
       and ev.event_type = 'stage_changed')::integer,
    -- Operator-generated types only. `nudge_sent` is system-generated and
    -- counting it would let our own reminders report the least engaged
    -- customers as active (§3).
    (select count(distinct ev.customer_id) from ev where ev.month_start = m.month_start
       and ev.event_type in ('detail_opened','tel_click','mailto_click','stage_changed'))::integer,
    -- Days of this month for which telemetry could exist at all.
    greatest(0, (
      least(
        (m.month_start + interval '1 month' - interval '1 day')::date,
        current_date
      )
      - greatest(m.month_start, coalesce((select first_event from bounds), m.month_start))
    ) + 1)::integer,
    (date_part('days', (m.month_start + interval '1 month' - interval '1 day')))::integer,
    -- False for any month that ended before the 0098 trigger existed, so
    -- "0 stage changes in July" cannot be read as "operators did nothing".
    coalesce(
      (m.month_start + interval '1 month' - interval '1 day')::date
        >= (select stage_from from bounds),
      false
    ),
    'activity_in_month'
  from months m
  order by m.month_start;
$$;

revoke execute on function public.get_monthly_activity(public.lead_type)
  from public, anon, authenticated;
grant execute on function public.get_monthly_activity(public.lead_type)
  to service_role;


-- ---------------------------------------------------------------------------
-- get_worked_conversion gains the open rate — BOTH readings of it.
--
-- ⚠️ DROP AND RECREATE. Adding columns to a RETURNS TABLE function is a
-- return-type change and `create or replace` fails with 42P13 (§28.5). The drop
-- discards grants unconditionally (§11, the 0028 -> 0038 -> 0049 trap), so they
-- are re-asserted below. This is the SECOND drop/recreate of this function.
--
-- The open rate belongs HERE rather than in get_monthly_activity because it is
-- a cohort measure: "of the leads delivered in July, what share were opened".
--
-- ⚠️ NOTHING EXISTING MOVES. `worked_past_cold` keeps its exact meaning — §28.1
-- spent a section protecting that name — and the regression that matters is
-- that this still returns 311 / 186 / 38 / 5, 1.6% and 13.2%.
--
-- TWO OPEN RATES, and the second is the one that can be compared month to
-- month:
--
--   open_rate_ever   — ever opened. DRIFTS UP forever, because a July lead
--                      opened in September moves July's figure. Useful as a
--                      total, useless as a trend.
--   open_rate_prompt — opened within 7 days of delivery. The window CLOSES, so
--                      the number settles and stays comparable. It is also the
--                      better measure: operator responsiveness rather than
--                      accumulated curiosity.
--
-- Shown together under the §18.1 / §21 "always two numbers, never one" rule.
-- 0097's `mature` flag at 30 days covers both and is conservative for the
-- 7-day one.
-- ---------------------------------------------------------------------------
drop function if exists public.get_worked_conversion(public.lead_type);

create function public.get_worked_conversion(
  p_lead_type public.lead_type default 'management'
)
returns table (
  cohort_month       date,
  delivered          integer,
  contacted          integer,
  worked_past_cold   integer,
  won                integer,
  win_rate_delivered numeric,
  win_rate_worked    numeric,
  opened             integer,
  opened_within_7d   integer,
  open_rate_ever     numeric,
  open_rate_prompt   numeric,
  open_data_complete boolean,
  operators          integer,
  mature             boolean,
  thin               boolean,
  basis              text
)
language sql
stable
security definer
set search_path = public
as $$
  with params as (
    select 30 as maturity_days,
           20 as min_worked,
            3 as min_wins,
            3 as min_operators,
            7 as prompt_days,
           (select min(created_at)::date from public.lead_events) as first_event
  ),
  per_assignment as (
    select
      date_trunc('month', la.assigned_at)::date as cohort_month,
      la.id,
      la.customer_id,
      la.assigned_at,
      la.status,
      (la.first_contacted_at is not null)                          as contacted,
      public.assignment_worked_past_cold(la.pipeline_stage)        as worked_past_cold,
      exists (select 1 from public.lead_events e
               where e.assignment_id = la.id
                 and e.event_type = 'detail_opened')               as opened,
      exists (select 1 from public.lead_events e
               where e.assignment_id = la.id
                 and e.event_type = 'detail_opened'
                 and e.created_at < la.assigned_at
                     + make_interval(days => (select prompt_days from params)))
                                                                   as opened_prompt
    from public.lead_assignments la
    join public.leads l on l.id = la.lead_id
    where l.lead_type = p_lead_type
  ),
  grouped as (
    select
      p.cohort_month,
      grouping(p.cohort_month)                                     as is_total,
      count(*)::integer                                            as delivered,
      count(*) filter (where p.contacted)::integer                 as contacted,
      count(*) filter (where p.worked_past_cold)::integer          as worked_past_cold,
      count(*) filter (where p.status = 'won')::integer            as won,
      count(*) filter (where p.opened)::integer                    as opened,
      count(*) filter (where p.opened_prompt)::integer             as opened_within_7d,
      count(distinct p.customer_id)
        filter (where p.status = 'won')::integer                   as operators,
      max(p.assigned_at)                                           as newest
    from per_assignment p
    group by grouping sets ((p.cohort_month), ())
  )
  select
    case when g.is_total = 1 then null else g.cohort_month end,
    g.delivered,
    g.contacted,
    g.worked_past_cold,
    g.won,
    case when thin.v then null when g.delivered > 0
         then round(100.0 * g.won / g.delivered, 1) end,
    case when thin.v then null when g.worked_past_cold > 0
         then round(100.0 * g.won / g.worked_past_cold, 1) end,
    g.opened,
    g.opened_within_7d,
    -- The open rates are NOT gated on `thin`: that floor exists for a WIN rate
    -- built on 5 wins across 3 operators. Opens run to the hundreds, so
    -- withholding them would suppress the one figure here with a real sample.
    case when g.delivered > 0
         then round(100.0 * g.opened / g.delivered, 1) end,
    case when g.delivered > 0
         then round(100.0 * g.opened_within_7d / g.delivered, 1) end,
    -- ⚠️ Both open rates are FLOORS for any month that began before telemetry
    -- did. lead_events starts 27 July 2026, so a lead delivered on 5 July could
    -- not be recorded as opened until 22 days later — it fails the 7-day test
    -- however promptly it was actually read. July's 34.9% is therefore not
    -- comparable with August's 41.5%.
    --
    -- The counts are still returned, because understatement is a floor and a
    -- floor is useful. What must never happen is a month-on-month DELTA across
    -- this boundary, which is what the flag exists to prevent.
    coalesce(g.cohort_month >= (select first_event from params), false),
    g.operators,
    mature.v,
    thin.v,
    'cohort_delivered_in_month'
  from grouped g,
  lateral (
    select coalesce(
      g.newest <= now() - make_interval(days => (select maturity_days from params)),
      false
    )
  ) as mature(v),
  lateral (
    select g.worked_past_cold < (select min_worked    from params)
        or g.won              < (select min_wins      from params)
        or g.operators        < (select min_operators from params)
  ) as thin(v)
  order by (g.is_total = 1) desc, g.cohort_month;
$$;

revoke execute on function public.get_worked_conversion(public.lead_type)
  from public, anon, authenticated;
grant execute on function public.get_worked_conversion(public.lead_type)
  to service_role;
