# CLAUDE.md — Stayful Lead Marketplace

Working notes for anyone (human or agent) changing this codebase. It describes
what the system **actually does**, not what it was once intended to do.

This file was authored during the engagement/telemetry/benchmarking programme
(migrations 0043–0048). Earlier phases of the project referred to a CLAUDE.md
that did not exist in the repository; sections are numbered to match those
references where they were used.

---

## 1. What this is

A marketplace that sells pre-screened landlord enquiries ("leads") to property
operators on monthly subscriptions. Two independent products:

| Product | Column prefix | Price/lead | Typical plan |
|---|---|---|---|
| **Management** | *(none)* | £15 | £150/mo for 10, £300/mo for 20 |
| **Guaranteed Rent** | `gr_` | £15 | £150/mo for 10, £300/mo for 20 |

Both products are two-plan and both price at £15 a lead, so `LEAD_PRICE_GBP`
needs no per-plan branch. Plan tables live in `plans.ts` (`PLANS` / `GR_PLANS`);
each plan names the env var holding its Stripe price id.

Next.js 14 (App Router) · Supabase (Postgres + Auth) · Stripe · Resend · Vercel.
Leads originate in Monday.com and arrive via n8n webhooks or a scheduled sync.

**Production runs from `main`**, deployed by Vercel to `leads.stayful.co.uk`.
The Supabase project is `znlfwbnvhlacwzgfalcf` ("Lead database").

---

## 2. Scheduled jobs (`vercel.json`)

| Path | Schedule | Purpose |
|---|---|---|
| `/api/monday/sync` | `0 9 * * *` | Pull + ingest management leads |
| `/api/monday/sync-gr` | `0 9 * * *` | Same, guaranteed rent |
| `/api/cron/generate-public-stats` | `0 3 * * *` | Landing-page activity figures |
| `/api/cron/inactivity-nudge` | `0 10 * * 1` | Mondays: leads awaiting follow-up |
| `/api/cron/reclaim-stale-leads` | `0 11 * * *` | Soft reclaim (0046) |
| `/api/cron/progress-report` | `0 16 * * 5` | Fridays: weekly summary |
| `/api/cron/resume-paused-subscriptions` | `0 8 * * *` | Un-pause on schedule |

`/api/cron/post-call-offer-reminders` exists but has **no `vercel.json` entry**
— removed in `173a746` when the plan was Hobby (daily-cron cap). The account is
now on Pro. The route needs ~15-minute cadence to hit its 12h/4h/1h windows and
is currently driven by nothing. See §12.

**Cron auth pattern** — copy this exactly for new jobs:

```ts
const auth = request.headers.get("authorization");
const cronSecret = process.env.CRON_SECRET;
const viaCron = Boolean(cronSecret) && auth === `Bearer ${cronSecret}`;
if (!viaCron) { /* fall back to an admin session check */ }
```

`Boolean(cronSecret)` matters: it fails closed when the var is unset.
Export both `GET` (Vercel Cron issues a GET) and `POST`.

---

## 3. Core tables

### `customers`
Parallel column sets per product. `lead_balance` / `gr_lead_balance` are the
**allocation gate**; `monthly_allocation` drives pacing; `leads_received_this_month`
is a pacing counter only. `account_status`, `paused_at`, `subscription_status`
are **management-only** — the Stripe webhook deliberately leaves them untouched
on a GR cancellation, so they must never gate GR behaviour.

Also: `notification_preferences` (jsonb, 0034), `sms_alerts_enabled`,
`last_nudge_sent_at`, `last_report_sent_at`, lead-filtering columns (0026),
pause columns (0038), goal columns (0051 — see §13).

### `leads`
`assignment_count` / `max_assignments` (**default 3** since 0055, was 2) cap
ordinary assignment. The default applies to newly ingested leads only — leads
ingested before 0055 keep the 2 they were created with, so a lead's reach is
whatever its own row says, never a global constant. `DEFAULT_MAX_ASSIGNMENTS`
in `types.ts` mirrors the DB default and is only a null fallback.
`lead_type` selects the product. Idempotent on `monday_item_id`.

### `lead_assignments`
One row per (lead, customer). Carries `price_paid`, `status`, `pipeline_stage`,
`viewed_at`, `first_contacted_at` (0033), `last_status_change_at` (0035),
`reclaimed_at` + `is_reclaimed` (0043).

`status` ∈ `new, contacted, in_discussion, won, not_relevant, rejected`.
`pipeline_stage` ∈ 10 values (0010/0015/0050). Independent of status in general,
with two deliberate couplings: moving off `cold` sets `contacted` (§6), and
reaching a terminal winning stage sets `won` (§6A).

### `lead_events` *(0043, 0044)*
Append-only passive telemetry. **The engagement basis for everything.**

```
id · assignment_id (FK, cascade) · event_type · created_at · metadata
```

`event_type` ∈ `detail_opened, tel_click, mailto_click, note_added,
file_added, stage_changed, nudge_sent`.

- The first three are **operator-generated** — the only ones that mean
  engagement. `src/lib/types.ts` exports `ENGAGEMENT_EVENT_TYPES`.
- `nudge_sent` is **system-generated**. Any aggregate meaning "operator
  activity" must filter to the operator types explicitly; counting rows would
  let our own nudges inflate the score of the least engaged customers.
- **No browser insert policy.** Writes go through `POST /api/customer/events`
  on the service role. These events influence who receives a reclaimed lead, so
  a directly-insertable table would let a customer manufacture engagement.

Other tables: `notifications`, `payments`, `lead_notes`, `lead_files`,
`stripe_events`, `system_settings`, `post_call_offers`, `lead_topup_tokens`,
`testimonials`, `public_activity_stats`.

---

## 4. Assignment path

`ingestLead()` → `autoAssignLead()` → two-pool candidate selection
(`get_filtered_candidates_for_lead` + `get_unfiltered_candidates_for_lead`,
deficit-first with a guarantee-floor override) → `assign_lead_to_customer`.

`autoAssignLead()` requests only `max_assignments − assignment_count` and is
safe to call repeatedly. This is why leads bank up harmlessly when everyone is
at quota: each daily sync re-offers them, and they place as cycles reset or new
customers onboard. **Banked leads are inventory, not a backlog.**

`assign_lead_to_customer` is the single money path: it locks lead + customer,
checks capacity, checks the per-product balance gate (and `paused_at` for
management), inserts, increments `assignment_count`, spends one credit and bumps
the monthly counter — atomically.

---

## 5. Reject and discard

| | Reject | Discard |
|---|---|---|
| Eligibility | `pipeline_stage = 'cold'` and status not `won`/`rejected` | `status = 'new'` **and** no notes |
| Effect | `status → 'rejected'`; stage frozen (§6A) | Row deleted, `assignment_count − 1` |
| Refund | **None** — still chargeable (0019) | None |
| Replacement | None | Lead returns to the pool |

### §5E — Reject eligibility changed in 0043

It used to gate on `status = 'new'`. Once status started flipping automatically
(§6), that rule locked an operator out of passing on a lead they had merely
rung. `pipeline_stage = 'cold'` is the honest test of "nothing has been built on
this lead yet". Terminal statuses stay barred so a signed lead cannot lose its
conversion record.

The API route runs **no pre-flight check** — eligibility lives entirely in
`reject_lead_assignment`, so route and function cannot disagree.

⚠️ Consequence: clicking a landlord's phone number auto-flips status to
`contacted`, which makes the lead **undiscardable** (discard still requires
`status = 'new'`). Reject covers the case; discard does not. Unresolved.

---

## 6. Automatic contacted flip *(0043)*

`mark_assignment_contacted()` sets `status = 'contacted'` when there is real
evidence of work. Four triggers call it: a note added, a file added,
`pipeline_stage` moved off `cold`, or a `tel_click` event.

- Idempotent via a `status = 'new'` predicate — first trigger wins, rest no-op.
- Stamps `first_contacted_at` with `coalesce` (first touch wins permanently) and
  **`last_status_change_at`**, which the nudge and progress-report crons read.
- Never touches `pipeline_stage`, `viewed_at`, balances or counters.
- `detail_opened` and `mailto_click` record but do **not** flip: reading a lead
  is not contacting it, and a mailto click guarantees nothing was sent.

**Recursion guard:** the `lead_assignments` trigger is `AFTER UPDATE OF
pipeline_stage`, and the flip never writes that column, so it cannot re-arm
itself. The `WHEN` clause and status predicate are a second stop.

### §6A — Automatic won flip *(0050)*

Management gained a terminal `won` stage; GR already had `contract_signed`.
Reaching either sets `status = 'won'` via `mark_assignment_won()`, on the same
`AFTER UPDATE OF pipeline_stage` pattern and with the same recursion guard.

Not cosmetic: the ROI funnel, the win-rate figure and the signed celebration all
count `status = 'won'`, so a stage that were purely a label would let an operator
mark a lead Won and have it register as a conversion nowhere. Both routes to a
win — the "Mark as signed" button and the dropdown — end in the same place.

`status = 'rejected'` is skipped. Reject is a settled, chargeable outcome (0019)
and must not be silently converted into a win.

**A rejected lead is settled and cannot be moved back into a working state.**
`PATCH /api/customer/assignments/[id]` refuses `contacted`, `signed` and
`pipeline_stage` with a 400, in **one guard** rather than field by field —
`contacted` was originally missed, and it is the laundering step: flipping
status off `rejected` unlocks the other two, which each refuse a rejected lead
directly. `viewed_at` / `due_to_call_date` / `income_estimate` stay allowed;
they are private record-keeping that changes no outcome. `LeadDetail` renders
the stage badge read-only to match.

Scoped to that one assignment: the same lead may sit with another operator as a
separate row with its own status, and one customer's rejection must not freeze
anybody else's pipeline.

Product stage lists are enforced in the application (`stagesForLeadType`), not in
the CHECK constraint — the column has always accepted the union of both products'
stages and narrowing it would reject existing GR rows.

---

## 7. Soft reclaim *(0046)*

After **three UK working days** with no `detail_opened` / `tel_click` /
`mailto_click` / note / file, a lead is offered to one further operator at a
reduced price (£10 management, £7 GR — **pounds**, matching `price_paid`).

The original assignment is untouched: same status, same `price_paid`, **no
refund**, no counter rollback, no data withdrawn. Once per lead ever. Only leads
assigned after `system_settings.reclaim_enabled_from`.

### §9.3 — `max_assignments` is NOT incremented

Capacity is `max_assignments + lead_open_reclaim_slots(lead_id)`, where the slot
count is **derived** (granted − consumed), not stored.

This matters. `ingest.ts` and `/api/admin/leads/assign-pending` both auto-fill
any gap between `assignment_count` and `max_assignments`, at the **standard
price through normal routing**. Incrementing the cap would hand the reclaimed
slot away within 24 hours, bypassing the discount and every reclaim rule. Normal
routing computes its shortfall from `max_assignments` alone and is therefore
structurally blind to the extra slot.

`admin_assign_lead` still checks `max_assignments` alone, so an admin
force-assign cannot consume a slot the cron is about to use.

A failed recipient search leaves `reclaimed_at` **unset**, so a lead never burns
its single reclaim on a day when nobody had credit.

---

## 8. Routes

**Customer:** `/api/customer/events` (telemetry),
`/api/customer/assignments/[id]` (PATCH), `/api/customer/notes`,
`/api/customer/files`, `/api/customer/settings`,
`/api/customer/settings/notifications`, `/api/customer/goal` (§13),
`/api/customer/subscribe` (§17), `/api/leads/[id]/reject`,
`/api/leads/[id]/discard`, `/api/leads/export`, `/api/billing/portal`.

`/api/customer/goal` is the **only** customer route with no admin client at
all — it calls a `SECURITY DEFINER` RPC on the session client. Everything else
here authenticates on the session client and then writes on the service role.

**Unauthenticated:** `/api/auth/forgot-password` (POST) — password reset. No
session by definition; see §15 for why it exists at all.

**Admin:** `/api/admin/assign`, `/api/admin/assign/bulk`,
`/api/admin/leads/[id]`, `/api/admin/leads/assign-pending`,
`/api/admin/customers/[id]/*`, `/api/admin/settings/capacity`,
`/api/admin/post-call-offer`.

**Webhooks / cron:** `/api/webhook/stripe`, `/api/webhook/n8n`,
`/api/monday/sync`, `/api/monday/sync-gr`, `/api/cron/*` (§2).

---

## 9. Invariants — do not break

1. `(gr_)lead_balance` is the allocation gate; assignment spends exactly one
   credit atomically.
2. Credits carry forward; monthly counters reset on the anchor day.
3. A lead reaches at most `max_assignments` customers **through ordinary
   routing**. Soft reclaim adds a derived slot invisible to that path (§7).
4. Every delivered lead is chargeable. Reject does not refund.
5. Ingest is idempotent on `monday_item_id`; Stripe on `stripe_events`.
6. Management and GR are fully parallel. Every balance/counter/pacing/eligibility
   branch must handle both `lead_type` values — and must not use a
   management-only column (`account_status`, `paused_at`,
   `subscription_status`) to gate GR.
7. All privileged writes go through server routes on the service role. The two
   `SECURITY DEFINER` functions `authenticated` may call are
   `get_engagement_benchmarks()` (§10) and `set_management_customer_goal()`
   (§13). Both take no id and resolve identity from `auth.uid()` internally.
8. Subscriber capacity is **per product and weighted** (§16). Management sums
   `monthly_allocation` over `account_status = 'active'` against
   `max_active_customers`; GR sums `gr_monthly_allocation` over
   `gr_subscription_status = 'active'` against `gr_max_active_customers`. The
   GR side must never read `account_status` (see 6).
9. `management_lifetime_leads_received` only ever counts **up**. It is neither
   the allocation gate nor a pacing counter (§13).
10. **No code path may ask Supabase to send an email.** Links are minted with
    `generateLink` and delivered through Resend (§15).

---

## 10. Engagement scoring and benchmarks *(0047, 0048)*

**`get_customer_engagement_scores(lead_type, customer_ids?)`** — service-role
only. Rolling 30 days. Open rate and contact-attempt rate, weighted 0.35/0.65.
All tunables live in `engagement_score_params()`.

Wired into **reclaim recipient selection only**. Ordinary allocation remains
purely deficit-first, and `get_next_customers_for_lead` is unmodified.

Customers with <30 days history or <5 assignments in the window receive the
**cohort median**, not a low score — otherwise every new subscriber is punished
for being new with no way to earn out of it.

**`get_engagement_benchmarks()`** — callable by `authenticated`. Security design:

- **Takes no parameters.** Nothing to tamper with.
- Identity from `auth.uid()` **inside** the function.
- Returns **aggregates only**: `lead_type, metric, own_value, own_sample,
  cohort_median, cohort_top_quartile, cohort_size, suppressed`. No column can
  carry another customer's data.
- Cohort figures withheld unless ≥5 **other** customers have ≥10 assignments in
  the 90-day window.
- Suppressed entirely while `lead_events` is empty, so launch does not render
  "You: 0%, Typical operator: 0%" for everyone.
- Win rate excluded — self-reported, so it measures record-keeping.
- `top_quartile` is the **good** quartile in both directions: 75th for rates,
  25th for hours-to-first-attempt.

---

## 11. Known issues and gotchas

- ~~**`pipeline_stage` validation is management-only.**~~ **Fixed (0050 branch).**
  `PATCH /api/customer/assignments/[id]` validated every lead against
  `PIPELINE_STAGES`, so a GR customer setting any of their own stages got a 400;
  the analytics funnel had the mirror fault and rendered their pipeline card as
  permanent zeros. Both now resolve the lead's product and use
  `stagesForLeadType()` / `GR_PIPELINE_STAGES`. The analytics half was then
  taken further — see §14. (An earlier draft of this entry claimed
  `GR_PIPELINE_STAGES` / `stagesForLeadType()` "are not imported"; that was
  wrong when written — `LeadDetail.tsx` and the guide page both used them.)
- **`viewed_at` ≠ telemetry.** `viewed_at` is set *only* by expanding a lead
  card in the feed. Opening `/dashboard/leads/[id]` does not set it, so a lead
  read end-to-end via a direct link leaves it null forever. `detail_opened` is
  the honest "this lead was read" signal. Never treat them as equivalent.
- ~~**`get_next_customers_for_lead` is executable by `anon`.**~~ **Fixed in
  0049.** `0028` blanket-revoked schema-wide, then `0038` dropped and recreated
  the function, which discards its ACL. Re-revoked. Any future
  `create or replace` on a privileged function must re-assert its grants.
- **Orphaned reject columns.** `rejection_reason`, `contact_validation_result`,
  `claim_denied` exist on `lead_assignments` in production but in **no
  migration** and no code — left by an abandoned branch. Do not reference them;
  a schema rebuilt from `supabase/migrations/` will not have them.
- **`supabase/schema.sql`** is stale. Migrations are the source of truth.
- **Admin shows "3 / 2 assigned"** on a reclaimed lead. Truthful, looks odd; the
  Reclaim history block on the lead detail page explains it.
- No ESLint config (`next lint` prompts interactively) and **no test suite**.

---

## 12. Deferred

- Drive `/api/cron/post-call-offer-reminders` (no scheduler; table is empty so
  nothing has been missed yet).
- Decide whether discard should gate on notes only (§5E).
- Decide whether a rejected lead should be reclaimable (currently excluded).
- Decide whether Goals should get a GR equivalent (§13 — deliberately none).
- Backfill accuracy: `management_lifetime_leads_received` cannot count leads
  that were delivered and later **discarded**, because discard deletes the row
  (§13). Only fixable by recording deliveries somewhere discard does not touch.

---

## 13. Goals *(0051, 0052)* — management only

A subscriber states how many signed management clients they want out of the
marketplace. `/dashboard/goals`, gated on `subscription_status = 'active'`.

Three columns on `customers`, all management-only, **no `gr_` mirror** — the
conversion model, price and sales cycle all differ, so a GR version is a
separate decision, not a symmetry obligation.

| Column | Meaning |
|---|---|
| `management_customer_goal` | Target signed clients. `NULL` = no goal set, which is **not** the same as 0 (a `CHECK` forbids 0). |
| `management_customer_goal_updated_at` | Last set/cleared. |
| `management_lifetime_leads_received` | Delivery odometer. |

### The odometer is a third counter — do not confuse it

`leads_received_this_month` resets on the anchor day; `lead_balance` is spent
and topped up. Neither can answer "how many leads has this customer ever had".
The odometer is monotonic: never reset, never decremented, and it gates
nothing. Reject and discard touch no customer counters, so it cannot wind back.

Both delivery paths bump it on the **management branch only**:
`assign_lead_to_customer` (inside the existing customer `UPDATE`, so it can
never disagree with the monthly counter) and `admin_assign_lead` (which writes
its own `UPDATE` rather than calling the former). Reclaimed leads count — they
route through `assign_lead_to_customer` — because the number means "leads
received and workable", not "leads paid full price for".

**0052 backfills it** from `lead_assignments` joined to management leads.
Without that, an existing customer saw "3 of 5 won" above "leads received so
far: 0" on one screen. The backfill uses `greatest()` so it is idempotent and
can never make the odometer go backwards; it **understates** history by any
discarded leads, which lengthens the estimate rather than shortening it.

### Won count vs pipeline estimate

**Won clients is the goal** — `status = 'won'` on management assignments, and
the only thing that decides whether the goal is met. The **pipeline estimate**
(`goal × 20` leads, months at `monthly_allocation`) is a model shown as
supporting context. Someone who signs five from forty has met a goal of five.
Never let the estimate gate the achieved state.

### `set_management_customer_goal(p_goal)`

The one customer-settable field in the schema. `customers` has a single
`SELECT` policy and no write policy, so this is exposed without weakening
that: no customer-id parameter, identity from `auth.uid()` inside the
function, exactly two columns written by name, and it **raises** (never
silently no-ops) for a missing row or a customer without an active management
subscription.

Gate on `subscription_status`, **not** `monthly_allocation`: the latter is
nullable but never actually null (DB default 20, and every creation path sets
it), so gating on it would admit every customer including the GR-only ones the
gate exists to exclude. Also not `holdsTopupProduct()`, which ORs
`account_status` in and is deliberately looser.

---

## 14. Analytics is split by product

`/dashboard/analytics` previously counted both products together: one funnel,
one win rate, `PIPELINE_STAGES` only. That was wrong for both products — GR
runs a viewing-to-contract pipeline — and its "Won" figure disagreed with the
Goals page, which has always been management-only.

Each held product now gets its own block (stats, status funnel, pipeline via
`stagesForLeadType()`, income, activity). Notes and files stay account-level:
they hang off an assignment, not a product. A product is shown when the
customer holds it **or** has ever received one of its leads, so a cancelled
subscription does not hide the history it produced.

---

## 15. Email transport — Resend only, never Supabase's mailer

Every customer-facing email goes out through **Resend**. Supabase's built-in
auth mailer is a shared test relay capped at roughly **two emails per hour for
the whole project**, so it cannot be used for anything real.

The pattern, used by `/api/auth/forgot-password`, the invite and resend-invite
routes, and `provisioning.ts`:

1. `admin.auth.admin.generateLink({ type: "recovery", email })` — mints the
   token and **sends nothing**.
2. Build `/auth/confirm?token_hash=<hashed_token>&type=recovery&next=…`.
3. Send that URL yourself via Resend.

Use the **token hash**, not `properties.action_link`. The raw action link uses
the PKCE `?code` flow, which needs a code-verifier cookie belonging to the
browser that started the flow. A link minted server-side never has one, so it
breaks the ordinary case of requesting on a laptop and opening on a phone.
`/auth/confirm` calls `verifyOtp`, which needs no verifier and works
cross-device.

### Why this section exists

`/forgot-password` originally called `supabase.auth.resetPasswordForEmail()`
from the browser, which is the one thing that reaches Supabase's mailer. Four
reset attempts in an evening exhausted the project quota, and every further
attempt — by any customer, on any flow — returned
`429: email rate limit exceeded`. One customer sat locked out of an active
paid account for a week because of it.

It read as fixed several times because the Resend integration works fine and
was repeatedly confirmed working. **Supabase auth email is configured
separately from Resend** (Dashboard → Authentication → SMTP Settings) and no
amount of Resend work touches it. That disconnect is the whole trap.

Two distinct 429s come back from `/recover`, and they mean different things:

| Error | Scope | Meaning |
|---|---|---|
| `For security purposes, you can only request this after N seconds` | Per user | Normal cooldown, harmless |
| `email rate limit exceeded` | **Project-wide** | Quota gone; everyone is locked out |

Only the second is a real fault. Never collapse them into one "wait an hour"
message — it sends the customer away for an hour when the wait may be seconds,
and it hides a project-wide outage behind what looks like a personal limit.

**Still worth doing:** configure custom SMTP in the Supabase dashboard as
defence in depth, so that if any future code path does reach the auth mailer it
is not on a 2/hour test sender. Nothing in the app depends on it today.

The reset route's abuse throttle is a per-instance in-memory map, so it is
best-effort across serverless instances. Swap it for a durable store if the
endpoint is ever actually abused.

---

## 16. Subscriber capacity is per product *(0054)*

`/admin` shows two capacity panels. They are independent numbers over
independent populations, and `src/lib/capacity.ts` is the only place either is
derived.

| | Management | Guaranteed Rent |
|---|---|---|
| Setting key | `max_active_customers` | `gr_max_active_customers` |
| Population | `account_status = 'active'` | `gr_subscription_status = 'active'` |
| Weight | `monthly_allocation / 20` | `gr_monthly_allocation / 10` |
| Default cap | 10 | 10 |

**The slot unit differs on purpose.** Management sells 10- and 20-lead plans, so
a 20-lead customer is one slot and a 10-lead customer half — the cap is a bound
on committed lead volume, not on heads. GR's unit is 10, so a standard £150/10
GR subscriber is exactly one slot. That is what makes a cap of 10 read as "10
guaranteed rent customers", which is how it was set.

⚠️ Since the £300/20 GR plan, a 20-lead GR subscriber consumes **two** GR slots.
That is the correct reading of a cap on committed lead volume and needs no code
change — `grCapacityWeight` derives it — but it does mean the GR cap no longer
reads as a headcount. Nothing gates on the GR cap (below), so this is a
reporting nuance today, not a behaviour change.

**The GR side must not read `account_status`.** It is management-only (§3): the
Stripe webhook leaves it untouched on a GR cancellation, so it would keep
counting departed GR subscribers *and* count management-only customers who never
held GR. `gr_subscription_status` is the GR population, full stop.

`POST /api/admin/settings/capacity` takes `{ capacity, product? }`, `product`
defaulting to `management` so older callers are unaffected. It resolves the key
through `capacitySettingKey()` — a request can never name a key the reader does
not know — and upserts, because an `update` against an unseeded key matches zero
rows and still reports success.

### What the GR cap does and does not do

It is **reporting and admin judgement only**. Nothing gates on it yet. Signup
deliberately does not capacity-check GR (`/api/signup`: "no capacity gate — GR
has its own allocation"), so a GR sale can still take the panel past its limit
and the panel will show that honestly, in red. Management is unchanged: it still
gates signup and warns on invite.

Making GR waitlist at the cap is a real behaviour change — a paid product would
start refusing checkout — and is a separate decision. See §12.

---

## 17. The Packages tab and self-serve cross-sell *(no migration)*

`/dashboard/packages` shows the customer which lead package they hold and
explains the one they don't, with a Stripe Checkout button for it.

**Why the description matters as much as the button.** Management and
Guaranteed Rent sell to different businesses — a management operator earns an
ongoing fee, a rent-to-rent operator earns the margin between the rent they pay
and what the property makes. "10 more leads a month" is meaningless to somebody
who does not already run the other model, so `PRODUCT_COPY` in
`src/lib/products.ts` carries three fields the card leads with: what a lead of
that type **is**, how it was **qualified**, and how the operator **makes money**
from it. Price comes last.

`holdsProduct()` is per product and reads only that product's columns, for the
usual reason (invariant 6): management from `account_status` /
`subscription_status`, GR from `gr_subscription_status`. `past_due` counts as
held — that is a billing problem to fix in the portal, not a thing to buy twice.

### `POST /api/customer/subscribe` is not a reopening of signup

`/api/signup` refuses every non-owner with "please enquire via our contact
form". Self-serve **acquisition** stays retired. This route only ever serves an
authenticated customer **who already holds the other product** — vetted,
paying, already on a Stripe customer record. Two guards keep it that way:

1. Identity comes from the session, never the body.
2. A customer holding **neither** product is refused (403). Those are the
   waitlisted accounts, and checkout here would be a way to jump the queue.
   They still see the descriptions; the call to action is support.

**Nothing in the route grants a product.** The Stripe webhook does that, routing
by price id: `invoice.paid` credits the leads and promotes `account_status` out
of `invited`/`waitlisted`. So a self-serve buyer lands in exactly the same state
as an admin-invited one, and an abandoned checkout changes nothing.

**Management is capacity-gated here, GR is not** — the same asymmetry as signup
(§16). The check is a headcount against `max_active_customers`, deliberately
copied from `/api/signup` rather than using the weighted helper, so the cap
means the same thing however a customer arrives. See the §16 note: those two
readings of the same setting still disagree.

### The one trap: the allocation column must be set before checkout

`invoice.paid` credits `planForAllocation(customer.monthly_allocation).leads`,
**not** the plan the invoice was actually for. A customer buying the £150/10
plan on a row still carrying the default 20 would be credited 20 leads a month,
every month, silently. The route therefore writes `monthly_allocation` from the
chosen plan **before** creating the session, putting the row in the same shape
an admin invite produces so the webhook needs no special case. Abandoning
checkout leaves the column inert — it gates nothing for a customer who does not
hold management.

An `allocationFromPrices()` helper already exists in the webhook and would fix
this at source, but it is only used for post-call-offer labelling; switching the
credit onto it would silently re-size any hand-edited allocation that disagrees
with its price, so it was left alone.

**The same trap applies to GR**, in the opposite direction. `gr_monthly_allocation`
defaults to **10**, so a £300/20 GR buyer left on the default is credited *half*
what they pay for. Both GR checkout paths (`/api/customer/subscribe` and the GR
branch of `/api/signup`) now write it before creating the session, and
`customer.subscription.created` sets it from the price id as a backstop —
creation only, so it can never undo an admin's hand-edit on a later `updated`
event. On a genuine disagreement the webhook credits the **row** and logs a
"GR allocation drift" error; the row stays the source of truth.

### GR price ids are the product router

### GR Payment Links and `gr_stripe_customer_id` *(0056)*

A GR Stripe **Payment Link** mints its own Stripe customer for the payer. That
broke the one Stripe field the two products still shared: `stripe_customer_id`.
An existing management subscriber buying GR through a link would have their
`stripe_customer_id` repointed at the new GR customer by `invoice.paid`
provisioning, detaching their **management** subscription from every future
webhook lookup — and management's own provisioning would repoint it back on its
next renewal, the two products fighting over one column indefinitely.

`gr_stripe_customer_id` (0056) is the GR half. **Reads match either column**
(`customerMatchFilter()` in the webhook); **only GR writers set the gr_ column**,
and the GR path never writes `stripe_customer_id`. Nothing is backfilled: a null
`gr_stripe_customer_id` means "GR bills against the shared customer", which is
what every pre-Payment-Link GR subscription does.

`invoice.paid` on a GR invoice for an unknown Stripe customer now **provisions**
the account (row + login + set-password email) exactly as the management branch
does, instead of logging and bailing. Bailing was survivable while GR had no
public purchase path; with a Payment Link it is a silent "took the money,
delivered no leads". GR provisioning writes **no** management column, so a GR-only
buyer never comes out looking like an active management subscriber (invariant 6).

`isGuaranteedRentPriceId()` in `plans.ts` decides, for **every** Stripe webhook
event, whether it belongs to GR or management. It matches against every price id
in `GR_PLANS`, so **each GR plan's price id must be in env**. This was an
equality test against the single `STRIPE_GR_MONTHLY_PRICE_ID` while GR had one
plan; a second GR price would have fallen through to the management branch and
credited management leads for a GR invoice, set `account_status = 'cancelled'`
on a GR cancellation, and marked management `past_due` on a failed GR payment —
invariant 6, breached three ways from one missing env var.

It fails **open to management** by design: an unknown price is treated as
management so a management Payment Link referencing a price object that is not
in env keeps working (the reason `allocationFromPrices` has a subtotal
fallback). That is exactly why a missing GR price id is dangerous rather than
merely broken — set it before the product goes on sale.

---

## 18. Onboarding a customer onto a product *(no migration)*

`POST /api/admin/customers/[id]/invite` takes `{ product? }`, defaulting to
`management` so older callers are unaffected (the same shape as the capacity
route, §16). The admin table offers the two invites as separate buttons.

**Until this existed there was no in-app way to onboard a GR customer at all.**
The route always billed `stripePriceIdFor(monthly_allocation)` — a *management*
price — and `/api/signup` is retired for non-owners while
`/api/customer/subscribe` (§17) requires already holding the other product. The
only way to sell GR was a hand-made Stripe Payment Link, which is what made the
mis-provisioning in §17 possible in the first place.

Each product bills off its **own** allocation column: `grPlanForAllocation` /
`stripeGrPriceIdFor` from `gr_monthly_allocation`, management from
`monthly_allocation`. Reading the management column for a GR invite would sell a
20-lead management customer the £300 GR plan by accident.

### A GR invite must not touch `account_status`

`waitlisted` / `invited` / `active` are **management** states (§3, invariant 6),
and the GR half of the Stripe webhook deliberately never writes `account_status`.
So the GR path:

- **does not** gate on `account_status = 'waitlisted'` — it refuses only when the
  customer already holds GR (`holdsProduct`). That admits both a waitlisted
  prospect and an existing management subscriber adding the second product.
- **does not** set `account_status = 'invited'` on success. A GR invitee stays
  exactly as they were until payment sets `gr_subscription_status = 'active'` —
  the one state GR routing and GR capacity actually read.
- weighs capacity against the **GR** cap via `getProductCapacityStatus(product)`.
  Charging a GR invite against the management panel is how a GR sale consumed a
  management slot.

The end state for a GR-only customer is `account_status = 'waitlisted'` with
`gr_subscription_status = 'active'`. They hold no management product, so every
management gate excludes them and every GR gate admits them.

### 18A — Admin must not read a GR customer through management columns

That end state is correct in the database and actively misleading on screen. A
GR-only subscriber has `account_status = 'waitlisted'`, `subscription_status =
'inactive'`, `lead_balance = 0` and no `stripe_subscription_id` — so every admin
surface reading those columns reported an active paying customer as an
unconverted prospect with no credits, and the first real GR subscriber was
effectively invisible. Each now resolves per product:

| Surface | Was | Now |
|---|---|---|
| Overview MRR | management subs only | management **+** GR, summed per product, split shown |
| Overview "Active customers" | `subscription_status = 'active'` | active on **either** product |
| Overview waitlist count | every `waitlisted` row | excludes GR holders (not queuing for management) |
| Customers tab / badge | `account_status` | `effectiveStatus()` — holding GR reads as active |
| Customers billing / credits / pacing | management columns | one line per held product |
| Bulk assigner pool | `account_status = 'active'` | holders of either product |
| Lead override pool | `account_status = 'active'` | holders of either product |

MRR sums **per product, not per customer**: the two subscriptions are
independent, so a customer holding both contributes both fees, and the
per-product counts in the hint deliberately add up to more than the customer
count. The GR side keys on `gr_stripe_subscription_id` — the management
subscription id says nothing about whether GR is billed, and a comped account has
neither.

Neither `assign_lead_to_customer` nor `admin_assign_lead` gates on
`account_status`, so none of this needed a database change — it was purely which
customers the UI offered.

### 18B — Customer emails are per product too

Both weekly crons select the union
(`subscription_status.eq.active,gr_subscription_status.eq.active`) and then
re-check each assignment against **its own** product via a local `eligibleFor()`,
rather than trusting the customer-level filter. The two-step is the point: the
union decides who is worth looking at, the per-assignment check decides what they
may be written to about, so a customer who cancelled Management but kept GR is
chased about GR leads only.

`inactivity-nudge` has worked this way since it was written. `progress-report`
did not — it required `account_status` **and** `subscription_status`, so a
GR-only subscriber never received a weekly summary of work they had genuinely
done.

One deliberate asymmetry: the nudge's management branch excludes paused customers
and the report's does not. A nudge asks for work and should not go to somebody
whose delivery is paused; a report describes work already done. `progress-report`
has never excluded paused customers, and widening GR eligibility was not a reason
to change that.

**Still management-only, deliberately:** pause/resume, top-ups and the goals page
all gate on `account_status` (§13, §16, §17).

### 18C — The supply-problem banner is scoped to live customers

`/admin/customers` warns when a customer is 5+ leads behind with under 10 days
left. Its only guard was `is_active` — a generic row flag that is **true for
every account**, including waitlisted prospects who never subscribed.

Those rows have no `billing_cycle_anchor`, so `computePacing` falls back to
`created_at` (the documented fallback, so the number is meaningful for a real
subscriber whose webhook has not landed). On a prospect it reports a three-week-old
signup as "0 received vs 9 expected" — a shortfall that can never resolve,
because they are not entitled to leads at all. The banner became permanent noise
naming people who were never owed anything, which is how a real shortfall would
have been missed.

Each branch now mirrors the matching half of `get_next_customers_for_lead`: if
routing would not send them a lead, they cannot be behind on one. Paused
management customers are excluded for the same reason — stopped delivery is
deliberate, not a supply problem. Pacing is per product, so a customer holding
both is judged on each separately and the row names which product is short.

**This was never about manual assignment.** Both `assign_lead_to_customer` and
`admin_assign_lead` increment `leads_received_this_month` and stamp
`last_assignment_at`, so an admin force-assign paces identically to an automatic
one — verified against live data, where every active customer's counter equals
their assignment count for the cycle.
