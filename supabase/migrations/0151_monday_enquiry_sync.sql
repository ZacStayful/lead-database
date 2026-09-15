-- ---------------------------------------------------------------------------
-- 0151 — Facebook lead ads become enquiries in the lead database (§57)
--
-- Facebook lead-form ads write straight into Monday board 18420649520, group
-- `topics` / "New enquiries" — the same board, the same group and the same
-- column ids POST /api/enquiry writes to. Nothing in the app noticed: a
-- Facebook lead became a row on a board and stopped there. No customers row,
-- no booking chase, no WhatsApp, no route to becoming a customer.
--
-- Everything downstream already works. Measured on production 2026-09-15:
-- `prospect_nudge_enabled` is TRUE, the WhatsApp connection is CONNECTED, and
-- the one ladder run so far sent both step-1 messages and then stopped itself
-- when Calendly reported the booking. So the only missing piece is the thing
-- that turns a board item into a customers row and a ladder row.
--
-- ⚠️ 0149's HEADER SAYS "NO BACKFILL AND NO GLOBAL CUTOFF ROW … ONLY
-- POST /api/enquiry CREATES ONE". THIS MIGRATION MAKES BOTH HALVES FALSE, and
-- that is deliberate rather than an oversight. §32.4's argument against a
-- global cutoff still stands — a global is one bad read away from enrolling
-- the whole back catalogue — and what answers it is NOT this cutoff row but
-- MAX_CHASE_AGE_MS in src/lib/enquiry/enquiryItem.ts, which bounds the LADDER
-- rather than the ingest. An item older than six hours is still turned into a
-- customer and is never chased, so the worst case of a cutoff misread to 1970
-- is a few dozen idempotent customer upserts and ZERO MESSAGES SENT. The
-- property 0149 was defending survives; only the mechanism moved.
--
-- Additive and inert. One new table nothing reads, one defaulted column, two
-- widened CHECKs (a widening cannot break deployed code — nothing older can
-- write the new value), and a switch that ships FALSE. Nothing here touches a
-- balance, counter, pacing or capacity column, so a lagging migration cannot
-- affect lead allocation.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1. The claim — one row per board item we have decided about
-- ===========================================================================
--
-- ⚠️ THE DUPLICATE CHECK HAS FOUR LAYERS AND ONLY ONE OF THEM IS THE SAFETY
-- PROPERTY. This table catches the same ITEM seen twice; customers.monday_item_id
-- catches the website→Monday→sync loop; the ladder's partial unique index
-- catches a second live chase. But that index is keyed on CUSTOMER_ID, so two
-- customer rows for one human means two ladders and two WhatsApps from a real
-- person's number to a member of the public, and the index is perfectly happy.
-- Matching an existing customer by email (and by name-corroborated phone) is
-- the thing standing in the way of that. The rest is hygiene.
create table if not exists public.monday_enquiry_claims (
  id              uuid primary key default gen_random_uuid(),

  -- ⚠️ THE GUARD. Claimed by INSERT before anything is written: a second pass
  -- over the same board item collides on 23505 and does nothing. Checking
  -- "have we done this?" and then doing it leaves a window, and at a
  -- once-a-minute cadence that window is found rather than theoretical.
  monday_item_id  text not null unique,
  monday_board_id text not null,

  -- The API's created_at, never the board's "Date added" cell. That cell read
  -- 2026-09-15 19:35 on a live item created at 13:35:21Z — six hours out, with
  -- a time component the website items do not have.
  item_created_at timestamptz,

  status          text not null default 'pending',
  outcome         text,

  -- ⚠️ SET NULL, NEVER CASCADE, AND THIS IS THE LOAD-BEARING LINE IN THE FILE.
  -- This row records that WE HAVE ALREADY DEALT WITH THIS BOARD ITEM. Under a
  -- cascade, deleting a customer — a cleaned-up test row, a GDPR erasure —
  -- deletes the claim with them; the next tick then sees an unclaimed item,
  -- re-creates the customer and STARTS A NEW LADDER, sending an unattended
  -- WhatsApp to somebody who was deleted from the database. The claim has to
  -- outlive its customer, which is why monday_item_id and not customer_id is
  -- the key. The opposite call to 0149's cascade, for the opposite reason: a
  -- deleted customer has no ladder left to run, but their board item is still
  -- sitting there being re-read every minute.
  customer_id     uuid references public.customers(id) on delete set null,

  attempts        smallint not null default 1,
  error           text,
  claimed_at      timestamptz not null default now(),
  settled_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.monday_enquiry_claims
  drop constraint if exists monday_enquiry_claims_status_check;
alter table public.monday_enquiry_claims
  add constraint monday_enquiry_claims_status_check
  check (status in ('pending', 'settled', 'skipped'));

-- A closed vocabulary, asserted mechanically against the TypeScript union in
-- vitest rather than by eye — the cancelOptions.ts arrangement (§29).
alter table public.monday_enquiry_claims
  drop constraint if exists monday_enquiry_claims_outcome_check;
alter table public.monday_enquiry_claims
  add constraint monday_enquiry_claims_outcome_check
  check (outcome is null or outcome in (
    'customer_created',
    'customer_matched',
    'already_linked',
    'ambiguous_phone',
    'junk',
    'bad_email',
    'stale_incomplete',
    'error'
  ));

-- The stuck report, and the only scan this table serves. A claim left pending
-- by a crash between the INSERT and the write is a SILENTLY LOST LEAD unless
-- something looks for it.
create index if not exists monday_enquiry_claims_pending_idx
  on public.monday_enquiry_claims (claimed_at)
  where status = 'pending';

-- The admin counters read this by day.
create index if not exists monday_enquiry_claims_claimed_at_idx
  on public.monday_enquiry_claims (claimed_at desc);

comment on table public.monday_enquiry_claims is
  'One row per Monday enquiries-board item the sync has decided about (§57). '
  'Claimed by INSERT before anything is written, settled with the outcome. '
  'Deliberately outlives its customer — see the on delete set null note.';

-- ===========================================================================
-- 2. RLS — deny-all, no policies. The house posture, shared with ~50 tables.
-- ===========================================================================
alter table public.monday_enquiry_claims enable row level security;

-- ===========================================================================
-- 3. Where a ladder came from
-- ===========================================================================
--
-- Additive and defaulted, and every existing row reads 'website' — which is
-- true of all of them, since /api/enquiry was until now the only creator.
-- It is what lets the admin counters say Facebook vs website, and it leaves a
-- future quiet-hours decision for ad leads a code change rather than a
-- migration.
alter table public.prospect_booking_nudges
  add column if not exists source text not null default 'website';

alter table public.prospect_booking_nudges
  drop constraint if exists prospect_booking_nudges_source_check;
alter table public.prospect_booking_nudges
  add constraint prospect_booking_nudges_source_check
  check (source in ('website', 'monday_sync'));

-- ===========================================================================
-- 4. A link we neither created nor guessed at
-- ===========================================================================
--
-- 0086's CHECK allows created|email|phone|name|manual and none of them is true
-- of an item the sync adopted. ⚠️ Writing 'created' would be a lie that
-- /api/admin/monday-status-check then reports as a high-confidence link.
-- src/lib/types.ts's union widens with it — that union has no `| string`
-- escape hatch, unlike monday_link_state beside it, so the compiler enforces
-- the pair.
alter table public.customers
  drop constraint if exists customers_monday_link_matched_by_check;
alter table public.customers
  add constraint customers_monday_link_matched_by_check
  check (
    monday_link_matched_by is null
    or monday_link_matched_by in
       ('created', 'email', 'phone', 'name', 'manual', 'monday_sync')
  );

-- ===========================================================================
-- 5. Settings
-- ===========================================================================

insert into public.system_settings (key, value) values
  -- ⚠️ SHIPS FALSE. What this gates ends in unattended WhatsApps from a real
  -- person's own number to members of the public, so it turns on deliberately,
  -- after a dry run has been read.
  ('enquiry_sync_enabled', 'false')
on conflict (key) do nothing;

-- ⚠️ SEEDED AT APPLY, AND READ FAIL-CLOSED. Absent, blank or unparseable means
-- INGEST NOTHING — never "ingest everything". §42.9's contact_notify_from rule,
-- where getting this backwards would have emailed 326 stale prospects.
--
-- Deliberately NOT in MESSAGING_SETTINGS: it is a timestamp set once at
-- go-live, the position landlord_nudge_from and contact_notify_from are
-- already in, and an admin able to edit it from a screen is precisely the bad
-- read this comment is about. Moving it is a SQL edit.
insert into public.system_settings (key, value)
  values ('enquiry_sync_from',
          to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
on conflict (key) do nothing;

-- The chase's daily ceiling is GLOBAL and was sized for ~15 enquiries a MONTH.
-- Paid traffic can reach that in a day, and the two populations share one
-- budget with no priority between them — so a Facebook spike would stop the
-- chase for website enquirers too. 200 is the documented ceiling in
-- MESSAGING_SETTINGS, above anything ads are likely to deliver while still
-- being a real bound on a runaway.
--
-- ⚠️ An UPDATE, not an insert: 0149 already seeded this key, so `on conflict
-- do nothing` would silently leave it at 30. Guarded on the old value so a
-- deliberate hand-edit is never overwritten.
update public.system_settings
   set value = '200'
 where key = 'prospect_nudge_daily_cap'
   and value = '30';
