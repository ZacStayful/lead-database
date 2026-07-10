# Stayful Lead Database — System & Feature Map

> Purpose of this file: give Claude (and anyone writing Claude Code prompts) a
> precise mental model of **what exists today**, **how the pieces integrate**,
> and **which business rules must not break** — so changes land in the right
> place and don't quietly violate an invariant. When you add or change a
> feature, update the relevant section here.

---

## 1. What this product is

A **vertically integrated lead subscription platform** for Stayful, a UK
short-term-rental (STR) property management company. Stayful generates more
landlord enquiries than it can service, and sells the surplus to other operators
on a monthly subscription. There are **two independent lead products**, each with
its own subscription, price, balance, Monday board, and sales pipeline:

| Product | What the buyer gets | Price / allocation | Monday board | Lead price* |
| --- | --- | --- | --- | --- |
| **Management** (`management`) | Landlord enquiries for STR management | £150/10 leads or £300/20 leads | `18420117742` | £15 |
| **Guaranteed Rent** (`guaranteed_rent`, "GR") | Rent-to-rent / guaranteed-rent leads | £100/10 leads | `18396542480` | £10 |

\* `price_paid` on the assignment — internal accounting, not what the buyer pays.

A single customer can hold **either or both** products. The two products are
tracked in **parallel columns** on the `customers` row (`lead_balance` vs
`gr_lead_balance`, `monthly_allocation` vs `gr_monthly_allocation`, etc.). Almost
every "how many leads left / who's next" decision branches on `lead_type`.

**Credit model:** each subscription payment tops up a running balance
(`lead_balance` / `gr_lead_balance`). Balance is the **sole allocation gate** —
leads are only assigned to customers with a positive balance, and each assignment
spends one credit. Unused credits **carry forward** automatically (never reset).
The monthly counter (`leads_received_this_month`) is a *pacing* signal only, and
resets on the customer's billing-anchor day.

---

## 2. Stack & where things live

- **Framework:** Next.js 14 (App Router, RSC + client components) · **Hosting:** Vercel
- **DB / auth / realtime / storage:** Supabase (Postgres + RLS + Realtime + Storage)
- **Payments:** Stripe (subscriptions, Checkout, billing portal, webhooks)
- **Lead ingestion:** n8n webhook + a scheduled Monday.com pull-sync (Vercel Cron)
- **Email:** Resend · **Excel export:** SheetJS (`xlsx`) · **Charts:** Recharts
- **Contact verification:** Twilio Lookup v2 + ZeroBounce
- **UI:** Tailwind + shadcn/ui, brand green `#5D8156`

```
src/
  app/
    page.tsx                     Management marketing landing
    guaranteed-rent/page.tsx     GR marketing landing
    enquiry/page.tsx             Waitlist entry form (management funnel)
    signup/ login/ …             Auth + owner-override signup
    feedback/ waitlisted/        Feedback form, waitlist confirmation
    dashboard/                   Customer portal (see §6)
    admin/                       Admin console (see §7, gated by role=admin)
    api/                         All server routes (see §5 + §8)
  components/
    dashboard/                   LeadCard, LeadFeed, LeadDetail, notes/files, etc.
                                 leadStatus.ts + pipelineStage.ts = the vocabularies
    admin/                       Customer table/form, capacity panel, sync buttons
    landing/                     Recharts (BucketChart, RevenueChart)
    ui/                          shadcn primitives
  lib/
    ingest.ts                    ⭐ Lead ingest + assignment orchestration
    monday.ts                    Monday GraphQL (fetch mgmt/GR leads, push enquiry)
    pacing.ts                    Deficit-first pacing maths (mirrors the SQL)
    plans.ts                     Management plan table (10/20 leads) + Stripe price mapping
    emails.ts / emails/          Resend templates (new lead, low/exhausted credits, activation, feedback)
    validation/contactValidation.ts  Twilio + ZeroBounce verification for invalid_contact rejects
    owner.ts                     Owner-email allowlist (bypasses payment wall → admin account)
    leadOrder.ts                 Ordered assignment lists for prev/next + priority
    types.ts                     ⭐ Canonical TS types for every table
    supabase/                    server / client / admin (service-role) / middleware clients
supabase/
  schema.sql                     Consolidated setup (⚠ only reflects up to ~0012 — see §11)
  migrations/0001…0021           Source of truth for the current DB (⭐ read these, not schema.sql)
middleware.ts                    Protects /dashboard/* and /admin/*
vercel.json                      Two daily crons: /api/monday/sync + /api/monday/sync-gr at 09:00
```

---

## 3. Data model (canonical types in `src/lib/types.ts`)

- **`customers`** — one row per buyer. Management fields (`subscription_status`,
  `monthly_allocation`, `leads_received_this_month`, `lead_balance`,
  `billing_cycle_anchor`, `stripe_customer_id/subscription_id`) **mirrored** by GR
  fields (`gr_subscription_status`, `gr_monthly_allocation`,
  `gr_leads_received_this_month`, `gr_lead_balance`, `gr_billing_cycle_anchor`,
  `gr_stripe_subscription_id/price_id`, `gr_last_assignment_at`). Plus
  `account_status` (`waitlisted` → `invited` → `active` → `cancelled`),
  `is_active`, and enquiry-form fields (`website_url`, `properties_managed`).
- **`leads`** — the enquiry. Shared fields (`lead_name`, `address`, `phone`,
  `email`, `lead_profile`, `bedrooms`, `enquiry_date`), `lead_type`,
  `assignment_count`/`max_assignments` (default max 2), plus **GR-only** columns
  (`desired_rent`, `pmi_analysis`, `tenancy_agreement`, `sourcing_agreement`,
  `formula`, `last_contact`). Keyed on `monday_item_id` (unique → idempotency).
- **`lead_assignments`** — the customer↔lead join **and the mini-CRM record**.
  Two independent axes (see §4): `status` and `pipeline_stage`. Also `viewed_at`,
  `due_to_call_date`, `income_estimate`, `price_paid`, `rejection_reason`,
  `claim_denied`, `contact_validation_result`, `notification_sent`, `email_sent`.
  Unique `(lead_id, customer_id)`; a lead can be assigned to at most
  `max_assignments` customers.
- **`lead_notes`** — timestamped per-assignment contact history. Once a note
  exists, the lead can no longer be **discarded** (it's "claimed").
- **`lead_files`** — metadata for files in the private `lead-files` Storage
  bucket (path `<user_id>/<assignment_id>/<file>`, 25 MB cap).
- **`notifications`** — in-portal feed, drives realtime + the bell badge.
- **`payments`** — Stripe payment audit trail.
- **`system_settings`** — key/value; today just `max_active_customers` (capacity).
- **`stripe_events`** — webhook idempotency ledger (dedup on Stripe event id).

**Two Supabase clients recur everywhere:**
`createClient()` = cookie/session-scoped, subject to RLS (auth checks, customer
reads). `createAdminClient()` = **service role, bypasses RLS** — used by every
privileged write (webhooks, admin routes, ingest). RLS policies only gate the
browser anon client; all trusted mutations go through server routes on the
service role. Customers can never self-edit allocation, balances, price, or
billing flags — those columns have no browser-writable RLS policy.

---

## 4. The two status axes (⚠ common source of confusion)

A `lead_assignment` carries **two independent labels**. Don't conflate them.

- **`status`** (`src/components/dashboard/leadStatus.ts`) — the *relationship*
  outcome: `new` → `contacted` → `in_discussion` → `won` / `not_relevant` /
  `rejected`. Drives eligibility (only `new` can be rejected/discarded) and
  win-rate analytics.
- **`pipeline_stage`** (`src/components/dashboard/pipelineStage.ts`) — the
  *sales-process* stage, **and it branches by product**:
  - **Management** (6 stages): `cold` → `interested_in_the_future` →
    `web_meeting_booked` → `web_meeting_no_show` → `web_meeting_attended` →
    `abandoned`.
  - **Guaranteed Rent** (4 stages): `cold` → `viewing_booked` → `contract_sent`
    → `contract_signed`.
  - `stagesForLeadType(leadType)` picks the right set. Both sets are stored in
    the **same** `pipeline_stage` CHECK constraint on `lead_assignments`.

---

## 5. Integration flows (how the pieces actually connect)

### A. Lead ingestion → assignment (the core loop) — `src/lib/ingest.ts`
Two entry points feed **one shared, idempotent pipeline** (`ingestLead`):
1. **Real-time:** `POST /api/webhook/n8n` (Bearer `N8N_WEBHOOK_SECRET`) — n8n fires
   on Monday "item created". Strips the two banned GR columns, defaults
   `lead_type` to `management`.
2. **Scheduled pull:** `POST|GET /api/monday/sync` (management) and
   `/api/monday/sync-gr` (GR), both auth'd by admin session **or** `CRON_SECRET`
   bearer, run daily at 09:00 by Vercel Cron. They pull *sellable* leads from the
   respective Monday board (`fetchMondayLeads` / `fetchGuaranteedRentLeads`) and
   run each through `ingestLead`.

`ingestLead` then:
- **Idempotency:** skip if `monday_item_id` already ingested (also handles the
  unique-violation race).
- Insert the lead (`buildManagementInsert` / `buildGuaranteedRentInsert` — GR maps
  Monday column ids to columns; date columns coerced to ISO-or-null).
- Call **`get_next_customers_for_lead(lead_id, max, lead_type)`** — returns up to
  `max_assignments` eligible customers, **deficit-first** (see §5B).
- For each, call **`assign_lead_to_customer(lead_id, customer_id, price, lead_type)`**
  — atomic, row-locked: checks capacity + balance, inserts the assignment, spends
  one credit, bumps the monthly counter.
- `completeAssignment`: insert an in-portal `notification`, send the Resend
  new-lead email, set delivery flags. **Management only:** send low-credit (at 2
  remaining) / exhausted (at 0) threshold emails, keyed on `lead_balance`.

### B. Pacing / fairness — `src/lib/pacing.ts` + `get_next_customers_for_lead`
Eligibility = `is_active` AND `account_status='active'` AND subscription active
AND balance > 0 AND not already on this lead AND not excluded. Ordering is
**deficit-first** so customers behind pace get served first:
```
days_elapsed = clamp(today − billing_cycle_anchor, 0..30)
expected     = round((days_elapsed / 30) × monthly_allocation)
deficit      = expected − leads_received_this_month   (positive = behind)
```
Ties break on `last_assignment_at` (oldest first) then `created_at`. `pacing.ts`
mirrors this in TS (`computePacing` / `computeGrPacing`) for dashboard/admin copy —
**keep the two in sync**. `reset_monthly_counts()` (daily cron) zeroes each
customer's monthly counter on their own anchor day, for both products.

### C. Billing — Stripe webhook `POST /api/webhook/stripe`
Verified by Stripe signature; deduped via `stripe_events`. Routes each event to
the **management vs GR column set** by comparing the price id to
`STRIPE_GR_MONTHLY_PRICE_ID`:
- `customer.subscription.created/updated/deleted` → map status, set billing anchor.
  A cancelled **management** sub sets `account_status='cancelled'` (frees a capacity
  slot); GR cancellation never touches `account_status`.
- `invoice.paid` → **grant credit**: management `increment_lead_balance(+plan
  allocation)` and promote `invited → active` on first payment; GR
  `increment_gr_lead_balance(+10)`. Insert a `payments` row, re-anchor the cycle.
- `invoice.payment_failed` → `subscription_status='past_due'` + failed payment row.

### D. Waitlist / capacity system
Supply is capacity-limited so Stayful doesn't oversell leads. Single source of
truth: `system_settings.max_active_customers` (default 10). **Capacity is measured
by `count(account_status='active')`, independent of Stripe state.** Flow:
1. Prospect submits `/api/enquiry` → creates/refreshes a **`waitlisted`** customer
   row (no auth user yet) + pushes contact to the Monday enquiries board. Response
   `hasCapacity` decides whether the form shows the Calendly link or "you're on the
   list".
2. Admin clicks **"Invite to subscribe"** → `/api/admin/customers/[id]/invite`
   (re-checks capacity, **409 if full**): creates the Supabase auth user + Stripe
   customer + Checkout session + set-password link, sends the activation email,
   **then** flips to `invited` (slot consumed only after the email sends).
3. Customer pays → `invoice.paid` promotes `invited → active`. Expired link →
   **"Resend invitation"** (`/resend-invite`) regenerates without status change.

### E. Reject vs Discard (⚠ subtle business rules, changed several times)
- **Discard** (`/api/leads/[id]/discard`, `discard_lead_assignment`): only while
  `status='new'` and **no notes**. Deletes the assignment and reopens the slot for
  reassignment. **Does NOT refund** the credit/monthly counter — a discarded lead
  still counts toward the allocation.
- **Reject** (`/api/leads/[id]/reject`, `apply_lead_rejection`) needs a **reason**:
  - `not_a_fit` → status `rejected`, **chargeable, no refund, no replacement**
    (business rule from migration 0019: every delivered lead is chargeable).
  - `invalid_contact` → runs **live phone+email verification**
    (`resolveContactClaim`: Twilio Lookup + ZeroBounce, fail-safe to
    "favour customer"). Rate-limited to 10 claims/24h/customer. If **both contacts
    genuinely valid** → claim **denied**, lead stays assigned & chargeable.
    Otherwise → **refund** balance, roll back the monthly counter, reopen the slot,
    and **reassign** to the next eligible customer (notification + email).
    Idempotent via stored `rejection_reason`.

### F. Realtime, exports, storage
- **Supabase Realtime channels:** `lead-feed:{id}` (new assignment banner),
  `notifications:{id}` (bell badge), `notif-centre:{id}` (live notification list).
  Realtime still enforces RLS, so customers only receive their own rows.
- **Exports:** all-leads → **XLSX** (`/api/leads/export`, includes notes + price);
  analytics → **PDF** via browser print; GR company-let agreement → `.docx`
  download; lead files → **60-second signed-URL** redirect from the private bucket.

---

## 6. Customer portal — `src/app/dashboard/**`

Gated by `middleware.ts` + `getCurrentCustomer()`. Nav: Dashboard · Leads ·
Priority · Analytics · Notifications · Documents · Guide · Settings (+ Admin link
if `role=admin`). Header has a live `NotificationBell`; footer links to feedback.

- **Home** (`/dashboard`) — stat cards (subscription, leads remaining =
  `lead_balance`, unread new leads, next renewal). If the customer holds GR, a
  **"Leads by product"** split replaces the simple card (Management vs GR
  received/remaining). Pacing message. GR holders also see the company-let
  agreement. `LeadFeed` (realtime) at the bottom.
- **Leads** (`/dashboard/leads`, `LeadsList`) — search + status tabs; a
  **product filter appears only when the customer holds both types**. `ExportButton`.
- **Lead detail** (`/dashboard/leads/[id]`, `LeadDetail`) — contact/property
  details, inline-editable **pipeline stage** (branched by type), **due-to-call
  date**, **estimated monthly income** — each PATCHes
  `/api/customer/assignments/[id]`. Actions on `new`: mark contacted / reject /
  discard. GR leads get a "Run figures on this property" link to the STR Analyser
  (`intelligence.stayful.co.uk`). Notes + files sections. ←/→ keyboard nav follows
  the list you came from (`leadOrder.ts`).
- **Priority** (`/dashboard/leads/priority`) — call list: excludes won/not_relevant,
  sorts by `due_to_call_date` (overdue first) then enquiry date.
- **Notifications** — marks unread read on open, live-appends new ones.
- **Analytics** — status funnel, management pipeline funnel, estimated-income
  totals (in-pipeline / won / all), activity counts. Print → PDF.
- **Documents** — **GR-gated**: company-let agreement + FAQ + `.docx` download
  when `gr_subscription_status='active'`, otherwise locked.
- **Guide** — help page that adapts to products held (management/GR/both).
- **Settings** — plan (derived from `monthly_allocation` via `plans.ts`),
  usage, **"Manage billing"** → Stripe billing portal (`/api/billing/portal`).

The **`LeadCard`** (feed/list/priority) shows both badges, a "Call {date}" badge,
a **lead-type badge (Management = green, GR = blue)**, and income. Expanding marks
the lead viewed.

---

## 7. Admin console — `src/app/admin/**` (role `app_metadata.role='admin'`)

Gated in `admin/layout.tsx` (non-admins → `/dashboard`). `isAdminUser` reads
`app_metadata` only (browsers can't edit it). Several admin routes also accept an
`x-admin-key: ADMIN_SECRET_KEY` header for programmatic use.

- **Overview** — MRR, active customers, leads sent this month, leads awaiting
  assignment; `CapacityPanel` (active/limit, edit `max_active_customers`,
  waitlisted count).
- **Customers** — `AdminCustomersTable` with account-status tabs
  (All/Active/Waitlisted/Invited) **and** product tabs (All/Management/GR/Both);
  row actions **Invite** / **Resend invitation**. "Potential supply problem" banner
  when active customers are far behind pace.
- **Customer detail** — `AdminCustomerForm` (edit management + GR allocations,
  balances, active flags — the manual credit levers) + a GR subscription card.
- **Leads** — list with recipients + type + assignment count; **two**
  `SyncMondayButton`s (management + GR pull-sync).
- **Lead detail** — set `max_assignments` (1–4) and **force-assign** to a
  product-appropriate customer (`/api/admin/assign` → `assign_lead_to_customer` +
  `completeAssignment`).

---

## 8. API route inventory (`src/app/api/**`)

| Route | Method | Auth | Purpose |
| --- | --- | --- | --- |
| `webhook/n8n` | POST | Bearer `N8N_WEBHOOK_SECRET` | Real-time lead ingest |
| `webhook/stripe` | POST | Stripe signature | Subscriptions, credit top-up, dedup |
| `monday/sync` · `monday/sync-gr` | POST/GET | admin **or** `CRON_SECRET` | Daily pull-sync (mgmt / GR) |
| `enquiry` | POST | public | Waitlist entry + Monday enquiries push |
| `signup` | POST | public | Owner→admin bypass; else 403→`/enquiry` |
| `feedback` | POST | public | Emails the team |
| `billing/portal` | POST | customer | Stripe billing portal session |
| `leads/export` | GET | customer | XLSX of own leads + notes |
| `leads/[id]/reject` · `discard` | POST | customer (owns it) | Reject (reason) / discard |
| `customer/assignments/[id]` | PATCH | customer | viewed/contacted/stage/due date/income |
| `customer/notes` | POST | customer | Add note |
| `customer/files` · `[id]` · `[id]/download` | POST/DELETE/GET | customer | File metadata + signed download |
| `admin/assign` | POST | admin | Force-assign |
| `admin/leads/[id]` | PATCH | admin | Set `max_assignments` |
| `admin/customers/[id]/allocation` | POST | admin | Edit allocations/balances/flags |
| `admin/customers/[id]/invite` · `resend-invite` | POST | admin key **or** admin | Activation flow |
| `admin/settings/capacity` | POST | admin key **or** admin | Set `max_active_customers` |

---

## 9. Business rules & invariants (don't break these)

1. **Balance is the allocation gate**, not the monthly counter. Assignment
   requires `(gr_)lead_balance > 0` and spends exactly one credit atomically.
2. **Credits carry forward; monthly counters reset on the anchor day.** Never
   reset `lead_balance`.
3. **A lead goes to at most `max_assignments` customers** (default 2). Enforced by
   the row-locked `assign_lead_to_customer`.
4. **Every delivered lead is chargeable** — except a confirmed/unverifiable
   `invalid_contact` reject, which refunds and reassigns. `not_a_fit` and discard
   do **not** refund.
5. **Ingestion is idempotent** on `monday_item_id`; Stripe handling is idempotent
   on `stripe_events`.
6. **Management and GR are fully parallel.** Any balance/counter/pacing/pricing
   logic must branch on `lead_type` and touch only that product's columns.
7. **All privileged writes go through server routes on the service role.**
   Customers can't self-edit allocation, balances, price, or billing flags.
8. **Capacity = `count(account_status='active')`** vs `max_active_customers`;
   a slot is consumed at `invited` and released on management cancellation.

---

## 10. Environment variables

Supabase (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`) · Stripe (`STRIPE_SECRET_KEY`,
`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`,
`STRIPE_MONTHLY_PRICE_ID`/`STRIPE_PRICE_ID_20`, `STRIPE_PRICE_ID_10`,
`STRIPE_GR_MONTHLY_PRICE_ID`) · Monday (`MONDAY_API_TOKEN`, board ids
`MONDAY_LEAD_BOARD_ID`, `MONDAY_GR_LEAD_BOARD_ID`, `MONDAY_ENQUIRY_BOARD_ID`,
optional `MONDAY_GR_SELLABLE_STATUS`) · `N8N_WEBHOOK_SECRET` · contact
verification (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `ZEROBOUNCE_API_KEY`) ·
Resend (`RESEND_API_KEY`, `RESEND_FROM_EMAIL`) · App (`NEXT_PUBLIC_APP_URL`,
`ADMIN_SECRET_KEY`, `OWNER_EMAILS`, `CRON_SECRET`). See `.env.example` for notes.

---

## 11. Gotchas & known asymmetries (worth a prompt if you touch them)

- **`supabase/schema.sql` is stale** — it only reflects migrations up to ~0012.
  The **migrations `0001`→`0021` are the source of truth** for the live DB (GR
  expansion, reject-reason/contact-validation, Stripe idempotency, etc.). If you
  change the schema, add a new numbered migration; regenerating the consolidated
  `schema.sql` is a separate task.
- **`pacing.ts` duplicates the SQL** in `get_next_customers_for_lead`. Change both
  together or the dashboard/admin copy drifts from actual ordering.
- **The `pipeline_stage` PATCH validation** (`/api/customer/assignments/[id]`) and
  the **analytics pipeline funnel** currently validate/enumerate **only the
  management stages** — GR-specific stages (`viewing_booked`, `contract_sent`,
  `contract_signed`) aren't in those two spots even though the UI offers them.
  Verify this when working on GR pipeline features.
- **`README.md` predates the GR product and most portal features** — treat this
  file (`CLAUDE.md`) as the current map; README is the historical MVP write-up.
- **Owner override** (`OWNER_EMAILS`, default `zac@stayful.co.uk`) skips the
  payment wall and provisions an active **admin** account with both products — used
  for previewing GR surfaces without a live subscription.

---

## 12. Writing prompts against this codebase

- **Name the layer.** Changes usually live in one of: a **migration + SQL function**
  (assignment/pacing/reject logic), **`src/lib/ingest.ts`** (ingest/assignment
  orchestration), an **API route** (`src/app/api/**`), or a **portal/admin
  component**. Point Claude at the layer.
- **Say which product.** "management", "guaranteed rent", or both — and expect
  parallel columns/branches.
- **Respect the invariants in §9.** If a request seems to violate one (e.g.
  "refund the credit when they reject"), call it out — the current rule may be
  deliberate (see migration 0019/0021 history).
- **Schema changes = new numbered migration** under `supabase/migrations/`, mirror
  any pacing maths into `pacing.ts`, and update this file.
```
