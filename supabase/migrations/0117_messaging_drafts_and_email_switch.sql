-- ---------------------------------------------------------------------------
-- 0117 — AI-drafted messages, the email channel switch, and the inbound
--        vocabulary (§40 phase 2)
--
-- ADDITIVE AND INERT. Nothing here changes any existing behaviour: the new
-- settings are read only by code that does not exist yet, the new table has no
-- readers, the new columns are nullable, and widening a CHECK admits values
-- nothing currently writes. It can be applied ahead of the deploy under the
-- standing migrations-before-code rule, and a lagging deploy cannot affect lead
-- allocation.
--
-- The migration that DOES touch routing is 0118, deliberately separated so it
-- can be applied on its own and reverted on its own.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1 — The email channel switch.
--
-- Seven DNS records, three of them 60-character DKIM CNAMEs, is not something a
-- property operator completes — the first contact with a real user confirmed
-- what the research had already said. WhatsApp is the channel that works here.
--
-- The email code is HIDDEN, NOT DELETED: it carries a four-layer defence against
-- putting an MX record on a customer's apex domain, which would stop their real
-- email arriving. That was the most careful work in the feature and it costs
-- nothing dormant. Seeded false, with the same admin-preview bypass as
-- messaging_enabled, so it stays reachable for a technical operator later.
-- ---------------------------------------------------------------------------
insert into public.system_settings (key, value)
  values ('messaging_email_enabled', 'false') on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2 — The draft ledger.
--
-- Two jobs, and the second is the more valuable. It is the rate-limit counter,
-- AND it is the only record of how often the validator refused the model, split
-- by whether the lead had figures at all. Half the live book has no analysis
-- (15 of 30 when this was written), so "does the draft degrade honestly on the
-- other half" is the question this feature will be judged on — and without this
-- table it is unanswerable after launch.
--
-- draft_text is stored because what operators CHANGE about a draft is the single
-- most useful signal here, and because the send path compares against it to
-- decide whether a sent message was edited.
-- ---------------------------------------------------------------------------
create table if not exists public.message_draft_requests (
  id             uuid primary key default gen_random_uuid(),
  customer_id    uuid not null references public.customers(id) on delete cascade,
  assignment_id  uuid references public.lead_assignments(id) on delete set null,
  channel        text not null,
  outcome        text not null,
  reject_reason  text,
  draft_text     text,
  model_id       text,
  prompt_version text,
  had_figures    boolean not null,
  created_at     timestamptz not null default now()
);

alter table public.message_draft_requests
  drop constraint if exists message_draft_requests_channel_check;
alter table public.message_draft_requests
  add constraint message_draft_requests_channel_check
  check (channel in ('email','whatsapp'));

alter table public.message_draft_requests
  drop constraint if exists message_draft_requests_outcome_check;
alter table public.message_draft_requests
  add constraint message_draft_requests_outcome_check
  check (outcome in ('drafted','rejected','error','rate_limited'));

create index if not exists message_draft_requests_customer_idx
  on public.message_draft_requests (customer_id, created_at desc);
create index if not exists message_draft_requests_assignment_idx
  on public.message_draft_requests (assignment_id, created_at desc);

alter table public.message_draft_requests enable row level security;

comment on table public.message_draft_requests is
  'Every AI draft request (SS28). Rate-limit ledger AND the record of how often the validator '
  'refused the model, split by had_figures. Grows unboundedly; at the per-customer cap that is '
  'roughly 110k rows a year across the whole book, i.e. not worth pruning yet.';
comment on column public.message_draft_requests.draft_text is
  'What the model wrote. The send path compares the sent text against this to decide whether the '
  'operator edited it — never trust a client-supplied "unchanged" flag.';

-- ---------------------------------------------------------------------------
-- 3 — Provenance on a sent message.
--
-- 0116 already carries generated_by / model_id / prompt_version. What it cannot
-- express is the difference between a draft sent verbatim and one the operator
-- rewrote — and that is the distinction that will matter when asking which
-- messages convert.
--
-- ⚠️ A FOURTH generated_by VALUE WOULD BE WORSE. Adding 'llm_edited' would make
-- generated_by = 'llm' mean "unedited" in new rows and "any LLM" in old ones, so
-- every existing query silently changes meaning. A boolean beside it cannot do
-- that: generated_by answers PROVENANCE, the boolean qualifies it.
-- ---------------------------------------------------------------------------
alter table public.lead_messages
  add column if not exists draft_id uuid
    references public.message_draft_requests(id) on delete set null;
alter table public.lead_messages
  add column if not exists edited_after_generation boolean;

comment on column public.lead_messages.edited_after_generation is
  'Null when no draft was involved. Gives three clean populations in one join: llm-and-unedited, '
  'llm-and-edited, human.';

-- ---------------------------------------------------------------------------
-- 4 — The inbound vocabulary.
--
-- Widened here (additive, nothing writes these yet) so that 0118 — which does
-- change routing — contains only the behaviour change and can be reverted
-- without also reverting the vocabulary.
--
-- THREE PROVENANCES NOW, NOT TWO:
--   operator-generated   detail_opened, tel_click, mailto_click, note_added,
--                        file_added, stage_changed, message_sent
--   counterparty         message_received  ← NEW CATEGORY
--   system-generated     nudge_sent
--
-- ⚠️ message_received is the landlord's act, not the operator's. It must never
-- count as operator activity — the nudge_sent rule, and for a sharper reason:
-- an operator who sends one message, gets an eager reply and then ignores it for
-- three weeks is exactly who escalation exists to take the lead from. Letting
-- the landlord's own reply shield that lead would be this feature's worst
-- failure. It is recorded so the timeline and later analytics have a dated
-- record, and for nothing else.
--
-- ⚠️ NEITHER may ever enter CLIENT_LEAD_EVENT_TYPES. message_sent is weighted
-- above tel_click in 0118; a customer able to POST it could shield every lead
-- they hold from escalation and from the pool.
-- ---------------------------------------------------------------------------
alter table public.lead_events drop constraint if exists lead_events_event_type_check;
alter table public.lead_events add constraint lead_events_event_type_check
  check (event_type in (
    'detail_opened',
    'tel_click',
    'mailto_click',
    'note_added',
    'file_added',
    'stage_changed',
    'message_sent',
    'message_received',
    'nudge_sent'
  ));
