-- ---------------------------------------------------------------------------
-- 0099 — Committed monthly revenue, captured
--
-- The half of the month-over-month series that CANNOT be derived.
--
-- §28.4's rule is "derive what durable columns can recompute; capture only what
-- they cannot", and applying it here draws a clean line. Activity and cohort
-- figures come from durable timestamps and are a function (0101). MRR does not:
-- it is computed from `monthly_allocation`, `subscription_status`,
-- `account_status` and `paused_at`, every one of which the Stripe webhook
-- OVERWRITES. `/admin` recomputes it live on each page load (force-dynamic) and
-- stores nothing, so historical MRR does not exist anywhere in this database
-- and cannot be reconstructed.
--
-- ---------------------------------------------------------------------------
-- WHY THERE IS NO CAPTURE FUNCTION IN THIS FILE — a deliberate departure.
--
-- 0064 and 0072 capture in SQL because they snapshot SQL functions that already
-- existed. MRR HAS NO SQL DEFINITION AND NEVER HAS — it is ~20 inline lines in
-- src/app/admin/page.tsx. Writing one here would CREATE the duplication that
-- §20 and §26.7 both record as a maintenance cost, in order to follow a
-- convention whose whole purpose is avoiding it, and it would have to hardcode
-- £150/£300 in SQL beside the copy in plans.ts. §1 records what three copies of
-- a price did last time.
--
-- So src/lib/mrr.ts is the single definition, and the escalate-leads cron
-- computes the figures in TypeScript and upserts the rows. This table is
-- storage, not logic.
--
-- ---------------------------------------------------------------------------
-- CADENCE: the CURRENT month's row is upserted DAILY, not written once at
-- month end.
--
-- A missed day degrades the month's closing value to the previous day's
-- reading. A missed month-end cron leaves a permanent hole — the failure mode
-- 0072 and 0081 both warn about, and one this repo has already demonstrated:
-- capture-leaderboard at `0 7 * * 1` has produced TWO captures against roughly
-- six expected Mondays. A weekly cron already misses; a monthly one is strictly
-- worse, and Vercel registers crons on production deployments only (§25), so a
-- deploy near month end shifts when a monthly job first fires.
--
-- ⚠️ The residual, stated rather than papered over: the last capture of a month
-- runs at 11:00 UTC on its final day, so anything changing between then and
-- midnight lands in the NEXT month's row. At a cancellation a quarter that is
-- immaterial. Do NOT add a second month-end-only cron to close it — two writers
-- for one row is the shape §23.6 warns about.
-- ---------------------------------------------------------------------------

create table if not exists public.customer_commercial_snapshots (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid not null references public.customers(id) on delete cascade,

  -- PER PRODUCT, not per customer. §18A: MRR sums per product because the two
  -- subscriptions are independent, so somebody holding both contributes both
  -- fees. Same grain as customer_engagement_snapshots (0064) and the OPPOSITE
  -- summing rule — see the comment on mrr_pence below.
  lead_type     public.lead_type not null,
  month_start   date not null,

  -- The last day this row was written, so a reader can tell a month that closed
  -- on its final day from one whose cron stopped on the 24th.
  captured_on   date not null default current_date,

  mrr_pence         bigint not null default 0,
  -- Reported BESIDE mrr_pence and never added to it (§21). A paused
  -- subscription is billing nothing today; folding it in is what made the
  -- figure wrong before.
  paused_mrr_pence  bigint not null default 0,

  holds_product boolean not null default false,
  paused        boolean not null default false,

  monthly_allocation  integer,
  subscription_status text,
  -- ⚠️ MANAGEMENT ONLY — null on guaranteed_rent rows. account_status is a
  -- management state (§3, invariant 6) and writing it onto a GR row is exactly
  -- how §18A's whole class of bug happens.
  account_status      text,

  cancel_at_period_end boolean not null default false,
  cancelled_at         timestamptz,

  created_at timestamptz not null default now(),

  constraint customer_commercial_snapshots_month_is_first
    check (month_start = date_trunc('month', month_start)::date),
  constraint customer_commercial_snapshots_account_status_mgmt_only
    check (lead_type = 'management' or account_status is null),
  constraint customer_commercial_snapshots_gr_never_paused
    check (lead_type = 'management' or paused = false)
);

comment on column public.customer_commercial_snapshots.mrr_pence is
  'Committed monthly revenue for THIS PRODUCT, priced from plans.ts. MUST be summed across lead_type for a customer total — the exact opposite of customer_engagement_snapshots.lifetime_revenue_pence (0064), which is per customer and must never be summed across products. Same grain, opposite rule.';

create unique index if not exists uniq_customer_commercial_month
  on public.customer_commercial_snapshots (customer_id, lead_type, month_start);

create index if not exists idx_customer_commercial_month
  on public.customer_commercial_snapshots (month_start);

-- Deny-all to the browser, as customer_engagement_snapshots (0064),
-- operator_proof_snapshots (§20), subscription_pauses (§21) and
-- subscription_plan_changes (§24). Reachable only on the service role.
alter table public.customer_commercial_snapshots enable row level security;


-- ---------------------------------------------------------------------------
-- The reader.
--
-- One row per month, both products broken out AND totalled — the breakout
-- because the two subscriptions are independent, the total because "reliable
-- income" is a single question.
--
-- `complete` is the `mature` analogue from 0097: a month counts only when it is
-- OVER and a capture actually landed on its final day. Anything else is a
-- partial reading, and `captured_days` says how partial.
-- ---------------------------------------------------------------------------
create or replace function public.get_monthly_commercial()
returns table (
  month_start          date,
  management_mrr_pence bigint,
  gr_mrr_pence         bigint,
  total_mrr_pence      bigint,
  paused_mrr_pence     bigint,
  customers_billed     integer,
  paused_customers     integer,
  captured_days        integer,
  last_captured_on     date,
  complete             boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    s.month_start,
    -- coalesced: a FILTERed sum over zero rows is NULL, and a month in which a
    -- product simply had no customers earned zero — which is a measurement,
    -- where null reads as "not known". Same instinct as 0064's "a zero is a
    -- measurement; a missing row is not".
    coalesce(sum(s.mrr_pence) filter (where s.lead_type = 'management'), 0)::bigint,
    coalesce(sum(s.mrr_pence) filter (where s.lead_type = 'guaranteed_rent'), 0)::bigint,
    -- Summed across lead_type deliberately: see the column comment.
    coalesce(sum(s.mrr_pence), 0)::bigint,
    coalesce(sum(s.paused_mrr_pence), 0)::bigint,
    count(distinct s.customer_id) filter (where s.mrr_pence > 0)::integer,
    count(distinct s.customer_id) filter (where s.paused)::integer,
    count(distinct s.captured_on)::integer,
    max(s.captured_on),
    (
      -- The month is over ...
      s.month_start < date_trunc('month', current_date)::date
      -- ... and a capture landed on its last day.
      and max(s.captured_on) >= (s.month_start + interval '1 month' - interval '1 day')::date
    )
  from public.customer_commercial_snapshots s
  group by s.month_start
  order by s.month_start;
$$;

revoke execute on function public.get_monthly_commercial()
  from public, anon, authenticated;
grant execute on function public.get_monthly_commercial() to service_role;
