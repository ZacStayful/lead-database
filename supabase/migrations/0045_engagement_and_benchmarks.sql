-- ============================================================================
-- Engagement scoring + cohort benchmarking.
--
-- Two independent things, deliberately in one migration because they share a
-- definition of "engagement" and must not be allowed to drift apart:
--
--   1. get_customer_engagement_scores — ranks customers by how hard they
--      actually work their leads. Wired into RECLAIM RECIPIENT SELECTION ONLY.
--      Normal routing is untouched; deficit-first still governs every allocated
--      lead, exactly as before. Engagement decides who gets a surplus lead
--      nobody paid a full price for.
--
--   2. get_engagement_benchmarks — shows a customer how their own behaviour
--      compares to the cohort. Read-only, aggregates only, and the security
--      review point of this whole programme of work.
--
-- BOTH read passive telemetry (lead_events) and NEVER self-reported status.
-- status is what an operator says they did; a benchmark built on it would
-- reward diligent form-filling rather than diligent selling, and would be
-- trivially gameable by the people it is meant to measure.
--
-- get_next_customers_for_lead is NOT modified by this migration. Nothing here
-- alters how an ordinary lead is allocated.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 — The weights, in exactly one place.
--
-- Contact attempts are weighted well above opens because they measure different
-- things: opening a lead proves it was read, ringing the landlord proves it was
-- acted on. An operator who opens everything and rings nothing is not engaged,
-- and a score that treated those equally would say otherwise.
--
-- Kept as a function rather than inline numbers so the two call sites cannot
-- diverge, and so tuning it is a one-line migration with an audit trail.
-- ---------------------------------------------------------------------------
-- Thresholds live here too, for the same reason: every tunable number for
-- engagement scoring is in one function, so nothing can be adjusted in one
-- place and forgotten in another.
--
--   window_days      — rolling window the score is computed over
--   min_assignments  — below this, the sample is too thin to read anything into
--                      and the customer takes the neutral score
create or replace function public.engagement_score_params()
returns table (
  open_rate_weight    numeric,
  contact_rate_weight numeric,
  window_days         integer,
  min_assignments     integer
)
language sql
immutable
as $$
  select 0.35::numeric, 0.65::numeric, 30, 5;
$$;

-- ---------------------------------------------------------------------------
-- 2 — Engagement score, per customer per lead_type, over a rolling 30 days.
--
--   open rate    = assignments with a detail_opened      / assignments
--   contact rate = assignments with a tel/mailto click   / assignments
--   score        = weighted combination of the two, in [0,1]
--
-- NEUTRAL DEFAULT. A customer with under 30 days of history, or fewer than
-- MIN_ASSIGNMENTS in the window, gets the cohort MEDIAN rather than a low
-- score. Scoring thin evidence as "unengaged" would quietly punish every new
-- subscriber for being new — they would lose reclaimed leads to established
-- customers and have no way to earn their way out of it. Absence of evidence is
-- not evidence of absence.
-- ---------------------------------------------------------------------------
create or replace function public.get_customer_engagement_scores(
  p_lead_type public.lead_type,
  p_customer_ids uuid[] default null
)
returns table (
  customer_id     uuid,
  score           numeric,
  is_neutral      boolean,
  assignments     integer,
  open_rate       numeric,
  contact_rate    numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with p as (
    select open_rate_weight ow, contact_rate_weight cw,
           window_days wd, min_assignments minn
    from public.engagement_score_params()
  ),
  base as (
    select
      c.id as cid,
      count(la.id)::integer as n,
      -- Rates are over assignments in the window, so a customer who received
      -- few leads is not penalised for receiving few leads.
      coalesce(
        count(la.id) filter (where exists (
          select 1 from public.lead_events e
          where e.assignment_id = la.id and e.event_type = 'detail_opened'
        ))::numeric / nullif(count(la.id), 0), 0
      ) as o_rate,
      coalesce(
        count(la.id) filter (where exists (
          select 1 from public.lead_events e
          where e.assignment_id = la.id
            and e.event_type in ('tel_click', 'mailto_click')
        ))::numeric / nullif(count(la.id), 0), 0
      ) as c_rate,
      (c.created_at <= now() - make_interval(days => (select wd from p))) as has_history
    from public.customers c
    left join public.lead_assignments la
      on la.customer_id = c.id
     and la.assigned_at >= now() - make_interval(days => (select wd from p))
    left join public.leads l
      on l.id = la.lead_id and l.lead_type = p_lead_type
    where (p_customer_ids is null or c.id = any (p_customer_ids))
      -- Only count assignments of the requested product.
      and (la.id is null or l.id is not null)
    group by c.id, c.created_at
  ),
  scored as (
    select b.*,
           (p.ow * b.o_rate) + (p.cw * b.c_rate) as raw,
           (b.n >= p.minn and b.has_history)     as qualifies
    from base b cross join p
  ),
  -- The neutral value is the median score among customers who DO have enough
  -- evidence. With no such customers at all, 0.5 is the honest midpoint.
  med as (
    -- percentile_cont resolves to double precision; cast back so the score
    -- column stays numeric and comparable with the directly-computed scores.
    select coalesce(
      percentile_cont(0.5) within group (order by raw)::numeric, 0.5::numeric
    ) as m
    from scored where qualifies
  )
  select
    s.cid,
    round(case when s.qualifies then s.raw else med.m end, 4),
    not s.qualifies,
    s.n,
    round(s.o_rate, 4),
    round(s.c_rate, 4)
  from scored s cross join med;
$$;

revoke execute on function public.get_customer_engagement_scores(public.lead_type, uuid[])
  from public, anon, authenticated;
grant execute on function public.get_customer_engagement_scores(public.lead_type, uuid[])
  to service_role;

-- ---------------------------------------------------------------------------
-- 3 — Telemetry start date.
--
-- lead_events began collecting when 0041 was applied; there is no passive
-- signal before it. Recorded so the dashboard can say "from <date>" honestly
-- instead of implying the figures cover a customer's whole history.
-- ---------------------------------------------------------------------------
insert into public.system_settings (key, value)
  values ('telemetry_from', coalesce(
    (select min(created_at)::text from public.lead_events),
    now()::text
  ))
  on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 4 — Cohort benchmarks for the CALLING customer.
--
-- ###################  SECURITY DESIGN  ###################
--
-- This is the only SECURITY DEFINER function in the schema that authenticated
-- users may call, so it is built to make leaking structurally impossible rather
-- than merely unlikely:
--
--   * IT TAKES NO PARAMETERS. There is no customer id, no filter, no window
--     override — nothing to tamper with. The most common way these functions
--     leak is an id parameter the caller can change; there isn't one.
--
--   * Identity is derived from auth.uid() INSIDE the function. A caller cannot
--     assert who they are; PostgREST sets the JWT claim and the function reads
--     it. An anon caller has no auth.uid(), resolves to no customer, and gets
--     zero rows.
--
--   * The result set is AGGREGATES ONLY. Every returned column is a rate, a
--     percentile or a count. No customer id, no business name, no lead, no
--     assignment, no row belonging to anyone else — there is no column capable
--     of carrying another customer's data.
--
--   * Cohort figures are suppressed entirely unless at least 5 OTHER customers
--     each have >= 10 assignments in the window. That is a re-identification
--     guard, not decoration: with two customers in a cohort, "the median" IS
--     the other one's number.
--
-- #########################################################
--
-- Win rate is deliberately absent. It is self-reported ('won' is a status a
-- customer sets by hand), so it measures record-keeping discipline rather than
-- performance, and publishing it as a comparison would reward the wrong thing.
--
-- "top_quartile" means the GOOD quartile in both directions: the 75th
-- percentile for rates (higher is better) and the 25th for hours-to-attempt
-- (faster is better). A single percentile constant would have made the speed
-- metric silently reward the slowest quarter of the cohort.
-- ---------------------------------------------------------------------------
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
  -- A customer needs this many assignments in the window to be counted as a
  -- cohort member at all.
  c_min_cohort_n    constant integer := 10;
  -- And this many OTHER qualifying customers must exist before any cohort
  -- figure is shown.
  c_min_cohort_size constant integer := 5;
  -- Hours-to-first-attempt is noisy on small samples, so a customer needs this
  -- many measurable attempts before their own figure or their contribution to
  -- the cohort is used.
  c_min_attempts    constant integer := 5;
  v_customer_id uuid;
begin
  -- Identity comes from the session, never from an argument.
  select c.id into v_customer_id
    from public.customers c
   where c.user_id = auth.uid();

  -- Not a customer (or not signed in): no rows. Never an error, so the function
  -- cannot be used to probe whether a given session maps to a customer.
  if v_customer_id is null then
    return;
  end if;

  return query
  with
  -- Has passive telemetry actually been collecting during this window?
  --
  -- Without this guard the first weeks after launch render "You: 0%, Typical
  -- operator: 0%" for everybody — which reads as either a broken page or an
  -- accusation, when the truth is simply that measurement has just started. A
  -- genuine 0% and an unmeasured 0% are indistinguishable in the arithmetic,
  -- so they are distinguished here instead, and the state resolves itself as
  -- soon as any real activity is recorded.
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
      (
        select min(e.created_at) from public.lead_events e
        where e.assignment_id = la.id
          and e.event_type in ('tel_click', 'mailto_click')
      ) as first_attempt_at
    from public.lead_assignments la
    join public.leads l on l.id = la.lead_id
    where la.assigned_at >= now() - make_interval(days => c_window_days)
  ),
  -- Per customer per product.
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
  -- The cohort is every OTHER qualifying customer. Excluding self is what makes
  -- "median" a comparison rather than a mirror.
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

    -- Contact-attempt rate (may use the full 90 days)
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

-- This one IS callable by a signed-in customer — that is its purpose. It is
-- safe to expose because it takes no arguments, derives identity from
-- auth.uid(), and returns only aggregates. anon is refused: a session with no
-- auth.uid() resolves to no customer and receives zero rows, but there is no
-- reason to let it reach the function at all.
revoke execute on function public.get_engagement_benchmarks() from public, anon;
grant execute on function public.get_engagement_benchmarks() to authenticated, service_role;
