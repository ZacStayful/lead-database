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
| `/api/cron/capture-leaderboard` | `0 7 * * 1` | Mondays: weekly operator-proof snapshot (§20) |
| `/api/cron/inactivity-nudge` | `0 10 * * 1` | Mondays: leads awaiting follow-up |
| `/api/cron/sweep-lead-pool` | `30 10 * * *` | Expired leads pool: enter, exit, expire (§19) |
| `/api/cron/escalate-leads` | `0 11 * * *` | Inactivity escalation + daily engagement & capacity snapshots (§18) |
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
pause columns (0038 — see §21), goal columns (0051 — see §13), `pool_debit` /
`gr_pool_debit` (0073 — see §19), `cancellation_feedback` /
`cancellation_comment` (0084 — Stripe's cancellation reason, management-only,
first cancellation wins like `cancelled_at`), and the Monday link columns
(0086 — `monday_item_id` / `monday_board_id` / `monday_link_state` /
`monday_link_matched_by` / `monday_status_label` / `monday_status_synced_at` /
`monday_status_error`, see §23; `monday_item_id` is a pointer at the item
representing the CUSTOMER and is unrelated to `leads.monday_item_id`, which is
the lead ingest idempotency key).

### `subscription_pauses` *(0084)*
One row per pause episode: `reasons` (text[]), `note`, `months`, `paused_at`,
`resumes_at`, `ended_at`. **Live pause state is `customers.paused_at`, never this
table** — `ended_at` is a best-effort stamp that nothing reads to decide whether
a customer is paused. Management-only. See §21.

### `leads`
`assignment_count` / `max_assignments` (**default 3** since 0055, was 2) cap
ordinary assignment. The default applies to newly ingested leads only — leads
ingested before 0055 keep the 2 they were created with, so a lead's reach is
whatever its own row says, never a global constant. `DEFAULT_MAX_ASSIGNMENTS`
in `types.ts` mirrors the DB default and is only a null fallback.
`lead_type` selects the product. Idempotent on `monday_item_id`.

Pool columns (0073, 0076): `pool_entered_at` is the **current** tenancy and is
cleared on exit; `pool_first_entered_at` is stamped once and never cleared,
anchoring the 90-day life cap; `pool_expired_at` and `pool_excluded_at` are the
two permanent exits; `pool_entry_basis` ∈ `unassigned, ignored` decides whether
pooling retired the lead from allocation (§19).

### `lead_assignments`
One row per (lead, customer). Carries `price_paid`, `status`, `pipeline_stage`,
`viewed_at`, `first_contacted_at` (0033), `last_status_change_at` (0035),
`reclaimed_at` + `is_reclaimed` (0043).

Also `claimed_from_pool_at` (0073 — non-null marks a pool claim and retires the
lead permanently, invariant 11) and `due_to_call_date_set_at` /
`income_estimate_set_at` (0073 — trigger-maintained; null on pre-0073 rows even
where the value is set, which is why the pool bars those leads rather than
dating them).

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

## 7. Soft reclaim *(0046)* — SUPERSEDED by §18

The cron was removed from `vercel.json` in the escalation work; no new reclaim
is ever granted. The functions are left in place unaltered so the (currently
zero) rows carrying reclaim columns keep their meaning and a rollback is a
`vercel.json` edit rather than a migration. `assign_lead_to_customer` still adds
`lead_open_reclaim_slots()` to capacity.

What follows describes it as built.

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
`/api/leads/[id]/discard`, `/api/leads/[id]/close`,
`/api/leads/pool/[id]/claim` (§19), `/api/leads/export`, `/api/billing/portal`.

`/api/customer/goal` is the **only** customer route with no admin client at
all — it calls a `SECURITY DEFINER` RPC on the session client. Everything else
here authenticates on the session client and then writes on the service role.

**Unauthenticated:** `/api/auth/forgot-password` (POST) — password reset. No
session by definition; see §15 for why it exists at all.

**Admin:** `/api/admin/assign`, `/api/admin/assign/bulk`,
`/api/admin/leads/[id]`, `/api/admin/leads/assign-pending`,
`/api/admin/customers/[id]/*`, `/api/admin/settings/capacity`,
`/api/admin/settings/escalation`, `/api/admin/pool` (§19),
`/api/admin/post-call-offer`, `/api/admin/monday-status-check` (§23.8),
`/api/admin/customers/[id]/monday-link` (§23.8).

**Webhooks / cron:** `/api/webhook/stripe`, `/api/webhook/n8n`,
`/api/monday/sync`, `/api/monday/sync-gr`, `/api/cron/*` (§2).

---

## 9. Invariants — do not break

1. `(gr_)lead_balance` is the allocation gate; assignment spends exactly one
   credit atomically.
2. Credits carry forward; monthly counters reset on the anchor day.
3. A lead reaches at most `max_assignments` customers **through ordinary
   routing**. Escalation raises that column directly, ceiling 5 (§18); soft
   reclaim's derived slot (§7) is retired but its functions remain. A **pool
   claim bypasses the cap entirely** (§19), so `assignment_count` may exceed
   `max_assignments` — nothing enforces the comparison, and the two queries that
   subtract them clamp with `greatest(…, 0)`.
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
11. A lead that has been **claimed from the expired pool**, or that pooled on the
    `ignored` basis, is never re-allocated by ordinary routing (§19).
    `lead_retired_from_allocation()` is the single expression of this and is
    asserted in all three candidate functions, in `get_escalation_candidates`,
    and inside `assign_lead_to_customer` under its row lock. A lead pooled on
    the `unassigned` basis is deliberately **not** retired.
12. `(gr_)pool_debit` is never negative and is settled only inside
    `credit_invoice()`, behind the same idempotency claim as the credit (§19).
    Never decrement it from application code.

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
- **`enquiry_date` is not displayed anywhere**, admin included (0071 branch). It
  is free text of uneven quality from Monday — `safe_enquiry_date()` exists in
  0062 precisely because it does not always parse. Lead age is measured from
  `lead_assignments.assigned_at` everywhere: `formatLeadAge` phrases it as
  "Received N days ago", and `leadOrder` ranks on it. The column is still
  ingested and still readable; nothing renders it.
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
  Reclaim history block on the lead detail page explains it. A **claimed pool
  lead does the same** and can read "4 / 3" — claiming bypasses the cap by
  design (§19, invariant 3). Nothing enforces `assignment_count <=
  max_assignments`: there is no CHECK and no trigger, and the two capacity
  queries that subtract the pair clamp with `greatest(…, 0)`. What a claim does
  skew is `sum(max_assignments)` in `get_service_capacity`, which will
  understate delivered slots by one per claim.
- **Stripe's billing cycle keeps running underneath a pause.** `pause_collection:
  { behavior: "void" }` generates invoices and voids them; resuming does not
  create a charge, it stops voiding future ones. So the first real charge after a
  resume lands at the **next natural cycle boundary**, not on the resume date —
  a gap that is a fixed fraction of a cycle and therefore proportionally larger
  the shorter the pause. A customer anchored to the 1st who pauses on the 5th for
  one month is not charged until the 1st of the *following* month. Not yet
  measured against a real subscription. If it needs fixing, the fix is aligning
  `pause_resumes_at` to the Stripe period boundary — **not** setting
  `billing_cycle_anchor: "now"` on resume (forces proration, can invoice
  immediately, collides with the re-anchoring both resume paths already do) and
  **not** setting Stripe's own `pause_collection.resumes_at` (two resume
  authorities is how a subscription unpauses without the DB knowing).
- **`fully_served` for a paused customer is a stale reading, in an unverified
  direction.** `got` counts assignments since `coalesce(billing_cycle_anchor,
  created_at)`. Both customers paused at the time of writing had taken their full
  10 of 10 first, so they read as *fully served*, not un-served. Whether that
  freezes or flips depends on whether `billing_cycle_anchor` advances during a
  pause: `invoice.paid` cannot move it (invoices are voided, so the event never
  fires) but `customer.subscription.updated` sets it from `current_period_start`
  and the Stripe period keeps rolling. Neither had reached their next anchor date
  when 0084 shipped. Excluding them from the metric (§21) sidesteps it either way.
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
- Rehearse the §24 tier swap in Stripe **test mode** before relying on it. The
  build session could only reach the live account, so `subscriptions.update` with
  `proration_behavior: "none"` has not been exercised end to end.
- The 20-lead prices (management and GR) are `tax_behavior: "inclusive"` while
  both 10-lead prices are `"unspecified"`. A §24 tier switch is the first thing
  that will move a customer between the two treatments. Pre-existing in Stripe,
  not introduced by code.
- Decide whether repeat pausing should be capped (§21). It is currently
  unlimited, and 0084 made the duration customer-chosen, so a customer could in
  principle pause a month at a time indefinitely. `subscription_pauses` makes
  "total paused months in a rolling 12" a five-line query if wanted.
- **Review the return-likelihood thresholds once ~20 pauses have completed.**
  They are stated guesses (§21) and `get_pause_outcomes()` is what will let them
  be checked against what actually happened.
- ~~Enable cancellation-reason collection on the Stripe billing portal.~~
  **Already enabled** — verified on the live configuration
  (`bpc_1Tz1VxCpQPIFzv4r`): `subscription_cancel.cancellation_reason.enabled` is
  true with options `too_expensive`, `switched_service`, `unused`, `other`. The
  `feedback_options` list is empty, so those four are what a leaving customer
  sees. Nothing to do; noted because it is easy to assume the opposite.

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

It is **reporting and admin judgement only**, for BOTH products now. Nothing
anywhere refuses a sale on capacity.

Management used to: `/api/signup` waitlisted anybody arriving once active
customers reached `max_active_customers`, and `/api/customer/subscribe` returned
a 409. Both were removed — a typed cap cannot know that lead volume moved or
that escalation opened extra slots, so it turned away paying customers on a
figure that was probably stale. Running short on leads is a supply problem to
solve by sourcing more, not by refusing revenue. Both paths now log when they go
over and carry on; §18.1 surfaces the real position.

The invite route has always warned rather than blocked, and still does.

Neither product waitlists at the cap. That was settled deliberately: never
refuse a sale.

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
the subscription lifecycle handler sets it from the price id as a backstop. On a
genuine disagreement the webhook credits the **row** and logs a "GR allocation
drift" error; the row stays the source of truth.

⚠️ **This paragraph used to say "creation only, so it can never undo an admin's
hand-edit on a later `updated` event". That was never what the code did.** The
block is keyed on `gr_stripe_price_id !== subPriceIds[0]` — "the price is not the
one we last recorded" — not on the event type, so it fires on `updated` too. What
protects a hand-edit is narrower than the old wording claimed: an allocation
edited while the **price stayed put** is untouched, but an allocation edited to
disagree with a price that then changes is overwritten. It has a second exception
since 0088 — see §24.

### GR price ids are the product router

### GR Payment Links and `gr_stripe_customer_id` *(0062)*

A GR Stripe **Payment Link** mints its own Stripe customer for the payer. That
broke the one Stripe field the two products still shared: `stripe_customer_id`.
An existing management subscriber buying GR through a link would have their
`stripe_customer_id` repointed at the new GR customer by `invoice.paid`
provisioning, detaching their **management** subscription from every future
webhook lookup — and management's own provisioning would repoint it back on its
next renewal, the two products fighting over one column indefinitely.

`gr_stripe_customer_id` (0062) is the GR half. **Reads match either column**
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

### 18D — `is_active = false` means archived

A duplicate signup superseded by a later account is archived rather than deleted:
the row keeps its history and can be restored, but leaves circulation.

Routing has always honoured the flag — both candidate functions require
`is_active = true` — but the **admin surfaces did not**, so a dead duplicate kept
appearing beside the live account under the same name. That is how the
supply-problem banner (§18C) came to name "Leslie Rogers" when the real Leslie
Rogers had had her full allocation: the row it flagged was a different,
superseded signup at another address.

Archived rows now sit under their own **Archived** tab in the customers table
and appear nowhere else, including "All" — visible enough to undo, invisible in
day-to-day use. They are also excluded from the management waitlist count (a
superseded row is not a prospect awaiting a slot) and from the bulk assigner,
which selected `is_active` but never filtered on it.

Archiving is **not** a substitute for `account_status`. It says "this row should
not be in circulation at all", where `cancelled` says "this customer left".

### 18E — A cancelled customer can be invited back *(no migration)*

The management branch of `POST /api/admin/customers/[id]/invite` accepts
`account_status` of **`waitlisted` or `cancelled`**. It used to accept only
`waitlisted`, which meant a customer who left had no in-app route back at all:
this route refused them, `/api/customer/subscribe` requires already holding the
other product (a cancelled management-only customer holds neither), and
`/api/signup` is retired for non-owners. The only way to take their money was a
hand-made Payment Link, and the admin got "Customer is not waitlisted", which reads
like a defect rather than a policy.

Safe because **an invite is not a grant**: the route only emails an activation link
and creates a Checkout session. Nothing about their product state moves until they
pay, and `invoice.paid` is what promotes `account_status` — a promotion that now
includes `'cancelled'` (§23.9) precisely so this path cannot leave somebody paying
and lead-less. The two changes are complements; neither is safe alone.

Still refused, for different reasons, so the error names the state:
`active` (they already hold management — inviting would sell it twice) and
`invited` (they have a live link; `resend-invite` is that route, and swallowing it
here would hide a working feature).

**The button reads the RAW `account_status`, not `effectiveStatus()`.** That helper
reports any GR holder as `active` (§18A), which is right for the badge and the tabs
and wrong for "can management be sold to them" — a management-only question
(invariant 6). Keying on the raw column also un-hid the button for a GR-only
subscriber still `waitlisted` for management: the route had always accepted them,
only the UI was hiding it. `canInviteManagement()` in `AdminCustomersTable` mirrors
the route's gate deliberately — a hidden button looks like a missing feature and an
offered one that 400s looks like a bug.

Two knock-ons left alone, both judgement calls rather than oversights:

- **A returning customer keeps their unused credits.** Nothing zeroes
  `lead_balance` on cancellation, so they come back with the old balance plus the
  fresh grant. Invariant 2 says credits carry forward and they paid for those
  leads; confiscating them on return would be the surprising behaviour.
- **Cancel and return inside one billing cycle leaves the pacing counter stale.**
  `reset_monthly_counts()` filters on anchor day only, not status (0018), so a
  cancelled customer's counter is still zeroed monthly and anyone returning after
  more than a cycle is clean. Only the same-cycle case carries a stale count, and
  since `invoice.paid` re-anchors to today, pacing reads those leads as already
  delivered and under-prioritises them for up to a month. It self-corrects at their
  next anchor day and errs toward delivering **fewer** leads, which is the safe
  direction. Re-baselining as the resume-from-pause path does (§21) would mean
  changing `invoice.paid` for every customer on every renewal.

This adds an admin action, not self-serve re-subscription: `/api/customer/subscribe`
still requires holding the other product, which is the §17 guard keeping self-serve
acquisition retired.

---

## 18. Inactivity escalation *(0062–0070)*

Replaces soft reclaim (§7). A lead nobody has engaged with for **10 days** goes
to one further operator, and again at **20**, then stops. **Full price**
(`leadPriceFor`), standard two-pool routing, standard new-lead notification. The
original assignment is untouched — same status, same `price_paid`, no refund.

`/api/cron/escalate-leads`, daily at 11:00. Checks `escalation_enabled` first
and logs a skipped run rather than silently doing nothing.

### Why this one increments `max_assignments` where reclaim would not

§9.3 is still correct *for reclaim*: incrementing the cap would have handed a
discounted slot away at full price through the sync's top-up path. Escalation
has no discount and no bespoke recipient rule, so the top-up path is a **second
executor of the same intent**, not a defeat. Ceiling is **5** — the brief said 4
when the base default was 2, and 0055 moved the base to 3, so 4 would have left
room for one rung and silently killed the day-20 step.

### The score is per assignment, over a trailing window

`get_assignment_engagement_scores(ids, since)` — weights live in the
`engagement_weights` **table** (not a function like `engagement_score_params`)
because they are provisional and must be tunable from admin without a deploy.

Trailing window, not lifetime: a note written on day 1 must not shield a lead on
day 40. `detail_opened` is weighted 0.30, as heavily as a note, because it is the
only signal with usable volume — 278 opens against 3 contact-clicks in the first
16 days. Thresholds (`system_settings`) are **0.35** at day 10 and 0.45 at day 20
(this said 0.30; production reads 0.35, which is also what §18.2's "a lone
`mailto_click` (0.30) sits just under the threshold" already assumed),
tuned so **opening a lead buys ten more days and not twenty**. Changing a weight
without re-reading that sentence breaks the ladder.

**The freshness gate moved onto the allocation clock (0073).**
`escalation_max_lead_age_days` is set to **25** in production — the same number
as pool entry (§19), and clearly meant as a handoff: escalate up to day 25, pool
after. It could not work as built, because the gate counted from
`safe_enquiry_date(l.enquiry_date)` — free text from Monday that does not always
parse — while allocation, pacing and the pool all count from
`lead_assignments.assigned_at`. `get_escalation_candidates.lead_age_days` is now
days since **this assignment**, so the ladder reads as one sequence: assigned →
day 10 rung → day 20 rung → day 25 pool. The route's null-tolerant branch is
left in place and simply never fires now, because `assigned_at` is NOT NULL.

Candidates are **not** gated on `status = 'new'` despite the brief saying so: 31
of 87 ten-day-old assignments sit at `contacted` scoring ≤0.10, and the PATCH
route lets an operator set that by hand, so it would have been a one-click
permanent exemption. Only `won` and `rejected` are excluded by status.

### Closing a lead *(0067)*

`POST /api/leads/[id]/close`, reasons `not_interested` / `sorted_elsewhere`.
Available at **any** stage — reject needs `pipeline_stage = 'cold'` and discard
needs an untouched `new` assignment, so both refuse the operator who actually
rang. That gap is why 70 worked leads carry no outcome and only 3 wins exist.

Both reasons describe the **landlord**, so a closed lead is offered to nobody
new — guarded in `get_escalation_candidates` *and* in `autoAssignLead`, because
the daily sync's top-up branch is what would otherwise re-sell it within 24h.
No refund; bad contact data goes to support, which is what keeps the signal
honest.

### Duplicate landlords *(0070)*

Idempotency on `monday_item_id` never stopped one landlord arriving as several
items — 28 exact groups, 32 redundant copies, 24 assignments sold. Blocks on
name **AND** email **AND** phone, normalised (phone compared on its last 9
digits; `0000 0000000` treated as missing). A key with any part missing is NULL
and never matches, because management ingest writes `""` for absent fields.

Strict on purpose and **fails open**: under-matching costs a duplicate,
over-matching silently discards a real enquiry. Scoped within `lead_type`.

### Admin

`/admin` — live service capacity (§18.1) and churn risk; escalation settings.
`/admin/outcomes` — wins, customer scoreboard, outcome evidence, duplicates.

### §18.1 — Capacity separates what refills from what does not

An earlier version reported management "114% oversubscribed" by comparing
new-lead slots against promised allocations. It was wrong: every customer had
received 100% of their allocation and 276 leads/month were delivered against 260
promised. It had ignored the standing inventory of unsold leads.

The organising rule that came out of that: **supply that REFILLS decides the
customer ceiling; supply that clears once is reported beside it and never added.**

| | Refills monthly → in the ceiling | One-off → shown separately |
|---|---|---|
| New leads | `slots_per_month` | |
| Ignored leads returning | `recycled_slots_per_month` (0072) | `recycled_slots_now` |
| Unsold back catalogue | | `inventory_slots_now` |

`serviceable_slots_per_month` is the sum of the first column and is what
`sustainable_customers` divides by `avg_allocation`.
`sustainable_customers_new_only` is the same figure on new leads alone, always
shown beside it — the gap is exactly how much headroom depends on customers
continuing to ignore leads, and it must never be presented as one number.
`delivered_per_month` is the check on all of it, and `fully_served` measures the
guarantee per customer against **their own billing anchor**.

Nothing gates on any of this (§16) — it is reporting and admin judgement.

### §18.2 — Recycled supply *(0071, corrected by 0072)*

0066 counted only lead inflow, so it answered "room for 0 more customers" while
36% of delivered leads sat untouched. A lead nobody has worked **is supply** —
escalation is the machine that recovers it, and unlike inventory that recovery
recurs every month.

**Measured with escalation's own test, or the number is a lie.** Two things must
match `get_assignment_engagement_scores`, and both are easy to get wrong:

- **Which signals count** — contact click, note, stage move, status advance. The
  same set as `passive_only`. Opening a lead is *not* working it. Marking a lead
  contacted **is**: an operator only does that to organise their own pipeline.
  One documented inexactness: a lone `mailto_click` (0.30) sits just under the
  0.35 threshold, so escalation recycles it where this test reads it as active.
  Left alone rather than duplicating the weighted score, which would drift the
  moment a weight is edited from admin. The error is one signal wide and it
  **understates** recycling.
- **When it is asked** — over each assignment's own first ten days, never its
  lifetime. This is what separates recurring from one-off: asking "what looks
  dead right now" sweeps in the long-abandoned backlog and answers **76%**, a
  wave that clears once; asking "was this worked inside its own first ten days"
  answers **41%**, which a fresh cohort repeats monthly.

#### Count one rung ahead — never compound the ladder *(0072)*

0071 originally multiplied the two rungs together, `rate_10 × (1 + rate_20)`,
having measured the conditional day-20 rate at 100% (53 of 53 management, 10 of
10 GR). Management came out at 487.8 slots against a physical maximum of 493 —
the model was asserting **every lead gets sold the full five times**. Wrong twice:

1. **It counted a resale that had not happened.** When a lead goes out for its
   first resale, the second is not capacity — the new operator may work it, which
   ends the ladder there. The fifth allocation is only real once the fourth has
   happened *and* that operator has also gone silent.
2. **The 100% was measured in a world without escalation.** Every assignment in
   that sample sat with ONE operator who ignored it; no second operator ever
   existed to engage it. Of course it stayed quiet to day 20. That population
   cannot predict post-intervention behaviour — projecting it forward assumed the
   fix would never work.

So: **one rung, always.** The second enters the figures by *observation* — once a
lead has actually escalated and its new holder has actually gone quiet past their
own ten days, it becomes a live candidate and is counted then, as a fact.

| Column | Meaning |
|---|---|
| `recycled_slots_now` | A **count**: leads held by someone not working them, passable today. One per **lead**, never per assignment — `get_escalation_candidates` returns assignments and does not dedupe, but escalating raises `max_assignments` by one, so two silent co-assignees still open only one slot. |
| `recycled_slots_per_month` | Observed escalations per month once escalation has run; before then a one-rung estimate, `delivered × unworked_rate`. |
| `recycling_basis` | `observed` or `estimated`, so an estimate is never read as a count. |

Bounded by one rung of headroom per lead (`count(*) where max_assignments < 5`),
not the full run to the ceiling — the clamp obeys the same rule as the estimate.
On live data that clamp binds: the raw estimate of 117.4 is capped to 98.6,
because you cannot recycle more leads a month than you ingest when each steps once.

**No safety discount, deliberately.** The obvious objection is that recycled
supply peaks when customers are least engaged, so capacity looks best right
before churn. Rejected because the insurance costs more than the risk: holding
capacity back means leads sit unsold longer, and a cold landlord is a permanent
loss where a short month is not. **The guarantee rolls over** — `lead_balance`
carries forward and only `leads_received_this_month` resets (invariant 2), so an
undelivered lead survives as an unspent credit. Under-delivering is recoverable;
letting a lead go cold for safety is not.

The exposure is therefore **shown, not discounted**: the panel prints the
new-leads-only ceiling beside the headline, and states in words that the ceiling
falls back to it if everyone starts working their leads.

Same treatment for GR, with `recycling_sample` returned per row so a rate built
on ten assignments is labelled as too thin to rely on rather than presented as
solid.

Live at time of writing — management **26** with recycling against **18** on new
leads alone, 95 leads passable now; GR **14** against **13**.

#### The trend is the health signal *(`service_capacity_snapshots`, 0072)*

Captured daily by the escalation cron, after escalation rather than before —
escalation is what converts an ignored lead into a sold slot, so measuring first
would record the position the run has just changed. **Cannot be backfilled**:
`get_service_capacity` reads live state, so a missed day is gone. Best-effort and
separately fallible from the engagement snapshot, so one failing never costs the
other its reading.

What to watch: as customers who actually use the platform replace those who do
not, `unworked_rate` should fall and recycled supply with it, while
`slots_per_month` rises with lead volume — so the **two ceilings converge**. A
closing gap means the business is getting healthier. A widening one means
headroom is increasingly borrowed from customers ignoring their leads, which is
capacity that evaporates the moment they engage or leave.

### Churn

`customer_engagement_snapshots` (0070) — weekly, per customer per product,
rolling window plus lifetime figures. **The only part that cannot be
backfilled**, which is why it shipped ahead of anything that reads it.
`get_customer_risk()` is stated rules, not a model: zero customers have ever
cancelled, so there is nothing to fit. Re-engagement clears a flag by
construction, since every band is defined on days-since-activity.
`cancelled_at` / `gr_cancelled_at` are stamped by the Stripe webhook, first
cancellation winning.

### Deployment order — migrations BEFORE code

`0062`–`0070` must be applied before the code deploys. Otherwise the nudge cron
silently sends nothing (it reads `inactivity_escalation_stage`) and the admin
panels render their unavailable state. `autoAssignLead`'s closed-lead check
fails **open** specifically so this ordering mistake cannot halt all assignment.

Escalation will not fire for ~7 days after apply: the cutoff is stamped at
`now() - 3 days` and a lead must be 10 days old to qualify.

### Verification

There is still no test suite. All 60 migrations were applied to a scratch
Postgres 16 from empty — which caught `"can't reach"` in 0063 quoted as an
identifier, an error read-only validation cannot see — and the write paths were
exercised against seeded data.

---

## 19. The expired leads pool *(0073–0076)*

The third and final rung of the distribution ladder. Initial allocation places a
lead with up to `max_assignments` operators; inactivity escalation adds one at
day 10 and again at day 20 (§18); at **day 25** the lead opens to *every*
subscriber of its product, who may ring the landlord for free and **claim** it
if they are still interested.

`/dashboard/leads/expired` · `/admin/pool` · `/api/cron/sweep-lead-pool` at 10:30.

### 19.1 — Two bases for entry, and only one is terminal

The brief's rule was "a pooled lead can never be re-allocated". That is right
for a lead that went round its operators and was ignored. It is wrong for a lead
**never sent to anybody**: at build time 211 of 230 GR leads had never been
assigned — not ignored, just unsold, because GR has two subscribers and cannot
absorb the volume. Retiring those on their 25th day would have handed the next
GR subscriber an allocation with an empty book behind it.

| `pool_entry_basis` | Meaning | Retired from allocation? |
|---|---|---|
| `ignored` | Was assigned; nobody worked it | **Yes** — invariant 11 in full |
| `unassigned` | Never sent to anyone | **No** — sits in the pool *and* stays in stock |

Whichever happens first wins. An `unassigned` lead that is allocated leaves the
pool **in the same transaction** as the assignment — not on the next sweep,
because a 24-hour window in which a lead is both assigned and claimable sells
one operator's paid lead to somebody else. If its new holder then ignores it, it
re-enters 25 days later as `ignored`, terminal like any other.

### 19.2 — The clocks

Entry: 25 days (`pool_entry_days`) of silence, measured from
`lead_last_activity_at()` — the later of the most recent assignment and the most
recent engagement on any assignment. Never assigned: from `leads.created_at`.

**`nudge_sent` is excluded** from the event scan for the usual reason (§3):
counting it would let our own reminders reset the clock on exactly the leads
nobody is touching.

Death: 90 days (`pool_life_days`) from `pool_first_entered_at`, which is stamped
once and **never cleared**. Leaving the pool on engagement and re-entering does
not restart it, or a lead alternately touched and abandoned would live forever.

### 19.3 — Permanent bars

Never poolable at any age: a note exists on any assignment · any assignee
reached `in_discussion` or `won` · any assignee **closed** it (0067 — not in the
brief, but selling a landlord who has already said no is the exact outcome close
exists to prevent) · the lead was **withdrawn** on a swap (0059) · it has
expired or been **excluded by an admin** (0076) · a `due_to_call_date` or
`income_estimate` is set with **no timestamp**.

That last one is the pre-0073 backlog. Both columns stored a value and no date,
so they could say "somebody touched this" but not when — and a clock needs a
when. 0073 added `due_to_call_date_set_at` / `income_estimate_set_at`, stamped
by **trigger** rather than in the PATCH route because the route is not the only
writer. Existing rows get null, and null-with-a-value is barred rather than
guessed at. Live cost of that bluntness: **3 leads**, and it shrinks to zero as
leads turn over.

### 19.4 — Claiming

`claim_pool_lead()` mirrors `assign_lead_to_customer` — lock lead, lock customer
(same order, so the two cannot deadlock), validate, insert, bump counters — and
differs in three ways:

1. **No capacity check.** Claiming bypasses `max_assignments` (invariant 3).
2. **Balance or debit.** At zero balance the claim still succeeds and increments
   `(gr_)pool_debit`. This is the only path that delivers a lead with no credit
   behind it.
3. **It returns a status, not an exception.** Losing the race is ordinary — two
   operators ringing the same landlord and one claiming first is the mechanism
   working — so the loser gets `already_claimed` and a 200.

**First claim wins, and the row lock is what makes it true.** The winner clears
`pool_entered_at` and commits; the loser's `for update` then returns the updated
row and reports `already_claimed`. The check and the clear are never separated.

Visibility (`customer_can_see_pool_lead`) is **one definition** shared by the
listing and the claim, so a lead can never be listed but unclaimable: in the
pool and unexpired · active subscription **for that product** · never assigned
to this customer · matches their lead filter · not paused.

**Filters are the allocation filters** — same columns, same semantics, including
`pending_lift` counting as filtered and a lead with an unparseable postcode or
bedroom count matching no filtered customer.

### 19.5 — The debit

Balance must never go negative (invariant 1): every routing query tests
`lead_balance > 0`, so a negative balance would read as "no credit" and quietly
drop the customer out of allocation as a side effect of using a feature we
invited them to use. The debt sits in its own column instead.

**Settled inside `credit_invoice()`, never in application code.** That function
is idempotent by INSERT — it claims the invoice with a payments row and returns
false on a redelivery. A debit decrement written beside it in TypeScript has no
such guard, so a redelivered Stripe event would correctly skip the credit and
**wipe the debt a second time**, silently. Stripe redelivers. The signature is
unchanged and the webhook still passes the plan allocation, knowing nothing
about the debit.

10-lead plan, debit 12: cycle 1 grants 0 and leaves debit 2; cycle 2 grants 8
and clears it; cycle 3 grants 10. `credits_added` records what was **actually**
credited, so the payments table cannot disagree with `lead_balance`.

**Top-ups are exempt** — they credit through `record_lead_topup_success` (0041),
and taking them to settle a pool claim would charge for leads and deliver none.

**Pacing subtracts the debit.** `effective_allocation(allocation, debit)`,
floored at zero, in all three candidate functions *and* in `src/lib/pacing.ts` —
they duplicate each other by design and must change together. Without it a
customer who claimed 3 shows a deficit of 3 all month, gets named on the
supply-problem banner (§18C), and is pushed leads ahead of customers who are
genuinely short. `poolDebitExplanation()` puts the reason on their dashboard.

### 19.6 — Discard, and the one thing it must not do

A claimed lead may be discarded, but the slot **does not reopen**: decrementing
`assignment_count` would put the lead back under its cap while the claim marker
died with the deleted row, so ordinary routing would re-sell a lead the pool had
retired — invariant 11 breached by the one path that destroys the evidence.
`discard_lead_assignment` therefore sets `pool_expired_at` instead, which carries
both the bar and the retirement in one column. No refund either way.

### 19.7 — Copy is part of the mechanism

Contact details are visible **before** claiming, so nothing technically stops an
operator working a pool lead to signature without ever claiming it. The only
thing that makes claiming rational is that somebody else can take it first — so
the scarcity line gets its own block and is not folded into a paragraph:

> First claim wins. This lead is removed from every other subscriber's pool the
> moment someone claims it.

The confirmation states the real price both ways, including the zero-credit
case. An empty pool is written as the **good** outcome it is. Nothing about
previous holders is shown — not the count, not their activity; it is absent from
the row set and from the `PoolLead` type, so no later UI change can reach for
it. "Three operators passed on this" is an argument against ringing, and the
premise is that they never rang.

Lead age falls back honestly: the parsed enquiry date where it parses, ingest
date where it does not, labelled as such (see §11 on `enquiry_date`).

### 19.8 — Admin

`/admin/pool` — both pools read-only, per-product summary, force in/out, claim
log. It reports what the customer view hides (holders, basis) because that is
what tells an admin whether the pool is behaving. `barred` is given equal
billing with `in pool`: a management pool of six against 151 leads reads as
broken until you see that 77 are barred for having been genuinely worked.

**Forcing a lead out needs `pool_excluded_at`.** Clearing `pool_entered_at`
alone is undone by the next morning's sweep, and a control that silently reverts
is worse than none because the admin believes it worked. Forcing a lead in
clears the marker, so the pair are true opposites. A **claimed** lead can never
be forced back in — it belongs to whoever claimed it.

Claim history reports the customer's **current** debit rather than inventing a
per-claim "paid with credit / paid with debit". `price_paid` is the full price
either way (invariant 4) and nothing records which balance moved; per-claim
attribution would need a column written at claim time, and is not worth one
while the claim count is zero.

### 19.9 — Analytics and export

Claimed leads are **counted in every figure** and broken out beside them, with
their own win rate against allocated leads. They are self-selected — the
operator rang before keeping — so the two populations should not convert alike,
and one blended win rate hides the comparison that says whether the pool is
worth working. The XLSX export carries a **Source** column: "Claimed from
expired leads" or "Allocated".

### 19.10 — What this does to the recycled-supply model

§18.2 measures unworked leads as *recurring supply recovered by escalation*.
The pool now harvests the same leads by a different route, so
`recycled_slots_per_month` and pool throughput are **two counts of one supply**.
Nothing has been changed there yet; treat the capacity panel as over-counting
until it is reworked.

### 19.11 — Deployment state at time of writing

~~**0073 is applied to production. 0074, 0075 and 0076 are not.**~~ **Out of
date — all four are applied.** Verified against the live schema while preparing
0077: `claim_pool_lead`, `customer_can_see_pool_lead`, `get_customer_pool_leads`
and `leads.pool_excluded_at` are all present. The note is kept rather than
deleted because the ordering constraint it records still holds for any rebuild:
0075 depends on 0074 (`customer_can_see_pool_lead`) and fails outright without
it. With every debit at zero, 0074's `credit_invoice` is arithmetically identical
to the one it replaces (`granted = amount − 0`), so it was inert until the first
claim.

Nothing pools until the code deploys: the sweep route does not exist on `main`.

---

## 20. Insights → Leaderboard *(0077–0082)*

`/dashboard/leaderboard`. Social proof for existing subscribers: what the
operators who have signed a management client do differently from everyone who
has not, with the reader's own figures beside them.

**It does not rank anybody, and the name is the only thing about it that
suggests otherwise.** With ~21 active operators a ranked table means fourteen of
them open the page to learn they are in the bottom half, and the operators most
likely to drift are exactly the ones a ranking punishes. `get_customer_scoreboard`
(0068) already existed and deliberately left ordering to the caller for this
reason; nothing here sorts it.

### The four rows, and why those four

| Row | Source | Signed (3) | Not yet (18) |
|---|---|---|---|
| Open every lead | `viewed_at` OR `detail_opened` | 100% | 81% |
| Ring every one | `first_contacted_at` | 100% | 56% |
| Get the meeting booked | management meeting stages | 20.0% | 6.9% |
| Write it down | `lead_notes` count | 10.7 | 5.8 |

All rates share one denominator — management leads **delivered** — so the three
percentages read as a funnel rather than as three bases. The meeting row is the
one that matters: it is the last step the operator fully controls, it is where
the funnel actually breaks (56% chased → 7% in a diary), and it has ~7× the
volume of wins across 3× the operators. A no-show still counts as booked.

**Speed of opening is deliberately absent.** Both groups open a new lead within
about six hours; the median gap is 6.1 vs 6.0. An earlier read put winners at
14.8 hours against 29.9, but that was a mean of per-operator means pooled across
both products. The difference is entirely in what happens after opening.

### Weekly snapshots *(0081, 0082)*

`operator_proof_snapshots`, captured Mondays 07:00 by
`/api/cron/capture-leaderboard`, ahead of the 10:00 nudge so the reading
measures the week that ended rather than the nudge's own effect.

The page was never stale — `get_operator_proof` reads live state. The snapshot
buys a date the reader can see, figures that hold still mid-conversation, and a
previous week to compare against. **It cannot be backfilled**, same as 0064 and
0072: the capture reads current state, so a missed Monday is a permanent hole.

- **Cohort rows come from the latest snapshot; the `you` row is always live.**
  The cohort is a weekly reference point, but nobody should see a stale version
  of their own work.
- **Falls back to live** with `as_of = null` when no snapshot exists, so a cron
  that never fires degrades to the old behaviour rather than an empty page.
- `prev_*` columns carry the capture before last and are null until a second
  week exists. The movement line stays hidden until then.
- Idempotent on `(captured_on, group_key)` — a retry or manual re-run refreshes
  that week rather than duplicating it.
- `capture_operator_proof` **duplicates** the aggregate arithmetic in
  `get_operator_proof` rather than calling it, because that function resolves
  identity from `auth.uid()` and returns nothing to a service-role caller. The
  two must change together.

### Privacy

`get_operator_proof` and `get_recent_wins_anonymised` are the second and third
`SECURITY DEFINER` functions `authenticated` may call (invariant 7). Both take
no customer id, resolve identity from `auth.uid()`, and return aggregates only.

- Hidden entirely below **3** signed operators — fewer is a report on named
  individuals with the names removed.
- The wins feed withholds `postcode_area` below **5** wins: a lead reaches at
  most three operators, so area plus month would let a competitor who held the
  same lead work out that somebody else signed it. `won_at` is truncated to the
  month for the same reason.
- `operator_proof_snapshots` has RLS on with **no policy** — deny-all to the
  browser. The aggregates are reachable only through the guarded function.

### Related, shipped alongside

- **0077** re-bases `contact_rate` / `hours_to_first_attempt` in
  `get_engagement_benchmarks` onto `first_contacted_at`. Both were computed from
  `tel_click`/`mailto_click`, which had fired on **3 assignments in six weeks**
  against 290 `detail_opened`, so two of the three benchmarks a customer is
  shown had been blank since launch. Management goes 0.010 → 0.621, and
  operators able to see their own speed figure 0 → 14.
  **`get_customer_engagement_scores` is deliberately untouched** — it weights
  `contact_rate` at 0.65 and drives reclaim/escalation recipient selection, so
  changing it moves leads between operators and needs its own dry run.
- **0079** stamps `contact_gate_from`. The lead feed card no longer shows the
  landlord's phone and email, so getting a number means opening the lead. That
  changes what `detail_opened` MEANS partway through the series: 114 of 308
  assignments were expanded in the feed and never opened, and the 129 with prior
  opens cannot be read as contact attempts. Nothing reads the marker yet — on
  the day it was applied there were zero qualifying events.
- **"Picked up and left"** on the dashboard home (`workSummary.ts`): overdue
  callbacks (16 of the 17 ever set) and leads stalled at `contacted` for 14+
  days (70, across 9 operators). Both name a specific lead rather than a rate.
---

## 21. Pause, and understanding why customers leave *(0038, 0084)*

Pause is the off-ramp offered instead of cancellation, so it is the best churn
signal the business has. Until 0084 it collected nothing.

### What a pause is

Management-only. The customer picks **1, 2 or 3 months** and must give at least
one reason (`/dashboard/settings`, `POST /api/customer/subscription/pause`).
Stripe collection is paused with `behavior: "void"` — not cancelled — so nothing
is billed. `account_status` deliberately stays `'active'` so the **routing** slot
is reserved, and `lead_balance` is untouched so credits carry forward.

Pausing is **repeatable**. 0038's header claims a one-time allowance is enforced
in the app; it never has been, the route has no such check, and 0084 corrects the
comment rather than changing behaviour. `pause_count` gates nothing.

### The two resume paths, and the third thing that clears a pause

1. `/api/cron/resume-paused-subscriptions`, daily 08:00 — picks up
   `pause_resumes_at <= now`, unpauses Stripe **first**, then clears the DB and
   re-baselines pacing (`billing_cycle_anchor` = today,
   `leads_received_this_month` = 0) so a stale anchor does not read as a maximal
   deficit and flood them on return.
2. The Stripe webhook's resume-detection block — fires when `pause_collection`
   is gone, i.e. the customer resumed early through the billing portal.

Both are guarded on `.not("paused_at","is",null)` so only the writer that
actually flips the column sends the email, and both close the episode through
`stampEpisodeEnded()`.

That helper stamps the **latest** open episode by id, not every open one.
Because the stamp is best-effort and allowed to fail, a customer can carry an
un-stamped episode from an earlier pause, and a blanket
`is("ended_at", null)` update would close it too with today's date — inventing a
pause window that never happened. For the same reason `get_pause_outcomes()`
decides `active` from "the customer is paused **and** this is their most recent
episode" rather than from `ended_at is null`, and gives a missed stamp its own
outcome, `ended_untracked`, instead of guessing it into one of the three that are
decided by comparing `cancelled_at` against `ended_at`.

**The third case is a cancellation.** A cancelled subscription reports no
`pause_collection`, so path 2 fires for it too — and only the *email* there is
status-guarded, not the write. So cancelling during a pause clears `paused_at`.
That is deliberate and must stay: gating the write would strand the row paused
forever with the cron retrying a dead subscription every morning. The episode row
is what preserves the history the clear would otherwise erase.

### Paused customers are excluded from every allocation metric

A paused customer receives no leads and is owed none, so their allocation is not
committed volume. Excluded in four places, **management branch only** (invariant
6 — GR keeps flowing to a paused management customer):

| Surface | What was wrong |
|---|---|
| `capacity.ts` weighted slots | counted their full allocation |
| `get_service_capacity` `served` CTE | fed `active_customers`, `demand_per_month`, `avg_allocation`, `fully_served`, and transitively `sustainable_customers` / `room_for_customers` |
| `get_customer_risk` | every band is days-since-activity, so a paused customer inevitably reached `high` and appeared on "Customers who may leave" with their plan price in revenue-at-risk, while billing £0 |
| Admin overview MRR + active counts | invoices are voided, so MRR counted money not being collected |

The precedent is already in the codebase twice: `capacity.ts` excludes
`is_active = false` because such an account "commits no monthly volume", and the
supply-problem banner excludes paused because "delivery is stopped deliberately,
which is not a supply problem".

**Always two numbers, never one.** `paused_customers` / `paused_demand`,
`pausedCount` / `pausedWeight` and the paused MRR figure are reported **beside**
the headline and never added to it. Excluding without reporting would show
headroom that a returning customer silently reclaims, and selling into it
over-commits us — the demand-side version of the §18.1 rule.

**Deliberately not excluded:** `unworked_rate`, `recycled_slots_now` and
`recycled_slots_per_month`. Leads sitting with a paused operator genuinely are
passable — escalation and the pool will recover them — so filtering them would
understate real supply. Nor `delivered_per_month` (a record of what happened) or
the waitlist count (paused customers are `account_status = 'active'`, so already
excluded; a predicate there would be a misleading no-op).

`service_capacity_snapshots` rows written before 0084 carry the old
paused-inclusive definition and **cannot be recomputed** (0072's header). The
series has a definition change at that date; a step change there is not a
business event.

### Return-likelihood is stated rules, not a model

`src/lib/pauseOutlook.ts`. Facts come from `get_paused_customer_facts()`; the
rules live in TypeScript where they can be read and argued with — the same split
`serviceHealth.ts` uses, and the same position `get_customer_risk()` took, for
the same reason: **zero customers have ever cancelled, so there is nothing to
fit.**

| Band | Rule |
|---|---|
| **Not returning** | Stripe reports `cancel_at_period_end` or already cancelled. A **fact**, and it outranks everything below. |
| **Unlikely** | A verdict-on-the-product reason **and** no wins **and** weak pre-pause engagement. |
| **Likely** | Has wins, **or** strong engagement, **or** a temporary reason. |
| **Unclear** | Everything else, including every `unknown_pre_0077` backfill row. |

Three refusals, all load-bearing: no numeric score (a percentage implies a fitted
model); a reason alone never lands anyone in "unlikely" (someone who signed
clients and cited lead quality is telling us about the leads, not their intent);
and "unclear" is never collapsed into "likely" to make the tab look decisive.
Every band renders **with its supporting reason** — an unauditable rules-based
verdict is indistinguishable from a guess, and these will be wrong sometimes.

**Engagement is measured from events and notes, never `status = 'contacted'`.**
The PATCH route lets an operator set that by hand (§18): both customers paused at
the time of writing had all 10 assignments marked contacted, while one had 31
engagement events and 15 notes and the other had 3 and 1. It measures
record-keeping, not work — the same trap §10 flags for win rate.

### Can they actually be re-billed?

The Paused tab reads this **live from Stripe**, not from our columns. The billing
portal is configured `subscription_cancel.mode = "at_period_end"`, so a
cancellation is **never** a cancelled subscription at the moment it happens: it
arrives as `customer.subscription.updated` with `status` still `"active"` and
`cancel_at_period_end` true. The webhook therefore writes `subscription_status =
'active'`. Unreachable Stripe renders as "couldn't check", never as healthy.

⚠️ This section used to add "and `cancel_at_period_end` is stored nowhere. A stored
flag would also be wrong for everyone already paused." **0087 stores it**, as
`cancel_at_period_end` / `gr_cancel_at_period_end`, because the Monday label rule
had to be a pure function of the row (§23.2). The objection above was specifically
about back-filling a flag for customers who were *already* paused, where the true
value was unknowable — there was nothing to backfill at apply time, since no
customer had ever cancelled.

**The Paused tab should still read Stripe live.** It answers "can we actually
re-bill this person right now", which wants the live truth rather than our cache of
it. The stored flags gate nothing and are read only by the label rule.

**That same mode is why cancellation reasons are captured outside the
`status = 'canceled'` branch.** `cancellation_details` is populated on the
*updated* event, at the moment the customer gives it — reading it only on
cancellation would discard it then and recover it a billing period later, having
nulled it in between. The columns are cleared only when a subscription is active
**and** no longer scheduled to cancel, which is the only genuine change of mind;
`cancelled_at` now follows the same rule, so a pending cancellation no longer
wipes the date of a previous one.

### Backfill

0084 writes one episode per already-paused customer with
`reasons = '{unknown_pre_0077}'` — a distinct sentinel, never a plausible-looking
reason, so "we never asked" stays countable separately from "they told us". It is
`insert…select…where not exists`, so it is idempotent and picks up whoever is
genuinely paused at apply time.

---

## 22. Announcements *(0085)*

`/admin/announcements`. An admin writes a message, chooses who it goes to, sends
a test, confirms, and it is emailed through Resend and shown as a dismissible
banner on the customer dashboard.

The first thing this system sends that is not about a lead. Everything else is
machine-generated and lead-shaped, so a price change or a planned outage had no
channel at all — in practice, addresses pasted into a mail client by hand.

Three tables, all RLS-enabled with **no policies** (deny-all to the browser, as
`operator_proof_snapshots`): `announcements`, `announcement_deliveries`,
`announcement_dismissals`. Entirely additive; nothing here touches a balance,
counter, pacing or capacity column.

### 21.1 — Audience decides the email; audience alone decides the banner

`announcement_deliveries` records who was **emailed**. The dashboard banner is
governed by the audience rule **only**, so a customer who turned announcement
emails off still reads the notice in the app, and so does one whose email
bounced. The opt-out is a preference about their inbox, not a request to be kept
uninformed.

`announcementTargetsCustomer()` in `src/lib/announcements.ts` is the single
definition, shared by the send route and the banner — the same discipline as
`customer_can_see_pool_lead` (§19.4). Two readings of "management customer"
would eventually disagree, and the failure is silent both ways.

| `audience` | Test |
|---|---|
| `management` | `account_status = 'active'` **and** `subscription_status = 'active'` |
| `guaranteed_rent` | `gr_subscription_status = 'active'`, and **nothing else** |
| `all` | either of the above, **one email per customer** |

The GR branch must never read `account_status` (invariant 6). Measured on live
data at build time: **1 of 1** GR subscribers would have been skipped if it did —
a GR-only account sits at `account_status = 'waitlisted'` forever (§18A).

`all` dedupes by **customer**, not by product, so somebody holding both gets one
email. This is the opposite of the MRR figures in §18A, which count per product
deliberately.

**Paused management customers are included**, following §18B's asymmetry: the
nudge skips them because it asks for work, the progress report does not because
it describes work already done. An announcement is a notice, so it follows the
report — somebody paused for three months still needs to hear about a price
change. Two customers are paused today.

The candidate query is the crons' verbatim (`is_active = true` plus the
`subscription_status`/`gr_subscription_status` union). `is_active` is
load-bearing: one archived-but-subscribed row exists today (§18D), and without
the filter that person would be emailed twice.

### 21.2 — Idempotency is the unique index, not the status column

`announcement_deliveries` is unique on `(announcement_id, customer_id)`. The send
**claims a recipient by INSERT and only then calls Resend**, so a double-clicked
button, a browser retry, or a second run after a timeout all collide on `23505`
and skip. Same guard `credit_invoice()` uses against Stripe redelivery (§19.5),
and for the same reason: checking whether we already sent, then sending, leaves a
window. Claiming by write does not.

This is also why a run left at `status = 'sending'` by a killed function is
**re-enterable** rather than jammed. `status` is presentation; the index is what
makes a second attempt safe. `recipient_count` is read back from the delivery log
rather than counted in the loop, so a resumed run does not record only its half.

**A failed delivery keeps its row and is not retried.** The row is the record
that we tried, which is a different fact from never having tried, and deleting it
would let a retry double-send a message Resend may have accepted before erroring.
The admin page surfaces failures with the address; chasing one by hand at this
list size is trivial, and a sent announcement refuses a second send outright.

### 21.3 — Pacing and the recipient ceiling

Sends are sequential with **600ms between them**. Resend's default limit is 2
requests a second; the existing crons ignore it because they trickle out on a
schedule, but this fires the whole book on a button press, which is exactly the
shape that trips a rate limiter. With `maxDuration = 300` that puts the ceiling at
**~450 recipients**. Today's book is 21. If it ever approaches the ceiling the fix
is Resend's batch endpoint (100 per call), not a longer timeout — `resend.batch`
is not used anywhere in the repo today.

### 21.4 — Draft, test, confirm

Sending is in `AnnouncementSendPanel`, deliberately **not** in the compose form.
A form whose submit button sometimes saves and sometimes mails the entire
customer book is one mis-click from something that cannot be undone.

- `POST .../[id]/test` sends one copy, defaulting to the signed-in admin's own
  address, prefixed `[TEST]`. Writes no delivery row and does not touch status.
- `?dryRun=true` on the send route reports the exact recipient list and sends
  nothing, matching `monthly-insights` and `inactivity-nudge`. `GET` serves the
  dry run **only** and refuses anything else with a 405, so no GET can send.
- The confirmation is an expanded inline panel naming the count and the audience
  in words, following the reject confirmation in `LeadDetail` rather than a
  two-button swap — a swap asks "are you sure" with no new information, and the
  count and the audience are exactly the two things an admin can have wrong
  without noticing.
- Recipient counts for all three audiences are computed **server-side** from one
  query and passed into the form, so the number on each audience button is the
  number that would actually be emailed and no endpoint exists to poll.

**A sent announcement is read-only.** PATCH and DELETE both refuse it with a 409.
It is already in inboxes: editing would leave the banner saying something nobody
was emailed and the delivery log describing the delivery of different words. The
way to correct a sent announcement is another announcement.

### 21.5 — The body is plain text, and escaping is load-bearing

No markdown renderer is installed, so `body_text` is split on blank lines into
paragraphs — the same treatment `/dashboard/training/[slug]` gives
`body_markdown`, extracted as `paragraphs()` so the email and the banner break
the text in identical places.

Every paragraph, the title and the **link label** go through `esc()` before
reaching the HTML email. The label matters: `button()` drops it into the anchor
unescaped, and every other caller in `emails.ts` passes a hard-coded string where
this one passes whatever an admin typed. `link_url` needs no escaping because the
write route runs it through `new URL().toString()`, which percent-encodes the
quote that would otherwise break out of the `href` — and rejects anything that is
not `https:`.

### 21.6 — The banner

Newest undismissed announcement addressed to that customer, `show_banner = true`,
within `BANNER_MAX_AGE_DAYS` (30). **One banner, never a stack** — two notices
competing for the top of the dashboard is how both get ignored. The 30-day
cut-off is what stops an undismissed banner living there forever.

Dismissal is optimistic and per customer, through
`POST /api/customer/announcements/[id]/dismiss` — the §8 pattern, identity from
the session and never the body, upserted so a double click is not an error.

**The `notifications` table was deliberately not reused.** It was the obvious
reuse and it is wrong: `NotificationsCentre` marks every row read the moment the
bell is opened, and its click handler navigates to a lead, falling back to the
leads list. An announcement in there would be marked read without being seen and
would send the reader to a page about something else.

### 21.7 — Opt-out

`announcements` joins `notification_preferences`, opt-out only, a missing key
reading as true. A new key touches four places, all following `monthly_insights`:
the type, `PREFERENCE_KEYS`/`DEFAULT_PREFERENCES` in the settings route,
`PREFERENCE_ROWS` **and** the `useState` initialiser in `SettingsPanel`, and the
migration's default plus `||` backfill.

### Verification

All 85 migrations applied to a scratch Postgres 16 from empty; every CHECK and
the delivery unique index exercised against seeded rows, including confirming the
`||` backfill preserves an existing explicit `false` on another stream. The
audience rule, the both-holder dedupe and the validator were unit-checked, and
the email template was rendered with a hostile body (`<script>`, `<img onerror>`,
`&`, quotes) to confirm nothing escapes into markup. The candidate query was run
read-only against production: 21 emailable, 20 management, 1 GR.

### Deployment order — migration BEFORE code

0085 must be applied before the code deploys, or the admin page renders against
missing tables and the dashboard banner query fails. Nothing else in the app
reads these tables, so a lagging migration cannot affect lead allocation.

---

## 23. Monday subscription-status sync *(0086)*

Board **18420649520** ("Stayful Lead database enquiries") is the sales board for
operator prospects. Its Status column **`color_mm5eda07`** carries ten labels;
five of them describe a subscription, and until now every one was set by hand, so
the board was only as current as the last time somebody remembered. The Stripe
events that already move a customer's status in Postgres now move the label too.

The first Monday **mutation** in the codebase. `monday.ts` previously only read
the two lead boards and created items on the two enquiry boards.

**n8n is not involved.** n8n feeds leads *into* the app (`/api/webhook/n8n`);
this is the opposite direction and the app already writes to this board directly.

### 23.1 — Who owns what

| | Owner |
|---|---|
| The five subscription labels | **This code** |
| The five sales labels (`Web meeting booked/sat/no show`, `In the future`, `In the future due to call`) | Sales, by hand — never written from code |
| Group placement | The board's own automations |
| `Customer start date` / `Customer end date` | **This code** (see 23.3) |

Ten "when status changes to X, move item to group Y" automations place every item,
and all 34 items currently sit in the group matching their label. So the code sets
one cell and the grouping follows. **Verified against the live board that an
API-driven column change does fire those automations** — the whole design rests on
it, so re-check that before assuming a future board behaves the same way.

`setEnquiryStatus()` writes with `create_labels_if_missing: false`, so a wrong or
mis-cased label **fails loudly** rather than adding an eleventh label to a column
the grouping depends on. Verified: `"Guaranteed Rent Customer"` is rejected.

⚠️ **Casing is exact and inconsistent between the two customer labels**:
`Management Customer` (capital C) but `Guaranteed rent customer` (lower r, lower
c). ⚠️ **Label index 5 does not exist** — a deleted label — so an index must never
be derived from position. `ENQUIRY_STATUS` in `monday.ts` is the only place these
strings should live.

### 23.2 — The label rule

`mondayStatusLabelFor()` in `src/lib/mondayStatus.ts` is the single definition,
shared by the webhook, the pause route, the resume cron and the admin check tool —
the same discipline as `announcementTargetsCustomer()` (§22) and
`customer_can_see_pool_lead` (§19.4). **The order is the rule:**

| # | Condition | Label |
|---|---|---|
| 0 | `is_active = false` | **`null`** |
| 1 | management cancelling-or-cancelled **and GR not still there** | `Cancelled` |
| 2 | `paused_at is not null` | `Paused` |
| 3 | management `subscription_status = 'past_due'` | `Wants to pay card declined` |
| 4 | holds management, not cancelling | `Management Customer` |
| 5 | GR active and not cancelling | `Guaranteed rent customer` |
| 6 | GR `past_due` and not cancelling | `Wants to pay card declined` |
| 7 | GR cancelling-or-cancelled, management not held | `Cancelled` |
| 8 | otherwise | **`null`** |

- **`null` means "do not write", and rules 0 and 8 are the safety mechanism for
  the whole feature.** A waitlisted prospect sitting at `Web meeting booked` has no
  commercial state to report, so their hand-set label survives.
- **Rule 0 keeps archived rows out.** §18D: the superseded duplicate is precisely
  the row carrying the board's stale email in both live mismatch cases, so without
  it the archived and live rows would compete for one cell.
- **`Paused` before `Management Customer`** — a paused customer is
  `account_status = 'active'` *and* `subscription_status = 'active'` (§21), so
  testing "held" first would never reach `Paused`.
- **`past_due` before rule 4** because `holdsProduct()` counts `past_due` as held.
  Recovery needs no code: `invoice.paid` clears it and rule 4 takes over.
- **Cancellation outranks held, GR outranks cancellation.** Somebody who cancels
  management but keeps GR reads `Guaranteed rent customer` — still a paying
  customer. Management-wins applies only between two *live* products.
- **Management cancellation is derived from `subscription_status`, never
  `account_status`** — see 23.6.

Deliberately not reusing `holdsProduct()` as the whole rule: it treats `past_due`
as held, which is right for "offer them a checkout" and wrong here.

### 23.3 — Why the date columns had to move into code

Two board automations used to write them, and both become wrong the moment the
label is automated:

- `7920935809` (status → `Management Customer`) set **Customer start date = Now**
  on **every** entry into that label. **Verified live** by clearing the cell and
  flipping `Paused` → `Management Customer`, which re-stamped it. Left alone it
  would reset the start date of every customer who resumes a pause, recovers a
  failed payment or re-subscribes — silent data loss on exactly the customers whose
  history matters most.
- `7920935830` (status → `Cancelled`) set **Customer end date = Now**, which with
  `Cancelled` written at click records the request date, not the end of service.

**Prerequisite, done on the Monday side:** delete `7920935830` (its group move is
already duplicated by `7921870420`) and strip the start-date action from
`7920935809`, which cannot be deleted because it is the only automation moving
items into `group_mm5f9by1`.

The code then writes status and both dates in one
`change_multiple_column_values` call, so they can never be half applied:

- **Start date: first write wins** — only sent when the cell is empty, mirroring
  the `coalesce` on `first_contacted_at` (§6). This also closes a gap: GR customers
  never got a start date, because `7921747590` only moves the group.
- **End date: the real end of service** — `sub.cancel_at` (falling back to
  `subscriptionPeriodEnd()`) on a pending cancellation, `ended_at ?? canceled_at`
  once it has happened, and **cleared** on a change of mind, in the same branch
  that clears `cancellation_feedback`.
- `endDate` is `string | null | undefined`: set, clear, leave alone. `{}` clears a
  Monday date cell.

`subscriptionPeriodEnd()` moved into `src/lib/stripe.ts` and is shared with the
admin billing panel — `current_period_end` moved onto subscription items in the
newer API version and `getStripe()` pins no `apiVersion`, so both readings must
stay identical.

### 23.4 — `monday_status_label` is a cache, not a fact

It is **"the label WE last wrote"**, not what the board currently says, and nothing
reads it to decide business state. Two consequences:

- **A renewal costs zero Monday HTTP.** `invoice.paid` fires monthly per customer;
  the cache comparison short-circuits before any API call.
- **We write on TRANSITIONS, not continuously**, so a manual edit to the Status
  cell survives until that customer's next genuine lifecycle change. Reading the
  board's label first would instead make our write conditional on somebody else's
  edit — and double the round trips.

A date instruction costs one item read, but `endDateNeedsWrite()` still suppresses
the **write** when the cell already agrees — `customer.subscription.updated` fires
on all sorts of unrelated changes and arrives asking to clear an end date that is
almost always already empty. It compares on the date part only, because Monday
returns `YYYY-MM-DD` or `YYYY-MM-DD HH:MM` depending on whether a time was ever
set and the old automation wrote times.

On a failed push `monday_status_label` is left **unchanged** so the next event
retries naturally; `monday_status_error` carries the reason for the admin cell.

⚠️ One automation can overwrite our label: **`7921640231`** sets the status to
`In the future due to call` whenever `date_mm60kphq` equals the current date. A
paying customer with a stale due-to-call date would be flipped off
`Management Customer` by Monday itself, and the cache means we will not re-correct
it until their next lifecycle event. The check tool reports the drift; the durable
fix is scoping that automation to prospect statuses, on the Monday side.

### 23.5 — Item resolution is tiered, and email alone is not enough

`customers` had no Monday link at all. `/api/enquiry` now keeps the item id
`createEnquiryContact()` has always returned and discarded, which covers every
future prospect. For everyone else `matchItemForCustomer()` — pure, so it can be
run read-only before anything writes — tries **email, then mobile's last 9 digits
(the 0070 rule), then name**, each tier needing **exactly one** hit to win.

Measured on live data: 16 of 18 customer items match by email; the other two carry
the customer's original address while the live row has a newer one, and in both
cases the board's address matches an **archived** duplicate row. Both resolve on
name. One email cell holds two addresses separated by a space; one differs only by
case.

Read-only run over all 31 active customers: **30 resolve — 28 email, 2 name — no
item claimed twice, and the first run would change nothing**, because the
hand-maintained board already agrees with the rule. The one unresolved customer is
a GR-form enquirer whose only item is on the status-less GR board (23.7).

`monday_item_id` is **deliberately not unique** (see the 0086 header): the link is
a best-effort match, and a unique violation raised inside the webhook's lazy
resolution is far worse than a recorded collision, because the handler deletes its
`stripe_events` claim on any throw. `monday_link_state` records `ambiguous`
instead. The manual link route is the one place a uniqueness check belongs, because
a human is choosing.

### 23.6 — Hook points, and the one hard contract

| Transition | Where |
|---|---|
| Management becomes paying | `invoice.paid` management branch, after the promotion and renewal writes |
| GR becomes paying | `invoice.paid` GR branch, after `gr_subscription_status: 'active'` |
| Cancel · re-subscribe · GR status change · early resume | **one** call at the end of `customer.subscription.*` |
| Payment failed | end of `invoice.payment_failed` |
| Pause | pause route, after the confirmation email |
| Resume (scheduled) | resume cron, inside the cleared-pause branch |

**NOTHING MAY THROW OUT OF THE WEBHOOK.** The handler deletes its `stripe_events`
idempotency claim on any throw so Stripe retries, so an exception escaping a
Monday failure would make Stripe redeliver an invoice that has **already been
credited**. `setEnquiryStatus` and `syncCustomerMondayStatus` both return result
objects, and every call site also wraps in `try/catch`. Do not "simplify" that.

Ordering that matters: the subscription hook goes **after** the resume-detection
block, because that block can clear `paused_at` including on a cancellation
(§21's third case), so an earlier push would label somebody who has just left as
`Paused`. The pause hook goes **after** the Stripe call and its rollback window,
for the reason that file already gives about phantom state.

**`cancel_at_period_end` is STORED, and the label rule reads it (0087).** It was
briefly a parameter passed in from the webhook, on the grounds that §21 kept it out
of the schema — and that was a bug, not a design. Only the subscription branch could
supply it, so every other hook (a GR renewal, a failed payment, a pause, a resume)
recomputed the label without it, decided the customer was simply active, and wrote
`Management Customer` back over `Cancelled`. A cancellation could therefore be
silently undone on the board for the rest of the customer's paid period.

A rule that must not vary by caller cannot take a parameter every caller has to
remember. `mondayStatusLabelFor()` is now a pure function of the row, so all hooks
necessarily agree. Both products have the flag, so a GR cancellation shows at the
moment it is requested rather than a billing period later.

This also removes the blocker on a **reconciliation cron** — the reason there was
none is that a scheduled job could not see a pending cancellation and would have
flipped a leaving customer back. It could now be written safely. Still not built,
because event-driven writes plus the check tool have covered everything so far.

### 23.7 — GR customers and the status-less board

GR enquiries go to board **18420913271**, which has **no status column at all**.
Karey Summers, the one GR customer, sits on 18420649520 — added by hand. So a GR
customer arriving through the GR form has no labelable item. `monday_board_id`
exists for exactly this: the writer refuses a non-status board
(`skipped: "not_status_board"`) rather than erroring at Monday, and the check tool
lists them as orphans for the same hand-fix Karey already had. At a GR population
of one that is proportionate; automating it means either creating the item on
18420649520 from the GR enquiry path or letting the sync create one.

### 23.8 — `GET /api/admin/monday-status-check`

Read-only by default; `?link=1` stores the resolved links and fills
`monday_status_label` where the board **already** agrees. **It never writes to
Monday.** Reports label drift, unresolved and ambiguous customers, items claimed
by two customers, and orphan items. Run it with `?link=1` once before wiring
anything, so the first live event finds a populated cache and a stored item id.

The admin customers table gained a **Monday** cell (`No board item`,
`Ambiguous match`, `Push failed`, or the label we last wrote, linking to the item),
and `POST /api/admin/customers/[id]/monday-link` links or unlinks by hand. That
route clears `monday_status_label` deliberately — leaving a stale value against a
*new* item would suppress the first push to it.

### 23.9 — The re-subscribe promotion fix, shipped alongside

`invoice.paid` promoted `account_status` only `.in(['invited','waitlisted'])`, and
`provisionPaidSubscriber` short-circuits on a known `stripe_customer_id` before
its activation object applies. So a customer who cancelled and re-subscribed kept
`account_status = 'cancelled'` **for ever**, which meant:

- **no leads** — both candidate functions require `account_status = 'active'`
  (0073) — while `credit_invoice` kept topping up `lead_balance` every month,
  banking credits that could never be spent;
- no nudge, no weekly report, no announcements;
- no pause, no top-ups;
- absent from capacity, MRR and active counts, and reading inactive in admin.

The board would have read `Management Customer` throughout, because the label rule
keys on `subscription_status` — making it the one place that looked healthy.
`'cancelled'` is now included in the promotion, which is safe because it is gated
on a **paid invoice**. The label rule still keys on `subscription_status` anyway, so
it does not depend on the fix having run.

~~**Still open:** there is no in-app route back for a cancelled customer.~~
**Closed** — `invite/route.ts` now accepts `cancelled` as well as `waitlisted`
(§18E). Before that the only working route was a hand-made Payment Link, which
healed the row incidentally: a new Stripe customer misses the lookup, so
provisioning's by-email branch applied `account_status: 'active'`. The promotion
fix above is what makes the in-app route safe, because an admin re-invite reuses
the customer's EXISTING `stripe_customer_id`, so the webhook lookup succeeds,
`provisionPaidSubscriber` short-circuits, and the promotion is the only thing that
reactivates them.

### 23.10 — What a review caught, and why it clustered where it did

The first cut of this feature passed a thorough label-rule and matcher test suite and
still shipped several real defects. Every one of them was on a **failure path** —
which is exactly what those suites did not touch. Recorded because the pattern is
more useful than the individual fixes:

| Defect | Why it mattered |
|---|---|
| Pending cancellation was a parameter, not a column | Any other hook recomputed a leaving customer as `Management Customer` and wrote it over `Cancelled` — see §23.6. Fixed by 0087. |
| A missing board read as an **empty** board | Monday returns `boards: []` for an id it cannot see, which yielded `ok:true` with zero items — so a mistyped board id would have marked the whole book `not_found`. Now an explicit failure. |
| `board_unreadable` / `not_configured` were never logged | Call sites logged only on `error`, so a revoked token would have stopped the sync silently. Skip codes are now logged and recorded on the row. |
| `?link=1` re-derived every link | Overwrote a hand-made link — the one repair available for a customer matching cannot reach. It now never overwrites an existing status-board link. |
| `monday-link` did not check the board | `items(ids:)` is not board-scoped, so an id from any other board validated and then failed on every push. |
| A repeat enquiry repointed the link | This route creates a new item per submission, so status writes would land on the duplicate while sales worked the original. First item wins. |
| A GR-board link was terminal | `resolveItem` short-circuited on any stored id, so a GR-form enquirer could never later be matched to a management-board item. A stored link is now trusted only when it is on the status board. |
| End date was management-only | The automation being deleted stamped it for **both** products, so a departing GR customer would have silently lost their end date. |

The lesson worth keeping: a suite that only exercises the happy path will report
"verified" on code whose failure modes are all silent. The label rule and matcher
were tested hard; the things around them were not tested at all.

### Verification

No test suite, so: all **83 migrations applied to a scratch Postgres 16 from
empty**; 0086's two CHECK constraints exercised and its non-uniqueness confirmed;
0087's NOT NULL and defaults exercised; both re-applied to prove idempotency.

The label rule was driven through **26 cases** covering every ordered branch —
including the GR pending-cancellation symmetry 0087 added, both products cancelling
at once, and the distinction between a GR customer who is leaving and one who is
merely `past_due`. The matcher and `endDateNeedsWrite` went through **21**, among
them the phone tier, which resolves nobody on today's data and would otherwise ship
unexercised, and the two-items-share-a-number ambiguity case that exists on the live
board.

Both were then run against the real board and the real 31 active customer rows,
read-only: **30 resolve — 28 by email, 2 by name — no item claimed twice, and the
first run would change no label**, because the hand-maintained board already agrees
with the rule. The one unresolved customer is the GR-form enquirer of §23.7.

On the live board a throwaway item confirmed the automations fire on API writes,
that the start-date automation re-stamps on **every** entry into `Management
Customer` (the finding §23.3 rests on), that `{}` clears a date cell, and that a
mis-cased label is rejected. It was deleted afterwards and the board is back to 34
items.

### Deployment order

Migrations 0086 and 0087 first, then the library code (inert on its own), then the check tool
run with `?link=1`, **then the two Monday automation edits (23.3)**, and only then
the hooks. Everything before that step changes no board data, so there is no window
where the code is live and fighting the automations.
## 24. Self-serve tier changes *(0088)*

A subscriber can move between the 10-lead and 20-lead tier of a product they
already hold, from `/dashboard/packages` and `/dashboard/settings`.
`POST /api/customer/subscription/plan`.

**Choosing a tier when BUYING the other product already worked** and is
untouched here: `PackageUpsellCard` has rendered a 10/20 selector for any
two-plan product since the £300/20 GR plan shipped, and `/api/customer/subscribe`
has always accepted `plan`. What did not exist was resizing a live subscription —
there was no `subscriptions.update` price swap anywhere in the repo, only
pause/resume, so a tier change meant an admin editing Stripe by hand.

### The change lands at the next billing date, and that is the whole design

`proration_behavior: "none"`. Nothing is charged or refunded on the day; the
customer keeps the cycle they have paid for at the tier they paid for, and the
new price arrives on their natural next invoice. A customer who needs leads
sooner already has Top up.

**The route does not write the allocation.** `invoice.paid` credits
`(gr_)monthly_allocation` (§17) and the same column drives deficit-first pacing
and weighted capacity — but Stripe applies a price swap **immediately**, even
with no proration; only the billing waits. Writing the allocation at swap time
would therefore pace a customer at 20 leads through a month they paid £150 for,
or starve one who has already paid £300 down to 10. So the new figure is parked
in `(gr_)pending_monthly_allocation` and the **webhook applies it at the next
paid invoice** — the same moment `credit_invoice()` grants the leads it sizes.

`applyPendingPlanChange()` in `src/lib/planChanges.ts` is the single expression
of that, called from both halves of `invoice.paid`.

**It applies only when the invoice's own price agrees with the pending figure.**
That equality test is the safety: a stray, replayed or out-of-order invoice can
never promote a change early, and an allocation an admin has hand-edited is
still never silently re-sized from an invoice — the line §17 drew when it
declined to switch crediting onto `allocationFromPrices` wholesale. That broader
change has **not** been made. If the apply write fails, the **old** tier is
credited: under-crediting by a tier is recoverable because the balance carries
forward (invariant 2) and the next invoice applies the change, where crediting a
tier the row does not record is not.

### The GR auto-resize has to stand down for these

The GR backstop (§17) re-sizes `gr_monthly_allocation` whenever the
subscription's price stops matching `gr_stripe_price_id`. Our swap changes that
price instantly, so without a guard the backstop would undo the deferral within
seconds and re-size the customer a month early. It now skips when the row
carries a `gr_pending_monthly_allocation` equal to the price's allocation. A GR
plan switch made in the Stripe portal or by an admin has no pending row and
still re-sizes at once, exactly as before.

### Live state on `customers`, history in the table

The §21 split. `(gr_)pending_monthly_allocation` is the **only** authority on
whether a change is outstanding; `subscription_plan_changes` is a best-effort
audit trail and every write to it logs rather than throws. A missing history row
is a reporting gap; a failed plan change is a customer's money.

`customers` is read by `getCurrentCustomer()` on the **service role** with
`select("*")`, so the dashboard sees the pending columns with no RLS work.
`subscription_plan_changes` therefore has RLS on with **no policy** — deny-all
to the browser, as `subscription_pauses` and `operator_proof_snapshots`.

### Reverting is the same request

Asking for the tier you are currently on, while a change is pending, swaps the
price back and clears the pending columns. One code path, so the undo can never
diverge from the do. A second change before the first has billed supersedes it,
closing the earlier history row as `cancelled_at`.

### Guards

- **Must hold the product** (`holdsProduct`) — 403 otherwise.
- **Paused blocks the management side only** (invariant 6): under a pause Stripe
  is voiding invoices and a price change would land at an unpredictable moment.
  GR keeps flowing to a paused management customer, so `paused_at` must not gate
  it. A pending **cancellation** is deliberately allowed — somebody weighing up
  leaving is exactly who should be able to drop a tier instead.
- **No subscription id → 409 with a support message.** Comped and hand-provisioned
  accounts genuinely have nothing to resize.
- **A subscription with more than one item is refused.** This route swaps one
  item's price and must never guess which.

Stripe is called **first**, then the database; a failed DB write swaps the price
back. A row that disagrees with Stripe is worse than a failed request. Same
concern as the pause route's rollback, in the opposite order — there the DB
write is the thing that can be undone safely, here it is the price.

`current_period_end` comes from `subscriptionPeriodEnd()` in `src/lib/stripe.ts`
— the same helper the admin billing panel and the Monday sync (§23) use. That
field sits on the subscription or on its items depending on the account's API
version, and two readings of "when does this subscription actually end" would
eventually disagree.

### `customers.stripe_price_id`

Added for symmetry with `gr_stripe_price_id` and because which price a
management customer is actually billed on was otherwise invisible to admin.
**Observability only — nothing gates on it**, and deliberately no allocation
re-size follows it.

### Verification

All 82 migrations applied to a scratch Postgres 16 from empty. Both CHECKs were
exercised (zero and negative rejected), the `lead_type` CHECK rejected an
invalid product, the FK cascade was confirmed on customer delete, and the
partial index was confirmed to serve the open-change lookup. `credit_invoice`
was run against a seeded row after an applied change to confirm it credits the
**new** tier, and replayed to confirm the idempotency claim still short-circuits.
`applyPendingPlanChange` was unit-checked over six cases: nothing pending, price
matches, price disagrees, unrecognised price, GR downgrade writing only `gr_`
columns, and a failed write falling back to the old tier.

**Not rehearsed against Stripe.** The only account reachable from the build
session is livemode, so the price swap itself has not been exercised end to end
— do that in test mode before relying on it (see §12).

### Deployment order — migration BEFORE code

0088 must be applied before the code deploys. The webhook selects the pending
columns on **every** `invoice.paid`, so a lagging migration would break
crediting for everybody, not just for customers using this feature.

---

## 25. Estimated gross income on a lead *(0089)*

Every sellable item on the management leads board (18420117742) carries a
Stayful property-analysis PDF in the **`files__1`** "Deal Analyser" column, and
that PDF states the property's projected gross short-term-let revenue. Nothing
read it, so an operator deciding whether to work a lead saw a name, an address
and a bedroom count and no indication of what the property was worth.

Each management lead now shows the projected **gross income** as a range 10%
either side of the estimate, and beside it what that property earns a
**management company** at a 15% fee.

**Live coverage, measured over the whole book at backfill:** of 170 management
leads, **149 parsed, 21 carry no analysis on their Monday item, 0 unparsed, 0
failed**. All 149 carry a nightly rate and occupancy; **137 of those reconcile with
the gross** and are worded as its basis, the other 12 as comparables (below). Gross ranges from £9,573 to £149,283 (median
£39,614); nightly rate £57–£755 (median £180); occupancy 33%–85% (median 60%).

### The report is not part of the product

No PDF is attached to a lead, no URL is stored, and nothing links to one.
Monday's `public_url` is a **one-hour signed S3 link** — fetched, read for one
number, discarded. A stored copy would be dead within the hour, and a live
fetch would hand the customer the whole analysis, which is not what is sold.
`leads.income_report_asset_id` is an opaque id, never rendered and never a link;
it exists only so the sweep can skip a report it has already read.

### The nightly rate and occupancy behind it *(0090)*

The same headline block states the property's **average nightly rate** and its
**occupancy rate**, and `rate × 365 × occupancy` **is** the gross figure. Both
are stored on `leads` — `avg_nightly_rate` in whole pounds, `occupancy_rate` as
the percentage printed (63, not 0.63) — and shown as one supporting line under
the ranges: *"Based on £157 a night at 63% occupancy."* No range on either;
they are point figures the report states.

They ride on `income_report_status`. A second status column would be a second
source of truth about a single parse.

**They fail alone, and that is the whole design.** `gross_annual_income` is
live on leads customers already read; losing it because a nightly rate could
not be found would trade a working figure for a missing one. So the parser
publishes the gross with these two null rather than failing the lead, and
`NO_FIGURES` in `incomeReport.ts` is spread into every failure branch so a
fourth figure can never be added to the type and forgotten in one of them.

**Both or neither.** A rate without the occupancy it was measured at is not a
fact an operator can use.

#### The identity picks the WORDING, not whether to store *(0091)*

`rate × 365 × occupancy` reproduces the stated gross within **2%** on 137 of
149 live leads (0.00%–1.82%, average 0.55%). The next one up is **4.3%**, and
the rest run to 143% — the two populations are cleanly separated, so the test
detects something real about the document rather than drawing an arbitrary
line.

0090 used it as a storage gate and stored nothing on the twelve that miss.
That was the right instinct on the wrong lever: the report states those numbers
either way, and an operator opening one of those leads saw the money with
nothing behind it. What actually varies is whether the pair can be called the
basis of the gross. So `incomeBasis()` in `incomeProjection.ts` applies the
test at render time and picks between two wordings:

| | |
|---|---|
| reconciles (137) | *Based on £157 a night at 63% occupancy.* |
| does not (12) | *Comparable properties average £116 a night at 54% occupancy.* |

Both are true. The report captions its nightly rate **"ADR across comp set"** —
it is the comparable set's average, and usually the analyser prices the
property at that rate so the arithmetic closes. Where the property is unusual
against its comps it does not, and the second wording is then the honest
reading. `Stayful_Property_Analysis_Market_Place__Burslem` is the extreme:
£145 a night at 44% against a stated gross of £9,573 — a property that
genuinely underperforms its comparables, which is worth an operator knowing.

**Do not restore the storage gate.** Hiding a figure the document states, to
protect a sentence we chose to write, is the wrong way round.

The identity was never the primary defence against reading the **wrong** pair,
which is the objection this invites: the "Comparable Properties" page prints
`Avg Nightly Rate` and `Avg Occupancy`, while the anchors are `ADR across` and
`Market average`, which appear only in the headline block and cannot match it.

#### ⚠️ The headline labels are letter-spaced and unmatchable

In the PDF's text layer `AVG NIGHTLY RATE` comes out as
`AVG N I G H T LY R AT E`, with the spacing irregular enough (`LY`, `AT`) that
a tolerant pattern would be guesswork. Every anchor therefore reads the
**plain-rendered caption that follows the value** and captures backwards —
`£157 ADR across`, `63% Market average 62%`.

The gross figure escapes this only because the *Revenue Breakdown* table on a
later page prints it in ordinary title case, which is what `GROSS_RE` matches.
It never matched the headline. Anchoring on the obvious label is the thing that
does not work here.

The occupancy regex captures the market average as its second group and throws
it away: it was not asked for, and one live report states it as **0%** (no
comparable listings nearby) while its own figures are perfectly good, so
nothing may depend on it.

### `gross_annual_income` is OURS. `income_estimate` is THEIRS.

The single most important distinction in this section.

| | `leads.gross_annual_income` (0089) | `lead_assignments.income_estimate` (0012) |
|---|---|---|
| Whose | Stayful's, from the analyser | The operator's, typed by hand |
| Scope | One per **lead** | One per **assignment** |
| Two holders | See the same number | Can hold different numbers |
| Present | The moment the lead is delivered | Only once somebody types it |
| Feeds | The ranges below, and nothing else | Analytics income totals, the wins table, the pool's "last touched" clock |

They sit next to each other on the lead detail page on purpose. Never merge
them, sum them, or use one as a fallback for the other — the analytics totals
count the operator's figure precisely *because* it is the operator's.

### One stored figure, everything else derived

`gross_annual_income` is the only money column. The four ranges —
`src/lib/incomeProjection.ts`, `buildIncomeProjection()` — are computed on every
render:

```
low  = gross × 0.9        fee = <gross> / 6.667   (a 15% management fee)
high = gross × 1.1        monthly = <annual> / 12
```

Eight columns that must stay in step is eight chances to drift. Monthly is
`annual / 12` for the same reason: the PDF prints its own monthly line, but it
is only `round(annual / 12)`.

⚠️ `1/6.667` is not exactly `0.15`, so the derived fee can sit **£1** below the
one the report prints (which uses `× 0.15`). Irrelevant against a ±10% band, and
the parser's cross-check allows 1% for it. Do not "fix" it by switching to a
multiplier — 6.667 is the divisor the business states.

`leads.estimated_monthly_income` from 0001 is **not** reused: dead since day
one, `text` where this is numeric, and its name reads as the operator's figure.

### A mis-parse must fail silent

`parseIncomeReport()` matches `Gross Revenue £<annual> £<monthly>` — the
headline block and the "Revenue Breakdown" table both print it, and they agree —
then refuses to publish unless **two** independent cross-checks hold:

1. the stated monthly is the stated annual over twelve (2% tolerance), which is
   what kills a match that has straddled two unrelated table cells;
2. where the report states its own `Management Fees (15%)`, it agrees with
   `annual / 6.667` (1% tolerance) — the line that catches the analyser changing
   what it means by gross, before a customer does.

A wrong income figure is worse than no figure, because an operator prices a
call on it. The parser never throws; every failure becomes a status. The rate
and occupancy are reported as stated and judged at render time (above).

### The status column, and why it is not just "is the figure null"

Null means five things that need different handling:

| Status | Meaning | Retried? |
|---|---|---|
| `pending` | Never attempted | Yes |
| `parsed` | Figure set and corroborated | No |
| `no_report` | The item carries no analysis PDF | While the lead is under 30 days old |
| `unparsed` | A PDF was read and could not be trusted | No — a permanent fact about that document |
| `failed` | Monday unreachable, download errored, timed out | Yes |

`unparsed` vs `failed` is the load-bearing pair: a legacy third-party valuation
retried nightly forever is noise, and a transient S3 blip never retried is a
lead that silently never gets its figure.

### Management leads come from TWO Monday boards

`fetchMondayLeads` reads board **18420117742** ("Management leads for sale"),
but a substantial share of the management leads in the database arrived through
the **n8n webhook** (§4) and their items live on board **5891626711**
("Management Leads"), the main landlord pipeline. Those items carry the **same**
`Stayful_Property_Analysis_*.pdf` and parse identically — verified on live data.

This needs no board configuration, and must not acquire any:
`fetchIncomeReportAssets()` queries `items(ids:)`, which is **not board-scoped**,
so the sweep resolves a report wherever the item happens to live. What follows
from it is that **an n8n-ingested lead never gets the ingest-time parse** — only
the board sync attaches a report to the payload — so for those leads the sweep
is the only route, which is exactly what it is for.

### ⚠️ `items(ids:)` PAGINATES, and its default limit is 25

Asking for 40 ids returns the first 25 and says nothing about the other 15.
`fetchIncomeReportAssets` maps anything Monday did not return to `null`, which
`resolveIncomeReport` reads as "no report" — so an unset limit would have
permanently marked every lead past the 25th of each batch as `no_report`. That
is the worst shape of bug available here: silent, plausible, and indistinguishable
from a lead that genuinely has no analysis.

The function therefore chunks at `ITEMS_PER_CALL` (100, Monday's ceiling) and
passes an explicit `limit`. Caught during the launch backfill, not by the test
suite — the same lesson as §23.10: the tests covered the parser and the picker,
and nothing covered the shape of the API response around them.

### Two writers, and only one of them refreshes

- **`ingestLead()`, created leads only.** `fetchMondayLeads` now asks for
  `assets { id name public_url }` on the page read it already does, so the
  report costs no extra HTTP; `pickIncomeReportAsset()` takes the newest
  `Stayful_Property_Analysis*.pdf` (items accumulate spreadsheets, third-party
  valuations, and occasional re-runs). It runs **before** `autoAssignLead` so
  the figure is there when the delivery email lands, which puts a network call
  in front of the money path — hence the 8s timeout and the try/catch. **It can
  never fail ingest**; a failure leaves the row `pending`.
- **`/api/cron/parse-income-reports`, daily 12:00.** This is what keeps
  **existing** leads up to date, because `ingestLead` deliberately never touches
  an already-ingested row (§4) — without it the ~150 leads that predate the
  feature would never get a figure and a replaced report would keep the old one
  forever. Up to 150 leads a run — the 45s **wall-clock budget** is the real
  governor and the cap only exists to bound the query, because a low cap turns a
  backlog into a queue of nights. One Monday query per 100 ids, then one download
  each, `?dryRun=true` to list candidates without writing. A Monday failure
  aborts the batch **without writing**, rather than marking a whole batch failed
  because Monday was down for eight seconds.

**The cron only runs on production.** Vercel registers `vercel.json` crons on
production deployments only, so this job does nothing for a preview and nothing
at all until the branch is on `main`. A preview shows income figures only for
leads something else has already parsed.

### Management only

A GR operator earns the margin between the rent they pay and what the property
makes, not a 15% fee, so the figure would be *wrong* for them rather than
missing (invariant 6, §17). The GR board has a "PMI analysis" file column but no
item carries a file. `IncomeProjection` returns null for any non-management
lead, and both writers skip them.

### Where it shows

One component (`src/components/dashboard/IncomeProjection.tsx`), three
surfaces: the expanded feed card, the lead detail page, and the expired-leads
pool card (compact). An operator meets the same number in the feed, on the page
they work the lead from, and where they decide whether a pooled landlord is
worth ringing; a second implementation would eventually show two different
numbers for one property. It renders **nothing** without a figure — a lead with
no analysis should look like a lead from before this existed, not like a
property worth nothing.

Adding `gross_annual_income` to `get_customer_pool_leads` is **not** a breach of
0075's rule that nothing about previous holders may be returned. That rule is
about what the people who held the lead did with it; this is our own figure,
identical for every viewer.

Deliberately **not** on the admin pages or in the XLSX export — the figure is a
selling aid for operators, and the export's `!cols` width array is positional
and easy to mis-align.

### `unpdf` is pinned to `~1.7.0`

1.8.0 added `engines: { node: ">=22" }` and this project pins no Node version
anywhere, so a fresh install could pick a package the deployed runtime refuses.
1.7.0 has no engine floor and parses identically. `pdf-parse` is not an option:
it reads a bundled test file on import.

### Verification

All 85 migrations applied to a scratch Postgres 16 from empty, then 0089
re-applied to prove idempotency; the status CHECK exercised on every valid and
an invalid value; the partial index confirmed; `get_customer_pool_leads`
confirmed to still be `service_role`-only after **both** drop/recreates (the §11
ACL trap) and driven against seeded rows to confirm the figure and a null pass
through.

0090 was applied to a scratch Postgres and to production; its occupancy CHECK
was exercised on 101, −1, 0, 100 and null, and `get_customer_pool_leads`
confirmed `service_role`-only after a **third** drop/recreate. The extended
parser went through **33** cases, among them the regression guard that every
current report still yields a gross, the identity holding on everything
published, and the comp-set pair being rejected. The backfill then asserted, on
live data, that no lead has half a pair (0), none has a rate without a gross
(0), and all 149 gross figures survived untouched. 0091 moved the identity to
render time and went through **16** further cases — Barry Arnould and Burslem
returning their figures while never being called the basis, the 1.82%
worst-accepted case still reconciling, and the gross path unchanged.

`buildIncomeProjection` and `pickIncomeReportAsset` went through **22** cases,
including the three real multi-asset shapes on the live board
(xlsx + report, legacy PDF + report, two reports). The parser and
`resolveIncomeReport` went through **24**, among them every failure path — a
dead URL, a non-PDF body, a timeout, an empty buffer — and the twelve real
reports, one of which is a third-party valuation that must yield nothing.

Then against the live board and the live database. 0089 was applied to
`znlfwbnvhlacwzgfalcf` and re-verified there (columns, default, CHECK, partial
index, and `get_customer_pool_leads` still `service_role`-only after the
drop/recreate). The whole book was then backfilled by running the sweep's own
compiled modules over all 170 management leads — 149 parsed, 21 `no_report`, 0
unparsed, 0 failed, every item resolved on Monday. `get_customer_pool_leads` was
called for a real active customer and returns the figure. One lead was checked
end to end against its own report: Kieran England / Moorfields, gross £36,112 →
£32,501–£39,723 a year, fee £4,875–£5,958, midpoint £5,417 — which is exactly
what that PDF's own "Management Fees (15%)" line prints.

### Deployment order — migration BEFORE code

0089 first. `get_customer_pool_leads` changes its return shape, and every
customer lead surface selects `leads(*)`, so code arriving first would query
columns that do not exist. Nothing here touches a balance, counter, pacing or
capacity column, so a lagging migration cannot affect lead allocation.
