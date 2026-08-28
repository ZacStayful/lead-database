-- ---------------------------------------------------------------------------
-- 0116 — The message spine: threads, messages, per-message events (§28)
--
-- Stores what was sent to a landlord, what came back, and every delivery signal
-- in between. Additive and inert: nothing reads these tables until the code
-- ships, and nothing here touches a balance, counter, pacing or capacity
-- column, so a lagging deploy cannot affect lead allocation.
--
-- ONE MESSAGE TABLE, BOTH CHANNELS. The lead page shows one chronological list,
-- so two tables would mean a UNION on every read — and a UNION over divergent
-- column sets is where drift starts. Analytics wants ONE denominator (sent →
-- delivered → opened/read → replied → won); two tables give two funnels to
-- reconcile by hand. The channel-specific columns are few and orthogonal, and
-- CHECKs keyed on `channel` give what a NOT NULL would. `customers` already
-- lives with exactly this shape in its parallel gr_ columns (invariant 6).
--
-- THREADS ARE KEYED (customer, channel, counterparty), NOT PER ASSIGNMENT.
-- Two reasons. §18's duplicate-landlord problem means one landlord can arrive as
-- several leads, and the operator should see one conversation rather than two
-- half-conversations. And inbound arrives addressed to a PERSON, not to an
-- assignment, so a per-assignment key would have nothing to match on.
--
-- A landlord held by two operators produces TWO threads, one per customer. The
-- leading customer_id in every unique key is the containment guarantee: one
-- customer's conversation is structurally unreachable from another's.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1 — Threads.
-- ---------------------------------------------------------------------------
create table if not exists public.lead_message_threads (
  id                      uuid primary key default gen_random_uuid(),
  customer_id             uuid not null references public.customers(id) on delete cascade,

  -- "The assignment this conversation is currently about". Re-pointed if a newer
  -- assignment for the same landlord appears. Message rows keep their own
  -- immutable assignment_id, which is what analytics joins on.
  assignment_id           uuid references public.lead_assignments(id) on delete set null,
  lead_id                 uuid references public.leads(id) on delete set null,

  channel                 text not null,

  -- The minted token that appears in the reply address. This is the PRIMARY
  -- correlation route for inbound email, because it survives the landlord
  -- replying from a different address, forwarding, or stripping headers.
  thread_token            text,
  provider_chat_id        text,

  counterparty_email      text,
  counterparty_phone      text,
  counterparty_phone_norm text generated always as (public.normalised_phone(counterparty_phone)) stored,

  match_status            text not null default 'matched',
  opted_out_at            timestamptz,

  last_inbound_at         timestamptz,
  last_outbound_at        timestamptz,
  last_message_at         timestamptz,
  unread_inbound_count    integer not null default 0,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

alter table public.lead_message_threads
  drop constraint if exists lead_message_threads_channel_check;
alter table public.lead_message_threads
  add constraint lead_message_threads_channel_check
  check (channel in ('email','whatsapp'));

alter table public.lead_message_threads
  drop constraint if exists lead_message_threads_match_status_check;
alter table public.lead_message_threads
  add constraint lead_message_threads_match_status_check
  check (match_status in ('matched','unmatched','ambiguous'));

alter table public.lead_message_threads
  drop constraint if exists lead_message_threads_shape_check;
alter table public.lead_message_threads
  add constraint lead_message_threads_shape_check
  check (
    (channel = 'email'    and counterparty_email is not null) or
    (channel = 'whatsapp' and counterparty_phone is not null)
  );

create unique index if not exists lead_message_threads_email_idx
  on public.lead_message_threads (customer_id, lower(counterparty_email))
  where channel = 'email' and counterparty_email is not null;

create unique index if not exists lead_message_threads_phone_idx
  on public.lead_message_threads (customer_id, counterparty_phone_norm)
  where channel = 'whatsapp' and counterparty_phone_norm is not null;

create unique index if not exists lead_message_threads_token_idx
  on public.lead_message_threads (thread_token) where thread_token is not null;

create index if not exists lead_message_threads_assignment_idx
  on public.lead_message_threads (assignment_id, last_message_at desc);

comment on table public.lead_message_threads is
  'One conversation per (customer, channel, landlord). NOT per assignment — inbound arrives '
  'addressed to a person, and §18 duplicate landlords mean one person can be several leads.';
comment on column public.lead_message_threads.counterparty_phone_norm is
  'Generated via normalised_phone (0070): digits only, null under 7 digits or all zeros. '
  'This is what rejects the live "+0" WhatsApp chat that passes the @s.whatsapp.net JID test.';

-- ---------------------------------------------------------------------------
-- 2 — Messages.
-- ---------------------------------------------------------------------------
create table if not exists public.lead_messages (
  id                  uuid primary key default gen_random_uuid(),
  thread_id           uuid not null references public.lead_message_threads(id) on delete cascade,
  customer_id         uuid not null references public.customers(id) on delete cascade,
  assignment_id       uuid references public.lead_assignments(id) on delete set null,
  lead_id             uuid references public.leads(id) on delete set null,

  channel             text not null,
  direction           text not null,
  status              text not null default 'queued',
  provider            text not null,
  provider_message_id text,

  -- The send path claims by INSERT with this key BEFORE calling the provider, so
  -- a double-clicked Send collides on 23505 and returns the existing row rather
  -- than messaging the landlord twice. Same discipline as credit_invoice()
  -- against Stripe redelivery (§19.5) and the announcement send (§22.2).
  idempotency_key     text,

  -- email
  subject             text,
  from_address        text,
  to_address          text,
  reply_to_address    text,
  message_id_header   text,
  in_reply_to         text,
  references_header   text,

  -- whatsapp
  to_phone            text,
  to_phone_norm       text generated always as (public.normalised_phone(to_phone)) stored,

  body_text           text,
  body_html           text,
  -- Resend's email.received payload is METADATA ONLY; the body is a second call
  -- that can fail. When it does we keep the message and retry from the cron
  -- rather than throwing, because throwing deletes the webhook claim and makes
  -- Resend redeliver an event we have already half-processed.
  body_fetch_pending  boolean not null default false,

  -- v2 hooks. Populated as constants in v1 so that "which variant converted" is
  -- a join and not a migration. DO NOT add a `converted` boolean later: the
  -- outcome label is lead_assignments.status = 'won', reached through
  -- assignment_id.
  template_key        text,
  variant_key         text,
  generated_by        text not null default 'human',
  model_id            text,
  prompt_version      text,

  sent_by_user_id     uuid,
  error_code          text,
  error_detail        text,
  poll_attempts       integer not null default 0,
  next_poll_at        timestamptz,

  created_at          timestamptz not null default now(),
  sent_at             timestamptz,
  delivered_at        timestamptz,
  read_at             timestamptz,
  first_opened_at     timestamptz,
  first_clicked_at    timestamptz,
  replied_at          timestamptz
);

alter table public.lead_messages
  drop constraint if exists lead_messages_channel_check;
alter table public.lead_messages
  add constraint lead_messages_channel_check check (channel in ('email','whatsapp'));

alter table public.lead_messages
  drop constraint if exists lead_messages_direction_check;
alter table public.lead_messages
  add constraint lead_messages_direction_check check (direction in ('outbound','inbound'));

alter table public.lead_messages
  drop constraint if exists lead_messages_provider_check;
-- 'whatsapp_cloud' is listed now so that migrating off the QR-linked device to
-- the official WhatsApp Business API later is a value, not a schema change.
alter table public.lead_messages
  add constraint lead_messages_provider_check
  check (provider in ('resend','timelinesai','whatsapp_cloud'));

alter table public.lead_messages
  drop constraint if exists lead_messages_status_check;
alter table public.lead_messages
  add constraint lead_messages_status_check
  check (status in ('queued','sent','delivered','read','received','bounced','complained','failed','skipped'));

alter table public.lead_messages
  drop constraint if exists lead_messages_generated_by_check;
alter table public.lead_messages
  add constraint lead_messages_generated_by_check
  check (generated_by in ('human','llm','system'));

-- Holds in both directions: for direction='inbound' these are the landlord's
-- address and number rather than ours.
alter table public.lead_messages
  drop constraint if exists lead_messages_shape_check;
alter table public.lead_messages
  add constraint lead_messages_shape_check
  check (
    (channel = 'email'    and to_address is not null) or
    (channel = 'whatsapp' and to_phone   is not null)
  );

-- The dedupe spine for inbound and for status polling.
create unique index if not exists lead_messages_provider_id_idx
  on public.lead_messages (provider, provider_message_id)
  where provider_message_id is not null;

-- What a double-clicked Send collides on.
create unique index if not exists lead_messages_idempotency_idx
  on public.lead_messages (customer_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists lead_messages_thread_idx     on public.lead_messages (thread_id, created_at desc);
create index if not exists lead_messages_assignment_idx on public.lead_messages (assignment_id, created_at desc);
create index if not exists lead_messages_customer_idx   on public.lead_messages (customer_id, created_at desc);

-- The status poller's only scan. TimelinesAI has no delivered/read webhook on
-- the QR-linked route, so delivery state must be polled.
create index if not exists lead_messages_poll_idx
  on public.lead_messages (next_poll_at)
  where channel = 'whatsapp' and direction = 'outbound'
    and status in ('queued','sent','delivered') and next_poll_at is not null;

comment on table public.lead_messages is
  'Every message to or from a landlord, both channels in one table (§28). The v2 learning loop '
  'reads template_key/variant_key/generated_by as features and lead_assignments.status as the label.';
comment on column public.lead_messages.idempotency_key is
  'Claimed by INSERT before the provider is called. NOTE: email is safely re-sent under the same '
  'Resend Idempotency-Key after a crash, but TimelinesAI has NO idempotency key, so a stale queued '
  'WhatsApp message is never auto-retried — it is surfaced to the operator instead.';

-- ---------------------------------------------------------------------------
-- 3 — Per-message engagement events.
--
-- Separate from the stamps on lead_messages for the same reason lead_events is
-- separate from viewed_at (§11): the stamp is the cheap read for the UI, these
-- rows are the honest record of a repeatable act with counts and timings. Do
-- not let anyone tidy one into the other.
-- ---------------------------------------------------------------------------
create table if not exists public.lead_message_events (
  id                uuid primary key default gen_random_uuid(),
  message_id        uuid not null references public.lead_messages(id) on delete cascade,
  event_type        text not null,
  occurred_at       timestamptz not null default now(),
  provider_event_id text,
  -- machine_likely marks an open that is probably a mail-client prefetch rather
  -- than a human. Apple Mail Privacy Protection loads pixels unconditionally, so
  -- an open is never a fact — the §11 treatment of viewed_at, applied here.
  metadata          jsonb,
  created_at        timestamptz not null default now()
);

alter table public.lead_message_events
  drop constraint if exists lead_message_events_type_check;
alter table public.lead_message_events
  add constraint lead_message_events_type_check
  check (event_type in ('queued','sent','delivered','delivery_delayed','opened','clicked',
                        'bounced','complained','failed','read','replied'));

create unique index if not exists lead_message_events_dedupe_idx
  on public.lead_message_events (message_id, event_type, occurred_at);
create unique index if not exists lead_message_events_provider_idx
  on public.lead_message_events (provider_event_id) where provider_event_id is not null;
create index if not exists lead_message_events_type_idx
  on public.lead_message_events (event_type, occurred_at desc);

-- ---------------------------------------------------------------------------
-- 4 — Webhook idempotency claims, the stripe_events shape.
--
-- Claim by INSERT; 23505 means we have seen it; delete the claim on a throw so
-- the sender retries. `verified = false` rows are TimelinesAI payloads whose
-- read-back could not complete inside that vendor's 5-second budget — the
-- maintenance cron promotes them.
-- ---------------------------------------------------------------------------
create table if not exists public.message_webhook_events (
  id          text primary key,
  provider    text not null,
  event_type  text,
  payload     jsonb,
  verified    boolean not null default true,
  received_at timestamptz not null default now()
);

alter table public.message_webhook_events
  drop constraint if exists message_webhook_events_provider_check;
alter table public.message_webhook_events
  add constraint message_webhook_events_provider_check
  check (provider in ('resend','timelinesai'));

create index if not exists message_webhook_events_pending_idx
  on public.message_webhook_events (received_at) where verified = false;

-- ---------------------------------------------------------------------------
-- 5 — Templates. Ships EMPTY.
--
-- It exists so lead_messages.template_key / variant_key are foreign to
-- something real from day one, and so v2's "which variant converted" is a join
-- rather than a migration.
-- ---------------------------------------------------------------------------
create table if not exists public.message_templates (
  id               uuid primary key default gen_random_uuid(),
  customer_id      uuid references public.customers(id) on delete cascade,
  channel          text not null,
  template_key     text not null,
  variant_key      text not null default 'default',
  subject_template text,
  body_template    text not null,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table public.message_templates
  drop constraint if exists message_templates_channel_check;
alter table public.message_templates
  add constraint message_templates_channel_check check (channel in ('email','whatsapp'));

create unique index if not exists message_templates_key_idx
  on public.message_templates
  (coalesce(customer_id, '00000000-0000-0000-0000-000000000000'::uuid), channel, template_key, variant_key);

comment on table public.message_templates is
  'Named message variants. Ships empty; a null customer_id means Stayful-provided. The v2 seam.';

-- ---------------------------------------------------------------------------
-- 6 — RLS: on, no policy, on all five. Every read is server-side.
--
-- Bodies contain landlord PII and are reachable only through routes on the
-- service role. The one thing this forfeits is a browser realtime subscription
-- for live inbound; that is not v1, and adding a select-own policy later is
-- three lines.
-- ---------------------------------------------------------------------------
alter table public.lead_message_threads   enable row level security;
alter table public.lead_messages          enable row level security;
alter table public.lead_message_events    enable row level security;
alter table public.message_webhook_events enable row level security;
alter table public.message_templates      enable row level security;
