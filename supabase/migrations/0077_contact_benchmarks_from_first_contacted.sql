-- ============================================================================
-- Re-base the contact benchmarks on first_contacted_at.
--
-- THE PROBLEM
-- -----------
-- get_engagement_benchmarks (0047) shows the customer three metrics. Two of
-- them — contact_rate and hours_to_first_attempt — are computed from
-- tel_click/mailto_click events, and those have fired on THREE assignments in
-- six weeks against 290 detail_opened. Measured over the live 90-day window:
--
--     contact_rate      avg 0.010     (3 measurable attempts in total)
--     operators able to see their own hours figure:  0 of 20
--
-- So two thirds of the only telemetry the customer is ever shown have rendered
-- as ~0% or blank for every operator since launch.
--
-- THIS IS NOT A WIRING BUG. The emitters are present and correct
-- (LeadDetail.tsx — the phone and email rows both call recordEvent). Operators
-- open the lead, read the number off the screen, and dial from a handset or
-- their own CRM. A tel: click is simply not how this trade makes calls, and no
-- amount of fixing the handler changes that.
--
-- WHAT REPLACES IT
-- ----------------
-- first_contacted_at, which 0043 already stamps from four different directions:
-- a note, a file, a stage move off cold, or a tel_click. It covers 171 of 308
-- assignments (56%) where the click events cover 3.
--
--     contact_rate      avg 0.010  ->  0.621
--     attempts             3       ->  171
--     operators able to see their own hours figure:  0 -> 14
--
-- least() rather than coalesce(): mailto_click does NOT stamp first_contacted_at
-- (0043 deliberately only auto-contacts on tel_click), so the click stream can
-- still hold the earlier timestamp. least() ignores NULLs, so whichever source
-- has a value wins and the earlier one wins when both do.
--
-- WHAT THIS COSTS
-- ---------------
-- Honesty about the denominator. Click events are passive — the operator cannot
-- fake them without doing the thing. first_contacted_at is partly self-reported:
-- writing a note or moving a stage stamps it. So this measures diligence in
-- using the app alongside real speed, and the benchmark becomes something an
-- operator could in principle game by marking leads contacted.
--
-- That trade is worth taking because the alternative is not a stricter metric,
-- it is NO metric: a column of blanks teaches the customer nothing and quietly
-- tells them the product cannot measure itself. The objective second source is
-- explicit contact-attempt logging, which is a separate piece of work; when it
-- lands it should be added to the least() below rather than replacing it.
--
-- DELIBERATELY NOT CHANGED HERE
-- -----------------------------
-- get_customer_engagement_scores (0047) weights contact_rate at 0.65 and drives
-- reclaim and escalation recipient selection — the same dead signal, with
-- operational consequences. It is left alone on purpose: changing who gets a
-- lead reclaimed is a behavioural change that deserves its own migration, its
-- own dry run against get_escalation_candidates, and Zac's sign-off. This
-- migration only changes what a customer is shown about themselves.
-- ============================================================================

create or replace function public.get_engagement_benchmarks()
returns table (
  lead_type            public.lead_type,
  metric               text,
  own_value            numeric,
  own_sample           integer,
  cohort_median        numeric,
  cohort_top_quartile  numeric,
  cohort_size          integer,
  suppressed           boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  c_window_days     constant integer := 90;
  c_min_cohort_n    constant integer := 10;
  c_min_cohort_size constant integer := 5;
  c_min_attempts    constant integer := 5;
  v_customer_id uuid;
begin
  -- Identity comes from the session, never from an argument.
  select c.id into v_customer_id
    from public.customers c
   where c.user_id = auth.uid();

  if v_customer_id is null then
    return;
  end if;

  return query
  with
  -- Has anything been collecting during this window? open_rate still depends
  -- purely on detail_opened, so the launch-week guard stays event-based: if no
  -- passive telemetry exists at all, the page says so rather than rendering a
  -- wall of honest-looking zeroes.
  telemetry as (
    select exists (
      select 1 from public.lead_events e
      where e.created_at >= now() - make_interval(days => c_window_days)
        and e.event_type in ('detail_opened', 'tel_click', 'mailto_click')
    ) as present
  ),
  base as (
    select
      la.id            as assignment_id,
      la.customer_id   as cid,
      l.lead_type      as ltype,
      la.assigned_at,
      exists (
        select 1 from public.lead_events e
        where e.assignment_id = la.id and e.event_type = 'detail_opened'
      ) as opened,
      -- The change: earliest evidence of a contact attempt from EITHER source.
      least(
        (
          select min(e.created_at) from public.lead_events e
          where e.assignment_id = la.id
            and e.event_type in ('tel_click', 'mailto_click')
        ),
        la.first_contacted_at
      ) as first_attempt_at
    from public.lead_assignments la
    join public.leads l on l.id = la.lead_id
    where la.assigned_at >= now() - make_interval(days => c_window_days)
  ),
  _per as (
    select
      b.cid,
      b.ltype,
      count(*)::integer                                   as n,
      avg(case when b.opened then 1.0 else 0.0 end)       as open_rate,
      avg(case when b.first_attempt_at is not null then 1.0 else 0.0 end) as contact_rate,
      count(b.first_attempt_at)::integer                  as attempts,
      (percentile_cont(0.5) within group (
        order by extract(epoch from (b.first_attempt_at - b.assigned_at)) / 3600.0
      ) filter (where b.first_attempt_at is not null))::numeric as median_hours
    from base b
    group by b.cid, b.ltype
  ),
  products as (
    select unnest(enum_range(null::public.lead_type)) as ltype
  ),
  mine as (
    select p.ltype, pr.n, pr.open_rate, pr.contact_rate, pr.attempts, pr.median_hours
    from products p
    left join _per pr on pr.cid = v_customer_id and pr.ltype = p.ltype
  ),
  cohort as (
    select pr.*
    from _per pr
    where pr.cid <> v_customer_id
      and pr.n >= c_min_cohort_n
  ),
  cohort_stats as (
    select
      p.ltype,
      count(c.cid)::integer as size,
      percentile_cont(0.5)  within group (order by c.open_rate)::numeric    as open_med,
      percentile_cont(0.75) within group (order by c.open_rate)::numeric    as open_q,
      percentile_cont(0.5)  within group (order by c.contact_rate)::numeric as con_med,
      percentile_cont(0.75) within group (order by c.contact_rate)::numeric as con_q,
      (percentile_cont(0.5)  within group (order by c.median_hours)
        filter (where c.attempts >= c_min_attempts))::numeric      as hrs_med,
      -- 25th percentile: for a duration, the good quartile is the FAST one.
      (percentile_cont(0.25) within group (order by c.median_hours)
        filter (where c.attempts >= c_min_attempts))::numeric      as hrs_q
    from products p
    left join cohort c on c.ltype = p.ltype
    group by p.ltype
  )
  select * from (
    -- Lead open rate
    select
      m.ltype, 'open_rate'::text,
      case when t.present then round(m.open_rate, 4) end, coalesce(m.n, 0),
      case when t.present and s.size >= c_min_cohort_size then round(s.open_med, 4) end,
      case when t.present and s.size >= c_min_cohort_size then round(s.open_q, 4) end,
      s.size,
      (not t.present) or s.size < c_min_cohort_size
    from mine m join cohort_stats s on s.ltype = m.ltype cross join telemetry t

    union all

    -- Contact-attempt rate
    select
      m.ltype, 'contact_rate'::text,
      case when t.present then round(m.contact_rate, 4) end, coalesce(m.n, 0),
      case when t.present and s.size >= c_min_cohort_size then round(s.con_med, 4) end,
      case when t.present and s.size >= c_min_cohort_size then round(s.con_q, 4) end,
      s.size,
      (not t.present) or s.size < c_min_cohort_size
    from mine m join cohort_stats s on s.ltype = m.ltype cross join telemetry t

    union all

    -- Median hours to first attempt. Own figure suppressed below the attempt
    -- floor, independently of whether the cohort qualifies.
    select
      m.ltype, 'hours_to_first_attempt'::text,
      case when coalesce(m.attempts, 0) >= c_min_attempts
           then round(m.median_hours, 2) end,
      coalesce(m.attempts, 0),
      case when t.present and s.size >= c_min_cohort_size then round(s.hrs_med, 2) end,
      case when t.present and s.size >= c_min_cohort_size then round(s.hrs_q, 2) end,
      s.size,
      (not t.present) or s.size < c_min_cohort_size
    from mine m join cohort_stats s on s.ltype = m.ltype cross join telemetry t
  ) rows;
end;
$$;

-- Same grants as 0047: customer-callable by design, anon refused.
revoke execute on function public.get_engagement_benchmarks() from public, anon;
grant execute on function public.get_engagement_benchmarks() to authenticated, service_role;
