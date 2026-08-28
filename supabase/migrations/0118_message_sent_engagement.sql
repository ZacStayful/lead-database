-- ---------------------------------------------------------------------------
-- 0118 — A sent message is contact (§40 phase 2)
--
-- ⚠️ THIS IS THE ONLY MIGRATION IN THIS PHASE THAT CHANGES WHO GETS LEADS.
-- Separated from 0117 so it can be applied on its own, sampled before and
-- after, and reverted without also reverting the vocabulary it depends on.
-- Deployed 0117-only, everything works and messages simply do not mark
-- contacted — the safe direction for the window between them.
--
-- WHY. The evidence hierarchy this codebase already runs on is incoherent
-- without it. 0043 excludes mailto_click from marking a lead contacted
-- "because a mailto click guarantees nothing was sent", and includes tel_click
-- because it is an attempt to ring. A DELIVERED WhatsApp with a provider
-- message id is stronger than both — it is not an attempt to make contact, it
-- IS contact. A system where clicking a phone number marks a lead contacted
-- while messaging the landlord does not would show up as genuinely-worked leads
-- escalating to a competitor at day 10 and pooling at day 25.
--
-- Measured before this shipped: 352 assignments, 12 contact clicks in total
-- (10 tel_click, 2 mailto_click) against 577 detail_opened — while 210
-- assignments carry first_contacted_at. Roughly 198 assert contact with no
-- evidence at all. That gap is what this closes.
--
-- ⚠️ INBOUND GETS NOTHING. No trigger, no weight. See section 3.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1 — lead_last_activity_at: exclusion filter -> inclusion list.
--
-- ⚠️ THE MOST IMPORTANT CHANGE IN THIS MIGRATION, AND IT CHANGES NO BEHAVIOUR.
--
-- It read `and e.event_type <> 'nudge_sent'`. An EXCLUSION filter means every
-- event type added to the vocabulary silently starts feeding the pool clock,
-- with nothing to review and nobody deciding. 0117 added two types, so both
-- would have been swept in automatically — including message_received, which
-- section 3 argues must never count as operator activity.
--
-- For the POOL CLOCK specifically, including both is right: the pool asks "is
-- this lead alive", and a landlord who replied three days ago plainly is. But
-- that must be a decision rather than an accident, which is what the inclusion
-- list makes it. Behaviour-identical on today's data — the list below is
-- exactly "everything except nudge_sent" — and explicit for the next person.
-- ---------------------------------------------------------------------------
create or replace function public.lead_last_activity_at(p_lead_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
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
        -- An INCLUSION list. Adding an event type to the vocabulary must not
        -- silently change the pool clock; it must be a decision made here.
        and e.event_type in (
          'detail_opened',
          'tel_click',
          'mailto_click',
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
$$;

-- §11's trap: a create-or-replace DISCARDS the function's ACL, so it must be
-- re-asserted every single time. This one is service_role only.
revoke execute on function public.lead_last_activity_at(uuid) from public, anon, authenticated;
grant  execute on function public.lead_last_activity_at(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 2 — A sent message marks the assignment contacted.
--
-- Through lead_events, NOT a second trigger on lead_messages. lead_events is
-- "the engagement basis for everything" (§3) and already owns this route into
-- mark_assignment_contacted; a parallel trigger would be a second undocumented
-- path for the next reader to discover. It also makes the signal weightable,
-- which section 4 needs.
--
-- mark_assignment_contacted is idempotent on `status = 'new'`, so a second
-- message never re-stamps first_contacted_at.
--
-- ⚠️ CONSEQUENCE, STATED RATHER THAN DISCOVERED: this makes a messaged lead
-- UNDISCARDABLE, because discard requires status = 'new'. §5E already records
-- that same gap for tel_click as unresolved. Sending a message is a far more
-- deliberate act than clicking a phone number, so it is the right trade — but
-- it is a new way to lose the discard button and belongs in §12 Deferred.
-- ---------------------------------------------------------------------------
drop trigger if exists lead_events_mark_contacted on public.lead_events;
create trigger lead_events_mark_contacted
  after insert on public.lead_events
  for each row
  when (new.event_type in ('tel_click', 'message_sent'))
  execute function public.trg_event_marks_contacted();

-- ---------------------------------------------------------------------------
-- 3 — The weight, and why inbound has none.
--
-- message_sent at 0.60, ABOVE tel_click's 0.50. tel_click is an attempt to
-- ring; a delivered message is the contact itself, with a provider id behind
-- it. It is the strongest operator signal in the table and should outrank
-- everything else in it.
--
-- ⚠️ message_received DELIBERATELY GETS NO WEIGHT AND NO ROW.
--
-- A landlord replying is the LANDLORD's act. Counting it as operator engagement
-- is the nudge_sent mistake (§3) in a more damaging form: an operator who sends
-- one message, gets an eager reply, and then ignores it for three weeks is
-- precisely who escalation exists to take the lead from. Letting the landlord's
-- own reply shield that lead would be the worst failure this feature could
-- have.
--
-- It is also the reason messages are not written as lead_notes rows: a note for
-- an inbound reply would have done exactly this, silently, through note_added
-- at 0.40 — and would additionally have barred the lead from the pool for ever.
-- ---------------------------------------------------------------------------
insert into public.engagement_weights (signal, weight, description) values
  ('message_sent', 0.60,
   'Sent the landlord a message from the dashboard, or from their own WhatsApp on a chat we can '
   'see. The strongest operator signal here: tel_click (0.50) is an attempt to ring, this is the '
   'contact itself with a provider message id behind it. mailto_click is 0.30 precisely because '
   'nothing was necessarily sent.')
on conflict (signal) do nothing;

-- ---------------------------------------------------------------------------
-- 4 — Wire the signal into the score.
--
-- ⚠️ A WEIGHT ROW ALONE IS A SILENT NO-OP. get_assignment_engagement_scores has
-- a FIXED `present` CTE unpivoted against engagement_weights, so a signal that
-- is not named in the function body scores nothing however it is weighted. It
-- must be added in FOUR places: the CTE, the weighted sum, the passive_only
-- negation, and the breakdown jsonb. Missing the third would let a lead someone
-- has messaged still read as "passively held", which the caller treats as
-- inactive whatever the score says.
--
-- Body below is production's live prosrc (md5 d11e98e0adba4286206201659e965ca9,
-- verified identical to 0063 before editing), plus the four additions.
--
-- SCOPED TO THIS FUNCTION ONLY. The capacity and reporting predicates (0064,
-- 0066, 0071, 0072, 0084) each duplicate their own "was this worked" test.
-- Widening all of them is eight create-or-replaces with eight ACL traps, for a
-- reporting approximation §18.2 already documents as inexact by one signal.
-- ---------------------------------------------------------------------------
create or replace function public.get_assignment_engagement_scores(
  p_assignment_ids uuid[],
  p_since          timestamptz
)
returns table (
  assignment_id uuid,
  score         numeric,
  passive_only  boolean,
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
      exists (select 1 from public.lead_events e
               where e.assignment_id = la.id and e.event_type = 'stage_changed'
                 and e.created_at >= p_since)                                    as stage_moved,
      -- NEW. message_sent ONLY: an inbound reply is the landlord's act and must
      -- never shield a lead from escalation.
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
      p.tel_click or p.mailto_click or p.note_added
      or p.stage_moved or p.status_advanced or p.message_sent
    ),
    jsonb_build_object(
      'tel_click',              p.tel_click,
      'mailto_click',           p.mailto_click,
      'detail_opened',          p.detail_opened,
      'note_added',             p.note_added,
      'stage_moved',            p.stage_moved,
      'message_sent',           p.message_sent,
      'status_advanced',        p.status_advanced,
      'notification_read',      p.notification_read,
      'login_since_assignment', p.login_since_assignment
    )
  from present p;
$$;

revoke execute on function public.get_assignment_engagement_scores(uuid[], timestamptz) from public, anon, authenticated;
grant  execute on function public.get_assignment_engagement_scores(uuid[], timestamptz) to service_role;
