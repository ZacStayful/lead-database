-- ============================================================================
-- Enquiry routes: which message brought an enquirer into the funnel, which
-- option order they were offered, and a claim table for the Monday status
-- sync (batch 03 Part A, Phase 1). Management only.
--
-- docs/build/03-enquiry-workflow.md is the prompt and
-- docs/build/03-phase0-report.md the approved Phase 0 report. Decisions E1
-- and E3 are cited below by number.
--
-- What it adds:
--   1. funnel_sessions.entry_point — 'instant' | 'chase' | 'no_show' |
--      'post_call'. Sent by n8n to POST /api/funnel/session.
--   2. funnel_sessions.offer_order — 'call_first' | 'funnel_first'. The
--      alternate-week test's cohort, set once.
--   3. funnel_sessions.first_answered_at — when the first answer was saved.
--      The point E1 freezes entry_point at, and Phase 2's "Funnel started".
--   4. funnel_monday_writes — one claim per (session, transition), so each
--      Monday status change is written once (E3).
--
-- ⚠️ INERT. Every new column is nullable and nothing reads it until batch 03's
-- code ships. No function is created, replaced or re-granted, and no existing
-- constraint is touched. funnel_sessions held 0 rows when this was written
-- (funnel_enabled has never been on), so there is nothing to backfill.
--
-- ⚠️ ONE OPEN SESSION PER EMAIL (0165), SO entry_point CAN CHANGE (E1).
-- The instant message creates the session, and every later n8n call for the
-- same email (the chase, a no-show, the post-call step) finds that same row.
-- entry_point is therefore the LAST value n8n sent BEFORE THE FIRST ANSWER:
-- the route overwrites it only while first_answered_at is null, and that
-- condition is in the write itself. offer_order is set by the call that
-- creates the session and never changed: it is about the instant message,
-- not about what came after.
--
-- ⚠️ THE MONDAY CLAIMS LIVE IN THEIR OWN TABLE, NOT ON funnel_sessions (E3).
-- funnel_sessions has a before-update trigger that stamps updated_at (0165,
-- trg_funnel_sessions_touch), and the funnel discount's "quiet for an hour"
-- test reads updated_at (src/lib/funnel/discount.ts). A claim column on that
-- row would reset the clock every time a Monday write was claimed. This
-- table has no such trigger, so a claim moves nothing on the session.
--
-- ⚠️ RLS ON, NO POLICIES: every read and write goes through a server route on
-- the service role (the house posture, as 0165).
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1–3 — funnel_sessions: entry_point, offer_order, first_answered_at
-- ---------------------------------------------------------------------------
alter table public.funnel_sessions
  add column if not exists entry_point       text,
  add column if not exists offer_order       text,
  add column if not exists first_answered_at timestamptz;

alter table public.funnel_sessions
  drop constraint if exists funnel_sessions_entry_point;
alter table public.funnel_sessions
  add constraint funnel_sessions_entry_point check (
    entry_point is null or entry_point in ('instant', 'chase', 'no_show', 'post_call')
  );

alter table public.funnel_sessions
  drop constraint if exists funnel_sessions_offer_order;
alter table public.funnel_sessions
  add constraint funnel_sessions_offer_order check (
    offer_order is null or offer_order in ('call_first', 'funnel_first')
  );

comment on column public.funnel_sessions.entry_point is
  'Which n8n message brought this enquirer into the funnel: the last entry '
  'point sent before the first answer, frozen from first_answered_at (0166, E1). '
  'Null for a session created without one.';

comment on column public.funnel_sessions.offer_order is
  'Which option the instant message put first: the alternate-week test''s '
  'cohort. Set by the call that creates the session and never changed (0166).';

comment on column public.funnel_sessions.first_answered_at is
  'When the first answer was saved. entry_point is frozen from here, and the '
  'Monday status sync writes "Funnel started" (0166).';


-- ---------------------------------------------------------------------------
-- 4 — funnel_monday_writes
--
-- One row per Monday status change a session has had written: claimed by
-- INSERT before the Monday call (the credit_invoice discipline), so two
-- overlapping runs, or a retried request, cannot write the same change twice.
-- A collision on the primary key (23505) means another run already has it.
-- ---------------------------------------------------------------------------
create table if not exists public.funnel_monday_writes (
  session_id   uuid not null references public.funnel_sessions(id) on delete cascade,
  transition   text not null,
  claimed_at   timestamptz not null default now(),
  completed_at timestamptz,
  outcome      text,
  detail       text,

  primary key (session_id, transition),

  constraint funnel_monday_writes_transition check (transition in ('started', 'finished')),
  constraint funnel_monday_writes_outcome check (
    outcome is null or outcome in ('written', 'skipped', 'failed')
  ),
  -- Settled together: an outcome is recorded when the attempt completes.
  constraint funnel_monday_writes_settled check ((outcome is null) = (completed_at is null)),
  constraint funnel_monday_writes_detail_length check (
    detail is null or char_length(detail) <= 500
  )
);

comment on table public.funnel_monday_writes is
  'Claims for the funnel''s Monday status changes, one per session and '
  'transition (0166, batch 03). Kept off funnel_sessions so a claim never '
  'moves its updated_at. Service role only (RLS on, no policies).';

alter table public.funnel_monday_writes enable row level security;
