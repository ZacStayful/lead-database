-- ---------------------------------------------------------------------------
-- 0100a — Worked-lead conversion
--
-- ⚠️ RECOVERED, NOT NEW. This migration was applied to production on
-- 2026-08-23 (supabase_migrations name `worked_conversion`) and never
-- committed. §36.8 records it as the last of three such drifts; the other two
-- were committed as 0109 and 0110. This file is its SQL recovered verbatim
-- from `supabase_migrations.schema_migrations`, so applying it to production
-- is a no-op and applying it to a scratch build reproduces production.
--
-- ⚠️ WHY 0100a AND NOT 0125. It is not cosmetic. 0124 issues
-- `CREATE OR REPLACE FUNCTION public.get_customer_scoreboard()` against the
-- FOURTEEN-column signature this migration introduces. Built from the
-- directory without it, 0068's twelve-column version is what exists and 0124
-- fails outright with 42P13 "cannot change return type of existing function" —
-- verified on a scratch Postgres 16 before this file was written. So it has to
-- sort before 0124, and its real apply date is between 0100 and 0101.
--
-- Its own header called it 0097; that number was taken by
-- backfill_postcode_areas while this sat uncommitted.
--
-- Nothing in `src/` calls get_worked_conversion, worked_past_cold or
-- assignment_worked_past_cold, and the `src/lib/workedConversion.ts` mirror
-- referenced below has never existed — the SQL half shipped and the
-- application half did not. That is why the drift went unnoticed.
--
-- Everything below this line is the recovered original, unaltered.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 0097 — Worked-lead conversion
--
-- Operators report that lead quality and landlord intent are poor. The data
-- says something different, and nothing in the product currently says it:
--
--     delivered            311   wins 5   1.6%
--     contacted            186   wins 5   2.7%
--     worked past cold      38   wins 5  13.2%
--
-- Leads an operator actually takes into their pipeline convert at 13.2%. Only
-- 38 of 311 delivered assignments ever got that far and 125 were never
-- contacted at all, so the binding constraint is follow-through rather than
-- landlord intent.
--
-- ADMIN ONLY. Nothing here is granted to `authenticated`, and that absence is
-- the mechanism: the sample is 5 wins across 3 operators, wins are
-- self-reported (§10 excluded win rate from customer benchmarks for exactly
-- that reason), and one of the five carries status='won' with
-- pipeline_stage='abandoned'. The customer-facing version waits until those
-- facts are grounded.
--
-- ---------------------------------------------------------------------------
-- Three decisions taken here, all deliberate:
--
-- 1. "WORKED" MEANS pipeline_stage <> 'cold', AND IT GETS ITS OWN NAME.
--
--    get_customer_scoreboard already returns a column called `worked`, meaning
--    any detail_opened/tel_click/mailto_click event, note or file. That is a
--    different population (95 assignments, 4.2%) from this one (38, 13.2%).
--    One word meaning two things on two admin panels is how two numbers stop
--    reconciling and nobody can say which is wrong, so the new measure is
--    `worked_past_cold` throughout and the existing `worked` is left untouched.
--
--    Why this denominator: moving a lead off 'cold' is the operator declaring
--    they have taken it into their own pipeline. §21 warns that
--    status = 'contacted' measures record-keeping rather than work, and stage
--    is hand-settable through the same PATCH route — but the bias runs the safe
--    way. Advancing stages without doing the work INFLATES the denominator and
--    DEPRESSES the rate, so 13.2% is conservative against stage-padding.
--
--    ⚠️ The distortion that does flatter it is the opposite one: an operator
--    who works leads in their own CRM and never updates the stage is excluded
--    from the denominator entirely. That caveat must travel with the number.
--
-- 2. COHORT MATURITY IS PART OF THE RESULT, NOT A NOTE ON IT.
--
--    Days from assignment to win, all five: 2, 2, 10, 22, 24. So a cohort needs
--    about a month before its rate means anything. Read raw, the two cohorts
--    that exist say 19.0% (July) then 5.9% (August) — which reads as a collapse
--    and is almost entirely August being three weeks old.
--
--    `mature` is therefore returned per row and every caller must respect it.
--    Same shape as recycling_basis in 0072: a provisional number must never be
--    readable as a settled one.
--
-- 3. NO SNAPSHOT TABLE, UNLIKE 0070 / 0072 / 0081.
--
--    Those exist because they read live state and CANNOT be backfilled — a
--    missed cron is a permanent hole. This is derived entirely from durable
--    columns on lead_assignments (assigned_at, pipeline_stage, status), so any
--    cohort can be recomputed at any time and the series can never develop one.
--    A snapshot table plus a cron would buy nothing and add a failure mode.
--
--    ⚠️ The consequence, which is desirable but must be stated where it is
--    rendered: worked_past_cold is evaluated AS OF NOW, not as of then. A July
--    lead worked in September counts in the July cohort, so even a mature
--    cohort's rate can drift upward. For a cohort keyed on delivery date that
--    is the intended reading — "of the leads delivered in July, how many have
--    since been worked" — not a defect.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1 — The definition, in one place.
--
-- Trivial enough to inline and deliberately not inlined: it is asserted in
-- get_worked_conversion and in get_customer_scoreboard, and the whole point of
-- decision 1 is that those two must never drift. Mirrored in TypeScript by
-- isWorkedPastCold() in src/lib/workedConversion.ts, which must change with it.
--
-- Null-tolerant even though pipeline_stage is NOT NULL (0010): the argument may
-- arrive from a left join. Blank is treated as NOT worked for the same reason —
-- it cannot occur in the column (NOT NULL, defaulted to 'cold', CHECK-constrained
-- to ten known values) but the TypeScript mirror is fed from API rows where it
-- can, and the two must agree on every input or they are not one definition.
-- ---------------------------------------------------------------------------
create or replace function public.assignment_worked_past_cold(p_stage text)
returns boolean
language sql
immutable
as $$
  select p_stage is not null and btrim(p_stage) <> '' and p_stage <> 'cold';
$$;

comment on function public.assignment_worked_past_cold(text) is
  'True when an operator has advanced a lead out of cold into their pipeline. The single definition of "worked past cold"; see 0097.';

-- Revoked from authenticated even though it is pure, immutable and reveals
-- nothing: effective_allocation (0074) sets the house convention for a helper
-- of exactly this shape, and this migration's guarantee is that NOTHING it adds
-- is reachable by a customer. One un-revoked grant would make that claim false.
revoke execute on function public.assignment_worked_past_cold(text)
  from public, anon, authenticated;
grant execute on function public.assignment_worked_past_cold(text) to service_role;


-- ---------------------------------------------------------------------------
-- 2 — The metric: one row per monthly cohort, plus an all-time total row.
--
-- The total row carries cohort_month = null and covers EVERY assignment, not
-- just the mature ones — it is the honest complete picture and it is the figure
-- the argument is built on. Its own `mature` flag is false whenever any
-- contributing cohort is still open, which is what stops it being quoted as
-- settled.
--
-- Both rates are returned together, always. Per §18.1 and §21's "always two
-- numbers, never one": the GAP between 1.6% and 13.2% is the argument, and
-- either number alone misleads in a different direction — 1.6% understates what
-- the leads do, 13.2% understates how few of them get that far.
--
-- `thin` is an honesty flag, not a privacy gate; nothing here is published.
-- Below the floor the rates come back NULL rather than 0, because a suppressed
-- rate rendering as 0% is the failure §10 named.
-- ---------------------------------------------------------------------------
create or replace function public.get_worked_conversion(
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
  operators          integer,
  mature             boolean,
  thin               boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with params as (
    -- 30 days covers the longest observed time to a win (24) with headroom.
    select 30 as maturity_days,
           20 as min_worked,
            3 as min_wins,
            3 as min_operators
  ),
  per_assignment as (
    select
      date_trunc('month', la.assigned_at)::date as cohort_month,
      la.id,
      la.customer_id,
      la.assigned_at,
      la.status,
      (la.first_contacted_at is not null)                          as contacted,
      public.assignment_worked_past_cold(la.pipeline_stage)        as worked_past_cold
    from public.lead_assignments la
    join public.leads l on l.id = la.lead_id
    where l.lead_type = p_lead_type
  ),
  -- Grouping sets rather than a UNION ALL: one pass, and the total row cannot
  -- drift from the per-cohort rows because it is the same expression.
  grouped as (
    select
      p.cohort_month,
      grouping(p.cohort_month)                                     as is_total,
      count(*)::integer                                            as delivered,
      count(*) filter (where p.contacted)::integer                 as contacted,
      count(*) filter (where p.worked_past_cold)::integer          as worked_past_cold,
      count(*) filter (where p.status = 'won')::integer            as won,
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
    g.operators,
    mature.v,
    thin.v
  from grouped g,
  lateral (
    -- <= not <: "at least maturity_days old" includes the boundary. With a
    -- strict comparison a cohort whose newest assignment is exactly 30 days old
    -- reads as still open, which is an off-by-one nobody would ever notice in
    -- the rendered output — it would simply mature a day late, every time.
    -- coalesce because an empty result set still yields the total row, with
    -- newest NULL: "no assignments at all" is not mature, and a NULL flag would
    -- reach the client as an absent boolean rather than a decided one.
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


-- ---------------------------------------------------------------------------
-- 3 — The same measure per operator.
--
-- The other half of the argument: follow-through varies far more between
-- operators than between leads. All five wins sit with operators who contacted
-- everything they were sent, while the largest single recipient contacted 7 of
-- 27 and reported no outcome on any of them.
--
-- ⚠️ DROP AND RECREATE, NOT `create or replace`. Adding columns to a
-- RETURNS TABLE function is a return-type change and `create or replace` fails
-- with 42P13. A drop discards grants unconditionally (§11, the 0028 → 0038 →
-- 0049 trap), so they are re-asserted below.
--
-- Everything that was here before is unchanged, including `worked` with its
-- original event-or-note-or-file meaning — see decision 1. Two columns are
-- added and nothing else moves, so no figure already on /admin/outcomes
-- changes value.
--
-- Unlike get_worked_conversion this is not filtered by lead_type, because none
-- of its existing columns are either.
-- ---------------------------------------------------------------------------
drop function if exists public.get_customer_scoreboard();

create function public.get_customer_scoreboard()
returns table (
  customer_id               uuid,
  business_name             text,
  monthly_allocation        integer,
  delivered                 integer,
  worked                    integer,
  worked_rate               numeric,
  worked_past_cold          integer,
  wins_per_worked_past_cold numeric,
  attempted                 integer,
  wins                      integer,
  wins_per_attempted        numeric,
  wins_per_delivered        numeric,
  median_days_to_win        numeric,
  first_lead_at             timestamptz
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
      public.assignment_worked_past_cold(la.pipeline_stage) as worked_past_cold,
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
    count(p.id) filter (where p.worked_past_cold)::integer,
    case when count(p.id) filter (where p.worked_past_cold) > 0
         then round(count(p.id) filter (where p.status = 'won')::numeric
                    / count(p.id) filter (where p.worked_past_cold), 3) end,
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

revoke execute on function public.get_customer_scoreboard()
  from public, anon, authenticated;
grant execute on function public.get_customer_scoreboard() to service_role;
