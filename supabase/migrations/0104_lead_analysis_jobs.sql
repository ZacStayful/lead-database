-- ============================================================================
-- 0104 — The queue behind paid lead analysis.
--
-- A customer-owned lead (0102) arrives with no figures and no analysis PDF.
-- Those come from parsing a document attached to the lead's Monday item (§25),
-- and a lead the customer added themselves has no Monday item — the CHECK added
-- in 0102 says so explicitly. So the one path that produces gross income,
-- nightly rate, occupancy and the management fee can never fire for the leads
-- this feature is about.
--
-- The upsell closes that for £3 a lead: we call the Stayful analyser directly,
-- and write the answer into the SAME columns and the SAME storage bucket the
-- Monday path already writes. Nothing downstream learns a new shape — an owned
-- lead with figures renders identically to a marketplace one, which is the
-- whole product promise.
--
-- This migration is the durable queue in between, and nothing else. It is
-- INERT on its own: no code selects from these tables until the worker lands,
-- and no row can exist until the charge lands, so it can be applied ahead of
-- the code exactly as the deployment-order rule requires.
--
-- ── Why 0104 and not 0103 ───────────────────────────────────────────────────
--
-- 0103 is spoken for. CLAUDE.md §30.8 and 0102's own header both name it for
-- the eight cross-customer reporting functions that still need
-- `owner_customer_id is null` — get_customer_engagement_scores,
-- get_engagement_benchmarks, get_wins / get_customer_scoreboard /
-- get_assignments_awaiting_outcome, capture_operator_proof + get_operator_proof
-- (which duplicate one population and must change together), and the
-- leads-scanning CTEs in get_service_capacity. Taking the number would leave
-- that work with nowhere obvious to land.
--
-- ── Why a queue at all ──────────────────────────────────────────────────────
--
-- One analysis is 20-30 seconds typically and around 70 at worst: the revenue
-- API polls for up to 25s on its own, and a PDF is rendered at the end. Two
-- hundred leads is half an hour of wall clock. That cannot live in a request,
-- and it must survive a function being killed half way with money already
-- spent — every row costs us an Airbtics report whether or not we keep the
-- answer.
--
-- The design is a transcription of the analyser's own bulk-job machinery
-- (Stayful-STR-estimate-software, 20260817120000_create_bulk_jobs.sql), which
-- has been driven in anger against a 60-second ceiling. Deliberately a
-- transcription rather than an import: the two apps deploy independently, and
-- the shape is 60 lines of SQL.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 — The job: one purchase.
--
-- A job exists from the moment the customer says yes, BEFORE the money moves,
-- because the charge needs something to be idempotent against. It is created
-- `awaiting_payment` and nothing will claim its rows until a successful charge
-- flips it to `running` (0105). That flip is the only thing standing between an
-- abandoned checkout and a batch of Airbtics reports nobody paid for.
-- ---------------------------------------------------------------------------
create table if not exists public.lead_analysis_jobs (
  id              uuid primary key default gen_random_uuid(),
  customer_id     uuid not null references public.customers(id) on delete cascade,
  lead_type       public.lead_type not null,

  -- Where the purchase came from. Kept because the three answer different
  -- questions about the feature: `import` is the batch offer after a
  -- spreadsheet lands, `manual` is the checkbox on the single-lead form, and
  -- `detail` is somebody coming back to a lead they added weeks ago.
  source          text not null,
  -- The spreadsheet this job followed, when there was one. `on delete set null`
  -- because the staged rows are transient (§30.6) and their disappearance must
  -- not take a paid job with them.
  import_id       uuid references public.lead_imports(id) on delete set null,

  status          text not null default 'awaiting_payment',
  paused_reason   text,

  -- What was quoted, in the units the quote was made in. Stored rather than
  -- recomputed: the price is a promise made at a moment, and a later change to
  -- LEAD_ANALYSIS_PRICE_PENCE must not retroactively alter what somebody was
  -- told they would pay.
  row_count       integer not null default 0,
  amount_pence    integer not null default 0,

  succeeded_count integer not null default 0,
  failed_count    integer not null default 0,

  -- Refund state is a small machine of its own, because the indeterminate case
  -- has to be re-attemptable. See 0105 and the finaliser below.
  refund_status   text not null default 'none',
  refund_pence    integer,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  confirmed_at    timestamptz,
  finished_at     timestamptz
);

alter table public.lead_analysis_jobs drop constraint if exists lead_analysis_jobs_source_check;
alter table public.lead_analysis_jobs
  add constraint lead_analysis_jobs_source_check
  check (source in ('import', 'manual', 'detail'));

alter table public.lead_analysis_jobs drop constraint if exists lead_analysis_jobs_status_check;
alter table public.lead_analysis_jobs
  add constraint lead_analysis_jobs_status_check
  check (status in ('awaiting_payment', 'running', 'completed', 'cancelled', 'failed'));

alter table public.lead_analysis_jobs drop constraint if exists lead_analysis_jobs_refund_status_check;
alter table public.lead_analysis_jobs
  add constraint lead_analysis_jobs_refund_status_check
  check (refund_status in ('none', 'due', 'refunded', 'failed'));

create index if not exists idx_lead_analysis_jobs_customer
  on public.lead_analysis_jobs (customer_id, created_at desc);

-- The worker's own index: it only ever looks for jobs that are running.
create index if not exists idx_lead_analysis_jobs_running
  on public.lead_analysis_jobs (created_at)
  where status = 'running';

comment on table public.lead_analysis_jobs is
  'One purchase of paid lead analysis. Created awaiting_payment; only a '
  'successful charge (0105) flips it to running, which is what makes its rows '
  'claimable. Never touches lead_balance — this buys analysis, not leads.';

comment on column public.lead_analysis_jobs.amount_pence is
  'What the customer was quoted, in pence, at the moment they were quoted it. '
  'Stored rather than recomputed so a later price change cannot retroactively '
  'alter what somebody was told they would pay.';


-- ---------------------------------------------------------------------------
-- 2 — The row: one lead.
--
-- `chargeable` exists so the finaliser can tell "we took £3 and produced
-- nothing" from "this was never charged for". A row excluded at quote time is
-- never charged and so is never refunded — we exclude up front rather than
-- refunding by exclusion, which keeps the money story simple enough to explain.
-- ---------------------------------------------------------------------------
create table if not exists public.lead_analysis_rows (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references public.lead_analysis_jobs(id) on delete cascade,
  -- Cascades: a customer who deletes an owned lead mid-job takes its row with
  -- it. The worker therefore has to tolerate a row vanishing between claim and
  -- write, which it does — that is one lead lost from a batch, not a batch.
  lead_id       uuid not null references public.leads(id) on delete cascade,

  status        text not null default 'pending',
  attempts      integer not null default 0,
  max_attempts  integer not null default 2,

  claim_token   uuid,
  claimed_at    timestamptz,
  started_at    timestamptz,
  finished_at   timestamptz,

  -- What came back. `quality_ok` false is the tell-tale of a synthetic figure
  -- (the revenue API swallows upstream failures and returns a plausible
  -- estimate), and is a refundable failure rather than a stored one.
  quality_ok    boolean,
  error_code    text,
  error_message text,

  chargeable    boolean not null default true,
  refunded_at   timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.lead_analysis_rows drop constraint if exists lead_analysis_rows_status_check;
alter table public.lead_analysis_rows
  add constraint lead_analysis_rows_status_check
  check (status in ('pending', 'claimed', 'running', 'succeeded', 'failed', 'cancelled'));

-- One lead once per job. A double-submitted offer must not buy the same
-- analysis twice inside one purchase.
create unique index if not exists uq_lead_analysis_rows_job_lead
  on public.lead_analysis_rows (job_id, lead_id);

create index if not exists idx_lead_analysis_rows_claimable
  on public.lead_analysis_rows (job_id, status);

create index if not exists idx_lead_analysis_rows_inflight
  on public.lead_analysis_rows (claimed_at)
  where status in ('claimed', 'running');

comment on table public.lead_analysis_rows is
  'One lead inside a paid analysis job. attempts is incremented AT CLAIM, so a '
  'row that hard-kills its worker burns max_attempts and stops, rather than '
  'looping forever on an external report we pay for each time.';


-- ---------------------------------------------------------------------------
-- 3 — updated_at, so a stalled job is visible without reading the worker log.
-- ---------------------------------------------------------------------------
create or replace function public.touch_lead_analysis_updated_at()
returns trigger
language plpgsql
-- Pinned even though this is SECURITY INVOKER and needs a trigger context to
-- do anything: Supabase's linter flags a mutable search_path on any function
-- (0011), and leaving a new one warning teaches everyone to ignore the list.
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_lead_analysis_jobs_touch on public.lead_analysis_jobs;
create trigger trg_lead_analysis_jobs_touch
  before update on public.lead_analysis_jobs
  for each row execute function public.touch_lead_analysis_updated_at();

drop trigger if exists trg_lead_analysis_rows_touch on public.lead_analysis_rows;
create trigger trg_lead_analysis_rows_touch
  before update on public.lead_analysis_rows
  for each row execute function public.touch_lead_analysis_updated_at();


-- ---------------------------------------------------------------------------
-- 4 — claim_lead_analysis_rows
--
-- Transcribed from claim_bulk_rows in the analyser repo
-- (20260817120000_create_bulk_jobs.sql), with the names changed and nothing
-- else. Every clause in it is load-bearing:
--
--   p_max_inflight   A global ceiling on rows running at once across EVERY
--                    worker. This is the spend-rate throttle, not a latency
--                    knob: each in-flight row is an external report we are
--                    paying for.
--   skip locked      Two overlapping invocations must never claim one row. The
--                    worker chains ahead of itself, so overlap is normal.
--   attempts at claim A row that hard-kills its worker (OOM, timeout) burns an
--                    attempt and eventually stops, instead of looping forever
--                    buying the same report.
--   stale reclaim    ...but a row abandoned by a killed invocation must come
--                    back. The window is many times the worst-case row, so it
--                    cannot race a worker that is merely slow.
--   order by job     Queued purchases drain oldest-first. Ordering by a random
--                    uuid would interleave two customers' batches and finish
--                    neither.
-- ---------------------------------------------------------------------------
create or replace function public.claim_lead_analysis_rows(
  p_limit         int,
  p_claim_token   uuid,
  p_max_inflight  int  default 3,
  p_stale_seconds int  default 600
) returns setof public.lead_analysis_rows
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inflight int;
  v_take     int;
begin
  select count(*) into v_inflight
    from public.lead_analysis_rows r
   where r.status in ('claimed', 'running')
     and r.claimed_at > now() - make_interval(secs => p_stale_seconds);

  v_take := least(p_limit, greatest(p_max_inflight - v_inflight, 0));
  if v_take <= 0 then
    return;
  end if;

  return query
  with candidate as (
    select r.id
      from public.lead_analysis_rows r
      join public.lead_analysis_jobs j on j.id = r.job_id
     where j.status = 'running'
       and r.attempts < r.max_attempts
       and (
             r.status = 'pending'
             or (r.status in ('claimed', 'running')
                 and r.claimed_at < now() - make_interval(secs => p_stale_seconds))
           )
     order by j.created_at, r.created_at, r.id
     limit v_take
     for update of r skip locked
  )
  update public.lead_analysis_rows r
     set status      = 'claimed',
         claim_token = p_claim_token,
         claimed_at  = now(),
         attempts    = r.attempts + 1,
         updated_at  = now()
    from candidate c
   where r.id = c.id
  returning r.*;
end;
$$;


-- ---------------------------------------------------------------------------
-- 5 — finalise_lead_analysis_job
--
-- Closes a job once no row can move again, and decides what is owed back.
--
-- A row is finished when it succeeded, or when it failed with no attempts left.
-- Refunding earlier would refund a row that is about to be retried; refunding
-- never would keep £3 for figures we did not produce.
--
-- Idempotent on `finished_at is null`, so the worker can call it at the end of
-- every invocation without checking first.
-- ---------------------------------------------------------------------------
create or replace function public.finalise_lead_analysis_job(p_job_id uuid)
returns table (
  finalised       boolean,
  succeeded_count integer,
  failed_count    integer,
  refund_pence    integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job       public.lead_analysis_jobs%rowtype;
  v_unit      integer;
  v_pending   integer;
  v_succeeded integer;
  v_failed    integer;
  v_refund    integer;
begin
  select * into v_job
    from public.lead_analysis_jobs
   where id = p_job_id
     for update;

  if not found then
    return query select false, 0, 0, 0;
    return;
  end if;

  if v_job.finished_at is not null then
    return query select false, v_job.succeeded_count, v_job.failed_count,
                        coalesce(v_job.refund_pence, 0);
    return;
  end if;

  -- Anything that could still move. A row with attempts left is not a failure
  -- yet, however many times it has already come back wrong.
  select count(*) into v_pending
    from public.lead_analysis_rows r
   where r.job_id = p_job_id
     and r.status in ('pending', 'claimed', 'running')
     and r.attempts < r.max_attempts;

  if v_pending > 0 then
    return query select false, v_job.succeeded_count, v_job.failed_count,
                        coalesce(v_job.refund_pence, 0);
    return;
  end if;

  select count(*) filter (where r.status = 'succeeded')
    into v_succeeded
    from public.lead_analysis_rows r
   where r.job_id = p_job_id;

  -- Divide rather than re-read the price constant: what a row cost is a fact
  -- about this purchase, and row_count is what the customer was charged for.
  v_unit := case
              when v_job.row_count > 0 then v_job.amount_pence / v_job.row_count
              else 0
            end;

  -- ── What is owed back is what was PAID FOR and not DELIVERED ──────
  --
  -- Deliberately `row_count - succeeded` rather than a count of failed rows,
  -- and the difference is a row that is no longer there.
  --
  -- lead_analysis_rows.lead_id cascades from leads, so a customer who deletes
  -- one of their own leads in the half hour between paying and it running takes
  -- its row with it. Counting failures then finds nothing to refund: they paid
  -- for three, received two, and were owed nothing — the money quietly kept for
  -- work never done. Counting what was paid for and subtracting what was
  -- delivered cannot miss a row, because it never looks at the rows at all.
  --
  -- failed_count is reported the same way, so the figure in the email agrees
  -- with the refund beside it.
  v_failed := greatest(v_job.row_count - v_succeeded, 0);
  v_refund := least(v_failed * v_unit, v_job.amount_pence);

  update public.lead_analysis_jobs
     set status          = 'completed',
         succeeded_count = v_succeeded,
         failed_count    = v_failed,
         refund_pence    = v_refund,
         -- 'due' is picked up by the next worker run. Marking it 'refunded'
         -- here would claim money moved that has not.
         refund_status   = case
                             when v_refund > 0 and refund_status = 'none' then 'due'
                             else refund_status
                           end,
         finished_at     = now()
   where id = p_job_id;

  return query select true, v_succeeded, v_failed, v_refund;
end;
$$;


-- ---------------------------------------------------------------------------
-- 6 — Access.
--
-- Both functions are SECURITY DEFINER because they must bypass RLS. Supabase
-- exposes every public function at /rest/v1/rpc/<name> and EXECUTE defaults to
-- PUBLIC, so without these revokes they are callable by `anon` holding nothing
-- but the publishable key — which would let anyone stall a paid job or close
-- one early and trigger a refund. (Supabase's own linter flags this as 0028;
-- 0024 is this repo's precedent for locking privileged RPCs down.)
--
-- The role guards let this migration also apply to a plain Postgres, where
-- anon / authenticated / service_role do not exist — which is how it is
-- verified before it goes near production.
-- ---------------------------------------------------------------------------
revoke all on function public.claim_lead_analysis_rows(int, uuid, int, int) from public;
revoke all on function public.finalise_lead_analysis_job(uuid) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.claim_lead_analysis_rows(int, uuid, int, int) from anon';
    execute 'revoke all on function public.finalise_lead_analysis_job(uuid) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.claim_lead_analysis_rows(int, uuid, int, int) from authenticated';
    execute 'revoke all on function public.finalise_lead_analysis_job(uuid) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.claim_lead_analysis_rows(int, uuid, int, int) to service_role';
    execute 'grant execute on function public.finalise_lead_analysis_job(uuid) to service_role';
  end if;
end $$;


-- ---------------------------------------------------------------------------
-- 7 — RLS on, no policies.
--
-- The shape lead_imports and subscription_pauses already use. Only server code
-- holding the service-role key touches these tables, and that bypasses RLS — so
-- enabling it with no policy changes nothing today and denies everything to any
-- other key. A job row names what a customer bought and what it cost; it must
-- never be one missing policy away from another customer.
-- ---------------------------------------------------------------------------
alter table public.lead_analysis_jobs enable row level security;
alter table public.lead_analysis_rows enable row level security;
