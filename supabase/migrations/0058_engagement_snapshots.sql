-- ============================================================================
-- Weekly engagement snapshots + a cancellation timestamp.
--
-- WHY THIS EXISTS
-- ---------------
-- Three questions need the same data, and none of them can be answered from
-- what the schema records today:
--
--   1. WHO IS ABOUT TO LEAVE. Nobody cancels a product they use. A customer
--      whose engagement is falling is a customer who has stopped seeing value,
--      and that shows up weeks before the cancellation does.
--   2. DOES ENGAGEMENT PREDICT VALUE. Engagement measured against lifetime
--      revenue, per customer, over time.
--   3. HOW MANY SUBSCRIBERS CAN THE LEAD SUPPLY ACTUALLY CARRY. Nominal
--      capacity counts credits, which is the wrong unit: a customer who buys 20
--      leads a month and works 2 of them consumes 20 credits and delivers
--      service on 2. Real capacity is credits x engagement, and it cannot be
--      computed without knowing the engagement rate.
--
-- get_customer_engagement_scores (0047) already computes the rate. What it does
-- not do is REMEMBER it — the score is derived live from a rolling 30-day
-- window, so last month's score is gone the moment the window moves past it.
-- Every question above is about a trend, and a trend needs history.
--
-- THIS IS THE PART THAT CANNOT BE BACKFILLED. Everything else in this feature
-- can be added later against existing rows; a time series cannot be
-- reconstructed after the fact. That is the whole reason this ships now, ahead
-- of anything that reads it.
--
-- ON PREDICTION SPECIFICALLY
-- --------------------------
-- No customer has ever cancelled — 20 active, 12 waitlisted, zero cancelled
-- rows. A churn MODEL needs churn to learn from, so there is deliberately no
-- model here and no risk score pretending to be one. What this table supports
-- immediately is the ranked list: least-engaged customers first, with a trend
-- once a few weeks have accumulated. That is the actionable part anyway — a
-- prediction would only tell you who to ring, and the ranking already does.
-- The model becomes possible after the first handful of cancellations, with the
-- history already sitting here waiting for it.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 — When a subscription ended.
--
-- account_status flips to 'cancelled' and gr_subscription_status to 'canceled'
-- with no record of WHEN, so even with perfect engagement history there would
-- be nothing to line it up against: "engagement fell, and six weeks later they
-- left" is unanswerable without a date on the leaving.
--
-- Two columns, not one, for the usual reason (invariant 6): the products are
-- independent and a customer may cancel one and keep the other. Stamped by the
-- Stripe webhook in the code phase; nullable, so a customer who has never
-- cancelled is NULL rather than falsely dated.
-- ---------------------------------------------------------------------------
alter table public.customers
  add column if not exists cancelled_at    timestamptz,
  add column if not exists gr_cancelled_at timestamptz;

-- ---------------------------------------------------------------------------
-- 2 — The snapshot.
--
-- One row per customer per product per capture. Per product because engagement
-- is per product everywhere else in this schema, and a customer who works their
-- management leads and ignores their GR leads is a real and important case that
-- a single blended number would hide.
--
-- captured_on is a DATE, not a timestamp, and carries the unique constraint:
-- re-running the capture on the same day overwrites rather than duplicating, so
-- a retried cron cannot corrupt the series with two subtly different readings
-- of the same week.
-- ---------------------------------------------------------------------------
create table if not exists public.customer_engagement_snapshots (
  id                     uuid primary key default gen_random_uuid(),
  customer_id            uuid not null references public.customers(id) on delete cascade,
  lead_type              public.lead_type not null,
  captured_on            date not null default current_date,
  window_days            integer not null,

  -- The capacity numbers. worked_rate is the headline: of the leads this
  -- customer was delivered in the window, what fraction did they engage with at
  -- all. Stored rather than derived so the figure can never drift from the
  -- definition that was in force when it was taken.
  assignments_delivered  integer not null default 0,
  assignments_worked     integer not null default 0,
  worked_rate            numeric,

  -- The 0047 components, kept separately so a later recalibration can see which
  -- half of the score moved.
  open_rate              numeric,
  contact_rate           numeric,
  engagement_score       numeric,

  -- Platform-wide activity, not attached to any one lead. This is the half the
  -- existing scoring cannot see and the half that speaks to "are they still
  -- using the product at all".
  logins_in_window       integer not null default 0,
  notes_added            integer not null default 0,
  notifications_read     integer not null default 0,

  -- LIFETIME figures, alongside the rolling window rather than instead of it.
  --
  -- The 30-day window is the right lens for deciding whether a single lead has
  -- gone quiet. It is the wrong one for churn: a customer who has used the
  -- product properly for six months and gone quiet for three weeks is a
  -- different proposition from one who has never engaged at all, and a rolling
  -- window shows them as identical. Cumulative use is what separates "gone off
  -- the boil" from "never got started", and those two need different phone
  -- calls.
  --
  -- days_since_last_activity is the single most direct churn signal here:
  -- nobody cancels a product they used yesterday.
  lifetime_assignments     integer not null default 0,
  lifetime_worked          integer not null default 0,
  lifetime_worked_rate     numeric,
  -- Two tenures, because they answer different questions and were conflated
  -- once already. tenure_days runs from account creation, which for most
  -- customers is an invite or a waitlist entry a week or two before they paid.
  -- paying_days runs from the billing anchor — the date money first changed
  -- hands — and is the one that belongs next to revenue or a churn window.
  tenure_days              integer,
  paying_days              integer,
  days_since_last_activity integer,

  -- Value, for engagement-against-revenue. Gross recorded payments to date, in
  -- pence. NOTE: the payments table is known to be incomplete (17 rows against
  -- 20 active subscribers), so this understates and must not be presented as
  -- authoritative LTV until that gap is closed. It is recorded now so the
  -- series exists; correcting the source later corrects every future row.
  lifetime_revenue_pence bigint not null default 0,

  -- Denormalised so a snapshot stays meaningful after the customer's plan or
  -- status changes. Without these, a row from three months ago cannot be read
  -- in the terms that applied when it was taken.
  monthly_allocation     integer,
  account_status         text,
  subscription_status    text,

  created_at             timestamptz not null default now(),
  unique (customer_id, lead_type, captured_on)
);

create index if not exists idx_engagement_snapshots_customer
  on public.customer_engagement_snapshots (customer_id, lead_type, captured_on desc);

create index if not exists idx_engagement_snapshots_captured
  on public.customer_engagement_snapshots (captured_on desc);

-- RLS on with no policies. A customer must never read the cohort's engagement:
-- get_engagement_benchmarks (0047) is the sanctioned, aggregate-only,
-- suppression-guarded way for them to compare themselves to anyone, and this
-- table is the raw per-customer material that function exists to withhold.
alter table public.customer_engagement_snapshots enable row level security;

-- ---------------------------------------------------------------------------
-- 3 — Take a snapshot.
--
-- Idempotent per day via the unique constraint: a second run on the same date
-- updates the existing rows. Safe to call by hand, and safe for a cron that
-- retries after a partial failure.
--
-- "Worked" uses the same definition as soft reclaim and the escalation ladder —
-- an operator-generated lead_event, a note, or a file. Keeping the three in
-- step matters: if the escalation job and this table disagreed about what
-- working a lead means, the capacity figure would not describe the system the
-- escalation is operating on.
-- ---------------------------------------------------------------------------
create or replace function public.capture_engagement_snapshots(
  p_window_days integer default 30
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  with since as (
    select now() - make_interval(days => p_window_days) as t
  ),
  base as (
    select
      c.id                          as customer_id,
      lt.lead_type,
      c.monthly_allocation,
      c.account_status,
      c.subscription_status,
      -- The product match is a FILTER on every aggregate rather than a
      -- predicate on the join, so each customer produces a row for each product
      -- whatever they hold. Filtering in the WHERE instead would eliminate a
      -- management-only customer's guaranteed_rent row entirely, leaving the
      -- series with holes that a reader cannot distinguish from "we did not run
      -- that week". A zero is a measurement; a missing row is not.
      count(la.id) filter (where l.lead_type = lt.lead_type)::integer as delivered,
      count(la.id) filter (where l.lead_type = lt.lead_type and (
        exists (select 1 from public.lead_events e
                 where e.assignment_id = la.id
                   and e.event_type in ('detail_opened', 'tel_click', 'mailto_click'))
        or exists (select 1 from public.lead_notes n where n.lead_assignment_id = la.id)
        or exists (select 1 from public.lead_files f where f.lead_assignment_id = la.id)
      ))::integer                   as worked,
      count(la.id) filter (where l.lead_type = lt.lead_type and
        exists (select 1 from public.lead_events e
                 where e.assignment_id = la.id and e.event_type = 'detail_opened')
      )::integer                    as opened,
      count(la.id) filter (where l.lead_type = lt.lead_type and
        exists (select 1 from public.lead_events e
                 where e.assignment_id = la.id
                   and e.event_type in ('tel_click', 'mailto_click'))
      )::integer                    as contacted
    from public.customers c
    cross join (select unnest(enum_range(null::public.lead_type)) as lead_type) lt
    cross join since s
    left join public.lead_assignments la
           on la.customer_id = c.id
          and la.assigned_at >= s.t
    left join public.leads l
           on l.id = la.lead_id
    group by c.id, lt.lead_type, c.monthly_allocation, c.account_status, c.subscription_status
  ),
  -- The 0047 score for the WHOLE cohort, once per product.
  --
  -- This must not be called per customer. get_customer_engagement_scores
  -- computes its neutral value as the median over the customers it was asked
  -- about, so a single-id call has a cohort of one: if that customer does not
  -- qualify (under 30 days history, or under 5 assignments in the window) the
  -- median is empty and they take the hard-coded 0.5 fallback. Verified against
  -- production — four of six customers came back 0.5000 called singly against a
  -- true cohort median of 0.1225. That would have recorded the least engaged
  -- customers as mid-pack, in the one table built to identify them.
  scores as (
    select lt.lead_type, s.customer_id, s.score
    from (select unnest(enum_range(null::public.lead_type)) as lead_type) lt
    cross join lateral public.get_customer_engagement_scores(lt.lead_type, null) s
  ),
  -- Lifetime, per customer per product: every assignment ever, not just the
  -- window. Same "worked" definition as everywhere else in this feature.
  lifetime as (
    select
      c.id as customer_id,
      lt.lead_type,
      count(la.id) filter (where l.lead_type = lt.lead_type)::integer as ever_delivered,
      count(la.id) filter (where l.lead_type = lt.lead_type and (
        exists (select 1 from public.lead_events e
                 where e.assignment_id = la.id
                   and e.event_type in ('detail_opened', 'tel_click', 'mailto_click'))
        or exists (select 1 from public.lead_notes n where n.lead_assignment_id = la.id)
        or exists (select 1 from public.lead_files f where f.lead_assignment_id = la.id)
      ))::integer                                                     as ever_worked
    from public.customers c
    cross join (select unnest(enum_range(null::public.lead_type)) as lead_type) lt
    left join public.lead_assignments la on la.customer_id = c.id
    left join public.leads l on l.id = la.lead_id
    group by c.id, lt.lead_type
  ),
  activity as (
    select
      c.id as customer_id,
      -- Tenure from account creation. Not from first assignment: a customer who
      -- signed up and never received a lead has still been a customer, and that
      -- is itself worth seeing in a churn series.
      (current_date - c.created_at::date)::integer as tenure_days,
      -- Null until they have actually paid for something.
      (current_date - coalesce(c.billing_cycle_anchor, c.gr_billing_cycle_anchor))::integer
        as paying_days,
      -- Most recent engagement of any kind, anywhere on the platform. Signing in
      -- counts: it is the weakest signal but the broadest, and a customer who
      -- has not even logged in for six weeks is the clearest warning available.
      (current_date - greatest(
        (select max(e.created_at)::date from public.lead_events e
           join public.lead_assignments la on la.id = e.assignment_id
          where la.customer_id = c.id
            and e.event_type in ('detail_opened', 'tel_click', 'mailto_click')),
        (select max(n.created_at)::date from public.lead_notes n where n.customer_id = c.id),
        (select max(nt.read_at)::date from public.notifications nt where nt.customer_id = c.id),
        (select u.last_sign_in_at::date from auth.users u where u.id = c.user_id)
      ))::integer as days_since_last_activity,
      (select count(*) from public.lead_notes n, since s
        where n.customer_id = c.id and n.created_at >= s.t)::integer as notes_added,
      (select count(*) from public.notifications nt, since s
        where nt.customer_id = c.id and nt.read_at >= s.t)::integer  as notifications_read,
      -- auth.users holds only the MOST RECENT sign-in, not a log, so this can
      -- only ever be 0 or 1: "did they sign in during the window at all". A
      -- true login count needs a login event stream we do not keep.
      (select case when exists (
          select 1 from auth.users u, since s
           where u.id = c.user_id and u.last_sign_in_at >= s.t
        ) then 1 else 0 end)                                          as logins_in_window,
      (select coalesce(sum(p.amount_pence), 0) from public.payments p
        where p.customer_id = c.id and p.status = 'paid')::bigint     as revenue
    from public.customers c
  )
  insert into public.customer_engagement_snapshots (
    customer_id, lead_type, captured_on, window_days,
    assignments_delivered, assignments_worked, worked_rate,
    open_rate, contact_rate, engagement_score,
    logins_in_window, notes_added, notifications_read,
    lifetime_assignments, lifetime_worked, lifetime_worked_rate,
    tenure_days, paying_days, days_since_last_activity,
    lifetime_revenue_pence,
    monthly_allocation, account_status, subscription_status
  )
  select
    b.customer_id, b.lead_type, current_date, p_window_days,
    b.delivered, b.worked,
    case when b.delivered > 0 then round(b.worked::numeric / b.delivered, 4) end,
    case when b.delivered > 0 then round(b.opened::numeric / b.delivered, 4) end,
    case when b.delivered > 0 then round(b.contacted::numeric / b.delivered, 4) end,
    -- The 0047 score, recorded alongside the raw rates rather than instead of
    -- them: it applies a neutral cohort median to thin samples, which is right
    -- for choosing a recipient and wrong for a historical record. Keeping both
    -- means the series shows what the customer actually did AND what the
    -- routing model believed about them.
    sc.score,
    a.logins_in_window, a.notes_added, a.notifications_read,
    lf.ever_delivered, lf.ever_worked,
    case when lf.ever_delivered > 0
         then round(lf.ever_worked::numeric / lf.ever_delivered, 4) end,
    a.tenure_days, a.paying_days, a.days_since_last_activity,
    a.revenue,
    b.monthly_allocation, b.account_status, b.subscription_status
  from base b
  join activity a on a.customer_id = b.customer_id
  join lifetime lf
    on lf.customer_id = b.customer_id and lf.lead_type = b.lead_type
  left join scores sc
         on sc.customer_id = b.customer_id and sc.lead_type = b.lead_type
  on conflict (customer_id, lead_type, captured_on) do update set
    window_days            = excluded.window_days,
    assignments_delivered  = excluded.assignments_delivered,
    assignments_worked     = excluded.assignments_worked,
    worked_rate            = excluded.worked_rate,
    open_rate              = excluded.open_rate,
    contact_rate           = excluded.contact_rate,
    engagement_score       = excluded.engagement_score,
    logins_in_window       = excluded.logins_in_window,
    notes_added            = excluded.notes_added,
    notifications_read     = excluded.notifications_read,
    lifetime_assignments     = excluded.lifetime_assignments,
    lifetime_worked          = excluded.lifetime_worked,
    lifetime_worked_rate     = excluded.lifetime_worked_rate,
    tenure_days              = excluded.tenure_days,
    paying_days              = excluded.paying_days,
    days_since_last_activity = excluded.days_since_last_activity,
    lifetime_revenue_pence = excluded.lifetime_revenue_pence,
    monthly_allocation     = excluded.monthly_allocation,
    account_status         = excluded.account_status,
    subscription_status    = excluded.subscription_status;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke execute on function public.capture_engagement_snapshots(integer)
  from public, anon, authenticated;
grant execute on function public.capture_engagement_snapshots(integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- 4 — Seed the series with today's reading, so the first week of the trend does
-- not have to wait for the cron to be wired up. Telemetry has been collecting
-- since 27 July, so this first point is real data, not a zero row.
-- ---------------------------------------------------------------------------
select public.capture_engagement_snapshots(30);
