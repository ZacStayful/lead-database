-- ============================================================================
-- Announcements — the first message this system sends that is not about a lead.
--
-- Every other email is machine-generated and lead-shaped: new lead alerts,
-- inactivity nudges, the weekly report, the monthly summary. A price change, a
-- planned outage, a change to how filtering works — none of it had a channel,
-- which in practice meant pasting addresses into a mail client by hand:
-- untracked, easy to send twice, easy to send to the wrong half of the book.
--
-- Entirely additive. Nothing here reads, writes or derives from lead_balance,
-- gr_lead_balance, monthly_allocation, leads_received_this_month, or any
-- billing, pacing, capacity or allocation column. An announcement cannot move a
-- lead or a credit.
--
-- WHY NOT THE EXISTING notifications TABLE
-- ----------------------------------------
-- That was the obvious reuse and it is wrong here. NotificationsCentre marks
-- every row read the moment the bell is opened, and its click handler navigates
-- to /dashboard/leads/<id>, falling back to the leads list when there is no
-- lead. An announcement dropped in there would be marked read without being
-- seen and would dump the reader on a page about something else. Bending that
-- component means reworking behaviour the lead notifications depend on, so
-- announcements get their own tables and their own banner.
--
-- WHAT DECIDES WHO SEES ONE
-- -------------------------
-- Audience, not delivery. announcement_deliveries records who was EMAILED;
-- the dashboard banner is governed by the audience rule alone, so a customer
-- who turned the emails off still sees the notice in the app. The opt-out is a
-- preference about their inbox, not a request to be kept uninformed.
--
-- The audience rule itself lives in src/lib/announcements.ts and is shared by
-- the send and the banner, for the same reason customer_can_see_pool_lead is
-- one definition shared by the pool listing and the pool claim: an announcement
-- must never be emailed to somebody the banner hides it from.
-- ============================================================================

create table if not exists public.announcements (
  id               uuid primary key default gen_random_uuid(),

  subject          text not null,   -- email subject line
  title            text not null,   -- heading in the email and in the banner
  body_text        text not null,   -- PLAIN TEXT; blank lines split paragraphs

  -- Who it goes to. 'management' and 'guaranteed_rent' are resolved from each
  -- product's OWN status columns (invariant 6) — the GR branch must never read
  -- account_status. 'all' is the union, one email per customer even for
  -- somebody holding both products.
  audience         text not null default 'all'
                     check (audience in ('all', 'management', 'guaranteed_rent')),

  -- Optional call to action. https only, enforced in the write route.
  link_url         text,
  link_label       text,

  -- Not every notice deserves a banner. Some are worth an email and nothing
  -- more, and a dashboard that always carries a bar of text trains people to
  -- stop reading it.
  show_banner      boolean not null default true,

  status           text not null default 'draft'
                     check (status in ('draft', 'sending', 'sent')),
  sent_at          timestamptz,
  recipient_count  integer,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- A sent announcement must carry the evidence that it was sent. Guards
  -- against a status flipped by hand leaving a banner on the dashboard with no
  -- delivery log behind it and no date to show the reader.
  constraint announcements_sent_is_stamped check (
    status <> 'sent' or sent_at is not null
  ),

  -- A link needs a label or the button has nothing to say.
  constraint announcements_link_is_labelled check (
    link_url is null or btrim(coalesce(link_label, '')) <> ''
  )
);

create index if not exists idx_announcements_sent
  on public.announcements(status, sent_at desc);

-- ---------------------------------------------------------------------------
-- One row per (announcement, customer) actually emailed.
--
-- THE UNIQUE INDEX IS THE IDEMPOTENCY GUARD, not the status column. The send
-- claims a recipient by INSERTing this row and only then calls Resend, so a
-- double-clicked button, a retry after a timeout, or two concurrent runs all
-- collide on the index and skip. Same shape as credit_invoice() claiming a
-- Stripe invoice with a payments row (§19.5): the claim is the write, and
-- checking-then-acting would leave a window.
--
-- `error` is set when Resend refused. The row still exists, because "we tried
-- and it failed" and "we never tried" are different facts and only one of them
-- is worth retrying by hand.
-- ---------------------------------------------------------------------------
create table if not exists public.announcement_deliveries (
  id               uuid primary key default gen_random_uuid(),
  announcement_id  uuid not null references public.announcements(id) on delete cascade,
  customer_id      uuid not null references public.customers(id) on delete cascade,
  email            text not null,
  sent_at          timestamptz not null default now(),
  resend_id        text,
  error            text,
  unique (announcement_id, customer_id)
);

create index if not exists idx_announcement_deliveries_announcement
  on public.announcement_deliveries(announcement_id);

-- ---------------------------------------------------------------------------
-- Banner dismissal.
--
-- Separate from deliveries deliberately: an opted-out customer has no delivery
-- row and still sees, and still needs to be able to dismiss, the banner.
-- ---------------------------------------------------------------------------
create table if not exists public.announcement_dismissals (
  announcement_id  uuid not null references public.announcements(id) on delete cascade,
  customer_id      uuid not null references public.customers(id) on delete cascade,
  dismissed_at     timestamptz not null default now(),
  primary key (announcement_id, customer_id)
);

create index if not exists idx_announcement_dismissals_customer
  on public.announcement_dismissals(customer_id);

-- ---------------------------------------------------------------------------
-- RLS: enabled with NO policies on all three tables — deny-all to the browser,
-- the same posture as operator_proof_snapshots (0081).
--
-- Every read and write goes through a server route on the service role. There
-- is nothing to gain from a browser-readable announcements table: drafts are
-- unsent work in progress, and the banner is assembled server-side in the
-- dashboard page, which already runs on the service role. A browser-writable
-- dismissals table would let a customer dismiss on somebody else's behalf.
-- Consistent with invariant 7.
-- ---------------------------------------------------------------------------
alter table public.announcements            enable row level security;
alter table public.announcement_deliveries  enable row level security;
alter table public.announcement_dismissals  enable row level security;

-- ---------------------------------------------------------------------------
-- `announcements` joins the notification preferences.
--
-- Every reader already treats a missing key as true (prefOn in SettingsPanel,
-- wantsAnnouncements in lib/announcements, the merge onto DEFAULT_PREFERENCES
-- in the settings route), so this is not what makes the opt-out work. It is
-- what stops the column drifting from the TypeScript type that now declares
-- the key required.
--
-- Same shape as 0034 and 0083: update the DEFAULT for new rows, then merge the
-- key into existing ones. `||` is a merge, not a replace, so an existing
-- explicit false on any other stream survives untouched.
-- ---------------------------------------------------------------------------
alter table public.customers
  alter column notification_preferences set default
    '{"new_lead": true, "credit_warnings": true, "inactivity_nudge": true,
      "progress_report": true, "monthly_insights": true, "announcements": true}'::jsonb;

update public.customers
   set notification_preferences =
       notification_preferences || '{"announcements": true}'::jsonb
 where not (notification_preferences ? 'announcements');
