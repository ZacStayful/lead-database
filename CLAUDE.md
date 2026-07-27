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
| **Guaranteed Rent** | `gr_` | £15 | £150/mo for 10 |

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
pause columns (0038), goal columns (0050 — see §13).

### `leads`
`assignment_count` / `max_assignments` (default 2) cap ordinary assignment.
`lead_type` selects the product. Idempotent on `monday_item_id`.

### `lead_assignments`
One row per (lead, customer). Carries `price_paid`, `status`, `pipeline_stage`,
`viewed_at`, `first_contacted_at` (0033), `last_status_change_at` (0035),
`reclaimed_at` + `is_reclaimed` (0043).

`status` ∈ `new, contacted, in_discussion, won, not_relevant, rejected`.
`pipeline_stage` ∈ 9 values, **independent of status** (0010/0015).

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
| Effect | `status → 'rejected'` | Row deleted, `assignment_count − 1` |
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
`/api/leads/[id]/reject`, `/api/leads/[id]/discard`, `/api/leads/export`,
`/api/billing/portal`.

`/api/customer/goal` is the **only** customer route with no admin client at
all — it calls a `SECURITY DEFINER` RPC on the session client. Everything else
here authenticates on the session client and then writes on the service role.

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
8. Capacity = `count(account_status = 'active')`.
9. `management_lifetime_leads_received` only ever counts **up**. It is neither
   the allocation gate nor a pacing counter (§13).

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

- **~~`pipeline_stage` validation is management-only.~~ Fixed (0051 branch).**
  `PATCH /api/customer/assignments/[id]` validated against `PIPELINE_STAGES`
  only, so the GR stages (`viewing_booked`, `contract_sent`,
  `contract_signed`) — which `LeadDetail` *offered* via `stagesForLeadType()`
  and which the DB `CHECK` has always permitted — came back as a 400. GR
  operators could not record a viewing or a contract at all. The route now
  fetches the lead's `lead_type` alongside the ownership check and validates
  with `stagesForLeadType()`. Note the old §11 claim that
  `GR_PIPELINE_STAGES` / `stagesForLeadType()` "are not imported" was already
  wrong: `LeadDetail.tsx` and the guide page both used them. The analytics
  half is fixed too — see §14.
- **`viewed_at` ≠ telemetry.** `viewed_at` is set *only* by expanding a lead
  card in the feed. Opening `/dashboard/leads/[id]` does not set it, so a lead
  read end-to-end via a direct link leaves it null forever. `detail_opened` is
  the honest "this lead was read" signal. Never treat them as equivalent.
- **~~`get_next_customers_for_lead` is executable by `anon`.~~ Fixed.** `0028`
  blanket-revoked schema-wide, then `0038` dropped and recreated the function,
  which discards its ACL. `0049_revoke_anon_routing_execute.sql` applies the
  revoke; this entry and §12 previously said "not yet applied", which was
  already stale when written.
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

## 13. Goals *(0050, 0051)* — management only

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

**0051 backfills it** from `lead_assignments` joined to management leads.
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

## 14. Analytics is split by product *(0051 branch)*

`/dashboard/analytics` previously counted both products together: one funnel,
one win rate, `PIPELINE_STAGES` only. That was wrong for both products — GR
runs a viewing-to-contract pipeline — and its "Won" figure disagreed with the
Goals page, which has always been management-only.

Each held product now gets its own block (stats, status funnel, pipeline via
`stagesForLeadType()`, income, activity). Notes and files stay account-level:
they hang off an assignment, not a product. A product is shown when the
customer holds it **or** has ever received one of its leads, so a cancelled
subscription does not hide the history it produced.
