-- ============================================================================
-- Weekly snapshots of the operator proof.
--
-- WHAT THIS CHANGES, AND WHAT IT DOES NOT
-- ---------------------------------------
-- get_operator_proof already reads live state, so the leaderboard has never
-- been stale — it recomputes on every page load. This is not a freshness fix.
--
-- It buys three things live computation cannot:
--
--   1. A DATE THE READER CAN SEE. "100% against 56%" with no asof reads as a
--      claim; "as of Monday" reads as a measurement. The figures also stop
--      shifting under somebody mid-conversation about them.
--   2. MOVEMENT. The single most persuasive thing this page could eventually
--      say is "the gap is closing" or "meeting rate is up from 6.9%". Neither
--      is answerable from live state, which only ever knows about today.
--   3. AN HONEST RECORD. If a win is un-marked, or a customer is archived, the
--      live figure silently changes and the old one is gone. A snapshot keeps
--      what was actually shown to customers that week.
--
-- CANNOT BE BACKFILLED — the same reason 0064 shipped its engagement snapshots
-- ahead of anything that read them. get_operator_proof reads current state, so
-- a week not captured is a week that cannot be reconstructed. That is why this
-- lands now rather than when the trend display is built.
--
-- GROUPS ONLY, NEVER THE READER
-- -----------------------------
-- Rows are 'winners' and 'others' — the two cohort aggregates. The 'you' row
-- stays live and per-customer and is deliberately absent here: it is that
-- customer's own current position, it should be up to the minute, and storing
-- a weekly copy of every customer's figures would build a per-operator history
-- table that the page has no use for and that did not exist before.
--
-- So the page compares your live figures against last Monday's cohort. The
-- cohort moves slowly and the reader's own number should not lag behind their
-- own work, which is the right way round.
-- ============================================================================

create table if not exists public.operator_proof_snapshots (
  id                   uuid primary key default gen_random_uuid(),
  captured_on          date not null default current_date,
  group_key            text not null check (group_key in ('winners', 'others')),
  operators            integer not null,
  open_rate            numeric,
  contact_rate         numeric,
  meeting_rate         numeric,
  avg_notes            numeric,
  operators_no_notes   integer not null default 0,
  median_hours_to_open numeric,
  -- Denormalised so a row stays readable on its own: how many wins existed in
  -- total when this reading was taken. Without it, "3 winners" a year from now
  -- cannot be told apart from a week the capture ran against partial data.
  wins_total           integer not null default 0,
  created_at           timestamptz not null default now(),
  -- captured_on carries the uniqueness, as in 0064: a re-run on the same day
  -- overwrites rather than duplicating, so a retried cron cannot leave two
  -- subtly different readings of the same week.
  unique (captured_on, group_key)
);

create index if not exists idx_operator_proof_snapshots_captured
  on public.operator_proof_snapshots (captured_on desc);

alter table public.operator_proof_snapshots enable row level security;
-- RLS on with no policy: deny-all to the browser. Customers reach these figures
-- through get_operator_proof, which is aggregate-only and suppression-guarded;
-- a directly readable table would hand them the same numbers with none of that.

-- ---------------------------------------------------------------------------
-- The capture. Service role only.
--
-- Deliberately duplicates the aggregate arithmetic in get_operator_proof rather
-- than calling it: that function resolves identity from auth.uid() and returns
-- nothing for a service-role caller with no session, so it cannot be reused
-- here. The two must be changed together — the definitions of opened,
-- attempted and met are the same in both by design, and a snapshot measured
-- differently from what the page shows would be worse than no snapshot.
-- ---------------------------------------------------------------------------
create or replace function public.capture_operator_proof(
  p_captured_on date default current_date
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  with per_assignment as (
    select
      la.customer_id as cid,
      la.status,
      (la.viewed_at is not null
       or exists (
         select 1 from public.lead_events e
         where e.assignment_id = la.id and e.event_type = 'detail_opened'
       )) as opened,
      (la.first_contacted_at is not null) as attempted,
      (la.pipeline_stage in (
        'web_meeting_booked', 'web_meeting_no_show', 'web_meeting_attended'
      )) as met,
      extract(epoch from (la.viewed_at - la.assigned_at)) / 3600.0 as hours_to_open
    from public.lead_assignments la
    join public.leads l on l.id = la.lead_id
    where l.lead_type = 'management'
  ),
  per_customer as (
    select
      p.cid,
      count(*)                                              as delivered,
      avg(case when p.opened then 1.0 else 0.0 end)          as open_rate,
      avg(case when p.attempted then 1.0 else 0.0 end)       as contact_rate,
      avg(case when p.met then 1.0 else 0.0 end)             as meeting_rate,
      count(*) filter (where p.status = 'won')               as wins,
      (select count(*) from public.lead_notes n where n.customer_id = p.cid) as notes,
      percentile_cont(0.5) within group (order by p.hours_to_open)
        filter (where p.hours_to_open is not null)           as median_hours
    from per_assignment p
    group by p.cid
  ),
  labelled as (
    select pc.*, case when pc.wins > 0 then 'winners' else 'others' end as grp
    from per_customer pc
    where pc.delivered > 0
  ),
  totals as (
    select coalesce(sum(lb.wins), 0)::integer as wins_total from labelled lb
  ),
  rolled as (
    select
      lb.grp                                                       as group_key,
      count(*)::integer                                            as operators,
      round(avg(lb.open_rate), 4)::numeric                         as open_rate,
      round(avg(lb.contact_rate), 4)::numeric                      as contact_rate,
      round(avg(lb.meeting_rate), 4)::numeric                      as meeting_rate,
      round(avg(lb.notes), 1)::numeric                             as avg_notes,
      count(*) filter (where lb.notes = 0)::integer                as operators_no_notes,
      round(percentile_cont(0.5) within group (order by lb.median_hours)::numeric, 1)
                                                                   as median_hours_to_open
    from labelled lb
    group by lb.grp
  )
  insert into public.operator_proof_snapshots as s (
    captured_on, group_key, operators, open_rate, contact_rate, meeting_rate,
    avg_notes, operators_no_notes, median_hours_to_open, wins_total
  )
  select
    p_captured_on, r.group_key, r.operators, r.open_rate, r.contact_rate,
    r.meeting_rate, r.avg_notes, r.operators_no_notes, r.median_hours_to_open,
    t.wins_total
  from rolled r cross join totals t
  on conflict (captured_on, group_key) do update set
    operators            = excluded.operators,
    open_rate            = excluded.open_rate,
    contact_rate         = excluded.contact_rate,
    meeting_rate         = excluded.meeting_rate,
    avg_notes            = excluded.avg_notes,
    operators_no_notes   = excluded.operators_no_notes,
    median_hours_to_open = excluded.median_hours_to_open,
    wins_total           = excluded.wins_total,
    created_at           = now();

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke execute on function public.capture_operator_proof(date) from public, anon, authenticated;
grant execute on function public.capture_operator_proof(date) to service_role;

-- ---------------------------------------------------------------------------
-- Seed the series with today's reading.
--
-- Without this the first customer to load the page after deploy sees the live
-- fallback and no "as of" date, until the first Monday comes round. One row
-- costs nothing and makes the feature complete on the day it ships.
-- ---------------------------------------------------------------------------
select public.capture_operator_proof();
