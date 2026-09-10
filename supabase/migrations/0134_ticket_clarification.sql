-- ---------------------------------------------------------------------------
-- 0134 — Asking the customer the questions, before the ticket lands (§47).
--
-- WHY THIS EXISTS
-- ---------------
-- 0133 (§46) fixed the bookkeeping: every request is now a row, with a
-- reference, a plan snapshot and a status. What it did not fix is the CONTENT.
-- `subject` is one line and `body` is one paragraph, written by a short-term-
-- rental operator who does not know the app calls it a pipeline stage, cannot
-- remember which screen they were on, and has no reason to state what "fixed"
-- would look like.
--
-- So every request still costs a follow-up conversation before any work starts.
-- The interrogation that makes a request actionable happens days later, in a
-- Claude Code session, against a customer who has moved on.
--
-- 0134 moves that interrogation to the moment of reporting. Three to five
-- questions, generated from what the customer wrote and from their live account
-- state, answered in taps, and then one synthesised brief and a ready-to-paste
-- implementation prompt. The columns below hold the conversation and its
-- output.
--
-- ⚠️ NOTHING ADDED HERE IS CUSTOMER-VISIBLE, AND THE BOUNDARY IS STRUCTURAL.
-- §46.3 put admin notes in their own TABLE precisely because a select("*")
-- would ship them. These columns cannot take that route — a clarification
-- belongs to its ticket and splitting it off would fork the admin screen — so
-- the boundary here is the one §46.3 already relies on for notes: the customer
-- read in src/app/dashboard/support/page.tsx names a FIXED COLUMN LIST and must
-- never grow one of these names, and never become select("*").
-- supportTicketBoundary.test.ts reads that file and fails if it does.
--
-- ⚠️ ADDITIVE AND INERT. Every existing row, including the nine backfilled by
-- 0133, keeps ai_status NULL and renders exactly as it does today. NULL is not
-- a missing value here, it is a real state: "no questions were ever offered",
-- which is true of every pre-0134 ticket and of every signed-out submission.
-- ---------------------------------------------------------------------------

alter table public.support_tickets
  add column if not exists clarifications   jsonb,
  add column if not exists brief            jsonb,
  add column if not exists generated_prompt text,
  add column if not exists ai_status        text,
  add column if not exists ai_model         text,
  add column if not exists ai_error         text,
  add column if not exists severity         text;

-- The lifecycle, and why 'abandoned' has to exist.
--
--   NULL             no questions were offered (pre-0134, or signed out)
--   awaiting_answers logged at step one, questions not yet answered
--   ready            answered and synthesised
--   failed           answered, synthesis errored — retried by the sweeper
--   abandoned        logged, never answered, swept and emailed unclarified
--   skipped          clarification unavailable (no API key, over the cap)
--
-- ⚠️ 'abandoned' is what keeps 0133's guarantee intact. The questions are
-- COMPULSORY — there is no skip control, because a skipped question puts a hole
-- in the brief exactly where it mattered. A compulsory multi-step form in front
-- of the insert would have reintroduced the precise failure 0133 was built to
-- fix: a customer who gives up at question two leaving no trace, where today
-- their paragraph is already on /admin/support. So the ticket is written BEFORE
-- the first question is asked, and the worst case is a ticket merely as good as
-- a pre-0134 one — never worse.
alter table public.support_tickets drop constraint if exists support_tickets_ai_status_check;
alter table public.support_tickets add constraint support_tickets_ai_status_check
  check (ai_status is null or ai_status in
    ('awaiting_answers', 'ready', 'failed', 'abandoned', 'skipped'));

-- Nullable: severity is the model's reading, and it has none until synthesis
-- runs. It is deliberately NOT a second status column on the admin list — see
-- §47 — it rides in the brief.
alter table public.support_tickets drop constraint if exists support_tickets_severity_check;
alter table public.support_tickets add constraint support_tickets_severity_check
  check (severity is null or severity in ('blocker', 'major', 'minor', 'cosmetic'));

-- Shape, not schema. The application validates these against a zod schema on
-- the way in; this is the floor that stops a scalar or a string ending up in a
-- column every reader will iterate. The 0130/0131 floor-of-1 idiom applies to
-- the text columns for the same reason it does in 0133: '' must never be able
-- to mean "set, but empty".
alter table public.support_tickets drop constraint if exists support_tickets_ai_shape_check;
alter table public.support_tickets add constraint support_tickets_ai_shape_check
  check (
        (clarifications   is null or jsonb_typeof(clarifications) = 'array')
    and (brief            is null or jsonb_typeof(brief)          = 'object')
    and (generated_prompt is null or length(btrim(generated_prompt)) between 1 and 20000)
    and (ai_model         is null or length(btrim(ai_model))         between 1 and 80)
    and (ai_error         is null or length(btrim(ai_error))         between 1 and 500)
  );

-- The sweeper's scan: tickets still waiting on answers (candidates for the
-- abandonment email) and tickets whose synthesis errored (candidates for a
-- retry). Partial, because every other row is uninteresting to it and the
-- terminal states are the overwhelming majority once this has been running.
create index if not exists support_tickets_ai_pending_idx
  on public.support_tickets (ai_status, submitted_at)
  where ai_status in ('awaiting_answers', 'failed');

comment on column public.support_tickets.clarifications is
  'The generated questions and the customer''s answers, as an array of '
  '{question, answer, depth}. `depth` is how many times the customer asked for '
  'the question to be simplified — 0 means they answered it as first asked. A '
  'high depth is itself a finding: it means the customer could not follow the '
  'app''s own vocabulary in that area. ADMIN ONLY — see §47 and the header of '
  'this migration.';

comment on column public.support_tickets.brief is
  'Structured synthesis output: the restated problem, acceptance criteria, '
  'files to look at, invariants in the blast radius, and what could not be '
  'determined. ADMIN ONLY.';

comment on column public.support_tickets.generated_prompt is
  'The ready-to-paste Claude Code prompt. This is the deliverable of §47. '
  'ADMIN ONLY.';

comment on column public.support_tickets.ai_status is
  'NULL means no questions were ever offered — every pre-0134 ticket and every '
  'signed-out submission. See the CHECK above for the other five states and '
  'why ''abandoned'' exists.';
