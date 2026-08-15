-- ============================================================================
-- Serve the operator proof from the weekly snapshot.
--
-- The two cohort rows now come from the most recent capture (0081) rather than
-- from live state, so the page can date what it shows and stop shifting under
-- somebody mid-sentence about it. The reader's OWN row stays live: the cohort
-- is a weekly reference point, but nobody should be shown a stale version of
-- their own work.
--
-- FALLS BACK TO LIVE. If no snapshot exists — before the first capture, or if
-- the weekly cron has never run — the function computes the cohort exactly as
-- it did before and returns as_of = null so the UI can omit the date rather
-- than print a wrong one. The page never breaks because a cron did not fire.
--
-- CARRIES THE PREVIOUS READING. prev_* columns come from the capture before
-- last, so the page can show movement. They are null until a second week has
-- been captured, which is the honest state and the one the UI must handle.
--
-- Adding columns to the returned table means postgres cannot CREATE OR REPLACE,
-- so this drops and recreates — and re-asserts the grants, which a drop
-- discards.
-- ============================================================================

drop function if exists public.get_operator_proof();

create or replace function public.get_operator_proof()
returns table (
  group_key            text,     -- 'winners' | 'others' | 'you'
  operators            integer,
  open_rate            numeric,
  contact_rate         numeric,
  meeting_rate         numeric,
  avg_notes            numeric,
  operators_no_notes   integer,
  median_hours_to_open numeric,
  suppressed           boolean,
  as_of                date,
  prev_as_of           date,
  prev_open_rate       numeric,
  prev_contact_rate    numeric,
  prev_meeting_rate    numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  -- Below this many winning operators there is no group to describe, only
  -- individuals — and describing one operator's habits to everybody else is a
  -- disclosure, not a benchmark.
  c_min_winners constant integer := 3;
  v_customer_id uuid;
  v_as_of       date;
  v_prev_as_of  date;
  v_winners     integer;
begin
  select c.id into v_customer_id
    from public.customers c
   where c.user_id = auth.uid();

  if v_customer_id is null then
    return;
  end if;

  select max(s.captured_on) into v_as_of
    from public.operator_proof_snapshots s;

  select max(s.captured_on) into v_prev_as_of
    from public.operator_proof_snapshots s
   where s.captured_on < v_as_of;

  return query
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
  -- The live cohort, used only when no snapshot exists yet.
  live_grouped as (
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
  ),
  snap as (
    select * from public.operator_proof_snapshots s
     where v_as_of is not null and s.captured_on = v_as_of
  ),
  prev as (
    select * from public.operator_proof_snapshots s
     where v_prev_as_of is not null and s.captured_on = v_prev_as_of
  ),
  -- How many winning operators the displayed reading knows about. Suppression
  -- must follow what is SHOWN, not live state, or a snapshot taken when three
  -- operators had signed would render beside a "not enough data" message.
  shown_winners as (
    select coalesce(
      (select s.operators from snap s where s.group_key = 'winners'),
      (select g.operators from live_grouped g where g.group_key = 'winners'),
      0
    ) as n
  ),
  cohort as (
    select
      s.group_key, s.operators, s.open_rate, s.contact_rate, s.meeting_rate,
      s.avg_notes, s.operators_no_notes, s.median_hours_to_open,
      v_as_of as as_of,
      case when p.captured_on is not null then v_prev_as_of end as prev_as_of,
      p.open_rate    as prev_open_rate,
      p.contact_rate as prev_contact_rate,
      p.meeting_rate as prev_meeting_rate
    from snap s
    left join prev p on p.group_key = s.group_key

    union all

    select
      g.group_key, g.operators, g.open_rate, g.contact_rate, g.meeting_rate,
      g.avg_notes, g.operators_no_notes, g.median_hours_to_open,
      null::date, null::date, null::numeric, null::numeric, null::numeric
    from live_grouped g
    where v_as_of is null
  )
  select
    c.group_key, c.operators, c.open_rate, c.contact_rate, c.meeting_rate,
    c.avg_notes, c.operators_no_notes, c.median_hours_to_open,
    (select w.n from shown_winners w) < c_min_winners,
    c.as_of, c.prev_as_of, c.prev_open_rate, c.prev_contact_rate,
    c.prev_meeting_rate
  from cohort c

  union all

  -- The reader's own figures: always live, never snapshotted.
  select
    'you'::text,
    1::integer,
    round(lb.open_rate, 4)::numeric,
    round(lb.contact_rate, 4)::numeric,
    round(lb.meeting_rate, 4)::numeric,
    round(lb.notes::numeric, 1),
    case when lb.notes = 0 then 1 else 0 end,
    round(lb.median_hours::numeric, 1),
    false,
    null::date, null::date, null::numeric, null::numeric, null::numeric
  from labelled lb
  where lb.cid = v_customer_id;
end;
$$;

revoke execute on function public.get_operator_proof() from public, anon;
grant execute on function public.get_operator_proof() to authenticated, service_role;
