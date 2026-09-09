-- ---------------------------------------------------------------------------
-- 0133 — Every support request and feature request, logged (§46).
--
-- WHY THIS EXISTS
-- ---------------
-- Two in-app forms have been collecting customer requests since launch and
-- neither has ever persisted anything. /api/feedback (public, works signed out)
-- and /api/support (signed-in) both validate, attach the customer, send one
-- email through Resend and forget. There is no table, no admin screen, and no
-- way to answer "how many requests have we had", "who is asking", or "which of
-- these did we actually ship".
--
-- Worse, a Resend failure returns 502 and LOSES THE SUBMISSION OUTRIGHT. The
-- customer is told to try again and nothing anywhere records that they asked.
--
-- The gap costs more than tidiness. A customer who writes in is a customer
-- using the product, so tickets are the clearest engagement signal the business
-- has — and the history proves it. Leslie Rogers sent three support requests in
-- eleven days and has since cancelled. Marcus Chong sent three feature requests
-- and two of them became shipped features (§30 customer-owned leads, §37
-- operator branding). None of that was visible anywhere.
--
-- ⚠️ NOTES LIVE IN THEIR OWN TABLE, AND THAT IS THE BOUNDARY. Tickets are
-- customer-visible from §46 onward, and both the admin and the customer read
-- run on the SERVICE ROLE — so RLS protects nothing here and the boundary has
-- to be structural. What keeps an admin's working notes away from the customer
-- is that the customer query names a fixed column list on ONE table and never
-- mentions the other. As a jsonb column on the ticket, a single select("*") —
-- which getCurrentCustomer() already does on customers, and which every
-- dashboard page therefore trains you to write — would ship them. §32.8 is the
-- precedent: stripping a field at the page boundary is a presentation control,
-- not a security boundary.
--
-- ⚠️ plan_snapshot IS COMPUTED WITH holdsProduct(), NEVER FROM account_status.
-- Two of the nine backfilled tickets belong to GR-only customers, who sit at
-- account_status = 'waitlisted' for ever (§18A) — so a snapshot taken from that
-- column files two paying subscribers as unconverted prospects. Karey Summers
-- and Emanuela Sharra are both that shape, which makes this the one column
-- where the bug would have shipped rather than been theorised about.
--
-- Additive: two tables, one identity sequence, nine backfilled rows. No
-- existing object is redefined, and nothing here touches a balance, counter,
-- pacing or capacity column. Inert until the code reads it.
--
-- ⚠️ Apply to production BEFORE the pull request merges (§1.1) — not at merge.
-- A Vercel preview of the branch runs against PRODUCTION Supabase, so the admin
-- page would render against a missing table; §30 records what that costs, where
-- fetchLeadVolumeData swallowed the error and quoted zero filter volume.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1 — The tickets.
--
-- One row per request, whatever door it came through. RLS on with no policies:
-- deny-all to the browser, as subscription_pauses, operator_proof_snapshots and
-- reset_rate_windows. Both reads go through the service role (§8).
--
-- ⚠️ reference IS THIS REPO'S FIRST IDENTITY COLUMN. Every other table is
-- uuid-keyed and stays that way. It earns itself because a ticket is now
-- customer-visible and gets replied to by email, and "your ticket
-- 0a712500-850a-…" is not something anybody puts in a subject line. The STF-
-- formatting lives in TypeScript, not here — the §43.2 discipline of keeping
-- presentation out of the schema so it tunes without a migration.
--
-- ⚠️ submitted_at IS SEPARATE FROM created_at, deliberately — §21's "always two
-- numbers, never one". created_at is when we wrote the row; submitted_at is
-- when the customer actually asked. On the nine backfilled rows those differ by
-- up to five weeks, and on a phone call logged the next morning they differ by
-- a night. EVERY LIST ORDERS ON submitted_at.
-- ---------------------------------------------------------------------------
create table if not exists public.support_tickets (
  id                      uuid        primary key default gen_random_uuid(),
  reference               bigint      generated always as identity,
  source                  text        not null,
  kind                    text        not null,
  status                  text        not null default 'open',
  channel                 text        not null default 'in_app',
  customer_id             uuid        references public.customers(id) on delete set null,
  submitter_name          text        not null,
  submitter_email         text        not null,
  submitter_business      text,
  subject                 text        not null,
  body                    text        not null,
  page                    text,
  product                 text,
  plan_snapshot           text,
  visible_to_customer     boolean     not null default false,
  shipped_migration       text,
  shipped_claude_section  text,
  submitted_at            timestamptz not null default now(),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  resolved_at             timestamptz,
  backfill_key            text
);

create unique index if not exists support_tickets_reference_idx
  on public.support_tickets (reference);

-- Non-null on exactly the nine rows reconstructed from the inbox, NULL on every
-- ticket the running system creates. Postgres allows many nulls under a unique
-- index — the same argument 0102 made for leads.monday_item_id. It is both the
-- backfill's idempotency claim and its provenance marker: a reader who finds a
-- ticket with no matching form submission needs to know it was rebuilt.
create unique index if not exists support_tickets_backfill_key_idx
  on public.support_tickets (backfill_key)
  where backfill_key is not null;

alter table public.support_tickets drop constraint if exists support_tickets_source_check;
alter table public.support_tickets add constraint support_tickets_source_check
  check (source in ('feedback_form', 'support_form', 'admin'));

alter table public.support_tickets drop constraint if exists support_tickets_kind_check;
alter table public.support_tickets add constraint support_tickets_kind_check
  check (kind in ('support', 'feature', 'bug'));

alter table public.support_tickets drop constraint if exists support_tickets_status_check;
alter table public.support_tickets add constraint support_tickets_status_check
  check (status in ('open', 'in_progress', 'done', 'wont_do'));

alter table public.support_tickets drop constraint if exists support_tickets_channel_check;
alter table public.support_tickets add constraint support_tickets_channel_check
  check (channel in ('in_app', 'email', 'whatsapp', 'phone'));

-- Nullable means the request is platform-wide and belongs to neither product.
-- Forcing every ticket into one of the two would put "add dark mode" under
-- Management and make the per-product counts a worse answer than no answer.
alter table public.support_tickets drop constraint if exists support_tickets_product_check;
alter table public.support_tickets add constraint support_tickets_product_check
  check (product is null or product in ('management', 'guaranteed_rent'));

-- ⚠️ Length caps are not cosmetic. /api/feedback is PUBLIC and unauthenticated
-- and caps nothing today, so persisting without these turns it into an
-- unbounded public database write. The floor of 1 on the nullable columns is
-- the 0130/0131 idiom: '' must never be able to mean "set, but empty".
alter table public.support_tickets drop constraint if exists support_tickets_lengths_check;
alter table public.support_tickets add constraint support_tickets_lengths_check
  check (
        length(btrim(submitter_name))  between 1 and 120
    and length(btrim(submitter_email)) between 1 and 200
    and length(btrim(subject))         between 1 and 200
    and length(btrim(body))            between 1 and 10000
    and (submitter_business is null or length(btrim(submitter_business)) between 1 and 200)
    and (page               is null or length(btrim(page))               between 1 and 80)
    and (plan_snapshot      is null or length(btrim(plan_snapshot))      between 1 and 120)
    and (backfill_key       is null or length(btrim(backfill_key))       between 1 and 120)
  );

-- ⚠️ The migration number is a filename and machine-checkable, so it gets a
-- regex — and the regex needs the trailing-letter branch, because 0100a exists
-- (§36.8, worked_conversion, committed out of sequence). The CLAUDE.md section
-- ref deliberately gets only a length cap: those refs HAVE ALREADY DRIFTED —
-- the subsections under §22 are numbered 21.x — so a regex over them would be
-- confidently wrong about a file that is already inconsistent.
alter table public.support_tickets drop constraint if exists support_tickets_shipped_check;
alter table public.support_tickets add constraint support_tickets_shipped_check
  check (
        (shipped_migration      is null or shipped_migration ~ '^[0-9]{4}[a-z]?$')
    and (shipped_claude_section is null or length(btrim(shipped_claude_section)) between 1 and 40)
  );

-- The admin list, which is ordered by submitted_at within a status filter.
create index if not exists support_tickets_status_submitted_idx
  on public.support_tickets (status, submitted_at desc);

-- The customer's own list, and the per-customer counts on the admin page.
create index if not exists support_tickets_customer_idx
  on public.support_tickets (customer_id, submitted_at desc)
  where customer_id is not null;

comment on table public.support_tickets is
  'One row per support request or feature request, from either in-app form or '
  'logged by hand. Written before the notification email is sent, so a Resend '
  'failure no longer loses the submission. See CLAUDE.md §46.';

comment on column public.support_tickets.reference is
  'Human reference, the repo''s only identity column. Rendered as STF-0007 in '
  'TypeScript so the formatting tunes without a migration.';

comment on column public.support_tickets.source is
  'Which door it came through. feedback_form and support_form are the two '
  'in-app forms; admin is one logged by hand.';

comment on column public.support_tickets.channel is
  'How the customer actually reached us. in_app for the forms; email, whatsapp '
  'or phone for a hand-logged ticket.';

comment on column public.support_tickets.customer_id is
  'Nullable, and on delete set null rather than cascade: the feedback form is '
  'public and works signed out, and a ticket is not meaningless without its '
  'customer — submitter_email, subject, body and plan_snapshot all stand alone. '
  'A null customer_id is structurally unreachable by the customer read, which '
  'filters .eq("customer_id", <uuid>).';

comment on column public.support_tickets.visible_to_customer is
  '⚠️ DEFAULTS FALSE SO A FORGETFUL WRITER FAILS CLOSED. Set true by the shared '
  'helper for the two in-app forms, because a form ticket is the customer''s own '
  'words and showing them back is honest. A hand-logged ticket is the ADMIN''s '
  'words about a conversation — "sounds like she is about to churn" must never '
  'render in her dashboard — so sharing one is a deliberate second act.';

comment on column public.support_tickets.product is
  'Which service the REQUEST concerns, admin-settable. Null means platform-wide. '
  'Distinct from plan_snapshot, which is what the customer was paying for.';

comment on column public.support_tickets.plan_snapshot is
  '⚠️ Computed with holdsProduct(), NEVER from account_status — a GR-only '
  'subscriber is waitlisted for ever (§18A) and would be filed as a prospect. '
  'Written once at submission and never read for logic: it is what they were '
  'paying WHEN THEY ASKED, which is not recoverable later. Leslie Rogers is '
  'cancelled today, so her row now says nothing about the three tickets she '
  'raised while paying.';

comment on column public.support_tickets.submitted_at is
  'When the customer asked, which is not when we wrote the row. Every list '
  'orders on this.';

comment on column public.support_tickets.resolved_at is
  'Cleared on a return to open or in_progress. Deliberately UNLIKE '
  'cancelled_at (first cancellation wins, §3) and pool_first_entered_at '
  '(stamped once, never cleared, §19): a ticket legitimately round-trips, and a '
  'stale resolved date printed beside an open ticket is a lie the list renders.';

comment on column public.support_tickets.backfill_key is
  'Non-null on exactly the nine tickets reconstructed from the inbox in this '
  'migration; null on everything the running system writes. Both the '
  'idempotency claim and the provenance marker.';


-- ---------------------------------------------------------------------------
-- 2 — The log book.
--
-- Append-only, and enforced by the ABSENCE OF A ROUTE rather than by a trigger
-- — the lead_events posture (§3). No PATCH and no DELETE handler is exported,
-- so Next answers 405 for free. Editing a note is editing the record of what we
-- decided, which is the one thing a log book must not allow.
--
-- Cascade here, where the ticket's own FK is set null. A note about a deleted
-- ticket is meaningless; a ticket about a deleted customer is not. The two are
-- deliberately different and must not be "tidied" into agreement.
-- ---------------------------------------------------------------------------
create table if not exists public.support_ticket_notes (
  id            uuid        primary key default gen_random_uuid(),
  ticket_id     uuid        not null references public.support_tickets(id) on delete cascade,
  body          text        not null,
  author_email  text,
  created_at    timestamptz not null default now()
);

alter table public.support_ticket_notes drop constraint if exists support_ticket_notes_lengths_check;
alter table public.support_ticket_notes add constraint support_ticket_notes_lengths_check
  check (
        length(btrim(body)) between 1 and 5000
    and (author_email is null or length(btrim(author_email)) between 1 and 200)
  );

create index if not exists support_ticket_notes_ticket_idx
  on public.support_ticket_notes (ticket_id, created_at);

comment on table public.support_ticket_notes is
  '⚠️ ADMIN-ONLY WORKING NOTES, AND A SEPARATE TABLE IS WHAT KEEPS THEM THAT '
  'WAY. Both reads run on the service role, so RLS is not the boundary here — '
  'the boundary is that the customer query names a fixed column list on '
  'support_tickets and never mentions this table. As a jsonb column, one '
  'select("*") would ship them. Append-only: no update or delete route exists.';

comment on column public.support_ticket_notes.author_email is
  'Taken from the admin session, never from the request body.';


-- ---------------------------------------------------------------------------
-- 3 — Deny-all to the browser.
-- ---------------------------------------------------------------------------
alter table public.support_tickets      enable row level security;
alter table public.support_ticket_notes enable row level security;


-- ---------------------------------------------------------------------------
-- 4 — The nine tickets that already happened.
--
-- Reconstructed from the [Support] and [Feature request] emails in the team
-- inbox, which until now were the only record any of these ever existed. Six
-- support requests and three feature requests, from five customers, between
-- 2026-08-04 and 2026-09-08.
--
-- ⚠️ ZERO BUG REPORTS IN THE ENTIRE HISTORY. Recorded here because it is only
-- knowable before the table starts accumulating, and it is a finding either
-- way: the product is solid, or nobody can find the bug form.
--
-- ⚠️ NEVER A BARE `values` LIST. A scratch Postgres built from 0001 has no
-- customers, so nine hardcoded FK values would fail the migration on every
-- fresh build. Each insert is a `select … from customers where id = …`, which
-- inserts ZERO rows on an empty database and does not error.
--
-- ⚠️ THE CUSTOMER ID COMES FROM THE EMAIL'S OWN "Account on file" BLOCK, NOT
-- FROM MATCHING THE SUBMITTER ADDRESS. Emily Kitts wrote from
-- info@thehostingedit.co.uk while her account is emily@thehostingedit.co.uk;
-- matching on the address she wrote from lands on 0a712500-…, the ARCHIVED
-- duplicate (§18D), rather than 22a61faf-…, the live paying row. That is the
-- §43 trap — a customer's login address and the address they write from are
-- different facts — and it is why submitter_email and customer_id are separate
-- columns rather than one.
--
-- Ordered by submitted_at ascending, so the identity column assigns references
-- 1–9 chronologically and STF-0001 is the oldest ticket. (A second apply
-- inserts nothing but still advances the sequence, so later tickets may start
-- above 10. Cosmetic; the nine keep their numbers.)
--
-- resolved_at is left NULL on the seven closed rows even though we know they
-- were answered. We do not know WHEN — the reply dates in the threads are when
-- Zac wrote back, not when the ask was settled, and for the two that became
-- features the settling date is a release weeks later. A fabricated timestamp
-- is worse than a missing one, so the admin list says "date unknown" instead.
--
-- shipped_migration / shipped_claude_section are filled in ONLY where the link
-- is certain. Where a request was answered across several migrations the
-- section is recorded and the migration left null, and where the honest answer
-- is "answered by email" both are null. A confident wrong reference is worse
-- than none, because the next session follows it.
-- ---------------------------------------------------------------------------

insert into public.support_tickets (
  source, kind, status, channel, customer_id, submitter_name, submitter_email,
  submitter_business, subject, body, product, plan_snapshot,
  visible_to_customer, submitted_at, shipped_migration, shipped_claude_section,
  backfill_key)
select 'support_form', 'support', 'done', 'in_app', c.id,
       'Emily Kitts', 'info@thehostingedit.co.uk', 'The Hosting Edit',
       'Help Please!',
       $body$I had a good call with one of the leads, I am just figuring out how to use the analysis, presentation ect. I would love to know if I am doing this right before I jump on a call with her again to talk through the presentation. Thank you, Emily$body$,
       'management', 'Management £150/10', true,
       timestamptz '2026-08-04T10:16:18Z', null, null,
       'inbox-2026-08-04-hostingedit-help'
  from public.customers c where c.id = '22a61faf-a4ee-4bad-951c-3ff64138c337'
on conflict do nothing;

insert into public.support_tickets (
  source, kind, status, channel, customer_id, submitter_name, submitter_email,
  submitter_business, subject, body, product, plan_snapshot,
  visible_to_customer, submitted_at, shipped_migration, shipped_claude_section,
  backfill_key)
select 'support_form', 'support', 'done', 'in_app', c.id,
       'Leslie Rogers', 'lesliebrogers@gmail.com', 'Leslie Rogers',
       'Change my email',
       $body$The purchase process used the personal email associated to my Apple Pay account. Please can I change my email? Leslie@homelyshortstays.com$body$,
       'management', 'Management £150/10', true,
       timestamptz '2026-08-08T13:29:42Z', null, '§43.3',
       'inbox-2026-08-08-lesliebrogers-change-email'
  from public.customers c where c.id = '38290f65-19cf-4f0c-9679-123a8d5d73e8'
on conflict do nothing;

insert into public.support_tickets (
  source, kind, status, channel, customer_id, submitter_name, submitter_email,
  submitter_business, subject, body, product, plan_snapshot,
  visible_to_customer, submitted_at, shipped_migration, shipped_claude_section,
  backfill_key)
select 'support_form', 'support', 'done', 'in_app', c.id,
       'Leslie Rogers', 'lesliebrogers@gmail.com', 'Leslie Rogers',
       'How are they qualified?',
       $body$1. If I remember correctly, Zac said each lead is already qualified by running some numbers. What numbers were run? Can you share the results? 2. A link to the STR analyser is on each lead. But it's just to the blank analyser page. Is the intention that we sign up to this? I see there are 5 free runs. Do we get more or is this a funnel to another paid-for service?$body$,
       'management', 'Management £150/10', true,
       timestamptz '2026-08-10T08:57:21Z', null, '§25',
       'inbox-2026-08-10-lesliebrogers-qualified'
  from public.customers c where c.id = '38290f65-19cf-4f0c-9679-123a8d5d73e8'
on conflict do nothing;

insert into public.support_tickets (
  source, kind, status, channel, customer_id, submitter_name, submitter_email,
  submitter_business, subject, body, product, plan_snapshot,
  visible_to_customer, submitted_at, shipped_migration, shipped_claude_section,
  backfill_key)
select 'support_form', 'support', 'done', 'in_app', c.id,
       'Karey Summers', 'karey@humberstoneproperty.co.uk', 'Karey Summers',
       'leads',
       $body$Good Morning, I have now received 10 leads so it says none are remaining however several are not within the filtered area I have set and another couple are duplicates so they have come through twice. Does this man I won't have access to any further leads this month? Thanks Karey$body$,
       'guaranteed_rent', 'Guaranteed Rent £150/10', true,
       timestamptz '2026-08-11T09:43:08Z', null, '§28',
       'inbox-2026-08-11-humberstone-leads'
  from public.customers c where c.id = '96006833-dc2a-433f-80ad-0ec92299c420'
on conflict do nothing;

insert into public.support_tickets (
  source, kind, status, channel, customer_id, submitter_name, submitter_email,
  submitter_business, subject, body, product, plan_snapshot,
  visible_to_customer, submitted_at, shipped_migration, shipped_claude_section,
  backfill_key)
select 'support_form', 'support', 'done', 'in_app', c.id,
       'Leslie Rogers', 'lesliebrogers@gmail.com', 'Leslie Rogers',
       'How are leads qualified?',
       $body$Zac mentioned something about the leads being ones that work financially. But I've come across one that definitely does not. What's the methodology used to qualify them?$body$,
       'management', 'Management £150/10', true,
       timestamptz '2026-08-18T22:44:56Z', null, '§25',
       'inbox-2026-08-18-lesliebrogers-qualified'
  from public.customers c where c.id = '38290f65-19cf-4f0c-9679-123a8d5d73e8'
on conflict do nothing;

insert into public.support_tickets (
  source, kind, status, channel, customer_id, submitter_name, submitter_email,
  submitter_business, subject, body, product, plan_snapshot,
  visible_to_customer, submitted_at, shipped_migration, shipped_claude_section,
  backfill_key)
select 'feedback_form', 'feature', 'done', 'in_app', c.id,
       'Marcus Chong', 'unityspaceproperty@gmail.com', 'Marcus Chong',
       'Add our own leads to track them in pipeline',
       $body$Add our own leads to track them in pipeline in order to have all leads in one place and be able to keep using the service long term.$body$,
       'management', 'Management £300/20', true,
       timestamptz '2026-08-24T16:23:25Z', '0102', '§30',
       'inbox-2026-08-24-unityspace-own-leads'
  from public.customers c where c.id = 'b613ae8d-ae77-4d9f-90ec-4daeaa3ae3c7'
on conflict do nothing;

-- product is NULL here on purpose: branding applies to both products (§37 opens
-- it to management and GR alike), so filing it under one would be wrong. This
-- is the row that demonstrates why the column is nullable.
insert into public.support_tickets (
  source, kind, status, channel, customer_id, submitter_name, submitter_email,
  submitter_business, subject, body, product, plan_snapshot,
  visible_to_customer, submitted_at, shipped_migration, shipped_claude_section,
  backfill_key)
select 'feedback_form', 'feature', 'done', 'in_app', c.id,
       'Marcus Chong', 'unityspaceproperty@gmail.com', 'Unity Stays',
       'Customizable Branding',
       $body$It would be helpful if the branding used across generated presentations and analysis reports could be customised for each company. This should include the ability to add the company's name, logo, brand colours and contact details, with the option to display "Affiliated with Stayful" alongside the company's branding. Ideally, these branding settings would be configured once at company or account level and then automatically applied to all presentations, reports and analysis outputs. This would allow us to produce professional, client-facing materials that reflect our own brand while retaining the connection to Stayful.$body$,
       null, 'Management £300/20', true,
       timestamptz '2026-08-25T22:06:24Z', '0112', '§37',
       'inbox-2026-08-25-unityspace-branding'
  from public.customers c where c.id = 'b613ae8d-ae77-4d9f-90ec-4daeaa3ae3c7'
on conflict do nothing;

insert into public.support_tickets (
  source, kind, status, channel, customer_id, submitter_name, submitter_email,
  submitter_business, subject, body, product, plan_snapshot,
  visible_to_customer, submitted_at, shipped_migration, shipped_claude_section,
  backfill_key)
select 'support_form', 'support', 'open', 'in_app', c.id,
       'Emanuela Sharra', 'emanuelasharra@yahoo.co.uk', 'Emanuela Sharra',
       'help to get more information for the leads sent to me .',
       $body$I need help with the leads you sent to me before I can make the call$body$,
       'guaranteed_rent', 'Guaranteed Rent £150/10', true,
       timestamptz '2026-09-07T12:47:09Z', null, null,
       'inbox-2026-09-07-emanuelasharra-lead-info'
  from public.customers c where c.id = '21c54ddf-8df8-4129-a09f-0d90074b4a58'
on conflict do nothing;

insert into public.support_tickets (
  source, kind, status, channel, customer_id, submitter_name, submitter_email,
  submitter_business, subject, body, product, plan_snapshot,
  visible_to_customer, submitted_at, shipped_migration, shipped_claude_section,
  backfill_key)
select 'feedback_form', 'feature', 'open', 'in_app', c.id,
       'Marcus Chong', 'unityspaceproperty@gmail.com', 'Unity Space Property Ltd',
       'Connect approved landlord leads to the Stayful analyser',
       $body$Hi Stayful team, We receive verified landlord enquiries through our company inbox and Make workflow. We would like a controlled integration where: 1. A human clicks Approve or Decline. 2. Approve creates the lead in Stayful with the available contact and property details. 3. The approved lead's details trigger the Short-Term Rental Property Analyser. 4. The analysis can feed the lead's income presentation. 5. Any outbound presentation remains behind a final human Send/Present action. We can see the REST API and MCP access in the dashboard, but they appear read-only, and the analyser appears separate from the Lead Database. Do you provide an API write scope, MCP write tool, webhook, or supported Make/n8n integration for this workflow? Account: Marcus Chong, Unity Space Property Ltd. Login email: unityspaceproperty@gmail.com Thanks, Marcus$body$,
       'management', 'Management £300/20', true,
       timestamptz '2026-09-08T23:55:31Z', null, null,
       'inbox-2026-09-08-unityspace-analyser-integration'
  from public.customers c where c.id = 'b613ae8d-ae77-4d9f-90ec-4daeaa3ae3c7'
on conflict do nothing;


-- ---------------------------------------------------------------------------
-- 5 — Seed the log book where the answer is not obvious from the ticket.
--
-- These are the rows that make the backfill worth doing rather than just
-- counting. A future session picking up STF-0009 needs to know it is being
-- asked for the one thing §27.1 forbids; picking up STF-0007 needs to know the
-- feature shipped PARTIALLY. Neither fact is recoverable from the ticket body.
--
-- Idempotent on "this ticket has no notes yet", which is true only at apply
-- time — the backfill is the sole writer here.
-- ---------------------------------------------------------------------------
insert into public.support_ticket_notes (ticket_id, body, author_email)
select t.id, n.body, 'zac@stayful.co.uk'
  from public.support_tickets t
  join (values
    ('inbox-2026-08-04-hostingedit-help',
     $note$Answered by email the same morning: the figures come from the property analysis (§25) and the walk-through deck is the presentation tool (§26). No code change was needed. Worth noting she wrote from info@thehostingedit.co.uk while her account is emily@thehostingedit.co.uk — matching on the address she wrote from lands on the archived duplicate row (§18D).$note$),

    ('inbox-2026-08-10-lesliebrogers-qualified',
     $note$Two questions in one ticket: what qualification is actually run, and what the STR analyser link on each lead is for. The first was answered by shipping gross income figures onto every management lead (§25). The second is the customer-paid analyser (§31). See also the near-identical ticket from the same customer on 2026-08-18.$note$),

    ('inbox-2026-08-11-humberstone-leads',
     $note$Three separate complaints in one ticket: leads outside her filter, duplicate landlords, and whether a filter caps the monthly allocation. Duplicates are §18 (0070); the filter/allocation relationship became the volume forecast (§28) and the mid-cycle filter release (§39). Answered by email at the time.$note$),

    ('inbox-2026-08-18-lesliebrogers-qualified',
     $note$⚠️ THE SAME QUESTION AS THE 2026-08-10 TICKET FROM THE SAME CUSTOMER, THREE WEEKS APART. Two identical asks is a documentation gap wearing a support ticket's clothes — the answer existed and she could not find it. She cancelled on 2026-09-08, three weeks after this. Both tickets were raised while she was paying.$note$),

    ('inbox-2026-08-25-unityspace-branding',
     $note$⚠️ SHIPPED PARTIALLY. §37 (0112) delivered the operator's logo, accent colour and derived palette across the PRESENTATION. It did NOT rebrand the analysis PDF, did not carry contact details through, and did not add the "Affiliated with Stayful" mark he asked for. The reply on file promised the logo and hex colours, which is exactly what landed — so the promise was kept and the request was not fully met. Closing it as done is the honest reading only alongside this note.$note$),

    ('inbox-2026-09-07-emanuelasharra-lead-info',
     $note$Open. Zac replied on 2026-09-09 asking what specifically she is stuck on and has had no answer yet. NOT the same incident as §43 — that was her being locked out of the account on 2026-09-02/03, the week before, and it is closed. This ticket is about needing more on a lead before ringing the landlord.$note$),

    ('inbox-2026-09-08-unityspace-analyser-integration',
     $note$⚠️ DO NOT BUILD THIS WITHOUT REVISITING §27.1. The ask is for an API write scope, an MCP write tool, a webhook, or a Make/n8n integration that creates a lead and triggers the analyser. §27.1's standing rule is that the public surface is READ-ONLY in every direction and that no tool may take a query, a table name, a column list, a file path or an arbitrary filter — and a lead-creating write endpoint is precisely the shape that rule exists to refuse. Answering this is a product decision about that rule, not an addition to it. Note that the pieces already exist internally: customers can add their own leads (§30) and pay to analyse them (§31), so the gap is the automated door, not the capability.$note$)
  ) as n(backfill_key, body) on n.backfill_key = t.backfill_key
 where not exists (
   select 1 from public.support_ticket_notes existing where existing.ticket_id = t.id
 );
