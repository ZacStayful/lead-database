-- ---------------------------------------------------------------------------
-- 0149 — Chase an enquirer who never books a web meeting (§55)
--
-- /enquiry redirects every prospect to the Calendly booking link and nothing
-- follows up the ones who do not book. Measured on production 2026-09-13: 29
-- waitlisted prospects, 15 of them in the last 30 days, 28 of 29 carrying a
-- usable phone number, and not one of them ever chased.
--
-- This adds the ladder — WhatsApp + email about two minutes after enquiring,
-- another at 24 hours, a third at 48 hours — and the ledger that stops it
-- sending anything twice.
--
-- ⚠️ NEW ENQUIRIES ONLY, AND THAT IS STRUCTURAL RATHER THAN A SETTING. There
-- is no backfill and no global cutoff row: a prospect with no ladder row can
-- never be chased, and only POST /api/enquiry creates one. §32.4 rejected a
-- `system_settings` cutoff for exactly this shape of rule — a global is one
-- bad read away from enrolling the whole back catalogue, and it does not
-- survive a restore into a different timeline. The 29 who enquired before this
-- shipped are never contacted.
--
-- Entirely additive. Two new tables, three settings rows, no function
-- replaced, no constraint widened. Nothing here touches a balance, counter,
-- pacing or capacity column, so a lagging migration cannot affect lead
-- allocation — and `prospect_nudge_enabled` ships FALSE, so the code is inert
-- until somebody presses the switch.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1. The ladder — one per prospect
-- ===========================================================================

create table if not exists public.prospect_booking_nudges (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid not null references public.customers(id) on delete cascade,

  -- When they enquired, which is what every step is measured from. Its own
  -- column rather than customers.created_at: that row is UPDATED on a repeat
  -- enquiry while still waitlisted, so it is the first enquiry ever and not
  -- the one this ladder is about.
  enquired_at   timestamptz not null default now(),

  status        text not null default 'active',
  stopped_reason text,
  booked_at     timestamptz,
  opted_out_at  timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.prospect_booking_nudges
  drop constraint if exists prospect_booking_nudges_status_check;
alter table public.prospect_booking_nudges
  add constraint prospect_booking_nudges_status_check
  check (status in ('active', 'booked', 'completed', 'stopped'));

-- ⚠️ ONE LIVE LADDER PER PROSPECT. A repeat enquiry must not start a second
-- one: two ladders on one person means two of every message, from a real
-- number, to a member of the public. Partial rather than plain, so a prospect
-- who was chased, stopped, and later enquires again can have a fresh ladder.
create unique index if not exists prospect_booking_nudges_active_uidx
  on public.prospect_booking_nudges (customer_id)
  where status = 'active';

-- The due scan is "active ladders, oldest first".
create index if not exists prospect_booking_nudges_due_idx
  on public.prospect_booking_nudges (enquired_at)
  where status = 'active';

comment on table public.prospect_booking_nudges is
  'One booking-chase ladder per enquirer (§55). Created by POST /api/enquiry '
  'and by nothing else, which is what makes "new enquiries only" structural '
  'rather than a setting somebody has to remember.';

-- ===========================================================================
-- 2. The ledger — claim by INSERT, then send
-- ===========================================================================

create table if not exists public.prospect_nudge_sends (
  id                  uuid primary key default gen_random_uuid(),
  nudge_id            uuid not null
                        references public.prospect_booking_nudges(id) on delete cascade,
  step                smallint not null,
  channel             text not null,

  -- Written BEFORE the provider is called. See the index below.
  claimed_at          timestamptz not null default now(),
  sent_at             timestamptz,
  provider_message_id text,
  error               text
);

alter table public.prospect_nudge_sends
  drop constraint if exists prospect_nudge_sends_step_check;
alter table public.prospect_nudge_sends
  add constraint prospect_nudge_sends_step_check
  check (step between 1 and 3);

alter table public.prospect_nudge_sends
  drop constraint if exists prospect_nudge_sends_channel_check;
alter table public.prospect_nudge_sends
  add constraint prospect_nudge_sends_channel_check
  check (channel in ('whatsapp', 'email'));

-- ⚠️ THIS INDEX IS THE IDEMPOTENCY GUARD, AND THE ROW IS CLAIMED BEFORE THE
-- PROVIDER IS CALLED.
--
-- The sending cron runs every minute, so one step being considered twice is
-- the ordinary case rather than a rare one. Checking "have we already sent?"
-- and then sending leaves a window; claiming by write does not — a second
-- attempt collides on 23505 and sends nothing. The discipline credit_invoice()
-- uses against Stripe redelivery (§19.5) and the announcement send uses
-- against a double-clicked button (§21.2).
--
-- ⚠️ Both key columns are NOT NULL on purpose. A unique index treats NULLs as
-- distinct, so a nullable half would silently disable the whole guard — the
-- trap 0125 records for card_decline_events.
create unique index if not exists prospect_nudge_sends_claim_uidx
  on public.prospect_nudge_sends (nudge_id, step, channel);

-- Serves the daily cap, which counts sends across all prospects in a window.
create index if not exists prospect_nudge_sends_claimed_idx
  on public.prospect_nudge_sends (claimed_at);

comment on table public.prospect_nudge_sends is
  'One row per (ladder, step, channel), claimed by INSERT before the provider '
  'is called (§55). The unique index is the only thing standing between a '
  'retried cron tick and a landlord-buyer getting the same WhatsApp twice.';

-- ===========================================================================
-- 3. RLS — deny-all, no policies
-- ===========================================================================
-- Both tables are read and written on the service role only. The posture ~50
-- other tables here already take: RLS on with zero policies, so a browser
-- reaches nothing even if a future select is written without a filter.

alter table public.prospect_booking_nudges enable row level security;
alter table public.prospect_nudge_sends    enable row level security;

-- ===========================================================================
-- 4. Settings
-- ===========================================================================
-- All three go in the closed allow-list in src/lib/messaging/adminSettings.ts.
-- ⚠️ A route may never write a key taken from a request body: system_settings
-- also holds escalation_enabled, pool_enabled and the release switches, so an
-- unfiltered upsert could stop lead allocation from the messaging screen.

insert into public.system_settings (key, value) values
  -- ⚠️ SHIPS FALSE. What this gates sends unattended WhatsApps from a real
  -- person's own number to members of the public, so it turns on deliberately
  -- and only once the connection and the Calendly key are actually in place.
  ('prospect_nudge_enabled',  'false'),
  -- A ceiling on the whole feature, not per prospect. At ~15 enquiries a month
  -- this is never reached; it exists so a bad loop cannot empty the WhatsApp
  -- number's reputation overnight.
  ('prospect_nudge_daily_cap', '30')
on conflict (key) do nothing;

-- Which connected WhatsApp workspace the chase sends FROM.
--
-- ⚠️ A SELECT, NEVER A HARDCODED UUID. A bare `values` list would fail on any
-- database that does not happen to contain that row — and a scratch build from
-- 0001 contains no customers at all. This inserts ZERO ROWS there and does not
-- error, which is §46.6's rule and the reason that backfill is shaped the same
-- way.
insert into public.system_settings (key, value)
select 'prospect_nudge_sender_customer_id', c.id::text
  from public.customers c
 where c.email = 'zac@stayful.co.uk'
 limit 1
on conflict (key) do nothing;
