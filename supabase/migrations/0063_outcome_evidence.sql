-- ============================================================================
-- Outcome evidence: does what the operator CLAIMED match what they DID?
--
-- Every outcome in this system is self-reported. status = 'won' is a button, and
-- pipeline_stage is a dropdown. Neither costs anything to set and neither is
-- checked against anything, which is why production currently holds:
--
--   * a lead marked WON whose own note reads "NOT INTERESTED ANYMORE", written
--     nine seconds after it was first opened — no call, no meeting
--   * 126 assignments marked 'contacted' still sitting at pipeline_stage 'cold'
--   * 22 of 298 assignments that have ever moved off the default stage at all
--
-- The claim and the evidence live in different tables and nobody has ever put
-- them side by side. This does.
--
-- WHY NOTES ARE THE CORROBORATION
-- -------------------------------
-- Telemetry says whether they rang. Notes say what happened when they did, in
-- the operator's own words, written for their own benefit rather than for us —
-- which is exactly what makes them trustworthy. The mis-marked win above was
-- only identifiable because of a nine-word note. No amount of event data would
-- have caught it; the operator opened the lead twice, which looks like interest.
--
-- WHAT THIS IS NOT
-- ----------------
-- Not an accusation and not a verdict. The overwhelmingly likely explanation for
-- an unsupported claim is a mis-click or a busy operator, not dishonesty — there
-- is nothing to gain from a false win, since it carries no credit and no refund.
-- This is a review queue: it surfaces the rows where the claim and the evidence
-- disagree so a person can look. The contradiction check in particular is a
-- crude keyword match, and is deliberately reported as "worth a look" rather
-- than "wrong".
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Phrases that contradict a positive outcome.
--
-- Kept as a table rather than inline so the list can be extended from admin as
-- real notes accumulate — the vocabulary operators actually use is not
-- guessable in advance, and the first version of this list is a guess informed
-- by exactly one real example.
-- ---------------------------------------------------------------------------
create table if not exists public.outcome_contradiction_phrases (
  phrase     text primary key,
  created_at timestamptz not null default now()
);

alter table public.outcome_contradiction_phrases enable row level security;

insert into public.outcome_contradiction_phrases (phrase) values
  ('not interested'),
  ('no longer interested'),
  ('not going ahead'),
  ('went elsewhere'),
  ('gone elsewhere'),
  ('going elsewhere'),
  ('another agent'),
  ('another company'),
  ('declined'),
  ('changed their mind'),
  ('changed his mind'),
  ('changed her mind'),
  ('wrong number'),
  ('dead number'),
  ('no answer'),
  ('not answering'),
  ('unreachable'),
  ('cannot reach'),
  ("can't reach"),
  ('sold the property'),
  ('sold it'),
  ('pulled out'),
  ('backed out'),
  ('time waster')
on conflict (phrase) do nothing;

-- ---------------------------------------------------------------------------
-- The evidence behind each recorded outcome.
--
-- One row per assignment carrying a claim worth checking. p_status narrows it
-- to a single claim ('won', 'not_relevant', 'rejected'); null returns all three.
--
-- evidence_level grades the SUPPORT for the claim, not the operator:
--
--   strong    a contact attempt AND a pipeline stage past cold
--   partial   one of the two
--   none      neither — the claim rests on nothing recorded anywhere
--
-- contradicted is separate from evidence_level on purpose. A win with strong
-- evidence AND a note saying the landlord went elsewhere is more interesting
-- than one with no evidence at all: the first is a genuine conflict between two
-- things the operator did, the second is just an unfilled form.
--
-- A NEGATIVE NOTE ONLY CONTRADICTS A WIN.
--
-- The first version of this got that wrong and flagged four rejections whose
-- notes read "not interested" and "business has gone to someone else" — which
-- are not contradictions of a rejection, they are the REASON for it. Ten of the
-- eleven rejections in production carry exactly that kind of note, so treating
-- the phrase list as status-blind turned a review queue into noise and buried
-- the one row that mattered.
--
-- So the same phrase means opposite things depending on the claim: on a win it
-- is a conflict, on a rejection or a close it is corroboration, and it is
-- counted as supporting evidence there instead.
-- ---------------------------------------------------------------------------
create or replace function public.get_outcome_evidence(
  p_status text default null
)
returns table (
  assignment_id     uuid,
  customer_id       uuid,
  business_name     text,
  lead_id           uuid,
  lead_name         text,
  lead_type         public.lead_type,
  status            text,
  closed_reason     text,
  pipeline_stage    text,
  assigned_at       timestamptz,
  claimed_at        timestamptz,
  hours_to_claim    numeric,
  contact_attempts  integer,
  opens             integer,
  note_count        integer,
  notes             text,
  evidence_level    text,
  contradicted      boolean,
  review_reason     text
)
language sql
stable
security definer
set search_path = public
as $$
  with claims as (
    select
      la.id, la.customer_id, la.lead_id, la.status, la.closed_reason,
      la.pipeline_stage, la.assigned_at, la.last_status_change_at,
      (select count(*) from public.lead_events e
        where e.assignment_id = la.id
          and e.event_type in ('tel_click', 'mailto_click'))::integer as attempts,
      (select count(*) from public.lead_events e
        where e.assignment_id = la.id
          and e.event_type = 'detail_opened')::integer                as opens,
      (select count(*) from public.lead_notes n
        where n.lead_assignment_id = la.id)::integer                  as note_count,
      -- Notes in order, each stamped, as one readable block. This is the column
      -- a human actually reads to decide whether the claim holds up.
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
      -- On a negative outcome a note explaining WHY is real corroboration, and
      -- for most operators it is the only trace they leave: they ring from the
      -- number in the alert email rather than through the portal, so there is no
      -- tel_click to find. Refusing to count it would grade the diligent ones
      -- 'none' for writing the note.
      when g.status in ('rejected', 'not_relevant') and g.negative_note then 'partial'
      else 'none'
    end,
    (g.negative_note and g.status = 'won'),
    -- Ordered most-serious first: a contradiction beats a missing signal,
    -- because it means two things the operator recorded disagree with each
    -- other rather than one of them simply being absent.
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
$$;

revoke execute on function public.get_outcome_evidence(text) from public, anon, authenticated;
grant execute on function public.get_outcome_evidence(text) to service_role;
