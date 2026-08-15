-- ============================================================================
-- Add the web meeting to the operator proof.
--
-- 0078 reported what the operators who signed a landlord did: they opened
-- every lead, they went after every lead, they wrote notes. It stopped one
-- step short of the thing those habits are FOR.
--
--                          signed a landlord (3)   no win yet (18)
--     opened their leads            100%                 81%
--     went after them               100%                 56%
--     got a web meeting            20.0%                6.9%     <- new
--     avg notes written             10.7                  5.8
--
-- Three times the rate, and the spread underneath it is starker than the
-- averages: all 3 operators who signed have booked a meeting, against 6 of 18
-- who have not. Twelve operators have never booked one at all.
--
-- WHY IT BELONGS HERE MORE THAN THE WIN DOES
-- ------------------------------------------
-- The meeting is the last step an operator fully controls. Whether a landlord
-- signs is partly theirs and partly the landlord's; whether a meeting gets
-- booked is a consequence of ringing people and asking. It is also the point
-- the funnel actually breaks — 56% of leads get chased and 7% reach a meeting,
-- so the drop is between the call and the diary, not between the meeting and
-- the signature.
--
-- And it has the data that wins do not: 20 meetings across 9 operators against
-- 3 wins across 3. A rate built on 20 events can be read; one built on 3
-- cannot.
--
-- WHAT COUNTS
-- -----------
-- The three management meeting stages — booked, attended, and booked-then-no-
-- show. A no-show counts deliberately: the operator did the work of getting it
-- in the diary, and a landlord who does not turn up is not their failing. This
-- measures the part they control, which is the whole reason the row is here.
--
-- Same denominator as the two rows above it (leads delivered), so the three
-- read as one funnel rather than three unrelated percentages against shifting
-- bases.
--
-- Management only, like the rest of the function. GR runs a viewing-to-contract
-- pipeline with different stage names and two active subscribers; a blended row
-- would describe neither product.
--
-- DROP AND RECREATE: postgres will not let CREATE OR REPLACE change a
-- function's return type, and this adds a column to the returned table.
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
  suppressed           boolean
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
begin
  select c.id into v_customer_id
    from public.customers c
   where c.user_id = auth.uid();

  if v_customer_id is null then
    return;
  end if;

  return query
  with per_assignment as (
    select
      la.customer_id as cid,
      la.id          as aid,
      la.assigned_at,
      la.viewed_at,
      la.status,
      -- viewed_at OR detail_opened: the event stream only began on 27 July, so
      -- on its own it would understate every operator who joined before then.
      -- Applied identically to both groups, so the comparison stays fair.
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
  winner_count as (
    select count(*)::integer as n from labelled where grp = 'winners'
  ),
  grouped as (
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
  mine as (
    select
      'you'::text                                                  as group_key,
      1::integer                                                   as operators,
      round(lb.open_rate, 4)::numeric                              as open_rate,
      round(lb.contact_rate, 4)::numeric                           as contact_rate,
      round(lb.meeting_rate, 4)::numeric                           as meeting_rate,
      round(lb.notes::numeric, 1)                                  as avg_notes,
      case when lb.notes = 0 then 1 else 0 end                     as operators_no_notes,
      round(lb.median_hours::numeric, 1)                           as median_hours_to_open
    from labelled lb
    where lb.cid = v_customer_id
  )
  select g.group_key, g.operators, g.open_rate, g.contact_rate, g.meeting_rate,
         g.avg_notes, g.operators_no_notes, g.median_hours_to_open,
         (select n from winner_count) < c_min_winners
  from grouped g
  union all
  select m.group_key, m.operators, m.open_rate, m.contact_rate, m.meeting_rate,
         m.avg_notes, m.operators_no_notes, m.median_hours_to_open,
         false
  from mine m;
end;
$$;

revoke execute on function public.get_operator_proof() from public, anon;
grant execute on function public.get_operator_proof() to authenticated, service_role;
