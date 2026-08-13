-- ============================================================================
-- Per-assignment engagement score, with the weights stored as data.
--
-- 0047 already scores engagement, but at the wrong grain for this: it answers
-- "how hard does this operator work their leads in general" as a rolling
-- per-customer RATE, and it chooses reclaim recipients. Escalation needs the
-- other question — "has anything happened on THIS lead" — over the same
-- signals. Same vocabulary, different unit, so this is a sibling of
-- engagement_score_params() rather than a replacement for it.
--
-- WEIGHTS LIVE IN A TABLE, NOT A FUNCTION
-- ---------------------------------------
-- engagement_score_params() keeps its weights in an immutable function, on the
-- grounds that tuning is then a one-line migration with an audit trail. That is
-- the right call for a two-number model nobody expects to touch. It is the
-- wrong one here: these weights are explicitly PROVISIONAL, and are to be
-- recalibrated against real won/lost outcomes at the 60-day checkpoint, by
-- somebody who should not need a deploy to do it. A table can be edited from
-- the admin panel; a function body cannot.
--
-- The two models are allowed to hold different weights. They measure different
-- things and are read by different callers, and forcing them to share numbers
-- would mean neither could be tuned without disturbing the other.
--
-- WHY detail_opened IS WEIGHTED AS HEAVILY AS A NOTE
-- --------------------------------------------------
-- Opening a lead is an operator deciding to act on it; on this platform it is
-- also the only engagement signal with usable volume. In the first 16 days of
-- telemetry there were 278 detail_opened events against 2 tel_click and 1
-- mailto_click across 298 assignments — operators contact landlords with the
-- phone number from the alert email or SMS, not by clicking through the portal.
-- A model that leaned on contact-clicks would mark almost every assignment
-- inactive and escalate the entire book.
--
-- The weights and the two thresholds are set so that an opened-but-otherwise
-- untouched lead SURVIVES the day-10 rung (0.30, not below the 0.30 threshold)
-- and FAILS the day-20 one (0.30 + a login = 0.35, below 0.45). Opening a lead
-- buys the operator ten more days; it does not buy them twenty. Changing any
-- weight without re-reading that sentence will silently break the ladder.
--
-- THE SCORE IS OVER A TRAILING WINDOW, NOT THE LIFE OF THE ASSIGNMENT
-- -------------------------------------------------------------------
-- p_since is not optional decoration. The question this feature asks is "has
-- anything happened LATELY", and a lifetime score cannot answer it: a note
-- written on day 1 would still be protecting the lead on day 40, which is the
-- opposite of an inactivity measure. The brief says as much — inactivity runs
-- "since assignment, or since last activity, whichever is later" — so any
-- activity inside the window resets the clock, and activity older than the
-- window counts for nothing.
--
-- This is also what lets the second rung mean anything. Without recency, an
-- assignment that failed at day 10 has the same score at day 20, and the two
-- thresholds would be testing the same evidence twice.
--
-- One consequence, deliberate: stage movement is read from the stage_changed
-- EVENT rather than the pipeline_stage column, because only the event carries a
-- date. A lead moved off cold before 0043 existed therefore scores nothing for
-- it. That understates engagement on old assignments, which is the safe
-- direction for everything except escalation — so the candidate query excludes
-- won and rejected outright rather than trusting the score to protect them.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 — The weights.
-- ---------------------------------------------------------------------------
create table if not exists public.engagement_weights (
  signal      text primary key,
  weight      numeric not null check (weight >= 0 and weight <= 1),
  description text not null,
  updated_at  timestamptz not null default now()
);

-- RLS on with no policies: service role only, like system_settings. These
-- weights decide who receives a lead, so a customer must not be able to read
-- (let alone write) the thresholds they are being measured against.
alter table public.engagement_weights enable row level security;

-- Seeded, never overwritten on re-run: a later hand-tuned value must survive a
-- re-applied migration.
insert into public.engagement_weights (signal, weight, description) values
  ('tel_click',              0.40, 'Clicked the landlord''s phone number. The only signal trusted enough to auto-flip status to contacted (0043).'),
  ('note_added',             0.30, 'Wrote a note against the lead. Direct evidence of work and costly to fake.'),
  ('detail_opened',          0.30, 'Opened the lead. Intent to act, and the only signal with usable volume on this platform.'),
  ('status_advanced',        0.30, 'Moved the lead''s status off new. Operators mark leads contacted to organise their own pipeline, so it reports work done off-platform.'),
  ('stage_moved',            0.20, 'Moved the pipeline off cold. Self-reported, but represents real investment in the lead.'),
  ('mailto_click',           0.20, 'Clicked the email address. Opens a mail client with no guarantee anything was sent (0043).'),
  ('notification_read',      0.05, 'Read the new-lead notification. Weak on its own; its absence is the earliest warning.'),
  ('login_since_assignment', 0.05, 'Signed in at all since the lead was assigned. Account-wide, so it says nothing about this particular lead.')
on conflict (signal) do nothing;

-- ---------------------------------------------------------------------------
-- 2 — The thresholds, in system_settings beside the other admin-tunable
-- numbers rather than in the weights table. They are not weights: they are the
-- line drawn through the weighted total, and Phase 3 exposes them through the
-- same settings panel as escalation_enabled and the freshness gate.
-- ---------------------------------------------------------------------------
insert into public.system_settings (key, value)
  values ('escalation_score_threshold_day_10', '0.30')
  on conflict (key) do nothing;

insert into public.system_settings (key, value)
  values ('escalation_score_threshold_day_20', '0.45')
  on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 3 — Score a batch of assignments.
--
-- Takes an array rather than a single id because the escalation job scores
-- every candidate in one pass; a scalar function would be an N+1 across a
-- table this job is already scanning.
--
-- Returns the breakdown as well as the total. Admin needs to show WHY a lead
-- escalated (Phase 3), and Phase 5 needs per-signal presence against outcome to
-- recalibrate these weights — both want the components, not just the sum.
--
-- The total is capped at 1.0. Weights sum to 1.50 if every signal fires, which
-- cannot happen while status = 'new' but can on the admin display of a worked
-- lead; an uncapped score above 1 would make the threshold comparison
-- meaningless and the number unreadable.
-- ---------------------------------------------------------------------------
create or replace function public.get_assignment_engagement_scores(
  p_assignment_ids uuid[],
  p_since          timestamptz
)
returns table (
  assignment_id uuid,
  score         numeric,
  signals       jsonb
)
language sql
stable
security definer
set search_path = public
as $$
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
               where e.assignment_id = la.id and e.event_type = 'detail_opened'
                 and e.created_at >= p_since)                                    as detail_opened,
      exists (select 1 from public.lead_notes n
               where n.lead_assignment_id = la.id
                 and n.created_at >= p_since)                                    as note_added,
      -- The event, not the pipeline_stage column: only the event carries a date,
      -- and a score that cannot tell WHEN the stage moved cannot measure
      -- inactivity. See the header note on what this costs.
      exists (select 1 from public.lead_events e
               where e.assignment_id = la.id and e.event_type = 'stage_changed'
                 and e.created_at >= p_since)                                    as stage_moved,
      -- Marking a lead contacted counts as engagement in its own right.
      --
      -- Most of the time an operator ticks this because they DID ring the
      -- landlord and are keeping their own pipeline tidy — the portal is not
      -- where the work happens, it is where the work gets recorded. Treating the
      -- tick as worthless would punish exactly the operators who bother to
      -- record anything, and the platform already knows contact happens
      -- off-system: 278 lead opens against 3 contact-clicks says operators dial
      -- the number from the alert email, not from the portal.
      --
      -- Weighted at 0.30, the same as opening the lead, and dated — so it buys
      -- the operator the day-10 rung and not the day-20 one. That is the point.
      -- If it were weighted above the day-20 threshold, one click would exempt a
      -- lead from escalation permanently, and the moment operators learn that
      -- ignored leads get resold, that click becomes the cheapest way to hold a
      -- lead they are not working. Counting it and time-limiting it is what
      -- respects the honest majority without creating the loophole.
      (la.status <> 'new' and la.last_status_change_at >= p_since)               as status_advanced,
      exists (select 1 from public.notifications n
               where n.lead_assignment_id = la.id
                 and n.read_at >= p_since)                                       as notification_read,
      -- Deliberately loose, per the brief: ANY sign-in inside the window counts,
      -- even one for entirely unrelated reasons. An operator who logs in
      -- regularly and never touches this lead still scores only 0.05 and still
      -- escalates — the login is a floor, not a shield.
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
        (w.signal = 'detail_opened'          and p.detail_opened) or
        (w.signal = 'note_added'             and p.note_added) or
        (w.signal = 'stage_moved'            and p.stage_moved) or
        (w.signal = 'status_advanced'        and p.status_advanced) or
        (w.signal = 'notification_read'      and p.notification_read) or
        (w.signal = 'login_since_assignment' and p.login_since_assignment)
      ), 0)
    )::numeric,
    jsonb_build_object(
      'tel_click',              p.tel_click,
      'mailto_click',           p.mailto_click,
      'detail_opened',          p.detail_opened,
      'note_added',             p.note_added,
      'stage_moved',            p.stage_moved,
      'status_advanced',        p.status_advanced,
      'notification_read',      p.notification_read,
      'login_since_assignment', p.login_since_assignment
    )
  from present p;
$$;

revoke execute on function public.get_assignment_engagement_scores(uuid[], timestamptz)
  from public, anon, authenticated;
grant execute on function public.get_assignment_engagement_scores(uuid[], timestamptz)
  to service_role;
