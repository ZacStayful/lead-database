-- ============================================================================
-- Operator proof: what the people who signed a landlord actually did.
--
-- WHY THIS EXISTS
-- ---------------
-- An operator logs in, sees leads they have not worked, and has no evidence
-- that anybody else is getting anything out of this. 274 of 308 assignments
-- have never moved off cold and ten operators have never written a note. The
-- product currently gives them no reason to believe it works for anyone.
--
-- It does work for someone, and the difference is measurable and unglamorous.
-- Management leads only, per-operator figures averaged across each group:
--
--                            signed a landlord (3)   no win yet (18)
--     opened their leads              100%                 81%
--     went after them                 100%                 56%
--     avg notes written               10.7                  5.8
--     wrote no notes at all              0                    9
--     median hours to open             6.1                  6.0
--
-- Wins landed 2, 2 and 10 days after the lead arrived.
--
-- NOTE THE LAST ROW. Speed of OPENING is not the differentiator — both groups
-- look at a new lead within about six hours. An earlier read of this data put
-- winners at 14.8 hours against 29.9, but that was a mean of per-operator means
-- pooled across both products; the median, restricted to management, shows no
-- gap at all. What separates the two groups is what happens AFTER they open it:
-- everyone looks, and then roughly half of them stop. The UI must not claim a
-- speed advantage that the data does not support.
--
-- WHY IT IS NOT A LEADERBOARD
-- ---------------------------
-- 0068 built get_customer_scoreboard and left the ranking to the caller,
-- noting that publishing a leaderboard changes behaviour. It does, and with 21
-- active operators a ranked table means fourteen of them discover they are in
-- the bottom half. The audience here is people we are trying to KEEP, and a
-- ranking punishes exactly the operators most likely to drift. So this reports
-- two groups and the caller's own figures, and never a position.
--
-- ON n = 3
-- --------
-- Three wins is not a study. Every figure below is a description of what three
-- operators did, not evidence that doing it causes a signing, and the UI copy
-- must not promise otherwise. Two caveats worth carrying:
--
--   * The notes gap is partly circular — a lead that is going well earns more
--     notes BECAUSE it is going well. open_rate and hours_to_open are cleaner:
--     they happen before the outcome is known.
--   * All three winners joined early. They are not a random sample.
--
-- The function is gated on c_min_winners so it returns nothing rather than
-- something misleading if a win is ever un-marked.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 — The comparison, plus the caller's own figures.
--
-- "opened" is deliberately viewed_at OR a detail_opened event. detail_opened is
-- the honest telemetry (CLAUDE.md is explicit that the two are not equivalent)
-- but it only began recording on 27 July, so on its own it would understate
-- every operator who joined before then. The union is the widest defensible
-- reading of "did they look at it", and it is applied identically to both
-- groups, so the COMPARISON stays fair even though each absolute figure is
-- generous.
--
-- "attempted" uses first_contacted_at for the reason set out in 0077: the
-- tel_click/mailto_click stream fired on three assignments in six weeks and
-- measures nothing.
--
-- Management only. All three wins are management leads, and GR has a different
-- pipeline vocabulary and two active subscribers — pooling them would describe
-- neither product.
-- ---------------------------------------------------------------------------
create or replace function public.get_operator_proof()
returns table (
  group_key            text,     -- 'winners' | 'others' | 'you'
  operators            integer,
  open_rate            numeric,
  contact_rate         numeric,
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
      (la.viewed_at is not null
       or exists (
         select 1 from public.lead_events e
         where e.assignment_id = la.id and e.event_type = 'detail_opened'
       )) as opened,
      (la.first_contacted_at is not null) as attempted,
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
      round(lb.notes::numeric, 1)                                  as avg_notes,
      case when lb.notes = 0 then 1 else 0 end                     as operators_no_notes,
      round(lb.median_hours::numeric, 1)                           as median_hours_to_open
    from labelled lb
    where lb.cid = v_customer_id
  )
  select g.group_key, g.operators, g.open_rate, g.contact_rate, g.avg_notes,
         g.operators_no_notes, g.median_hours_to_open,
         (select n from winner_count) < c_min_winners
  from grouped g
  union all
  select m.group_key, m.operators, m.open_rate, m.contact_rate, m.avg_notes,
         m.operators_no_notes, m.median_hours_to_open,
         false
  from mine m;
end;
$$;

revoke execute on function public.get_operator_proof() from public, anon;
grant execute on function public.get_operator_proof() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2 — The anonymised wins feed.
--
-- One row per recorded win: how long it took, what the property was, and
-- roughly where. No operator id, no business name, no lead name, no address.
--
-- LOCATION IS WITHHELD UNTIL THERE ARE ENOUGH WINS. postcode_area is already
-- coarse — "LE" is all of Leicester — but a lead goes to at most three
-- operators, so an operator who held the same lead and did NOT win it can pair
-- the area with the date and work out that their competitor signed it. That is
-- a real disclosure about somebody's commercial outcome. Below c_min_area_wins
-- the area is returned null and the UI says "UK"; the gate opens on its own as
-- volume grows.
--
-- won_at is truncated to the month for the same reason: a precise timestamp
-- pairs with "the lead I lost last Tuesday" far too easily.
--
-- days_to_win is measured from assignment, matching get_wins() in 0068 — it
-- answers "how long did this operator take", which is the number that belongs
-- in front of another operator.
-- ---------------------------------------------------------------------------
create or replace function public.get_recent_wins_anonymised(
  p_limit integer default 10
)
returns table (
  won_month     date,
  days_to_win   integer,
  bedrooms      text,
  postcode_area text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  -- Nothing is shown at all below this: with one or two wins the feed is a
  -- report on named individuals, whatever the columns say.
  c_min_wins      constant integer := 3;
  -- And the area stays hidden below this.
  c_min_area_wins constant integer := 5;
  v_customer_id uuid;
  v_wins        integer;
begin
  select c.id into v_customer_id
    from public.customers c
   where c.user_id = auth.uid();

  if v_customer_id is null then
    return;
  end if;

  select count(*)::integer into v_wins
    from public.lead_assignments la
   where la.status = 'won';

  if v_wins < c_min_wins then
    return;
  end if;

  return query
  select
    date_trunc('month', la.last_status_change_at)::date,
    (la.last_status_change_at::date - la.assigned_at::date)::integer,
    nullif(btrim(coalesce(l.bedrooms, '')), ''),
    case when v_wins >= c_min_area_wins
         then nullif(btrim(coalesce(l.postcode_area, '')), '') end
  from public.lead_assignments la
  join public.leads l on l.id = la.lead_id
  where la.status = 'won'
    and la.last_status_change_at is not null
  order by la.last_status_change_at desc
  limit greatest(p_limit, 0);
end;
$$;

revoke execute on function public.get_recent_wins_anonymised(integer) from public, anon;
grant execute on function public.get_recent_wins_anonymised(integer) to authenticated, service_role;
