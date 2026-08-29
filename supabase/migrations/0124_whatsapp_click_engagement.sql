-- ---------------------------------------------------------------------------
-- 0124 — whatsapp_click joins the engagement signals (§40.15)
--
-- 0123 added the event type, the weight and the contacted flip. On its own that
-- was inert. This migration is where the signal starts to COUNT, and it is the
-- risky half: get_reclaim_candidates decides which leads are taken back off an
-- operator, and get_assignment_engagement_scores decides who is offered them.
--
-- ⚠️ TWELVE FUNCTIONS HARD-CODE THIS LIST, NOT THE FOUR §40.7 DESCRIBES.
-- Audited against production: 27 mentions of tel_click across 12 functions.
-- §40.7's "four places" is true of get_assignment_engagement_scores alone and
-- was read as the whole job; it is not.
--
-- Two idioms run through them, and whatsapp_click belongs to both:
--   ('detail_opened', 'tel_click', 'mailto_click')  — ANY activity on the lead
--   ('tel_click', 'mailto_click')                   — a real CONTACT ATTEMPT
--
-- ⚠️ THE BODIES BELOW ARE PRODUCTION'S, NOT THE ORIGINAL MIGRATIONS'.
-- supabase/schema.sql is stale (CLAUDE.md §459) and several of these have been
-- revised in place since they were introduced, so each was taken from
-- pg_get_functiondef() on the live database and re-stated here with the single
-- token added. That makes the migration chain converge on what production
-- actually runs rather than on what an older file says it runs.
--
-- ⚠️ NO BACKFILL. The signal counts from deployment forward only. No historical
-- lead_events row is invented and no customer_engagement_snapshots row is
-- rewritten, so no score or reclaim decision changes retroactively. The cost is
-- a step in the benchmark series on the deployment date: assignments after it
-- can carry a signal earlier ones could not, so scores either side are not
-- strictly comparable. Recorded in §40.15 rather than smoothed over.
--
-- Deployment order: migrations before code.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1 — get_assignment_engagement_scores
--
-- The one that needed structure rather than a token: a presence flag in the
-- CTE, a weight arm, the passive_only negation, and a breakdown key. §40.7
-- warns that missing any one of them leaves 0123's weight row a silent no-op.
--
-- passive_only means "looked but never acted". A wa.me hand-off is an act, so
-- it joins the negation beside tel_click.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_assignment_engagement_scores(p_assignment_ids uuid[], p_since timestamp with time zone)
 RETURNS TABLE(assignment_id uuid, score numeric, passive_only boolean, signals jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with w as (
    select signal, weight from public.engagement_weights
  ),
  present as (
    select
      la.id as aid,
      exists (select 1 from public.lead_events e
               where e.assignment_id = la.id and e.event_type = 'tel_click'
                 and e.created_at >= p_since)                                    as tel_click,
      exists (select 1 from public.lead_events e
               where e.assignment_id = la.id and e.event_type = 'mailto_click'
                 and e.created_at >= p_since)                                    as mailto_click,
      exists (select 1 from public.lead_events e
               where e.assignment_id = la.id and e.event_type = 'whatsapp_click'
                 and e.created_at >= p_since)                                    as whatsapp_click,
      exists (select 1 from public.lead_events e
               where e.assignment_id = la.id and e.event_type = 'detail_opened'
                 and e.created_at >= p_since)                                    as detail_opened,
      exists (select 1 from public.lead_notes n
               where n.lead_assignment_id = la.id
                 and n.created_at >= p_since)                                    as note_added,
      exists (select 1 from public.lead_events e
               where e.assignment_id = la.id and e.event_type = 'stage_changed'
                 and e.created_at >= p_since)                                    as stage_moved,
      exists (select 1 from public.lead_events e
               where e.assignment_id = la.id and e.event_type = 'message_sent'
                 and e.created_at >= p_since)                                    as message_sent,
      (la.status <> 'new' and la.last_status_change_at >= p_since)               as status_advanced,
      exists (select 1 from public.notifications n
               where n.lead_assignment_id = la.id
                 and n.read_at >= p_since)                                       as notification_read,
      exists (select 1
                from public.customers c
                join auth.users u on u.id = c.user_id
               where c.id = la.customer_id
                 and u.last_sign_in_at >= p_since)                               as login_since_assignment
    from public.lead_assignments la
    where la.id = any (p_assignment_ids)
  )
  select
    p.aid,
    least(
      1.0,
      coalesce((select sum(w.weight) from w where
        (w.signal = 'tel_click'              and p.tel_click) or
        (w.signal = 'mailto_click'           and p.mailto_click) or
        (w.signal = 'whatsapp_click'         and p.whatsapp_click) or
        (w.signal = 'detail_opened'          and p.detail_opened) or
        (w.signal = 'note_added'             and p.note_added) or
        (w.signal = 'stage_moved'            and p.stage_moved) or
        (w.signal = 'message_sent'           and p.message_sent) or
        (w.signal = 'status_advanced'        and p.status_advanced) or
        (w.signal = 'notification_read'      and p.notification_read) or
        (w.signal = 'login_since_assignment' and p.login_since_assignment)
      ), 0)
    )::numeric,
    not (
      p.tel_click or p.mailto_click or p.whatsapp_click or p.note_added
      or p.stage_moved or p.status_advanced or p.message_sent
    ),
    jsonb_build_object(
      'tel_click',              p.tel_click,
      'mailto_click',           p.mailto_click,
      'whatsapp_click',         p.whatsapp_click,
      'detail_opened',          p.detail_opened,
      'note_added',             p.note_added,
      'stage_moved',            p.stage_moved,
      'message_sent',           p.message_sent,
      'status_advanced',        p.status_advanced,
      'notification_read',      p.notification_read,
      'login_since_assignment', p.login_since_assignment
    )
  from present p;
$function$;


-- ---------------------------------------------------------------------------
-- 2 — lead_last_activity_at
--
-- A multi-line list rather than an inline one, which is why it needed writing
-- out. Feeds "how long since anything happened to this lead".
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lead_last_activity_at(p_lead_id uuid)
 RETURNS timestamp with time zone
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select greatest(
    (select l.created_at from public.leads l where l.id = p_lead_id),
    (select max(greatest(
        la.assigned_at,
        coalesce(la.viewed_at,               '-infinity'::timestamptz),
        coalesce(la.last_status_change_at,   '-infinity'::timestamptz),
        coalesce(la.first_contacted_at,      '-infinity'::timestamptz),
        coalesce(la.due_to_call_date_set_at, '-infinity'::timestamptz),
        coalesce(la.income_estimate_set_at,  '-infinity'::timestamptz)
      ))
      from public.lead_assignments la
      where la.lead_id = p_lead_id),
    (select max(e.created_at)
      from public.lead_events e
      join public.lead_assignments la on la.id = e.assignment_id
      where la.lead_id = p_lead_id
        and e.event_type in (
          'detail_opened',
          'tel_click',
          'mailto_click',
          'whatsapp_click',
          'note_added',
          'file_added',
          'stage_changed',
          'message_sent',
          'message_received'
        )),
    (select max(n.created_at)
      from public.lead_notes n
      join public.lead_assignments la on la.id = n.lead_assignment_id
      where la.lead_id = p_lead_id),
    (select max(f.created_at)
      from public.lead_files f
      join public.lead_assignments la on la.id = f.lead_assignment_id
      where la.lead_id = p_lead_id)
  );
$function$;


-- ---------------------------------------------------------------------------
-- 3 — get_reclaim_candidates
--
-- ⚠️ THE ONE THAT TAKES A LEAD OFF SOMEBODY. "Untouched" is the whole test here,
-- and its comment already says status is deliberately not used because it is
-- self-reported. A wa.me hand-off is a passive signal in exactly that sense —
-- observed, not claimed — so a lead somebody has messaged stops being a
-- reclaim candidate.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_reclaim_candidates(p_cutoff timestamp with time zone, p_min_age_days integer DEFAULT 3)
 RETURNS TABLE(assignment_id uuid, lead_id uuid, customer_id uuid, lead_type lead_type, assigned_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select la.id, la.lead_id, la.customer_id, l.lead_type, la.assigned_at
  from public.lead_assignments la
  join public.leads l on l.id = la.lead_id
  where
    -- Never retroactive.
    la.assigned_at > p_cutoff
    and la.assigned_at <= now() - make_interval(days => p_min_age_days)

    -- The original assignment only; a reclaimed copy is never re-reclaimed.
    and la.is_reclaimed = false
    and la.reclaimed_at is null

    -- Once per lead, EVER: no assignment of this lead has ever been reclaimed.
    and not exists (
      select 1 from public.lead_assignments prior
      where prior.lead_id = la.lead_id
        and (prior.reclaimed_at is not null or prior.is_reclaimed)
    )

    -- Untouched: the operator has done nothing with it. status is deliberately
    -- NOT the test — it is self-reported. These are the passive signals.
    and not exists (
      select 1 from public.lead_events e
      where e.assignment_id = la.id
        and e.event_type in ('detail_opened', 'tel_click', 'mailto_click', 'whatsapp_click')
    )
    and not exists (
      select 1 from public.lead_notes n where n.lead_assignment_id = la.id
    )
    and not exists (
      select 1 from public.lead_files f where f.lead_assignment_id = la.id
    )

    -- A rejected lead has been consciously passed on and is settled under 0019
    -- (chargeable, no replacement). Reclaiming it would contradict that, so it
    -- is left alone. Flagged for review — resale may in fact be the right
    -- outcome for a rejected lead, but that is a pricing decision, not a bug.
    and la.status <> 'rejected'

    -- Still capacity-bound in the ordinary sense.
    -- Soft reclaim is retired (§7) and its functions are kept only so the rows
    -- carrying reclaim columns keep their meaning. Excluded here anyway,
    -- because a reclaim SLOT is added on top of max_assignments inside
    -- assign_lead_to_customer — so a granted slot would put an owned lead at
    -- three holders through a path nobody is watching any more.
    and l.owner_customer_id is null
    and l.assignment_count >= l.max_assignments;
$function$;


-- ---------------------------------------------------------------------------
-- 4 — get_customer_engagement_scores
--
-- contact_rate: the share of a customer's leads that got a real contact
-- attempt, as opposed to merely being opened.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_customer_engagement_scores(p_lead_type lead_type, p_customer_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(customer_id uuid, score numeric, is_neutral boolean, assignments integer, open_rate numeric, contact_rate numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with p as (
    select open_rate_weight ow, contact_rate_weight cw,
           window_days wd, min_assignments minn
    from public.engagement_score_params()
  ),
  base as (
    select
      c.id as cid,
      count(la.id)::integer as n,
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
            and e.event_type in ('tel_click', 'mailto_click', 'whatsapp_click')
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
      and (la.id is null or l.id is not null)
    group by c.id, c.created_at
  ),
  scored as (
    select b.*,
           (p.ow * b.o_rate) + (p.cw * b.c_rate) as raw,
           (b.n >= p.minn and b.has_history)     as qualifies
    from base b cross join p
  ),
  med as (
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
$function$;


-- ---------------------------------------------------------------------------
-- 5 — get_lead_outcome_report
-- "attempted" — the denominator for a conversion rate.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_lead_outcome_report()
 RETURNS TABLE(lead_type lead_type, lead_profile text, delivered integer, attempted integer, won integer, closed_not_interested integer, closed_sorted_elsewhere integer, rejected integer, win_rate_of_attempted numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with per_lead as (
    select
      l.id, l.lead_type,
      nullif(btrim(coalesce(l.lead_profile, '')), '') as profile,
      bool_or(
        exists (select 1 from public.lead_events e
                 where e.assignment_id = la.id
                   and e.event_type in ('tel_click', 'mailto_click', 'whatsapp_click'))
        or exists (select 1 from public.lead_notes n where n.lead_assignment_id = la.id)
        or la.closed_at is not null
      ) as attempted,
      bool_or(la.status = 'won')                             as won,
      bool_or(la.closed_reason = 'not_interested')           as not_interested,
      bool_or(la.closed_reason = 'sorted_elsewhere')         as sorted_elsewhere,
      bool_or(la.status = 'rejected')                        as rejected
    from public.leads l
    join public.lead_assignments la on la.lead_id = l.id
    group by l.id, l.lead_type, l.lead_profile
  )
  select
    lead_type,
    coalesce(profile, 'Not stated'),
    count(*)::integer,
    count(*) filter (where attempted)::integer,
    count(*) filter (where won)::integer,
    count(*) filter (where not_interested)::integer,
    count(*) filter (where sorted_elsewhere)::integer,
    count(*) filter (where rejected)::integer,
    case when count(*) filter (where attempted) > 0
         then round(
           count(*) filter (where won)::numeric
           / count(*) filter (where attempted), 3)
    end
  from per_lead
  group by lead_type, coalesce(profile, 'Not stated')
  order by lead_type, count(*) desc;
$function$;


-- ---------------------------------------------------------------------------
-- 6 — get_outcome_evidence
-- "attempts" is the evidence behind a claimed outcome; a hand-off is evidence.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_outcome_evidence(p_status text DEFAULT NULL::text)
 RETURNS TABLE(assignment_id uuid, customer_id uuid, business_name text, lead_id uuid, lead_name text, lead_type lead_type, status text, closed_reason text, pipeline_stage text, assigned_at timestamp with time zone, claimed_at timestamp with time zone, hours_to_claim numeric, contact_attempts integer, opens integer, note_count integer, notes text, evidence_level text, contradicted boolean, review_reason text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with claims as (
    select
      la.id, la.customer_id, la.lead_id, la.status, la.closed_reason,
      la.pipeline_stage, la.assigned_at, la.last_status_change_at,
      (select count(*) from public.lead_events e
        where e.assignment_id = la.id
          and e.event_type in ('tel_click', 'mailto_click', 'whatsapp_click'))::integer as attempts,
      (select count(*) from public.lead_events e
        where e.assignment_id = la.id
          and e.event_type = 'detail_opened')::integer                as opens,
      (select count(*) from public.lead_notes n
        where n.lead_assignment_id = la.id)::integer                  as note_count,
      (select string_agg(
                to_char(n.created_at, 'DD Mon HH24:MI') || ' — ' || n.body,
                E'\n' order by n.created_at)
         from public.lead_notes n where n.lead_assignment_id = la.id)  as notes
    from public.lead_assignments la
    where la.status in ('won', 'not_relevant', 'rejected')
      and (p_status is null or la.status = p_status)
  ),
  graded as (
    select c.*,
      (c.pipeline_stage is distinct from 'cold') as advanced,
      exists (
        select 1 from public.outcome_contradiction_phrases p
        where c.notes is not null
          and position(p.phrase in lower(c.notes)) > 0
      ) as negative_note
    from claims c
  )
  select
    g.id, g.customer_id, cu.business_name,
    g.lead_id, l.lead_name, l.lead_type,
    g.status, g.closed_reason, g.pipeline_stage,
    g.assigned_at, g.last_status_change_at,
    round(extract(epoch from (g.last_status_change_at - g.assigned_at)) / 3600.0, 1),
    g.attempts, g.opens, g.note_count, g.notes,
    case
      when g.attempts > 0 and g.advanced then 'strong'
      when g.attempts > 0 or g.advanced  then 'partial'
      when g.status in ('rejected', 'not_relevant') and g.negative_note then 'partial'
      else 'none'
    end,
    (g.negative_note and g.status = 'won'),
    case
      when g.negative_note and g.status = 'won'
        then 'Marked won, but a note contradicts it'
      when g.status = 'won' and g.attempts = 0 and not g.advanced
        then 'Marked won with no contact attempt and no pipeline progress'
      when g.status = 'won' and g.attempts = 0
        then 'Marked won with no recorded contact attempt'
      when g.status = 'won' and not g.advanced
        then 'Marked won while still at the default pipeline stage'
      when g.note_count = 0 and g.attempts = 0
        then 'Outcome recorded with nothing to support it'
      else null
    end
  from graded g
  join public.customers cu on cu.id = g.customer_id
  join public.leads l      on l.id = g.lead_id
  order by
    (g.negative_note and g.status = 'won') desc,
    case when g.status = 'won' then 0 else 1 end,
    g.last_status_change_at desc;
$function$;


-- ---------------------------------------------------------------------------
-- 7 — get_customer_scoreboard
-- Two lists: "worked" (any activity) and "attempted" (a real contact attempt).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_customer_scoreboard()
 RETURNS TABLE(customer_id uuid, business_name text, monthly_allocation integer, delivered integer, worked integer, worked_rate numeric, worked_past_cold integer, wins_per_worked_past_cold numeric, attempted integer, wins integer, wins_per_attempted numeric, wins_per_delivered numeric, median_days_to_win numeric, first_lead_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with per_assignment as (
    select
      la.customer_id,
      la.id,
      la.assigned_at,
      la.status,
      la.last_status_change_at,
      (exists (select 1 from public.lead_events e
                where e.assignment_id = la.id
                  and e.event_type in ('detail_opened', 'tel_click', 'mailto_click', 'whatsapp_click'))
       or exists (select 1 from public.lead_notes n where n.lead_assignment_id = la.id)
       or exists (select 1 from public.lead_files f where f.lead_assignment_id = la.id)
      ) as worked,
      public.assignment_worked_past_cold(la.pipeline_stage) as worked_past_cold,
      -- "Attempted" is a real contact attempt, not merely opening the lead: the
      -- denominator for a conversion rate has to be leads somebody actually
      -- went after. Closing one counts too — the operator reached a conclusion.
      (exists (select 1 from public.lead_events e
                where e.assignment_id = la.id
                  and e.event_type in ('tel_click', 'mailto_click', 'whatsapp_click'))
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
$function$;


-- ---------------------------------------------------------------------------
-- 8 — get_customer_risk
-- quiet_days and worked. Two lists, one spaced and one not.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_customer_risk()
 RETURNS TABLE(customer_id uuid, business_name text, email text, monthly_allocation integer, gr_monthly_allocation integer, holds_management boolean, holds_gr boolean, days_since_last_activity integer, tenure_days integer, paying_days integer, lifetime_delivered integer, lifetime_worked integer, lifetime_worked_rate numeric, risk_band text, risk_reason text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with base as (
    select
      c.id, c.business_name, c.email,
      c.monthly_allocation, c.gr_monthly_allocation,
      (c.account_status = 'active' and c.subscription_status = 'active'
        and c.paused_at is null)                                         as holds_mgmt,
      (c.gr_subscription_status = 'active')                              as holds_gr,
      (current_date - c.created_at::date)::integer                       as tenure_days,
      (current_date - coalesce(c.billing_cycle_anchor, c.gr_billing_cycle_anchor))::integer
                                                                         as paying_days,
      (current_date - greatest(
        (select max(e.created_at)::date from public.lead_events e
           join public.lead_assignments la on la.id = e.assignment_id
          where la.customer_id = c.id
            and e.event_type in ('detail_opened', 'tel_click', 'mailto_click', 'whatsapp_click')),
        (select max(n.created_at)::date from public.lead_notes n where n.customer_id = c.id),
        (select max(nt.read_at)::date from public.notifications nt where nt.customer_id = c.id),
        (select u.last_sign_in_at::date from auth.users u where u.id = c.user_id)
      ))::integer                                                        as quiet_days,
      (select count(*) from public.lead_assignments la where la.customer_id = c.id)::integer
                                                                         as delivered,
      (select count(*) from public.lead_assignments la
         where la.customer_id = c.id
           and (exists (select 1 from public.lead_events e
                         where e.assignment_id = la.id
                           and e.event_type in ('detail_opened','tel_click','mailto_click','whatsapp_click'))
             or exists (select 1 from public.lead_notes n where n.lead_assignment_id = la.id)
             or exists (select 1 from public.lead_files f where f.lead_assignment_id = la.id))
      )::integer                                                         as worked
    from public.customers c
    where c.is_active = true
      and (
        (c.account_status = 'active' and c.subscription_status = 'active'
          and c.paused_at is null)
        or c.gr_subscription_status = 'active'
      )
  ),
  rated as (
    select b.*,
      case when b.delivered > 0
           then round(b.worked::numeric / b.delivered, 3) end as worked_rate
    from base b
  )
  select
    r.id, r.business_name, r.email,
    r.monthly_allocation, r.gr_monthly_allocation,
    r.holds_mgmt, r.holds_gr,
    r.quiet_days, r.tenure_days, r.paying_days,
    r.delivered, r.worked, r.worked_rate,
    case
      when r.delivered >= 5 and r.worked = 0 and r.tenure_days >= 10 then 'critical'
      when r.quiet_days is null then 'critical'
      when r.quiet_days >= 21 then 'high'
      when r.quiet_days >= 14 and coalesce(r.worked_rate, 0) < 0.25 then 'high'
      when r.quiet_days >= 14 then 'medium'
      when r.quiet_days >= 10 and coalesce(r.worked_rate, 0) < 0.25 then 'medium'
      when r.quiet_days >= 7 then 'watch'
      else 'ok'
    end,
    case
      when r.delivered >= 5 and r.worked = 0 and r.tenure_days >= 10
        then 'Has never worked a single lead of ' || r.delivered || ' delivered'
      when r.quiet_days is null then 'No recorded activity ever'
      when r.quiet_days >= 21 then 'No activity for ' || r.quiet_days || ' days'
      when r.quiet_days >= 14 and coalesce(r.worked_rate, 0) < 0.25
        then 'Quiet ' || r.quiet_days || ' days, and has worked only '
             || round(coalesce(r.worked_rate, 0) * 100) || '% of leads sent'
      when r.quiet_days >= 14 then 'No activity for ' || r.quiet_days || ' days'
      when r.quiet_days >= 10 and coalesce(r.worked_rate, 0) < 0.25
        then 'Quiet ' || r.quiet_days || ' days, working '
             || round(coalesce(r.worked_rate, 0) * 100) || '% of leads sent'
      when r.quiet_days >= 7 then 'Quiet for ' || r.quiet_days || ' days'
      else 'Active in the last week'
    end
  from rated r;
$function$;


-- ---------------------------------------------------------------------------
-- 9 — get_paused_customer_facts
-- What a customer was doing in the 30 days before they paused.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_paused_customer_facts()
 RETURNS TABLE(customer_id uuid, has_wins boolean, wins integer, lifetime_delivered integer, engagement_before integer, notes_before integer, worked_rate numeric, pause_count integer, tenure_days integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    c.id,
    (select count(*) from public.lead_assignments la
       join public.leads l on l.id = la.lead_id
      where la.customer_id = c.id and l.lead_type = 'management'
        and la.status = 'won') > 0,
    (select count(*) from public.lead_assignments la
       join public.leads l on l.id = la.lead_id
      where la.customer_id = c.id and l.lead_type = 'management'
        and la.status = 'won')::integer,
    (select count(*) from public.lead_assignments la
       join public.leads l on l.id = la.lead_id
      where la.customer_id = c.id and l.lead_type = 'management')::integer,
    (select count(*) from public.lead_events e
       join public.lead_assignments la on la.id = e.assignment_id
      where la.customer_id = c.id
        and e.event_type in ('detail_opened', 'tel_click', 'mailto_click', 'whatsapp_click')
        and e.created_at >= c.paused_at - interval '30 days'
        and e.created_at <= c.paused_at)::integer,
    (select count(*) from public.lead_notes n
       join public.lead_assignments la on la.id = n.lead_assignment_id
      where la.customer_id = c.id
        and n.created_at >= c.paused_at - interval '30 days'
        and n.created_at <= c.paused_at)::integer,
    (select case when count(*) > 0 then round(
        count(*) filter (where
          exists (select 1 from public.lead_events e
                   where e.assignment_id = la.id
                     and e.event_type in ('detail_opened','tel_click','mailto_click','whatsapp_click'))
          or exists (select 1 from public.lead_notes n where n.lead_assignment_id = la.id)
          or exists (select 1 from public.lead_files f where f.lead_assignment_id = la.id)
        )::numeric / count(*), 3) end
     from public.lead_assignments la
     join public.leads l on l.id = la.lead_id
     where la.customer_id = c.id and l.lead_type = 'management'),
    c.pause_count,
    (current_date - c.created_at::date)::integer
  from public.customers c
  where c.paused_at is not null;
$function$;


-- ---------------------------------------------------------------------------
-- 10 — get_engagement_benchmarks
--
-- ⚠️ ONE OF THE THREE tel_click MENTIONS HERE IS A COMMENT, AND IT WAS WRONG THE
-- MOMENT 0123 SHIPPED. It said contact is stamped "on tel_click only"; the
-- trigger now fires on tel_click, whatsapp_click and message_sent. Corrected
-- below rather than left to rot — the comment is the reason the least() exists.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_engagement_benchmarks()
 RETURNS TABLE(lead_type lead_type, metric text, own_value numeric, own_sample integer, cohort_median numeric, cohort_top_quartile numeric, cohort_size integer, suppressed boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  c_window_days     constant integer := 90;
  c_min_cohort_n    constant integer := 10;
  c_min_cohort_size constant integer := 5;
  c_min_attempts    constant integer := 5;
  v_customer_id uuid;
begin
  select c.id into v_customer_id
    from public.customers c
   where c.user_id = auth.uid();

  if v_customer_id is null then
    return;
  end if;

  return query
  with
  telemetry as (
    select exists (
      select 1 from public.lead_events e
      where e.created_at >= now() - make_interval(days => c_window_days)
        and e.event_type in ('detail_opened', 'tel_click', 'mailto_click', 'whatsapp_click')
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
      -- Earliest evidence of a contact attempt from EITHER source. least()
      -- ignores NULLs, so whichever has a value wins and the earlier one wins
      -- when both do. mailto_click does not stamp first_contacted_at (0043 and
      -- 0123 auto-contact on tel_click, whatsapp_click and message_sent only),
      -- so the click stream can still hold the earlier timestamp.
      least(
        (
          select min(e.created_at) from public.lead_events e
          where e.assignment_id = la.id
            and e.event_type in ('tel_click', 'mailto_click', 'whatsapp_click')
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
      (percentile_cont(0.25) within group (order by c.median_hours)
        filter (where c.attempts >= c_min_attempts))::numeric      as hrs_q
    from products p
    left join cohort c on c.ltype = p.ltype
    group by p.ltype
  )
  select * from (
    select
      m.ltype, 'open_rate'::text,
      case when t.present then round(m.open_rate, 4) end, coalesce(m.n, 0),
      case when t.present and s.size >= c_min_cohort_size then round(s.open_med, 4) end,
      case when t.present and s.size >= c_min_cohort_size then round(s.open_q, 4) end,
      s.size,
      (not t.present) or s.size < c_min_cohort_size
    from mine m join cohort_stats s on s.ltype = m.ltype cross join telemetry t

    union all

    select
      m.ltype, 'contact_rate'::text,
      case when t.present then round(m.contact_rate, 4) end, coalesce(m.n, 0),
      case when t.present and s.size >= c_min_cohort_size then round(s.con_med, 4) end,
      case when t.present and s.size >= c_min_cohort_size then round(s.con_q, 4) end,
      s.size,
      (not t.present) or s.size < c_min_cohort_size
    from mine m join cohort_stats s on s.ltype = m.ltype cross join telemetry t

    union all

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
$function$;


-- ---------------------------------------------------------------------------
-- 11 — capture_engagement_snapshots
--
-- Four mentions: worked, contacted, ever_worked, days_since_last_activity.
--
-- ⚠️ THIS IS WHERE "NO BACKFILL" BECOMES VISIBLE. The nightly snapshot starts
-- counting whatsapp_click from the first run after deployment; rows already in
-- customer_engagement_snapshots are untouched. worked_rate and contact_rate
-- therefore step upward on that date for reasons that are not a behaviour
-- change by the operator. Deliberate — rewriting history to make a chart smooth
-- would be the worse choice.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.capture_engagement_snapshots(p_window_days integer DEFAULT 30)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      count(la.id) filter (where l.lead_type = lt.lead_type)::integer as delivered,
      count(la.id) filter (where l.lead_type = lt.lead_type and (
        exists (select 1 from public.lead_events e
                 where e.assignment_id = la.id
                   and e.event_type in ('detail_opened', 'tel_click', 'mailto_click', 'whatsapp_click'))
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
                   and e.event_type in ('tel_click', 'mailto_click', 'whatsapp_click'))
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
  scores as (
    select lt.lead_type, s.customer_id, s.score
    from (select unnest(enum_range(null::public.lead_type)) as lead_type) lt
    cross join lateral public.get_customer_engagement_scores(lt.lead_type, null) s
  ),
  lifetime as (
    select
      c.id as customer_id,
      lt.lead_type,
      count(la.id) filter (where l.lead_type = lt.lead_type)::integer as ever_delivered,
      count(la.id) filter (where l.lead_type = lt.lead_type and (
        exists (select 1 from public.lead_events e
                 where e.assignment_id = la.id
                   and e.event_type in ('detail_opened', 'tel_click', 'mailto_click', 'whatsapp_click'))
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
      (current_date - c.created_at::date)::integer as tenure_days,
      (current_date - coalesce(c.billing_cycle_anchor, c.gr_billing_cycle_anchor))::integer
        as paying_days,
      (current_date - greatest(
        (select max(e.created_at)::date from public.lead_events e
           join public.lead_assignments la on la.id = e.assignment_id
          where la.customer_id = c.id
            and e.event_type in ('detail_opened', 'tel_click', 'mailto_click', 'whatsapp_click')),
        (select max(n.created_at)::date from public.lead_notes n where n.customer_id = c.id),
        (select max(nt.read_at)::date from public.notifications nt where nt.customer_id = c.id),
        (select u.last_sign_in_at::date from auth.users u where u.id = c.user_id)
      ))::integer as days_since_last_activity,
      (select count(*) from public.lead_notes n, since s
        where n.customer_id = c.id and n.created_at >= s.t)::integer as notes_added,
      (select count(*) from public.notifications nt, since s
        where nt.customer_id = c.id and nt.read_at >= s.t)::integer  as notifications_read,
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
$function$;


-- ---------------------------------------------------------------------------
-- 12 — get_service_capacity
--
-- Two mentions, both answering "did the operator do anything with this lead in
-- its first / last ten days" — the test that decides whether a lead is recycled
-- to somebody else. Same argument as get_reclaim_candidates: a hand-off is
-- work, so it stops the clock.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_service_capacity()
 RETURNS TABLE(lead_type lead_type, leads_per_month numeric, slots_per_month numeric, recycled_slots_per_month numeric, serviceable_slots_per_month numeric, recycling_basis text, recycled_slots_now integer, unworked_rate numeric, recycling_sample integer, inventory_slots_now integer, unsold_leads_now integer, demand_per_month integer, delivered_per_month numeric, active_customers integer, fully_served integer, avg_allocation numeric, sustainable_customers integer, sustainable_customers_new_only integer, room_for_customers integer, paused_customers integer, paused_demand integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with w as (select 28 as days),
  rw as (select 90 as days),
  supply as (
    select
      lt.lead_type,
      count(l.id)                         as leads_in_window,
      coalesce(sum(l.max_assignments), 0) as slots_in_window,
      count(l.id) filter (where l.max_assignments < 5) as one_rung_headroom
    from (select unnest(enum_range(null::public.lead_type)) as lead_type) lt
    left join public.leads l
      on l.lead_type = lt.lead_type
     and l.created_at >= now() - make_interval(days => (select days from w))
    group by lt.lead_type
  ),
  delivered as (
    select lt.lead_type, count(la.id) as n
    from (select unnest(enum_range(null::public.lead_type)) as lead_type) lt
    left join public.leads l on l.lead_type = lt.lead_type
    left join public.lead_assignments la
      on la.lead_id = l.id
     and la.assigned_at >= now() - make_interval(days => (select days from w))
    group by lt.lead_type
  ),
  observed as (
    select
      lt.lead_type,
      (count(*) filter (where la.escalation_stage_1_at >= now() - make_interval(days => (select days from w)))
       + count(*) filter (where la.escalation_stage_2_at >= now() - make_interval(days => (select days from w))))::integer as n
    from (select unnest(enum_range(null::public.lead_type)) as lead_type) lt
    left join public.leads l on l.lead_type = lt.lead_type
    left join public.lead_assignments la on la.lead_id = l.id
    group by lt.lead_type
  ),
  recycling as (
    select
      lt.lead_type,
      count(la.id)::integer as sample_10,
      count(la.id) filter (where not la.active_by_10)::integer as escalates_at_10
    from (select unnest(enum_range(null::public.lead_type)) as lead_type) lt
    left join (
      select
        a.id, l.lead_type,
        (exists (select 1 from public.lead_events e
                  where e.assignment_id = a.id
                    and e.event_type in ('tel_click', 'mailto_click', 'whatsapp_click', 'stage_changed')
                    and e.created_at < a.assigned_at + interval '10 days')
         or exists (select 1 from public.lead_notes n
                     where n.lead_assignment_id = a.id
                       and n.created_at < a.assigned_at + interval '10 days')
         or (a.status <> 'new'
             and a.last_status_change_at < a.assigned_at + interval '10 days')
        ) as active_by_10
      from public.lead_assignments a
      join public.leads l on l.id = a.lead_id
      where a.assigned_at <= now() - interval '10 days'
        and a.assigned_at >= now() - make_interval(days => (select days from rw))
        and a.closed_at is null
        and a.status not in ('won', 'rejected')
    ) la on la.lead_type = lt.lead_type
    group by lt.lead_type
  ),
  passable as (
    select
      lt.lead_type,
      count(distinct a.lead_id)::integer as n
    from (select unnest(enum_range(null::public.lead_type)) as lead_type) lt
    left join public.leads l on l.lead_type = lt.lead_type
    left join public.lead_assignments a
      on a.lead_id = l.id
     and a.assigned_at <= now() - interval '10 days'
     and a.inactivity_escalation_stage < 2
     and a.status not in ('won', 'rejected')
     and a.closed_at is null
     and l.max_assignments < 5
     and not exists (
       select 1 from public.lead_assignments closed
       where closed.lead_id = a.lead_id and closed.closed_at is not null
     )
     and not (
       exists (select 1 from public.lead_events e
                where e.assignment_id = a.id
                  and e.event_type in ('tel_click', 'mailto_click', 'whatsapp_click', 'stage_changed')
                  and e.created_at >= now() - interval '10 days')
       or exists (select 1 from public.lead_notes n
                   where n.lead_assignment_id = a.id
                     and n.created_at >= now() - interval '10 days')
       or (a.status <> 'new'
           and a.last_status_change_at >= now() - interval '10 days')
     )
    group by lt.lead_type
  ),
  served as (
    select
      'management'::public.lead_type as lead_type,
      count(*)::integer as customers,
      count(*) filter (where got >= promised)::integer as fully_served,
      coalesce(round(avg(promised), 1), 0) as avg_alloc,
      coalesce(sum(promised), 0)::integer as demand
    from (
      select c.id, c.monthly_allocation as promised,
        (select count(*) from public.lead_assignments la
           join public.leads l on l.id = la.lead_id
          where la.customer_id = c.id and l.lead_type = 'management'
            and la.assigned_at >= coalesce(c.billing_cycle_anchor, c.created_at::date)
        ) as got
      from public.customers c
      where c.is_active and c.account_status = 'active'
        and c.subscription_status = 'active'
        and c.paused_at is null
    ) m
    union all
    select
      'guaranteed_rent'::public.lead_type,
      count(*)::integer,
      count(*) filter (where got >= promised)::integer,
      coalesce(round(avg(promised), 1), 0),
      coalesce(sum(promised), 0)::integer
    from (
      select c.id, c.gr_monthly_allocation as promised,
        (select count(*) from public.lead_assignments la
           join public.leads l on l.id = la.lead_id
          where la.customer_id = c.id and l.lead_type = 'guaranteed_rent'
            and la.assigned_at >= coalesce(c.gr_billing_cycle_anchor, c.created_at::date)
        ) as got
      from public.customers c
      where c.is_active and c.gr_subscription_status = 'active'
    ) g
  ),
  paused_side as (
    select
      'management'::public.lead_type as lead_type,
      count(*)::integer as n,
      coalesce(sum(c.monthly_allocation), 0)::integer as demand
    from public.customers c
    where c.is_active and c.account_status = 'active'
      and c.subscription_status = 'active'
      and c.paused_at is not null
    union all
    select 'guaranteed_rent'::public.lead_type, 0, 0
  ),
  inventory as (
    select
      lt.lead_type,
      coalesce(sum(greatest(l.max_assignments - l.assignment_count, 0)), 0)::integer as open_slots,
      count(l.id) filter (where l.assignment_count = 0)::integer                     as unsold
    from (select unnest(enum_range(null::public.lead_type)) as lead_type) lt
    left join public.leads l on l.lead_type = lt.lead_type
    group by lt.lead_type
  ),
  calc as (
    select
      s.lead_type,
      round(s.leads_in_window * 30.0 / (select days from w), 1) as leads_pm,
      round(s.slots_in_window * 30.0 / (select days from w), 1) as slots_pm,
      round(d.n * 30.0 / (select days from w), 1)               as delivered_pm,
      round(o.n * 30.0 / (select days from w), 1)               as observed_pm,
      o.n                                                        as observed_raw,
      r.sample_10 as sample,
      case when r.sample_10 > 0
           then round(r.escalates_at_10::numeric / r.sample_10, 4) end as rate_10,
      round(s.one_rung_headroom * 30.0 / (select days from w), 1) as headroom_pm,
      sv.demand, sv.customers, sv.fully_served, sv.avg_alloc,
      i.open_slots, i.unsold, p.n as passable_now,
      ps.n as paused_n, ps.demand as paused_demand
    from supply s
    join delivered d  on d.lead_type = s.lead_type
    join served sv    on sv.lead_type = s.lead_type
    join paused_side ps on ps.lead_type = s.lead_type
    join inventory i  on i.lead_type = s.lead_type
    join recycling r  on r.lead_type = s.lead_type
    join observed o   on o.lead_type = s.lead_type
    join passable p   on p.lead_type = s.lead_type
  ),
  scored as (
    select
      c.*,
      case when c.observed_raw > 0 then 'observed' else 'estimated' end as basis,
      least(
        case
          when c.observed_raw > 0 then c.observed_pm
          else round(c.delivered_pm * coalesce(c.rate_10, 0), 1)
        end,
        c.headroom_pm
      ) as recycled_pm
    from calc c
  )
  select
    s.lead_type,
    s.leads_pm,
    s.slots_pm,
    s.recycled_pm,
    round(s.slots_pm + s.recycled_pm, 1),
    s.basis,
    s.passable_now,
    s.rate_10,
    s.sample,
    s.open_slots,
    s.unsold,
    s.demand,
    s.delivered_pm,
    s.customers,
    s.fully_served,
    s.avg_alloc,
    case when s.avg_alloc > 0
         then floor((s.slots_pm + s.recycled_pm) / s.avg_alloc)::integer
         else 0 end,
    case when s.avg_alloc > 0
         then floor(s.slots_pm / s.avg_alloc)::integer
         else 0 end,
    case when s.avg_alloc > 0
         then greatest(
           floor((s.slots_pm + s.recycled_pm) / s.avg_alloc)::integer - s.customers,
           0)
         else 0 end,
    s.paused_n,
    s.paused_demand
  from scored s;
$function$;
