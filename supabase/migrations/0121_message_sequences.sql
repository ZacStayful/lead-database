-- ---------------------------------------------------------------------------
-- 0121 — WhatsApp follow-up sequences (§40.13)
--
-- ADDITIVE AND INERT. Four new tables with no readers until the code lands, one
-- nullable column with a default that preserves today's meaning, and two
-- settings the shipped switch turns OFF. It redefines no function, changes no
-- CHECK that anything currently writes, and touches no balance, counter, pacing
-- or capacity column — so a lagging deploy cannot affect lead allocation.
--
-- WHAT THIS IS FOR. §40 gave an operator a composer and a "Generate a draft"
-- button, one lead at a time. The backlog it has to clear is not one lead at a
-- time: across the top twelve operators there are ~247 workable leads, ~50 new
-- assignments a week, and two distinct failures — leads never contacted at all
-- (21 for one operator) and leads contacted once and then abandoned (19 for
-- another, every single one of theirs). A follow-up sequence is the machine for
-- both.
--
-- ⚠️ WHY THIS IS NOT THE QUEUE THE CODEBASE ARGUES AGAINST. The send route and
-- §40.12 both record: "there is nowhere to defer to … TimelinesAI has no
-- idempotency key, so a stale queued WhatsApp can never be safely auto-retried.
-- A queue whose entries cannot be safely retried is not worth inventing."
--
-- That objection is about a queue of unsent PROVIDER PAYLOADS — rows handed to
-- a sender, crashed mid-flight, unreplayable. This is not one. What is stored
-- here is an INTENT: "this text is due to go at 09:00". When it comes due the
-- sender walks the same synchronous claim-by-insert path a human Send uses —
-- lead_messages claimed on (customer_id, idempotency_key), THEN the provider,
-- exactly once. A crash after the provider call leaves the row at 'queued' and
-- visible to the operator, which is precisely what a manual send does today.
-- Nothing is ever auto-retried against TimelinesAI. The idempotency key is
-- derived deterministically from (run_id, step_number), so a re-run of the job
-- collides on 23505 instead of messaging the landlord twice.
--
-- The objection is respected. It rules out a retry queue, not a schedule.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1 — The sequence: a named ladder of steps belonging to one customer.
--
-- `trigger` is what separates the two halves of the ask. 'manual' is enrolled
-- by the operator, one lead or two hundred at a time, and clears the backlog.
-- 'on_assignment' is the standing rule — a plan already set for leads that have
-- not arrived yet — and is applied by completeAssignment().
-- ---------------------------------------------------------------------------
create table if not exists public.message_sequences (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid not null references public.customers(id) on delete cascade,
  name          text not null,
  lead_type     text not null default 'management',
  channel       text not null default 'whatsapp',
  trigger       text not null default 'manual',
  is_active     boolean not null default true,
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.message_sequences
  drop constraint if exists message_sequences_lead_type_check;
alter table public.message_sequences
  add constraint message_sequences_lead_type_check
  check (lead_type in ('management','guaranteed_rent'));

alter table public.message_sequences
  drop constraint if exists message_sequences_channel_check;
alter table public.message_sequences
  add constraint message_sequences_channel_check check (channel in ('email','whatsapp'));

alter table public.message_sequences
  drop constraint if exists message_sequences_trigger_check;
alter table public.message_sequences
  add constraint message_sequences_trigger_check
  check (trigger in ('manual','on_assignment'));

-- ⚠️ AT MOST ONE STANDING RULE PER PRODUCT. Without this a customer with two
-- active on_assignment sequences enrols every new lead twice and messages the
-- landlord twice on the day it arrives — from one number, minutes apart, which
-- is the exact profile that gets a WhatsApp account restricted.
--
-- Partial on is_active, so archiving one and creating another is ordinary.
create unique index if not exists message_sequences_standing_idx
  on public.message_sequences (customer_id, lead_type, channel)
  where trigger = 'on_assignment' and is_active;

create index if not exists message_sequences_customer_idx
  on public.message_sequences (customer_id, created_at desc);

comment on table public.message_sequences is
  'A named follow-up ladder (SS40.13). trigger=manual is enrolled by the operator; '
  'trigger=on_assignment is the standing rule applied by completeAssignment().';

-- ---------------------------------------------------------------------------
-- 2 — The steps.
--
-- `delay_days` is CALENDAR days from the previous step, not working days.
-- businessTime.ts is the wrong calendar here for the reason §40.12 already
-- gives: a landlord is a CONSUMER, so a Saturday may land better than a
-- Tuesday, and fetchUkBankHolidays() makes a live gov.uk request that has no
-- business anywhere near a send decision.
--
-- Step 1 with delay_days = 0 is the "message them as soon as they are assigned"
-- case, and needs no special column: it is simply due immediately.
--
-- `brief` is what the step is FOR, in the operator's own words — "ask if they
-- have had other quotes", "last try, offer a call". It is fed to the drafter so
-- that step 3 is a different message rather than the same one reworded.
-- ---------------------------------------------------------------------------
create table if not exists public.message_sequence_steps (
  id            uuid primary key default gen_random_uuid(),
  sequence_id   uuid not null references public.message_sequences(id) on delete cascade,
  step_number   integer not null,
  delay_days    integer not null default 3,
  brief         text,
  created_at    timestamptz not null default now()
);

alter table public.message_sequence_steps
  drop constraint if exists message_sequence_steps_number_check;
alter table public.message_sequence_steps
  add constraint message_sequence_steps_number_check
  check (step_number >= 1 and step_number <= 12);

alter table public.message_sequence_steps
  drop constraint if exists message_sequence_steps_delay_check;
alter table public.message_sequence_steps
  add constraint message_sequence_steps_delay_check
  check (delay_days >= 0 and delay_days <= 365);

create unique index if not exists message_sequence_steps_order_idx
  on public.message_sequence_steps (sequence_id, step_number);

-- ---------------------------------------------------------------------------
-- 3 — The run: one lead's progress through one sequence.
--
-- ⚠️ UNIQUE ON assignment_id ALONE, not on (assignment_id, sequence_id). A lead
-- may be in at most ONE sequence at a time. Two concurrent runs on one landlord
-- — an operator enrolling a backlog that happens to include a lead the standing
-- rule already picked up — is two ladders of messages to the same person from
-- the same number, and it is the failure this feature must not ship with.
--
-- ⚠️ ON DELETE CASCADE from lead_assignments, deliberately. A run is LIVE STATE,
-- not a record of what happened — that is lead_messages, which survives (0116
-- sets its assignment_id to null rather than cascading). So discard (§30.7),
-- the filter release (§39) and a swap all stop a run for free, with no edit to
-- any privileged function.
-- ---------------------------------------------------------------------------
create table if not exists public.message_sequence_runs (
  id             uuid primary key default gen_random_uuid(),
  customer_id    uuid not null references public.customers(id) on delete cascade,
  sequence_id    uuid not null references public.message_sequences(id) on delete cascade,
  assignment_id  uuid not null references public.lead_assignments(id) on delete cascade,
  lead_id        uuid not null references public.leads(id) on delete cascade,
  status         text not null default 'active',
  -- The step LAST completed. 0 means nothing has gone yet.
  current_step   integer not null default 0,
  next_due_at    timestamptz,
  stopped_reason text,
  stopped_at     timestamptz,
  enrolled_by    uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.message_sequence_runs
  drop constraint if exists message_sequence_runs_status_check;
alter table public.message_sequence_runs
  add constraint message_sequence_runs_status_check
  check (status in ('active','completed','stopped'));

create unique index if not exists message_sequence_runs_assignment_idx
  on public.message_sequence_runs (assignment_id);

-- The drafting cron's whole query: active runs due inside the review window.
create index if not exists message_sequence_runs_due_idx
  on public.message_sequence_runs (next_due_at)
  where status = 'active';

create index if not exists message_sequence_runs_customer_idx
  on public.message_sequence_runs (customer_id, created_at desc);

comment on column public.message_sequence_runs.status is
  'active | completed (ran out of steps) | stopped (landlord replied, operator cancelled, lead '
  'became unsendable). stopped_reason carries which.';

-- ---------------------------------------------------------------------------
-- 4 — The review queue.
--
-- THIS IS THE PRODUCT DECISION MADE VISIBLE. A step is drafted the evening
-- BEFORE it is due, sits here overnight where the operator can read, edit or
-- kill it, and sends itself in the morning if they do nothing.
--
-- Draft-then-send rather than send-blind is what makes an unattended message
-- from a real person's own WhatsApp number defensible: nothing goes out that
-- the operator could not have seen first. Requiring approval instead would put
-- the feature back to one lead at a time, which is the problem.
--
-- `body` is a copy of the text, not a pointer at the draft row: the operator may
-- edit it here, and the ledger must keep what the MODEL wrote so the send path
-- can still tell an edited draft from a verbatim one.
--
-- ⚠️ Unique on (run_id, step_number) — one draft per step, ever. It is also the
-- second line of defence behind the deterministic idempotency key: a drafting
-- cron that runs twice writes one row.
-- ---------------------------------------------------------------------------
create table if not exists public.message_sequence_drafts (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references public.message_sequence_runs(id) on delete cascade,
  customer_id   uuid not null references public.customers(id) on delete cascade,
  step_number   integer not null,
  body          text not null,
  draft_id      uuid references public.message_draft_requests(id) on delete set null,
  state         text not null default 'pending',
  send_after    timestamptz not null,
  message_id    uuid references public.lead_messages(id) on delete set null,
  skip_reason   text,
  cancelled_at  timestamptz,
  edited_at     timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.message_sequence_drafts
  drop constraint if exists message_sequence_drafts_state_check;
alter table public.message_sequence_drafts
  add constraint message_sequence_drafts_state_check
  check (state in ('pending','cancelled','sent','skipped'));

create unique index if not exists message_sequence_drafts_step_idx
  on public.message_sequence_drafts (run_id, step_number);

-- The sending phase's whole query.
create index if not exists message_sequence_drafts_due_idx
  on public.message_sequence_drafts (send_after)
  where state = 'pending';

create index if not exists message_sequence_drafts_customer_idx
  on public.message_sequence_drafts (customer_id, created_at desc);

comment on table public.message_sequence_drafts is
  'The review queue (SS40.13). Drafted ahead, visible overnight, auto-sends unless cancelled. '
  'body is a COPY the operator may edit; message_draft_requests.draft_text keeps what the model '
  'wrote, so the send path can still tell edited from verbatim.';

-- ---------------------------------------------------------------------------
-- 5 — Telling the two kinds of draft apart.
--
-- ⚠️ THE INTERACTIVE RATE LIMITS CANNOT BE REUSED FOR BULK, AND MUST NOT BE.
-- The draft route caps a customer at 50 drafts per rolling day. One operator's
-- workable backlog is 37 leads and another's is 38; a three-step sequence over
-- either is several times that. Worse, the counter cannot tell an operator
-- hitting "regenerate" four times from the engine drafting step 2 for two
-- hundred leads, so one would silently starve the other.
--
-- Defaulting to 'operator' preserves exactly today's meaning for every existing
-- row and for the interactive route, which continues to count its own origin
-- only. The sequence drafter gets its own ceiling, sized against the daily SEND
-- cap rather than against a human clicking.
--
-- Note for whoever reads message_draft_requests' own comment: its "~110k rows a
-- year" estimate is derived from the interactive cap and stops being true here.
-- ---------------------------------------------------------------------------
alter table public.message_draft_requests
  add column if not exists origin text not null default 'operator';

alter table public.message_draft_requests
  drop constraint if exists message_draft_requests_origin_check;
alter table public.message_draft_requests
  add constraint message_draft_requests_origin_check
  check (origin in ('operator','sequence'));

create index if not exists message_draft_requests_origin_idx
  on public.message_draft_requests (customer_id, origin, created_at desc);

comment on column public.message_draft_requests.origin is
  'operator = a person pressed Generate; sequence = the scheduler drafted a step. The two have '
  'separate ceilings, because a human clicking and a batch of two hundred are not the same load.';

-- ---------------------------------------------------------------------------
-- 6 — RLS: on, no policies. As every other messaging table.
--
-- These rows carry drafted message bodies — landlord names, property details —
-- and the whole schedule of who is about to be contacted. Every read is
-- server-side on the service role.
-- ---------------------------------------------------------------------------
alter table public.message_sequences         enable row level security;
alter table public.message_sequence_steps    enable row level security;
alter table public.message_sequence_runs     enable row level security;
alter table public.message_sequence_drafts   enable row level security;

-- ---------------------------------------------------------------------------
-- 7 — The settings.
--
-- ⚠️ messaging_sequences_enabled SHIPS FALSE, like messaging_enabled did, and
-- for a sharper reason: the thing being gated sends unattended messages from a
-- real person's own number to members of the public. Nothing drafts and nothing
-- sends until somebody turns this on deliberately.
--
-- messaging_sequence_review_hours is how far ahead a step is drafted, and it is
-- ⚠️ ARITHMETICALLY TIED TO THE DRAFTING CRON'S OWN SCHEDULE. That job runs at
-- 17:00 UTC and the earliest a step can send is 09:00 the next morning (quiet
-- hours, §40.12) — sixteen hours later. A twelve-hour window would therefore
-- MISS every ordinary morning step, draft it the following evening instead, and
-- turn "drafted overnight" into "sent a day late". Eighteen clears that gap with
-- room to spare.
--
-- Shorten this, or move the cron, and check that sum again.
--
-- messaging_sequence_daily_draft_cap is the bulk ceiling of §5 above. Sized
-- against the send cap: drafting far more than can be sent only builds a queue
-- of stale text.
-- ---------------------------------------------------------------------------
insert into public.system_settings (key, value)
  values ('messaging_sequences_enabled', 'false') on conflict (key) do nothing;
insert into public.system_settings (key, value)
  values ('messaging_sequence_review_hours', '18') on conflict (key) do nothing;
insert into public.system_settings (key, value)
  values ('messaging_sequence_daily_draft_cap', '250') on conflict (key) do nothing;
