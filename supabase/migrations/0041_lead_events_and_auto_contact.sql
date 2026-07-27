-- ============================================================================
-- Passive engagement telemetry + automatic "contacted" status flip.
--
-- WHY
-- ---
-- Everything the portal knows about whether an operator actually worked a lead
-- is self-reported: they press "Mark as contacted", or they don't. That makes
-- the status field unusable as an engagement measure — a diligent operator who
-- rings every lead but never touches the status looks identical to one who
-- ignores their leads entirely.
--
-- lead_events records what the operator DID, not what they said they did:
-- opening a lead, clicking the phone number, clicking the email address. It is
-- append-only and deliberately dumb — no aggregation, no derived state. The
-- rolling-window scoring built on top of it lives in later migrations.
--
-- The second half of this migration closes the reporting gap the other way
-- round: any real evidence of work (a note, a file, moving the pipeline off
-- cold, ringing the number) now flips status 'new' -> 'contacted' by itself, so
-- the status field stops under-reporting activity.
--
-- WHAT THIS DOES NOT DO
-- ---------------------
--   * It never touches pipeline_stage. Status and pipeline_stage stay
--     independent (0010) — pipeline_stage is the operator's own sales stage and
--     is theirs alone to set.
--   * It never touches viewed_at, lead_balance / gr_lead_balance, the monthly
--     counters, or leads.assignment_count. No allocation consequence whatsoever.
--   * It is lead-type blind: management and guaranteed-rent assignments run the
--     identical path, because status and its vocabulary are shared.
--
-- NOTE ON first_contacted_at
-- --------------------------
-- The column already exists (0033) and is stamped by the customer assignments
-- PATCH route on a manual contacted-flip. This migration adds the automatic
-- writers. No backfill is included: 0033 shipped alongside the write path and
-- every non-'new' assignment already carries a stamp, so there is nothing to
-- repair.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 — lead_events
-- ---------------------------------------------------------------------------
create table if not exists public.lead_events (
  id            uuid primary key default gen_random_uuid(),
  assignment_id uuid not null
                  references public.lead_assignments(id) on delete cascade,
  event_type    text not null check (event_type in (
                  'detail_opened',
                  'tel_click',
                  'mailto_click',
                  'note_added',
                  'file_added',
                  'stage_changed'
                )),
  created_at    timestamptz not null default now(),
  metadata      jsonb
);

-- Per-assignment lookups ("has this assignment ever been opened?") and the
-- per-customer rolling-window aggregates that read a date range per event type.
create index if not exists idx_lead_events_assignment_type_created
  on public.lead_events (assignment_id, event_type, created_at);

-- Window sweeps that scan by time first (nudge/reclaim crons).
create index if not exists idx_lead_events_created_at
  on public.lead_events (created_at);

-- RLS: read-your-own, write nothing.
--
-- A customer may read the events attached to their own assignments. There is
-- deliberately NO insert/update/delete policy, so the browser client cannot
-- write here at all — inserts go through POST /api/customer/events on the
-- service role, exactly like every other write in this schema.
--
-- This is a considered departure from the original brief, which proposed a
-- browser-facing insert policy scoped to the caller's own assignments. Two
-- reasons against it:
--   1. It would be the first browser-writable table in the schema, breaking the
--      "all privileged writes go through server routes on the service role"
--      invariant that keeps price_paid and friends unforgeable.
--   2. These events become an INPUT TO ROUTING — engagement score decides who
--      is offered a reclaimed lead. A directly-insertable telemetry table lets a
--      customer manufacture their own engagement and win leads off better
--      operators. Routing through a server route means the writes can be
--      deduplicated and rate-limited; an RLS policy cannot be.
alter table public.lead_events enable row level security;

drop policy if exists "lead_events_select_own" on public.lead_events;
create policy "lead_events_select_own" on public.lead_events
  for select using (
    exists (
      select 1
      from public.lead_assignments la
      join public.customers c on c.id = la.customer_id
      where la.id = lead_events.assignment_id
        and c.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- 2 — Reclaim columns (used from the soft-reclaim migration onward)
--
-- Added here rather than later so lead_assignments takes a single ALTER for
-- this programme of work.
--
--   reclaimed_at  — set on the ORIGINAL assignment when its lead is released
--                   for a second operator. Presence of this stamp on ANY
--                   assignment of a lead is the "already reclaimed once" guard.
--   is_reclaimed  — set on the SECOND assignment (the discounted one), never on
--                   the original. Drives the lead-age badge and reduced price.
-- ---------------------------------------------------------------------------
alter table public.lead_assignments
  add column if not exists reclaimed_at timestamptz;

alter table public.lead_assignments
  add column if not exists is_reclaimed boolean not null default false;

-- Reclaim sweeps look for un-reclaimed assignments past their window; the
-- partial index keeps that scan off the already-reclaimed majority.
create index if not exists idx_lead_assignments_reclaimed_at
  on public.lead_assignments (reclaimed_at)
  where reclaimed_at is not null;

-- ---------------------------------------------------------------------------
-- 3 — mark_assignment_contacted
--
-- The single place the automatic flip happens. Every trigger below is a thin
-- wrapper over this, so the rules live in exactly one function.
--
-- Idempotent by construction: the `status = 'new'` predicate means a second
-- call on an already-contacted assignment matches zero rows and does nothing.
-- That is what makes re-firing safe — four different triggers can and will fire
-- for the same assignment (a note AND a tel click AND a stage move), and only
-- the first one has any effect.
--
-- last_status_change_at is stamped deliberately. It is app-maintained (0035),
-- read by BOTH the inactivity-nudge and progress-report crons as "when did this
-- lead last move", and until now only the PATCH route wrote it. An automatic
-- flip that changed status without stamping it would leave those crons reading
-- a timestamp that predates the change — a lead auto-flipped by a phone click
-- would look stale immediately, or never, depending on its history.
--
-- first_contacted_at uses coalesce so the FIRST touch wins permanently. It is
-- the speed-to-lead numerator; overwriting it on a later touch would silently
-- improve an operator's apparent response time every time they came back.
-- ---------------------------------------------------------------------------
create or replace function public.mark_assignment_contacted(
  p_assignment_id uuid
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.lead_assignments
     set status                = 'contacted',
         first_contacted_at    = coalesce(first_contacted_at, now()),
         last_status_change_at = now()
   where id = p_assignment_id
     and status = 'new';
$$;

revoke execute on function public.mark_assignment_contacted(uuid)
  from public, anon, authenticated;
grant execute on function public.mark_assignment_contacted(uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- 4 — Triggers
--
-- RECURSION
-- ---------
-- One of these fires on lead_assignments, and mark_assignment_contacted UPDATEs
-- lead_assignments. Two independent guards stop that looping:
--
--   a) The trigger is `AFTER UPDATE OF pipeline_stage`, so it only fires when
--      pipeline_stage appears in the UPDATE's target column list.
--      mark_assignment_contacted sets status / first_contacted_at /
--      last_status_change_at and never mentions pipeline_stage, so the inner
--      write cannot re-arm its own trigger. This alone terminates it.
--   b) The WHEN clause requires old.pipeline_stage = 'cold', and the function
--      requires status = 'new'. Even if (a) were bypassed, the second pass
--      matches no rows and the chain stops there.
--
-- All four triggers RETURN NULL: they are AFTER triggers, where the return
-- value is ignored, and returning NULL makes it explicit that they do not
-- rewrite the row being inserted.
-- ---------------------------------------------------------------------------

-- 4a — a note is real evidence the operator engaged with the lead.
create or replace function public.trg_note_marks_contacted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.mark_assignment_contacted(new.lead_assignment_id);
  return null;
end;
$$;

drop trigger if exists lead_notes_mark_contacted on public.lead_notes;
create trigger lead_notes_mark_contacted
  after insert on public.lead_notes
  for each row
  execute function public.trg_note_marks_contacted();

-- 4b — so is uploading a file against it.
create or replace function public.trg_file_marks_contacted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.mark_assignment_contacted(new.lead_assignment_id);
  return null;
end;
$$;

drop trigger if exists lead_files_mark_contacted on public.lead_files;
create trigger lead_files_mark_contacted
  after insert on public.lead_files
  for each row
  execute function public.trg_file_marks_contacted();

-- 4c — moving the pipeline off 'cold' means they have started working it.
-- Fires for management and GR stage vocabularies alike: the condition is
-- "no longer cold", not a list of stage names, so the GR stages
-- (viewing_booked / contract_sent / contract_signed) qualify identically.
create or replace function public.trg_stage_marks_contacted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.mark_assignment_contacted(new.id);
  return null;
end;
$$;

drop trigger if exists lead_assignments_stage_mark_contacted on public.lead_assignments;
create trigger lead_assignments_stage_mark_contacted
  after update of pipeline_stage on public.lead_assignments
  for each row
  when (old.pipeline_stage = 'cold' and new.pipeline_stage is distinct from 'cold')
  execute function public.trg_stage_marks_contacted();

-- 4d — clicking the phone number is an attempt to ring the landlord.
-- Only tel_click qualifies. Opening the lead (detail_opened) or clicking the
-- email address are weaker signals: reading a lead is not contacting it, and a
-- mailto click opens a client without any guarantee a message was sent. Those
-- still record as telemetry, they just do not move the status.
create or replace function public.trg_event_marks_contacted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.mark_assignment_contacted(new.assignment_id);
  return null;
end;
$$;

drop trigger if exists lead_events_mark_contacted on public.lead_events;
create trigger lead_events_mark_contacted
  after insert on public.lead_events
  for each row
  when (new.event_type = 'tel_click')
  execute function public.trg_event_marks_contacted();

-- ---------------------------------------------------------------------------
-- 5 — Reject eligibility moves from status to pipeline_stage
--
-- BEFORE: rejectable only while status = 'new'.
-- AFTER:  rejectable while pipeline_stage = 'cold'.
--
-- The old rule was self-defeating once the flip above exists: a customer who
-- rings a landlord, gets no answer and decides to pass would find the lead had
-- auto-flipped to 'contacted' and become unrejectable. Worse, that was already
-- true manually — pressing "Mark as contacted" locked you out of rejecting.
--
-- pipeline_stage is the honest test of "have I invested in this lead yet".
-- 'cold' means no meeting booked, no viewing, no contract — nothing has been
-- built on it, so passing on it costs nothing downstream. Any other stage means
-- the operator has actively advanced it and reject would contradict their own
-- recorded progress.
--
-- The two terminal statuses are excluded explicitly:
--   'won'      — a signed landlord whose pipeline_stage was simply never moved
--                off cold would otherwise be rejectable, silently destroying a
--                conversion record. The original brief considered the
--                'contacted' case but not this one.
--   'rejected' — already rejected; keeps the operation a true no-op rather than
--                a repeated write.
--
-- Unchanged: reject is still a feedback signal only. No refund, no replacement,
-- the lead stays chargeable (0019). discard_lead_assignment is untouched — its
-- "status = 'new' AND no notes" rule already expresses the stricter thing it
-- needs to, since discard actually withdraws the lead.
-- ---------------------------------------------------------------------------
create or replace function public.reject_lead_assignment(
  p_assignment_id uuid,
  p_customer_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.lead_assignments
    set status = 'rejected'
    where id = p_assignment_id
      and customer_id = p_customer_id
      and pipeline_stage = 'cold'
      and status not in ('won', 'rejected');

  if not found then
    raise exception 'Assignment not found, not owned by this customer, or not rejectable';
  end if;
end;
$$;

-- Re-assert the 0028 lockdown for the function just redefined (CREATE OR
-- REPLACE preserves grants, but this is cheap and keeps the guarantee local).
revoke execute on function public.reject_lead_assignment(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.reject_lead_assignment(uuid, uuid)
  to service_role;
