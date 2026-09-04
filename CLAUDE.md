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

### 1.1 — How a change lands

⚠️ **BRANCH AND OPEN A PULL REQUEST. NEVER PUSH TO `main` DIRECTLY**, whatever a
session's own default instructions say — several of them tell an agent to develop
on `main` and push there, and this file overrides that. Branch name
`claude/<short-slug>`, matching PR #84. There is **no PR template** in the repo;
write the body normally.

This was already the convention — PRs #78–#86 all landed as merge commits — and
it went unwritten until an agent pushed 0131 straight to `main` and nothing in
7,900 lines of this file contradicted the instruction telling it to.

Three consequences that are not obvious, because `main` **is** production:

- **The migration-before-code rule attaches to the MERGE, not the push.** Apply
  and verify the migration against production before the PR merges. Doing it at
  PR-open is still right and still safe, because every migration here is written
  additive-and-inert precisely so production can run the old code against the new
  schema — but the merge is the deadline.
- ⚠️ **A Vercel preview of a PR branch runs against PRODUCTION Supabase.** So a
  preview whose code selects columns that do not exist yet is broken until the
  migration lands, and §30 records what that costs: `fetchLeadVolumeData`
  swallowed the error and quoted **zero** filter volume while the admin tile read
  0. Another reason the migration goes first rather than last.
- ⚠️ **Re-check the highest migration number on `origin/main` immediately before
  pushing AND again before merging.** §43 records the trap; concurrent branches
  make it likelier. The sharper version has already happened: a parallel branch
  shipped §41 while another session was part-way through building the same
  feature, and §41.6 records what that cost.

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
| `/api/cron/run-lead-analysis` | `0 6 * * *` | **Backstop only** for the paid lead-analysis queue (§31). The queue is driven by the purchase, a self-chain and the progress poll; this catches the case where all three failed |
| `/api/cron/parse-income-reports` | `0 12 * * *` | Read the property-analysis PDF off each lead's Monday item (§25) |
| `/api/cron/monthly-insights` | `30 9 2 * *` | Monthly customer insight email |
| `/api/cron/poll-whatsapp-status` | `*/5 * * * *` | WhatsApp delivered/read (no vendor webhook), deferred-event recovery, **and sending due follow-up steps** (§40.9, §40.13) |
| `/api/cron/draft-sequence-messages` | `0 17 * * *` | Draft tomorrow's follow-up steps into the review queue (§40.13) |
| `/api/cron/contact-followups` | `15 8 * * *` | Today's follow-up prompt, and the weekly falling-behind notice (§42.8) |

`/api/cron/post-call-offer-reminders` exists but has **no `vercel.json` entry**
— removed in `173a746` when the plan was Hobby (daily-cron cap). The route needs
~15-minute cadence to hit its 12h/4h/1h windows and is currently driven by
nothing. See §12.

⚠️ **THE HOBBY WARNING THAT USED TO BE HERE IS OUT OF DATE. The team is on
Pro.** `GET /v2/teams` returns `plan: "pro"` for `zacs-projects-bcdb6016`
(re-checked 2026-08-29). What it said — "the Vercel API reports this team as
`hobby`… 2 crons, daily only… 60-second functions" — was true when written on
2026-08-25 and is no longer.

That correction matters in three directions, so it is worth stating rather than
just deleting:

- The **14** crons in the table above genuinely all fire. Under Hobby only two
  would, and §31.8 records a whole feature that was designed around believing
  they might not.
- `maxDuration = 300` works. `parse-income-reports`, the 0092 backfill and
  `draft-sequence-messages` all rely on it; under Hobby they were being cut
  short at 60 seconds.
- §31.8's "on Pro, three numbers change together" note is now actionable rather
  than hypothetical — the lead-analysis worker is still sized for a 60-second
  ceiling and could be raised.

`/api/cron/poll-whatsapp-status` at `*/5` is itself proof: a sub-daily schedule
is a Pro-only feature and it has been registered since §40 shipped.

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
first cancellation wins like `cancelled_at`), `cancel_effective_at` /
`gr_cancel_effective_at` and `pause_ending_notice_sent_at` (0101 — see §29), and the Monday link columns
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
`lead_type` selects the product. Idempotent on `monday_item_id` — which is
**nullable since 0102**, because a customer-owned lead has no Monday item; a
CHECK requires `monday_item_id is not null or owner_customer_id is not null`,
and the UNIQUE constraint is unaffected (Postgres allows many nulls).
`owner_customer_id` / `owner_source` mark a lead a customer added themselves,
which retires it from all allocation, escalation and pooling (§30).

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
`testimonials`, `public_activity_stats`, `lead_imports` (§30),
`lead_analysis_jobs` / `lead_analysis_rows` / `lead_analysis_tokens` (§31).

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
`/api/customer/subscribe` (§17), `/api/customer/subscription/pause` (§21),
`/api/customer/subscription/plan` (§24),
`/api/customer/subscription/cancel` (§29), `/api/leads/[id]/reject`,
`/api/leads/[id]/discard`, `/api/leads/[id]/close`,
`/api/leads/[id]/report` (§25 — the stored analysis PDF),
`/api/customer/presentation/[leadId]` (§26),
`/api/customer/settings/presentation` (§26),
`/api/leads/pool/[id]/claim` (§19), `/api/leads/export`, `/api/billing/portal`,
`/api/customer/my-leads` (+ `/import/preview`, `/import/commit`, and
`DELETE /[id]`) — customer-owned leads (§30).

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
4. Every delivered lead is chargeable. Reject does not refund. **One narrow
   exception, since 0114 (§39): a lead that is UNDELIVERED — untouched,
   returned to the pool at the customer's own request when they apply a lead
   filter that excludes it — is refunded.** The untouched predicate in
   `releasable_filter_assignments` is what keeps that distinct from a refund on
   worked-for value, and must never be loosened.
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
11. A lead that has been **claimed from the expired pool**, that pooled on the
    `ignored` basis, or that a **customer added themselves** (§30), is never
    re-allocated by ordinary routing (§19).
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
- **Orphaned reject columns, AND the function that reads them.**
  `rejection_reason`, `contact_validation_result`, `claim_denied` exist on
  `lead_assignments` in production but in **no migration** and no code — left
  by an abandoned branch. Do not reference them; a schema rebuilt from
  `supabase/migrations/` will not have them.
  ⚠️ **`apply_lead_rejection(uuid, uuid, lead_type, text, jsonb, boolean,
  boolean)` belongs to the same branch** and is the ONLY object still differing
  between production and a rebuild (§36.8's audit). It selects
  `rejection_reason` and `claim_denied` under a row lock, and nothing in `src/`
  calls it. It is **deliberately not committed**: a migration for it would
  enshrine dead code, and could not apply to a fresh build anyway, because the
  columns it reads are themselves in no migration. Drop it in production, or
  commit the columns with it — not one without the other.
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
  ⚠️ **This entry claimed it was already enabled on live configuration
  `bpc_1Tz1VxCpQPIFzv4r`. During the 0101 work that configuration could not be
  found**: `GET /v1/billing_portal/configurations` on the live account returned
  an EMPTY list, the id itself returned "No such configuration", and customers
  reported the portal offered no way to cancel — which is what prompted §29.
  Either the config was deleted since this was written or the id was recorded
  wrong. **Resolved on 2026-08-24**: saving the Customer portal settings page in
  the Dashboard created live configuration `bpc_1U7tJSBcGEHkDHo9FK2EnInH`
  (`is_default: true`, `subscription_cancel` enabled at `at_period_end`, reason
  collection on with all 8 options) — verified over the API. The likely
  explanation for the original state: the settings page RENDERS the template
  defaults (Cancel = On) even when no configuration object has ever been saved,
  so it looks configured while the hosted portal serves nothing. Because the
  config is the account default, `STRIPE_PORTAL_CONFIGURATION_ID` is optional
  belt-and-braces: set it in Vercel to pin `/api/billing/portal` to this exact
  config; unset, the route's bare session already gets it as the default.
- Rehearse the §29 cancel flow in Stripe **test mode** (the same standing item
  as §24's tier swap): the API path `subscriptions.update({
  cancel_at_period_end: true, cancellation_details })` has not been exercised
  end to end against a real subscription, only the webhook's handling of the
  resulting event shape has been reasoned through.

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

⚠️ **Guard 2 gained one exception in §32.3**: a customer who once HELD this
product may buy it back. `previouslyHeldProduct()` reads `cancelled_at` /
`gr_cancelled_at`, which only a real cancellation ever stamps, so a waitlisted
prospect still cannot satisfy it — self-serve **acquisition** stays retired, and
that is now structural rather than a matter of care. The exception is per
product: having once held management buys management back, not GR.

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

~~An `allocationFromPrices()` helper already exists in the webhook and would fix
this at source, but it is only used for post-call-offer labelling; switching the
credit onto it would silently re-size any hand-edited allocation that disagrees
with its price, so it was left alone.~~

⚠️ **Corrected. The management side is now backstopped, on GR's rule** — see
§33. The objection above was sound but it conflated two things: crediting from
the price, and re-sizing a hand-edited row. The fix does the first without the
second, by testing whether the **price has MOVED** from the one we last recorded
rather than whether it merely disagrees. A comp — row edited, price untouched —
is still never re-sized, which is the line this paragraph was drawing. A first
payment has no recorded price and therefore always corrects, which is where the
trap actually bit.

`allocationFromPrices()` is still not the helper for it: it never returns null,
guessing from the subtotal and defaulting to **20**. `allocationForPriceIds()`
in `plans.ts` is the strict twin the credit path uses.

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
bedroom count matching no filtered customer. `lead_matches_customer_filter()`
is that one definition, and since 0109 the **admin swap** consults it too
(§34), so every route a lead can reach a customer by now reads the same
predicate.

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

⚠️ **Since 0092 the full property analysis is readable from the pool card too**,
without claiming (§25). "Calling is free, keeping is not" is now "calling and
reading are free, keeping is not" — a knowing extension, not a leak. The
tailored presentation is the line that did not move: it needs an assignment.

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
3. *(§32.3)* `POST /api/customer/subscription/resume` — the customer pressed a
   button. Shares `resumePausedCustomer()` in `src/lib/resumePause.ts` with path
   1 **verbatim**, so an early resume and a scheduled one cannot drift apart.
   Unlike the cron it REFUSES a pending cancellation rather than skipping it,
   pointing at "Keep my subscription": their subscription is on record as
   ending, so resuming would restart collection for a period they closed.

Both are guarded on `.not("paused_at","is",null)` so only the writer that
actually flips the column sends the email, and both close the episode through
`stampEpisodeEnded()`.

Two 0101 additions to path 1, both in service of §29:

- **The cron skips customers with a pending cancellation**
  (`cancel_at_period_end = true`). A customer who cancelled while paused has
  said they are done — un-pausing them would email "billing has restarted" to
  somebody who asked to leave and put them back into routing. They stay paused
  until Stripe deletes the subscription, and the third case below clears the
  pause. Self-healing: "Keep my subscription" clears the flag and the next
  daily run resumes them normally.
- **A "your pause ends soon" notice** goes ~7 days before `pause_resumes_at`,
  once per pause, stating the exact date billing restarts with resume / change
  plan / cancel all pointed at Settings. Dedup is `pause_ending_notice_sent_at`,
  claimed by a guarded write BEFORE the send (the `credit_invoice` discipline)
  so a re-run cannot double-send; the stamp is nulled when a new pause starts
  and when a pause clears (all three clearers). Pending cancellations are
  skipped — "billing resumes" would be false for them.

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

### 21.8 — The feature-request button *(no migration)*

Every announcement — email and banner — carries a **Request a feature** button
under the content. Announcements were the one channel that was not lead-shaped,
and they were also one-way; this makes each notice a prompt for the operators to
say what they want built next.

**It reuses the flow that already existed.** `/feedback?type=feature`
(`src/app/feedback/page.tsx` → `/api/feedback` → `sendFeedbackEmail`) prefills
from the signed-in customer and emails `FEEDBACK_EMAIL`. Nothing is persisted,
there is no table and no admin screen, and the dashboard footer has linked the
same page since long before this. A second feature-request flow beside it would
be two inboxes and two definitions of the same ask.

**Unconditional, with no column and no toggle.** It renders whether or not the
admin set a CTA link, on every audience, in the `[TEST]` copy, and on the banner.
Nothing about an announcement can suppress it — which is what keeps the email and
the banner from ever disagreeing about whether the ask is present.

`src/lib/featureRequest.ts` is the one definition of the path, prompt and label,
shared by `sendAnnouncementEmail` and `AnnouncementBanner` — the same discipline
as `announcementTargetsCustomer` (§21.1) and `customer_can_see_pool_lead` (§19.4).
**It must stay import-free**: the banner is a `"use client"` component, so these
constants cannot live in `announcements.ts`, which pulls in supabase-js for
`fetchAnnouncementCandidates`.

The email uses an outlined `secondaryButton()` rather than `button()`. Two
brand-filled buttons stacked read as a choice between equals, and on an
announcement the admin's own call to action is the one that matters. On the
banner the block sits INSIDE the dismissible card: dismissing the notice
dismisses the ask with it, because it is part of the notice rather than a
permanent dashboard fixture.

#### ⚠️ The email URL goes through `esc()`, and every other one does not

`?type=feature&page=Announcement` is the **only href in `emails.ts` carrying a
query string** — every other `button()` call passes a bare path. So the comment
above `${cta}`, which explains why the admin's `linkUrl` skips `esc()`, does not
cover it: `new URL().toString()` percent-encodes the quote that would break out
of the attribute but leaves `&` alone, and a raw `&` between two query params is
not valid in an `href`. `esc()` replaces `&` before `<` and `>`, so it yields
`&amp;` with no double-escaping. Verified in Chromium: the browser parses the
attribute back to `?type=feature&page=Announcement`.

#### `page=Announcement` is attribution, and it is invisible on this form

It seeds the feedback form's page field, so a request that came from an
announcement says `Page: Announcement` in the team email — which is the only way
to tell whether this button does anything.

⚠️ **`FeedbackForm` renders that input under `isBug &&`, so it is bug-only.** On
a feature request the value is still seeded into form state and still posted (the
submit body is `{ type, ...form }`) and still reaches the email; it is simply
never shown. Verified end to end by driving the real form. That is deliberate —
the attribution is ours, not a question we are asking the customer — but it means
the field is *not* editable on this path, and widening it to feature requests is
a decision about the feature form, not a fix.

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
| The six subscription labels | **This code** |
| The seven sales labels (`Web meeting booked/sat/no show`, `In the future`, `In the future due to call`, `Abandoned`, `Cancelled due to contact`) | Sales, by hand — never written from code |
| Group placement | The board's own automations |
| `Customer start date` / `Customer end date` | **This code** (see 23.3) |

"When status changes to X, move item to group Y" automations place every item, so
the code sets one cell and the grouping follows. **Verified against the live board
that an API-driven column change does fire those automations** — the whole design
rests on it, so re-check that before assuming a future board behaves the same way.

`setEnquiryStatus()` writes with `create_labels_if_missing: false`, so a wrong or
mis-cased label **fails loudly** rather than adding a label to a column the
grouping depends on. Verified: `"Guaranteed Rent Customer"` is rejected. The
corollary is a deployment order: **a new label must exist on the board BEFORE the
code that writes it ships**, or every push for that state fails.

⚠️ **Casing is exact and inconsistent between the two customer labels**:
`Management Customer` (capital C) but `Guaranteed rent customer` (lower r, lower
c). `ENQUIRY_STATUS` in `monday.ts` is the only place these strings should live.

⚠️ **Never derive a label value by position.** The column carries **thirteen**
labels and their ids do not match their display order: label **id 5 is deleted**
(so id 5 does not exist, while display position 5 does), and `Cancelling` is
**id 19** at position 13. `labels_positions_v2` is the id→position map, and
`color_mapping` remaps two colours (label 9 → colour 15, label 10 → colour 14) —
which matters only if the column settings are ever rewritten, because the colour
enum is numeric and the rest of this column pairs colour-int to label-id.

⚠️ **This section previously said the column had ten labels and that "index 5 does
not exist".** Both were out of date: sales added `Abandoned` and `Cancelled due to
contact` on 17–21 Aug 2026, and this feature added `Cancelling`. There are also
now **two columns titled "Customer start date"** — `date_mm5ft19y`, the one the app
writes, and `date_mm6fhgrn`, added 17 Aug and empty on every item — plus an unused
`Customer cancelled date` (`date_mm6f8wy`). Do not write to the latter two.

### 23.2 — The label rule

`mondayStatusLabelFor()` in `src/lib/mondayStatus.ts` is the single definition,
shared by the webhook, the pause route, the resume cron and the admin check tool —
the same discipline as `announcementTargetsCustomer()` (§22) and
`customer_can_see_pool_lead` (§19.4). **The order is the rule:**

| # | Condition | Label |
|---|---|---|
| 0 | `is_active = false` | **`null`** |
| 1 | management cancelling-or-cancelled **and GR not still there** | `Cancelling` / `Cancelled` |
| 2 | `paused_at is not null` | `Paused` |
| 3 | management `subscription_status = 'past_due'` | `Wants to pay card declined` |
| 4 | holds management, not cancelling | `Management Customer` |
| 5 | GR active and not cancelling | `Guaranteed rent customer` |
| 6 | GR `past_due` and not cancelling | `Wants to pay card declined` |
| 7 | GR cancelling-or-cancelled, management not held | `Cancelling` / `Cancelled` |
| 8 | otherwise | **`null`** |

### `Cancelling` is not `Cancelled`, and conflating them was a real defect

⚠️ **This rule used to return `Cancelled` for a customer who had merely ASKED to
cancel**, and §23.6 recorded that as deliberate — "a cancellation shows at the
moment it is requested rather than a billing period later". **That decision is
reversed.** The billing portal and the in-app cancel flow both cancel *at period
end*, so `cancel_at_period_end = true` describes somebody who is still paying,
still `subscription_status = 'active'`, and still being delivered leads for up to
a month. Writing `Cancelled` filed them under the board's Cancelled group the
second they clicked, which reads as churn that has not happened.

It was found live on two customers, both of whom had cancelled citing lead
quality and neither of whom had left: james hoare (management, paid 13 Aug,
cancelled 24 Aug, service to **13 Sep**) and Karey Summers (GR, paid 10 Aug,
cancelled 27 Aug, service to **10 Sep**).

The two states are now separated by whether service has actually stopped:

| | Test | Label |
|---|---|---|
| Scheduled to end | `(gr_)cancel_at_period_end = true` and not yet ended | `Cancelling` |
| Ended | `subscription_status = 'canceled'`, or `account_status = 'cancelled'` with `subscription_status` neither `active` nor `past_due`; GR: `gr_subscription_status = 'canceled'` | `Cancelled` |

**`leavingLabel` is derived ONCE, not decided inside rules 1 and 7.** The question
is about the customer, not the branch that happens to fire: somebody whose
management subscription has already ended while GR is still serving out a paid
period is still receiving leads, and a per-branch test labels them `Cancelled` —
the same error, one product over. `stillServing` asks whether *either* product is
still running against a pending cancellation.

**Nothing drives the flip to `Cancelled` except Stripe.** At the period end
`customer.subscription.deleted` arrives, the webhook writes
`subscription_status = 'canceled'` and clears the pending flag, and the next push
writes `Cancelled`. There is no cron behind it: if that event were ever missed the
item would sit at `Cancelling` indefinitely. `cancel_effective_at` (0101) is
stored and would make a reconciliation cheap — see 23.6 on why one is now safe to
build — but none exists.

`src/lib/__tests__/mondayStatus.test.ts` covers all of this: 20 cases, and it was
confirmed that 9 of them fail against the pre-split rule before being kept.

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
- **Cancellation still outranks `Paused`**, so a paused customer who cancels reads
  `Cancelling`. That ordering was kept: leaving is the more important fact, and
  `Cancelling` states it without claiming they have already gone — which is what
  made the old ordering wrong rather than the ordering itself.
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

⚠️ **This section used to say "Prerequisite, DONE on the Monday side". It was
never done.** Both automations are still live, and the cost was measured: when the
two pending cancellations of §23.2 were labelled, `7920935830` overwrote the real
end-of-service dates the app had just written — **13 Sep → 24 Aug** for james
hoare, **10 Sep → 27 Aug** for Karey Summers, each within four seconds. Because the
app writes only on transitions and compares against the `monday_status_label`
cache (§23.4), it never re-corrected them; both cells had to be repaired by hand.

The state of the four automations, and what still needs doing on the Monday side:

| Automation | What it does | Action |
|---|---|---|
| `7920935830` | Status → `Cancelled`: move to group **and set Customer end date = Now** | **Delete.** This is the one destroying data; its group move is already duplicated by `7921870420`. |
| `7921870420` | Status → `Cancelled`: move to group only | **Keep** — it is what makes deleting the above safe. |
| `7920935809` | Status → `Management Customer`: move to `group_mm5f9by1` **and set `date_mm5ft19y` = Now** | **Strip the date action only.** It cannot be deleted: it is the sole automation moving items into that group. |
| `7921982789` | Added 17 Aug — a duplicate of the above stamping `date_mm6fhgrn` | **Delete.** |
| `7922497242` | Status → `Cancelling`: move to the `Cancelling` group, no date action | Added by this change. Correct as built. |

⚠️ **The API token cannot do any of this.** It can CREATE automations —
`7922497242` was created with it — but `manage_automations` returns
`USER_UNAUTHORIZED` on both delete and deactivate for automations created in the
Monday UI. Verified against `7920935830` and `7921982789`. **These four edits must
be made by hand in Monday**, and until `7920935830` is gone it will corrupt the
Customer end date of the next customer who genuinely reaches `Cancelled` — the
first of whom is james hoare on 13 Sep 2026.

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
necessarily agree. Both products have the flag, so a departure shows on the board
at the moment it is requested rather than a billing period later.

⚠️ **What that fact is REPORTED AS has since changed.** This paragraph used to end
"...shows at the moment it is requested", with the label being `Cancelled` — which
put still-paying customers in the Cancelled group. Showing it immediately was
right; calling it `Cancelled` was not. A requested cancellation now writes
`Cancelling` and only a subscription that has actually ended writes `Cancelled`
(§23.2). The flag is still read by every hook, and still at the moment it is set.

This also removes the blocker on a **reconciliation cron** — the reason there was
none is that a scheduled job could not see a pending cancellation and would have
flipped a leaving customer back. It could now be written safely. Still not built,
because event-driven writes plus the check tool have covered everything so far.
Since §23.2 it has one more job worth doing: `Cancelling` → `Cancelled` is driven
solely by `customer.subscription.deleted`, so a missed event strands an item, and
`cancel_effective_at` (0101) is exactly the column that would catch it.

### 23.7 — GR customers and the status-less board

GR enquiries go to board **18420913271**, which has **no status column at all**.
Karey Summers, the one GR customer, sits on 18420649520 — added by hand. So a GR
customer arriving through the GR form has no labelable item. `monday_board_id`
exists for exactly this: the writer refuses a non-status board
(`skipped: "not_status_board"`) rather than erroring at Monday, and the check tool
lists them as orphans for the same hand-fix Karey already had. At a GR population
of one that is proportionate; automating it means either creating the item on
18420649520 from the GR enquiry path or letting the sync create one.

### 23.7A — Admin had no view of a pending cancellation

The other half of the §23.2 defect, and the reason it read as a sync bug rather
than a labelling one. **No admin surface read `cancel_at_period_end` or
`cancel_effective_at` at all.** A customer who had asked to leave rendered as a
plain green `active` subscriber: `active` badge (the cancel route never writes
`account_status`, so the Cancelled tab could not see them either), `Mgmt active`
in Billing, counted in MRR and in active customers. The only place the fact
appeared anywhere in the app was the Monday cell — showing `Cancelled`, our cache
of what we last wrote to the board. So Monday said Cancelled, the app said active,
and neither was lying.

`BillingHealthCell` would have said "Cancels at period end", but it is fed by a
live Stripe lookup scoped to `pausedCustomers` and rendered only under the Paused
tab, so it is unreachable for anybody who is not also paused.

`pendingCancellation(customer, leadType)` in `src/lib/cancelOptions.ts` is now the
single definition, resolved through the existing `cancelColumns()` so the GR
branch is structurally unable to read a management column (invariant 6 — a GR-only
customer sits at `account_status = 'waitlisted'` for ever, §18A). The admin
customers table gained a **Cancelling** tab keyed on it, and a
`Cancelling — leaves 13 Sep` badge beside the per-product subscription badge.

**The account badge deliberately still reads `active`.** They are active. The new
badge carries the extra fact rather than replacing a true one — the same
"always two numbers, never one" discipline §21 applies to paused customers.

**Still counted in full in MRR and in the active-customer counts**, deliberately:
they are paying for the period. §21 sets the precedent for reporting such
customers *beside* a headline rather than silently inside it, so this is a
reasonable thing to change later; it has not been changed.

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

⚠️ **No longer observability only.** As of §33 it is the change detector the
management allocation backstop reads — exactly the job `gr_stripe_price_id` has
always done on the GR side. The §24 stand-down applies to management too now: a
pending tier change is applied by `applyPendingPlanChange` at the next paid
invoice, so neither the re-size nor the credit decision may step in front of it.

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

### The report IS part of the product *(0092 — this reverses the original rule)*

⚠️ This section used to read **"The report is not part of the product — no PDF
is attached to a lead, no URL is stored, and nothing links to one."** That was
a deliberate product constraint, and it has been reversed: an operator deciding
whether to ring a landlord should be able to read the analysis their figures
come from. 0089's own header still states the old rule; 0092 supersedes it and
is where the current one lives.

What has **not** changed is the URL. Monday's `public_url` is a **one-hour
signed S3 link** and is still never persisted — a stored copy would be dead
before anyone clicked it. What is stored now is the **bytes**, in a bucket of
our own.

| | |
|---|---|
| Bucket | `lead-reports` — private, `application/pdf` only, 25 MB |
| Policies on `storage.objects` | **none at all** — deny-all to the browser |
| Path | `<lead_id>/analysis.pdf`, **fixed** |
| Columns | `income_report_path` (the one flag), `income_report_size_bytes` |
| Route | `GET /api/leads/[id]/report` → 60-second signed URL, served inline |

**A new bucket rather than `lead-files`.** That one is customer-owned: every one
of its policies keys on `(storage.foldername(name))[1] = auth.uid()::text`,
because each object belongs to exactly one customer. A report belongs to a
**lead** — read by up to three holders plus every pool viewer, owned by none of
them — so it does not fit that shape. `lead-reports` instead follows the state
`training-media` ends in after 0061 drops its read policy: no policy at all, and
every read authorised by a signature rather than by RLS.

**The fixed path IS the retention rule.** One file per lead, replaced by
overwrite (`upsert: true`), so there is no second object to delete, no window in
which two exist, and nothing to garbage-collect. The asset id is deliberately
**not** in the path — it changes when sales re-run the analyser, and a path that
moved would orphan the old file for ever.

`leads.income_report_asset_id` is still an opaque id, still never rendered and
still never a link. It now does two jobs: skip a document already read, and tell
whether a stored report needs replacing.

#### Who may read it — two existing predicates, never a third

`GET /api/leads/[id]/report` takes the **lead** id, as
`/api/leads/pool/[id]/claim` does, because both audiences reach it that way. It
allows a caller who either

1. has a `lead_assignments` row for (lead, customer) — the row is the
   entitlement and **status is deliberately not consulted**, exactly as
   `/api/customer/files/[id]/download` declines to consult it. A rejected or
   closed lead is still one they paid for (invariant 4); or
2. passes `customer_can_see_pool_lead` — the same function the pool listing and
   the claim already share (§19.4), so the pool can never list a lead whose
   analysis the route then refuses.

The pool-visibility check **fails closed**: an unreadable predicate is not
permission. "No report stored" and "not yours" return one identical 404, so the
endpoint cannot be used to discover which leads exist.

⚠️ **The second audience means a pooled lead's full analysis can be read without
ever claiming it.** That is a commercial decision taken knowingly, not an
oversight — §19.7's bargain was "calling is free, keeping is not", and this
widens the free half. What it must **not** widen is the tailored presentation
(§26), which stays behind an assignment.

#### The file follows the figures — except on `failed`

`syncStoredReport()` in `src/lib/incomeReportStorage.ts` is the only writer.

| Outcome | Object | Columns |
|---|---|---|
| `parsed` | uploaded, `upsert: true` | written |
| `no_report` | removed | nulled |
| `unparsed` | removed — no figures means a lone "read the analysis" link is an orphan | nulled |
| `failed` | **untouched** | **untouched** |

**This is why the storage columns are not in `incomeReportPatch()`.** That
function clears every figure on every outcome, so a replaced report cannot leave
stale numbers attributed to a document that no longer states them — right for a
figure we can recompute tomorrow, wrong for a file. `failed` means Monday was
unreachable or a download broke; treating it the same way would delete a
perfectly good PDF, and the operator's link to it, over a network blip.

A storage error **never costs the figures**: it logs, returns an empty patch,
and the gross, rate and occupancy publish regardless — the same "they fail
alone" rule §25 already applies to the rate and occupancy.

#### ⚠️ pdf.js DETACHES the buffer you hand it

`getDocumentProxy` takes ownership of the `Uint8Array` and detaches its
`ArrayBuffer`, so anything wanting the bytes **after** parsing must copy first.
`parseIncomeReport` therefore passes `bytes.slice()`, and the copy lives inside
the parser rather than at the call site: the parser is the destructive consumer,
so not destroying its caller's data is its job, and doing it there makes
"parsing does not consume what you passed in" true for every future caller.

This shipped broken and reached production. `resolveIncomeReport` parsed first
and returned `bytes` afterwards, by which point it was empty — so the first
backfill wrote **159 zero-byte PDFs**, each recorded as a stored report an
operator could open. The figures were all correct, because they are read before
the detach; only the file was empty, which is what made it look like a rendering
problem rather than a storage one.

`syncStoredReport` now **refuses to upload a zero-length buffer**, which is what
turns this class of failure loud. A 0-byte analysis is never a legitimate state,
and leaving the columns null keeps the row in the backfill queue.

**Why the tests missed it, which is the part worth keeping.**
`syncStoredReport` was exercised over all four outcomes with *synthetic*
outcomes carrying fake byte arrays, and the parser over 24 real PDFs for the
figures it returns. Neither ever ran a real document through parse-**then**-
upload, so the bug sat in the seam between two well-tested pieces — the same
shape as the `items(ids:)` pagination trap below and §23.10's failure-path
cluster. The regression test now asserts that what `resolveIncomeReport` hands
on is byte-identical to what it downloaded and still begins `%PDF-`.

#### The third sweep pass, and why there was no one-off backfill

159 leads were already `parsed` when this shipped, and neither of the sweep's
existing queries would ever look at them again — both are about leads with **no
figures**. So `/api/cron/parse-income-reports` gained a third pass, on leftover
batch capacity, newest first, which fills in **both** things such a lead is
missing: its stored PDF (0092) and its presentation figures (§26).

**IT MAY ONLY ADD, AND NEVER WRITES A COLUMN THAT ALREADY HAS A VALUE.** These
leads already show a gross figure to customers, so re-running
`incomeReportPatch` over them would let a report since moved or deleted on
Monday **blank a working figure** — trading something that works for nothing,
the one thing this section says never to do. That is why the figures half goes
through `presentationFiguresPatch()` — the five 0093 columns, omitting any the
re-read did not produce — and never `incomeReportPatch()`, which also writes
gross, rate and occupancy. An outcome other than `parsed` writes nothing at all.

**The two halves are written together but neither depends on the other.** A
failed upload returns an empty storage patch and the figures still land, because
they are the more valuable half and everything else here fails alone; the row
keeps a null path, so the upload is retried tomorrow.

**The selector is `income_report_path is null OR platform_fee_pct is null`**,
not the path alone. Selecting on the path was a trap in the exact situation this
existed for: a lead backfilled by an older build would get its file, drop out of
the query, and never pick the figures up. `platform_fee_pct` is the sentinel
because all 24 live reports sampled state a `Platform Fees (n%)` line — a report
that genuinely lacks one would be re-read nightly, which `remaining_unbackfilled`
makes visible rather than hiding. It is reported separately from `remaining`,
because the two backlogs drain at different rates and one being stuck says
nothing about the other.

`maxDuration` is **300** and the wall-clock budget **240s** (Vercel Pro, §2), so
a backlog of this size drains in one run rather than a queue of nights. Both are
ceilings rather than reservations: an ordinary day with nothing to do still
finishes in seconds.

It is a pass rather than a script deliberately: it needs no credentials, repeats
safely, drains itself to nothing, and afterwards keeps picking up any lead whose
upload failed transiently after a successful parse.

**`/admin/leads` has a "Read income reports" button** for it. The route always
accepted an admin session as well as the cron secret and its comments assumed it
could be run by hand, but nothing could actually do that — a backfill meant
typing the URL, and on a preview deployment meant signing into the app on that
origin first. `ParseIncomeReportsButton` is the `SyncMondayButton` pattern
unchanged. It matters beyond the one-off: a report format change or a spell of
Monday being unreachable both leave a backlog somebody will want to drain
without waiting a day to see whether it worked.

**The 21 `no_report` leads are not part of this.** Checked against Monday: their
items carry no files at all, so `no_report` is the truth rather than a backlog.
The 30-day re-check still catches an analysis attached later.

#### Where the link shows

`IncomeReportLink` — the lead detail page and the expired-pool card, under
`IncomeProjection` on both. **Not** on the feed card and **not** in admin;
neither was asked for and both are one-line additions.

It is a **separate component from `IncomeProjection`**, not a line inside it,
because a lead can have a stored PDF and no trustworthy figures, or figures and
no stored PDF, and folding them together would make each conditional on the
other. Both render nothing when they have nothing.

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

### ⚠️ There is now a THIRD writer of these columns *(§31)*

This section describes two writers — ingest and the daily sweep — and both read
a PDF from a lead's **Monday item**. Paid lead analysis (§31) writes the same
columns for a lead that has no Monday item at all, by calling the analyser
directly and building an `IncomeReportOutcome` from its reply.

It goes through `incomeReportPatch()` and `syncStoredReport()` unchanged, so
everything below about how the file follows the figures still governs it. What
is no longer true is "only the sweep keeps existing leads up to date": for an
owned lead the sweep is structurally blind (§30.8), and §31 is the only route.

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

0092 was applied to a scratch Postgres — **all 88 migrations from empty** — and
re-applied to prove idempotency, confirming the bucket upsert is stable and that
`get_customer_pool_leads` survives its **fourth** drop/recreate still
`service_role`-only *and* still returning `avg_nightly_rate` / `occupancy_rate`,
which is the check that would catch a recreate mistakenly built from 0089's
body. No `storage.objects` policy names the bucket. It was then applied to
`znlfwbnvhlacwzgfalcf` and the same four assertions re-run there.

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

0089 first, and **0092 on the same rule**. `get_customer_pool_leads` changes its
return shape in both, and every customer lead surface selects `leads(*)`, so
code arriving first would query columns that do not exist. Nothing here touches
a balance, counter, pacing or capacity column, so a lagging migration cannot
affect lead allocation.

---

## 26. The presentation, tailored to every lead *(0093)*

`public/income-presentation/index.html` is a static tool every management
customer reaches from Documents: six slides they walk a landlord through on a
web meeting. Until now the operator **typed every figure into it by hand** —
its own copy said "enter your own numbers, or bring them across from the STR
Analyser" — while the analysis PDF §25 already downloads states all of them.

Opened from a lead as `?lead=<id>`, it now arrives filled in.

### 26.1 — What comes from where, and the one thing that must not

| The property's, from the report | The operator's, from their profile |
|---|---|
| gross, nightly rate, occupancy | **management fee and its basis** |
| platform % and cleaning % | fee / cleaning / contract wording |
| long-let rent | compliance, vetting |
| the 12-month seasonal curve | onboarding, managed, landlord lists |
| address, landlord name, phone *(from the lead)* | discovery and next-step lists |

⚠️ **THE MANAGEMENT FEE MUST NEVER COME FROM THE REPORT.** The PDF states one —
`Management Fees (15%)`, charged on **gross** — and it is *Stayful's*. The
operator presenting is not Stayful, and seeding it would have them quote our
price to a landlord as their own. The platform and cleaning percentages **do**
come from the report, and the distinction is the point: those are operating
facts about the market that apply to whoever runs the property; the fee is a
price, and prices are theirs.

The consequence, which is correct and worth stating: **the tool's net will not
equal the report's net.** The tool computes net itself from gross, platform,
cleaning and the operator's own fee, so on 88 Bourneside Road the report says
£43,295 and an operator on 15%-of-net sees £45,169. `net_annual_income` is
stored precisely because it must not be shown.

**Existing leads get these through the sweep's third pass** (§25), not a one-off
script — the same pass that stores their PDF, and under the same "may only add"
rule.

### 26.2 — The curve is a shape, not twelve numbers

The report's forecast is stated in pounds **net at Stayful's fee**, so seeding
it raw would print twelve months that do not sum to the total on the same
slide. What is about the property is the **seasonality**, and it survives a
change of fee — so `monthly_revenue_profile` becomes multipliers of its own
average month, scaled to the operator's net.

The tool's `genMonths()` used a single hardcoded generic curve softened by a
`chart.variance` of 0.6. A seeded lead supplies `monthWeights` and releases
variance to **1**: the damping exists to soften a generic shape and would
flatten a real one.

### 26.3 — The setup screen collapses, it is not deleted

Of ~28 inputs on the tool's first page, **20 are answered by the analysis**, **6
move to the profile**, and **3 remain** (discovery ticks, next-step ticks, call
notes). Seeded, the screen becomes a read-only header, presenter notes, and
Present.

Two escape hatches, both load-bearing: **"Adjust figures"** reveals the income,
12-month and cases blocks exactly as they were, because the report is an
estimate and an operator must be able to overrule a figure they disagree with;
**"Edit my terms"** goes to Settings.

**Nothing is removed from the file.** Every section is wrapped in the file's own
`<sc-if>`, so `/dashboard/documents` — the tool with no `?lead=` — still shows
the complete original form, saving under the original storage key.

### 26.4 — Per-lead storage, and the bug that fixed

The tool saved to **one** `localStorage` key for the whole browser, so working a
second landlord silently wiped the first. Seeded, the key is
`wm_income_tool_v1:<leadId>`; unseeded it is the original, untouched.

### 26.5 — The profile prompt, and the staleness trap behind it

`presentation_settings_updated_at` is **null until the profile is saved**, and
that is the "set up yet?" test — deliberately not whether the blob is empty,
because a customer who saves a profile identical to the defaults **has**
configured it and testing the contents would nag them for ever (the same
NULL-is-not-zero distinction §13 draws for `management_customer_goal`).

When it is null the seeded tool leads with a banner, and the lead page carries
the same prompt beside the button, so it is met before the tool opens as well
as inside it. **It prompts, it does not block** — an operator with a landlord on
the phone must be able to present.

The trap that creates: they read it, set the profile, come back, and see the old
generic terms because the tool loads its saved copy. Two things handle it:

- **Opening a lead saves nothing.** `save()` fires only from `update()`, so
  open → leave → return **re-seeds**, which covers the common path.
- If they *had* edited first, the saved copy carries the `seededAt` it was
  seeded with; when the profile is newer the tool offers *"Your presentation
  details have changed · Apply them"*, which re-seeds **the terms only** and
  leaves their figures and notes alone. Explicit, because silently overwriting
  an operator's own edits is worse than showing stale terms.

### 26.6 — Assignment only, unlike the PDF

`GET /api/customer/presentation/[leadId]` requires a `lead_assignments` row.
Deliberately **not** pool-visible, where §25's report deliberately is: reading
the analysis before you claim is the pool's bargain widened; being handed the
pitch is the bargain gone. Management only (invariant 6).

### 26.7 — Two duplications that must be maintained as one

- **`src/lib/presentationSeed.ts` mirrors the tool's `defaults()`**, and the
  seed must be a **complete** object rather than a partial. The tool's
  `merge(base, over)` copies the base's keys first and therefore **cannot shrink
  an array**: a profile with three onboarding steps merged over five defaults
  comes out as five.
- **`operatorNetAnnual()` duplicates the tool's `calc()`**, because the months
  and cases are expressed in net pounds and must be scaled against the same net
  the tool will display.

Same arrangement §20 records for `capture_operator_proof` duplicating
`get_operator_proof`, and the same rule: they are one thing written twice.

### 26.8 — The static file is generated upstream

~~Four marked edits~~ **Nine**, and re-applying them after a regeneration is the
maintenance cost of this feature. 1-4 are 0093's: `componentDidMount` (lead id,
per-lead key, seeding), `genMonths` (real weights), `renderVals` (the flags),
and the setup template (the `<sc-if>` wrappers and the seeded header). 5-7 are
branding (§37): the `:root` palette in the helmet `<style>`, the brand fetch and
`applyBrand` in the script, and the logo `<img>` blocks. 8-9 are the market
slide (§38): the slide SEQUENCE replacing the fixed six, and the slide itself.
Each is commented `STAYFUL EDIT n of 9`.

⚠️ **Every brand colour in the file is now `var(--sf-*)`, not a hex.** A
regeneration brings the literals back, and a deck that has stopped responding to
an operator's colour is the symptom. The mapping is in §37.

⚠️ `componentDidMount` also assigned its keydown handler to `this._key`, which is
now the storage key. It is renamed `_keyHandler`; the two must not collide again.

### Verification

The extended parser was run over **24 live reports**: gross, net, long-let,
platform %, cleaning % and rate/occupancy on all 24, and the twelve-month curve
on 23. The one rejection is correct — that report's forecast table prints £0 for
all twelve months against a £25,696 net, and a curve of twelve zeros is not a
curve. **All 24 gross figures came back unchanged**, which is the regression
that would have mattered.

The net anchor was the risk: `NET ANNUAL REVENUE` appears **twice** in every
report, once per table. Anchoring through `Total Operating Costs` — which
appears only in the short-let table — was asserted on all 24, along with
`net < gross` and `gross − costs = net`.

⚠️ One finding worth keeping: the forecast's "vs long-let" column loses its minus
sign in the PDF text layer, so a negative month reads as a bare `£545`.
Requiring the sign lost the curve on **11 of 24** reports — precisely the
properties that underperform a long let in some month, where the seasonal
picture is most worth showing.

`buildPresentationSeed` and the validator went through **33 cases**, including
the array-shrink case above run through the tool's own `merge()`, a gross-only
lead, a lead with no report (which must come out identical to the blank tool),
and a 12%-of-gross fee correctly repricing the whole curve.

The tool was then rendered in Chromium both ways: blank shows the complete
original form and no seeded chrome; seeded shows the header, the right figures,
the profile prompt, hidden income and how-it-works blocks, and presenter notes
prefilled. "Adjust figures" reveals the income form with `83260` in the gross
input, the slides render, and the 12-month chart carries the property's real
seasonality — peak August, trough February, matching the report. No page errors.

All **89 migrations** applied to a scratch Postgres 16 from empty; the
cardinality CHECK exercised on 11, 12, 13 and null.

### Deployment order — migration BEFORE code

0093 first. The seed route selects the new columns on every request and the
dashboard reads `presentation_settings` through `getCurrentCustomer()`'s
`select("*")`, so code arriving first would query columns that do not exist.

---

## 27. The public API and MCP server *(0095)*

A customer can read **their own** leads from their own tools — n8n, a script, an
AI assistant — with a per-customer API key. `/api/v1` for REST, `/api/mcp` for
MCP. **Read-only in every direction**: no writes, no billing, no admin, and
nothing that spends a credit.

This is a **second front door onto rooms that already have a lock**. Invariant 7
already held, so nothing here widens what a customer may reach; it changes how
they may prove who they are.

### 27.1 — Containment: features, never the build

The requirement was that a customer gets to USE what the database offers and
never to copy it. Each line below is enforced by something, not by intention:

| Asset | Reachable | Enforced by |
|---|---|---|
| Source, files, config | No | No tool reads a file or takes a path |
| Table names, unexposed columns, migration history | No | Derived select lists + `internal()` |
| RPC names, RLS design, triggers | No | No database error ever reaches a caller |
| Scores, thresholds, capacity/pacing models, pricing | No | Absent from the vocabulary, not derivable |
| Another customer's data | No | `customer_id` resolved **server-side from the credential**; no endpoint accepts one |
| How many operators hold a lead | No | `assignment_count` / `max_assignments` withheld (§19.7) |
| Which lead ids exist | No | Byte-identical 404s |
| Supabase / Stripe / Monday credentials, storage layout | No | The report endpoint streams bytes rather than a signed URL |

**THE STANDING RULE: never add a tool or endpoint that takes a query, a table
name, a column list, a file path or an arbitrary filter.** Every addition is a
named operation with a fixed shape. A generic `query` tool would hand over in one
commit everything above protects, and it is exactly the shape that looks
convenient when somebody asks for "just one more filter".
`__tests__/dispatch.test.ts` asserts no tool takes one.

### 27.2 — One vocabulary, and why there is no spread anywhere

`src/lib/api/schema.ts` is the single field definition. Both the `.select()`
column strings and the serialized output are **derived** from it, so a column
cannot be selected without being exposed, a field cannot be exposed without being
selected, and the output keys are exactly the spec keys. There is no
`{ ...row }` anywhere in `serialize.ts`, and that is the point: a spread would
publish whatever a future migration adds.

`serialize.test.ts` asserts the emitted key set against a literal list
**duplicated on purpose** — a test deriving it from the same source would pass
whatever changed.

### 27.3 — Two credentials, one `Caller`

`resolveCaller` accepts a bearer API key or a cookie session and produces the
same `Caller`, which is what lets the service layer take a customer id and know
nothing about how it was proved. An OAuth token becomes a third branch rather
than a rewrite.

**A present `Authorization` header is terminal and never falls back to the
session** — not just `Bearer sfl_`, any header at all. Preferring an ambient
cookie over an explicit credential would show somebody testing a key their own
*session's* data and make a revoked key look like it still works.

**Keys outlive cancellation, deliberately.** Holding a product gates *creating* a
key; using one is not gated. Nothing else here withdraws what a customer paid
for — reject does not refund, §18E leaves unused credits intact — and cutting
their integration on the day they leave would also remove their ability to export
their own history. `is_active = false` **does** stop a key: archived is not
cancelled (§18D), and only one of those means "out of circulation".

### 27.4 — ⚠️ Next caches `fetch`, and it silently broke the rate limiter

`createAdminClient()` sends `cache: "no-store"` on every request. **This is
load-bearing and must not be removed.**

supabase-js talks to PostgREST over `fetch`, and the App Router patches `fetch`
with its own Data Cache. The rate limiter — an RPC that increments a counter and
returns the new value — **never reached the database from a deployed build**,
while the identical function committed normally over direct SQL. Sixty-six
requests in a minute all passed and `X-RateLimit-Remaining` sat at 59 throughout.

What made it hard to see: **plain inserts kept working**, so `api_request_log`
filled up correctly while the counter beside it stayed empty, which reads as a
database fault rather than a caching one. The tell was a response coming back
byte-identical minutes apart, still describing a function signature that had
since been replaced.

Two rules follow. If a privileged read looks stale or an RPC appears not to run,
**start at the fetch cache, not the SQL**. And a call made for its *side effect*
is exactly the shape this breaks, because a cached response means the call never
happens.

**Related: `consume_api_rate_limit` returns `jsonb`, not a one-row table.** A
`RETURNS TABLE` function is called by PostgREST as a set-returning function in a
FROM clause, and through that path its upserts did not persist either. A scalar
return is evaluated in the target list, which is what every other writing RPC
here already does.

**Every response sets `Cache-Control: no-store, private`.** Next's default of
`public, max-age=0, must-revalidate` invites any shared proxy to hold a copy,
which on this surface would mean one customer's leads in somebody else's cache.

### 27.5 — Cursors carry their sort, and their timestamp verbatim

Keyset pagination, never offset: the daily sync inserts while a client is
mid-walk, and offset paging over a table taking inserts repeats and skips rows.

Two failure modes here are silent and both are guarded. Postgres returns
`assigned_at` with **microseconds** and `new Date(x).toISOString()` truncates to
milliseconds, so a round-tripped cursor can re-emit or skip a row assigned in the
same millisecond — the raw string goes in and the same string comes out. And a
cursor **carries the sort it was issued under**, because paging one ordering with
another's boundary drops rows without erroring.

Both sort columns are NOT NULL, which is what makes the tuple comparison total.
**Do not add a nullable third sort mode** without handling nulls explicitly.

### 27.6 — Rate limits, the kill switch, and seeing it

60 requests a minute per key and 5,000 a day per customer, both consumed in one
round trip. **Increment then compare, never check then increment** — the
claim-by-write discipline `credit_invoice()` uses against Stripe redelivery. The
limiter **fails closed**: an error returns `rate_limited`, because letting
requests through when the limiter breaks disables the only defence against a
runaway integration at the moment it is under load.

`system_settings.api_enabled` turns the whole surface off without a deploy,
cached in process for 30 seconds. It deliberately does **not** gate the
key-management routes — a customer must be able to revoke a key while the API is
off.

`api_request_log` records every request **including rejected ones**, which are
most of what is worth looking at when something is wrong. `/admin/api` and the
customer's own settings panel both read it, and **both show REST and MCP side by
side**: they are one feature with two front doors, and a view showing one would
hide the half somebody came looking for. Usage totals are a rollup written by the
daily sweep, never a counter on the request path — that would turn every read
into a write.

### 27.7 — Client support is a documented limitation, not a surprise

MCP authorization is **OPTIONAL** in the spec, so a static-key server is not
spec-violating — but clients differ. n8n, Cursor and VS Code work today; Claude
Desktop works through an `mcp-remote --header` bridge; claude.ai connectors
expect OAuth and their header support is in beta; **ChatGPT cannot present an API
key at all**. The table is in `/dashboard/api` so a customer meets it before they
build on it.

**Phase 1.5 is OAuth 2.1**, and two things here exist to make it additive: the
resolver branches on credential kind, and the 401 is shaped so
`WWW-Authenticate: Bearer resource_metadata="…"` is a one-line addition. Next
serves `/.well-known/*` fine, so there is no platform blocker.

### Verification

The repo's first automated tests: **vitest**, 60 cases, pure units only — no
network, no database, sub-second — which is what makes it safe to put in front of
`next build`. There is no CI here, so the Vercel build is the only place tests
can be enforced, and an untriggered suite reads as coverage without being any.
`npm run lint` also runs for the first time: there was no ESLint config, so it
had been sitting on an interactive prompt.

Migration applied to live `znlfwbnvhlacwzgfalcf` (**Postgres 17.6** — the repo's
"scratch Postgres 16" convention is out of date). Every CHECK exercised on valid
and invalid values, the unique and partial indexes confirmed, FK cascade
confirmed on customer delete, re-applied for idempotency, and
`consume_api_rate_limit` confirmed `service_role`-only after its grants — twice,
since it was replaced.

Then end to end against a preview deployment with a real key on a real customer
(20 assignments): all five endpoints returned only allow-listed fields; a scan
for 18 banned tokens across a full page came back clean; a 7-page cursor walk
returned 20 rows with no duplicates; a cursor replayed under the other sort was
refused; a foreign id, a malformed id and a report-less lead returned
byte-identical 404s; the report streamed a real 24KB `%PDF-1.3`. On MCP:
`initialize` negotiated, a notification was acknowledged with 202, GET returned
405, a hostile `Origin` 403, an unsupported protocol version 400, unauthenticated
`tools/list` was refused, all five tools listed and called, and `run_sql` was
rejected as unknown. A concurrent burst of 80 produced 48 × 200 and 27 × 429 with
`Retry-After`, which also demonstrates the atomicity under real contention.

### 27.8 — ⚠️ Filtering on an embedded resource needs `!inner`

`ASSIGNMENT_COLUMNS` selects `lead:leads!inner(…)`, and the `!inner` is
load-bearing. `?product=` filters on `lead.lead_type`, and in PostgREST a filter
on a NON-inner embedded resource filters the EMBEDDED RESOURCE rather than the
parent rows — every assignment still returns, with the lead nulled on the ones
that do not match.

Shipped broken and caught in pre-merge review. `?product=guaranteed_rent` on a
management-only customer returned their entire book with half the rows carrying
`"lead": null`: a 200 that paginates normally and is wrong, which is the worst
shape available on a surface built for automated syncs.

The same lesson as §25's `items(ids:)` pagination trap and §23.10's failure-path
cluster — the pieces either side were tested and the seam between them was not.
`serialize.test.ts` and `leads.test.ts` now assert the `!inner`, and both were
confirmed to fail against the old select before being kept.

`lead_assignments.lead_id` is nullable by declaration (0001 never added the
constraint), though no row has ever been null. An inner join could therefore drop
an assignment with no lead where a left join would have kept it — which is the
better behaviour, not a regression: such a row carries nothing a caller can use.

### Deployment order — migration BEFORE code

0095 first: the resolver selects from `customer_api_keys` on every request. It is
additive and inert on its own, and nothing in this feature writes a balance,
counter, pacing or capacity column, so a lagging migration cannot affect lead
allocation. 0096 (`sweep_api_tables`) follows it and is read by the pool sweep
only — a lagging 0096 costs a day of housekeeping, nothing more.

---

## 28. The filter volume forecast *(0097–0100)*

Applying a lead filter used to say only that volume "varies": the customer
narrowed their leads, got no number back, and paid the same. They are now told
what to expect from the selection, how confident we are, and what it works out
at per lead — acknowledged explicitly before the filter applies.

`src/lib/filterForecast.ts` is the only place any of those numbers are derived.
The customer panel, the route that re-derives them, both admin surfaces and the
public estimator all call it.

### ⚠️ 28.0 — It was a GUARANTEE for one commit, and that was wrong

0098 shipped this as a priced commitment: a guaranteed number of leads, with any
shortfall credited back to `lead_balance` at each paid invoice. **0100 withdrew
the promise and kept everything else.**

The reason is arithmetic, not squeamishness. The figure is the largest N with
`P(X >= N) >= 0.83` — so it is missed **about one month in six by construction**,
and 0098's own §28.7 recorded that as a known gap while the UI called it a
guarantee. A number you have already calculated you will miss is not a guarantee;
it is a guarantee you have decided to break. Everything the model does is useful,
and only the word and the payout were wrong.

What that means for anyone changing this:

- **`filter_expected_leads` is a LOWER BOUND, not a mean.** Every surface words
  it "**at least** N · P% likely". Calling a P83 figure "expected" without that
  qualifier invites the reader to treat it as the middle of the range when it is
  deliberately the pessimistic end.
- **Nothing settles a shortfall.** `settle_filter_guarantee`,
  `filter_guarantee_settlements` and `filter_guarantee_credit` were dropped by
  0100. No copy anywhere may offer to make a short month good.
- **Do not lower `FORECAST_CONFIDENCE` to 0.5** to make "expected" literally
  true. A central estimate is wrong half the time, which would make the
  cost-per-lead figure beside it worthless. The honesty lives in the wording.
- The re-apply balance clamp went back to the plain `Math.min(balance,
  allocation)` it always was — the exception existed only to protect
  compensation we owed, and nothing is owed.

### 28.1 — Fixed confidence, not a fixed margin

`FORECAST_CONFIDENCE = 0.83`. The forecast is the largest number we can deliver
with at least that confidence, capped at the plan allocation.

The obvious design instead subtracts a fixed margin — `estimate - sqrt(estimate)`,
one sigma. The variance model behind it is right (per-filter monthly variance
really does track `1/sqrt(lambda)`, measured), but it makes the DISPLAYED
likelihood move against filter quality: an estimate of 3 shows 92% where an
estimate of 6 shows 80%, because a smaller number is proportionally easier to
hit. A customer comparing two filters by that percentage picks the worse one
every time — fewer leads, higher price, better-looking number.

Fixing the confidence and letting the number move makes both figures the
customer decides on monotone in filter breadth: **widening a filter can only
raise the expected volume and lower the cost per lead.** That property is
asserted across estimates 0..300 for both plans and is the regression that would
catch a reversion. Do not "simplify" this back to a fixed margin.

0.83 is calibrated so an estimate of 5/month forecasts 3 — the worked example the
pricing was agreed on. It is the one risk dial: raising it lowers every forecast
and raises every cost per lead. It survived 0100 unchanged, which is the point of
§28.0: the model was never the problem.

### 28.2 — Negative binomial, and why not Poisson

Poisson answers "how often would we hit this if the estimate were exactly
right". The estimate is inferred from a few weeks of history and carries real
error, and a percentage in front of a customer is close to a contractual claim.

A Jeffreys Gamma prior on the weekly arrival rate makes next month's count
`NegBinomial(r = m + 0.5, p = w / (w + WEEKS_PER_MONTH))` for `m` matching leads
over `w` weeks. Variance is inflated over Poisson's by `(w + 4.33) / w` — about
1.6x at a couple of months of history. As history accumulates `p -> 1`, it
converges to Poisson and forecasts rise on their own, so there is no haircut
anyone has to remember to remove.

Evaluated by the recurrence `P(0) = p^r`, `P(k) = P(k-1)(k+r-1)/k(1-p)` — no
log-gamma, no overflow. Cross-checked against an independent evaluation in SQL.

**Apply the allocation cap BEFORE reading the likelihood.** An estimate of
48/month on a 10-lead plan reads "38 leads, 79%" uncapped and "10 leads, 99%"
capped, and only one of those is a promise anyone made.

### 28.3 — Revenue is held constant

`costPerLeadPence = ceil(planPricePence / expected)`, from the LIST plan price
for the allocation, never the customer's actual Stripe price — discounts exist,
and every other price derivation goes through `planForAllocation`. Ceil, not
round, so `expected * costPerLead >= planPrice` always holds.

The bill does not change. Only what we tell them to expect for it.

`recommendedDowngrade` surfaces the cheapest plan that still covers the whole
forecast. The `expected <= plan.leads` test is what makes it safe to show
automatically: taking the advice can never cost a lead, only price.

⚠️ **This matters MORE since 0100, not less.** While a shortfall was credited
back, a customer over-planned for their filter at least got the difference in
leads. Nothing is credited now, so this advice is the only thing between them and
paying twice the going rate indefinitely. `repriceFilterForecast` in
`planChanges.ts` keeps the stored cost per lead honest when the plan actually
changes — the count is deliberately not recomputed, only the price it is divided
into.

### 28.4 — There is no settlement, and that is the design

~~Settlement rides invoice.paid, and the order is load-bearing.~~ **Removed by
0100 along with the guarantee it settled.** The figure is a forecast; a quiet
month is simply a quiet month.

Recorded because the removed machinery is worth not rebuilding by accident:
0098 hooked `settle_filter_guarantee` into both halves of `invoice.paid`, before
`maybeExecuteFilterLift`, with a unique `(customer_id, lead_type, period_start)`
as its idempotency claim. If a credit-back is ever wanted again, that shape was
correct — `invoice.paid` is the real per-customer cycle boundary, because
`reset_monthly_counts` is a privileged create-or-replace target (§11) and
`leads_received_this_month` is not a faithful delivery count (0006 decrements it
on reject, while invariant 4 says a rejected lead was still delivered). The
settle-before-lift ordering was load-bearing and would be again.

**But do not reinstate it without also changing the confidence.** At 0.83 a
shortfall is designed in one month in six, so an automatic credit is a standing
liability that accrues fastest against exactly the filters that can least fill
it — which is what §28.7's accrual warning was about.

### 28.5 — Contention: four filtered customers to a lead

`CONTENDED_FILTERED_CUSTOMERS = 4`, in `types.ts` beside
`DEFAULT_MAX_ASSIGNMENTS` so `filterPrediction.ts` can read it without importing
server-only code.

The two candidate pools are not symmetric. Unfiltered demand is elastic — any
lead satisfies it, so a slot lost here is found elsewhere this week. Filtered
demand is inelastic: those customers can only be served from the areas they
chose, so a slot lost there is a lead they will simply never get. So at
four or more filtered candidates the critically-behind override stands down and
filtered customers take every slot, and the lead opens its fourth slot
immediately rather than after ten days of nobody working it (§18 raises the cap
for a lead going to waste; this raises it for demand already queued). It stops
at 4 so a lead can still escalate to 5 but never overshoots by both routes.

**The estimate must agree with the router**, or the number quoted is one the
engine was never going to deliver. `predictMonthlyVolume` shares each area's leads by
`4 / competitors` past the ceiling, per area rather than across the filter.

Count FILTERED customers only. Counting unfiltered ones saturates every area and
collapses every quote — the engine serves them from anywhere. **A bedroom-only
filter names no areas but competes in all of them**, so it is a floor under
every area; missing that was the mistake that made an "it ships inert"
prediction wrong in review.

The contention read fails OPEN: an empty map quotes the unshared volume, which
is what the feature showed before contention existed.

### 28.6 — The public estimator publishes shares, not counts

`public_filter_volume` (0099) is a single-row cache on the
`public_activity_stats` pattern — lazy rebuild behind an atomic staleness claim,
because `fetchLeadVolumeData` pages the whole leads table and that is a lever
anyone can pull on an unauthenticated endpoint.

Contention is applied when the payload is BUILT. Shipping raw counts plus a
contention map would quote the same number and hand anyone with devtools our
per-area customer counts. The payload does still expose per-area, per-bedroom
lead volume — the minimum an honest estimate needs; bucket it in
`applyContention` if that trade ever looks wrong.

#### The estimator is the panel's components, not a copy of them

`LeadEstimator` composes `AreaPicker`, `RadiusControls`, `BedroomRange`,
`PredictionBox`, `VolumeBar`, `resolveRadius` and `LeadSourceMap` — the same
modules `LeadFilteringPanel` renders, extracted to `src/components/filtering/`.

A first cut shared only the MATHS and reimplemented a thinner UI, which is worse
than it sounds: the visitor could not filter by bedrooms at all (it hardcoded
`minBedrooms: null`), saw bare area codes with no lead counts, got no widening
suggestions, and was never told when their selection priced badly. Extract by
pure move — the panel's diff for the whole exercise is imports and prop passes
only, no authored JSX, which is the check to repeat if more is shared later.

`PredictionBox` is passed **the plan the estimator would sell them** (the
cheapest covering the forecast), not 0. `VolumeBar` then reads as progress
toward that plan and the amber "adding areas raises the volume" variant fires
where it should.

#### ⚠️ The boundary file must not load on mount

`public/data/uk-postcode-areas.geojson` is ~562 KB. The first cut gated its fetch
on `mode !== "radius"` and commented that it loaded "only if the visitor actually
uses radius mode" — but **radius is the default mode**, so it fired for every
visitor to both landing pages whether or not they touched the estimator.

The gate is now genuine intent: a postcode typed, the map opened, or a switch to
hand-picking. The map itself sits behind a **Show map** button, because it is
orientation rather than part of the estimate. Verified in Chromium against both
pages: **zero geojson requests on load, one after typing a postcode.** The
dashboard keeps its old behaviour — a customer who opened the filtering page is
already committed.

#### The map's counts are contention-scaled, and the dashboard's are not

Per-area totals for the public map are summed from the payload's bed buckets,
which `applyContention` has already scaled. So the same component shades by
"what you would get" here and by raw national volume on the dashboard. That is
the more honest number for a prospect and it IS a different number from one
component — noted here so nobody later "fixes" the discrepancy.

#### `areasInPayload` is scoped per product

It unioned both products, which put areas with **zero GR leads** in front of a
GR prospect: they pick one, are told there is not enough data to forecast it, and
reasonably conclude the product is empty in their patch. The two books genuinely
differ in coverage and the picker is the wrong place to blur that. Asserted in
`publicFilterVolume.test.ts` in both directions.

### 28.7 — Gaps, all deliberate

Every gap in the 0098 version of this list was about **crediting** — discard
deleting the `lead_assignments` row and inflating a shortfall, pause voiding the
invoice the settlement rode on, cancellation stranding a final partial cycle's
credits, and `filter_guarantee_credit` being cumulative so it could exceed the
balance it was meant to protect. **0100 removed all four with the payout.** They
are recorded in §28.4 rather than here, because they are the reason a credit-back
is harder than it looks if anyone wants one again.

What remains:

- **The forecast is a lower bound presented as an expectation.** At 0.83 it is
  missed about one month in six by construction. A customer reading it as a mean
  will think us pessimistic, which is the safe direction — and is exactly why the
  copy says "at least N" rather than "N". Change that wording and the gap stops
  being safe.
- **A customer whose supply genuinely drops is told nothing until they look.**
  Nothing recomputes the stored figure between applies, so the number on their
  dashboard is what the volumes supported the day they applied. The admin
  FilterCard shows the persisted figure beside today's live prediction for
  exactly this reason: the drift is the leading indicator of a customer about to
  ring up disappointed. It costs us nothing now, which makes it easier to ignore
  and no less worth watching.
- **`recommendedDowngrade` is now the only protection** for a customer over-planned
  for their filter (§28.3). Do not make it harder to find.

### 28.8 — 0097 is a data repair, not an ingest fix

137 leads carried no `postcode_area`, making them invisible to every filtered
customer and absent from every prediction — management matchable leads were 27%
low, GR 61%. `extractPostcode` already handled every format in the data; the
parser simply shipped on 2026-07-21 and every recoverable row predates it. **Do
not "fix" the parser.**

The Postgres spelling of "last regex match" matters: a greedy `.*` prefix eats
as much as it can, leaving `[A-Z]{1,2}` matching one letter, so every two-letter
area loses its first character — "BS14 0GG" becomes "S14 0GG", filing Bristol
under Sheffield. Enumerate matches with the `g` flag and take the highest
ordinality. This was caught by diffing against the real parser row by row, which
is the check to repeat if the backfill is ever rerun.

`fetchLeadVolumeAggregate` also gained a stable `.order()` — `.range()` is
LIMIT/OFFSET and Postgres guarantees no row order without ORDER BY, so pages
could repeat or skip rows once the table passes 1000 — and now excludes leads
`lead_retired_from_allocation()` has retired (invariant 11), which it was
counting as deliverable supply.

### 28.9 — 0100 renames live columns, which is normally wrong

Renaming a column a deployed reader selects breaks it the moment the name
changes. That risk was **absent here and verified rather than assumed**: 0098
reached the database but its code never reached production (`main` selects none
of these columns), so at apply time all 14 columns were NULL across all 38
customers and both new tables were empty. No reader, no data to migrate.

Leaving `filter_guaranteed_leads` in the schema to mean "expected" would have
been a permanent lie in the hardest place to correct later, so the rename was the
cheaper of the two.

| From | To |
|---|---|
| `filter_guaranteed_leads` | `filter_expected_leads` |
| `filter_guarantee_estimate` | `filter_forecast_estimate` |
| `filter_guarantee_likelihood_pct` | `filter_forecast_likelihood_pct` |
| `filter_guarantee_cost_per_lead_pence` | `filter_forecast_cost_per_lead_pence` |
| `filter_guarantee_plan_price_pence` | `filter_forecast_plan_price_pence` |
| `filter_guarantee_accepted_at` | `filter_forecast_acknowledged_at` |
| `filter_guarantee_acceptances` (table) | `filter_forecast_acknowledgements` |

Dropped: `(gr_)filter_guarantee_credit`, `filter_guarantee_settlements`,
`settle_filter_guarantee()`.

**The acknowledgement table survives the promise.** A customer is still shown
specific figures when they apply and still ticks to say they have read them, and
"you told me four a month" is worth being able to answer even when the answer
carries no liability. Same best-effort discipline as before: a failed insert must
never fail the apply, RLS on with no policy, nothing reads it to decide anything.

Two traps the migration itself hit, both worth keeping:

- **`alter … rename column` has no `if not exists`.** Guarding on the old name
  alone is not enough for a re-run: after the first pass the old name is gone and
  the new one is present. Each rename checks for **both**.
- **Drop the CHECK before re-adding it.** §1 drops the guarantee-named
  constraint; §4 must also drop the forecast-named one or a second apply fails
  with "constraint already exists". This was caught by the repo's re-apply
  convention and by nothing else.

**Deployment order — migration BEFORE code**, as ever. 0100 was applied to
`znlfwbnvhlacwzgfalcf` after all 96 migrations were applied to a scratch Postgres
16 from empty, three applies proving idempotency, and the CHECK exercised on 11
cases (negative counts, likelihood 101/-1/0/100, zero prices, the GR mirror, and
all-null). Production was then verified to match scratch exactly.

---

## 29. Self-serve cancellation *(0101)*

Until this shipped a customer had **no working way to cancel**. The settings
page said "To cancel entirely, use Manage billing above", and the billing
portal it opened offered no cancel: the live account's portal configuration
list came back EMPTY over the API, despite §12's old note claiming cancellation
was verified enabled (see the corrected §12 entry). The exposure was worst
around pause: a pause re-bills automatically when it ends, so a customer who
wanted OUT but could only pause was re-billed against their wishes — the exact
shape of a chargeback or a legal complaint. This section is the evidence trail
that closes it.

`POST /api/customer/subscription/cancel` · `CancelSubscriptionCard` in
Settings · both products (invariant 6) · `subscription_cancellations` audit
table.

### What a cancellation is

`cancel_at_period_end: true` on the Stripe subscription — **never an immediate
deletion**. The customer paid for the current period and keeps it (invariant 4:
no refunds); billing simply never happens again. This matches the portal's
`at_period_end` mode, so the webhook sees one event shape whichever door the
customer leaves through. The route sends `cancellation_details` (feedback
mapped onto Stripe's enum by `stripeFeedbackFor()`, comment composed from the
full reason list + note), which is what lets the webhook's EXISTING capture
(0084) store the reason with zero new webhook code.

**One route for do and undo** (§24's rule): `action: "keep"` sets
`cancel_at_period_end: false` and the webhook's change-of-mind branch clears
everything. The pending state renders in Settings with the exact end date and a
"Keep my subscription" button.

### The ordering rule, and why it inverts §24's

Stripe first, then the row — **and no Stripe rollback on a DB failure**, where
the plan route swaps the price back. Once Stripe has accepted the customer's
instruction to cancel, undoing it because OUR cache write failed would
manufacture exactly the "I cancelled but you kept billing me" incident this
exists to prevent. The route's row write (`(gr_)cancel_at_period_end` +
`(gr_)cancel_effective_at`) is UI freshness only; the webhook event our own
update fires is the source of truth and converges the row seconds later.

### The evidence trail

Four records per cancellation, none load-bearing for behaviour:

1. `subscription_cancellations` — reasons (CHECK matches `cancelOptions.ts`
   character-for-character, and `cancelOptions.test.ts` enforces it
   mechanically), note, the single Stripe feedback value, the subscription id,
   `effective_at`, and `confirmation_email_id`. **The only place a GR
   customer's reason survives** — the webhook's feedback capture is
   management-only (0084). RLS on, no policies. `reverted_at` is stamped on
   "keep", latest-open-row-only (`stampEpisodeEnded`'s reasoning). Live state
   is `customers.(gr_)cancel_at_period_end`, never this table.
2. `sendSubscriptionCancelledEmail` — "you will not be billed again" and the
   exact end date, in the customer's inbox on the day they asked. The Resend id
   is written back onto the audit row. `sendSubscriptionKeptEmail` is the same
   in the other direction.
3. Stripe's own record (`cancellation_details`, `cancel_at`).
4. The Monday board flips to `Cancelled` with the end date immediately — the
   route calls `syncCustomerMondayStatus` itself; the label rule already reads
   the stored flags (0087) so the webhook's later push is a cache no-op.

### Guards, and the one deliberately absent

`holdsProduct` (403) → per-product subscription id (409, support copy) →
already-pending / not-pending vs action (409). **No `paused_at` guard**: a
paused customer deciding not to return is the single most important caller.
They stay paused (invoices voided) until the subscription deletes; §21's third
case then clears the pause. `past_due` may also cancel — a failing card must
not trap someone in a subscription.

### The pause-instead interstitial

Cancelling an unpaused management subscription NEVER goes straight to the
reason form: a required first screen compares pausing (billing stops now,
credits kept, place reserved, auto-restart with 7 days' email warning, cancel
still available) against cancelling (ends for good at period end, return needs
a new signup), with "Pause instead" primary and "No thanks, continue to
cancel" quieter. One click each way — a save offer, not an obstacle. GR and
already-paused customers skip it (no pause product / already seen it).

### `(gr_)cancel_effective_at`

0087 stored WHETHER a cancellation is pending; these store WHEN. Written by the
route and by the webhook (`cancel_at` falling back to `subscriptionPeriodEnd`,
the Monday endDate fallback order), cleared by the same change-of-mind rule,
read only for display. For a paused customer the figure is Stripe's rolling
period end, not "when billing stops" — billing already stopped; it is the date
the subscription record dies.

### The portal, fixed alongside

`/api/billing/portal` now falls back to `gr_stripe_customer_id` (a GR-only
Payment-Link customer previously got a 404 — no billing management at all) and
pins `configuration: STRIPE_PORTAL_CONFIGURATION_ID` when the env var is set,
degrading to a bare session when not. The configuration was created from the
Stripe Dashboard on 2026-08-24 — `bpc_1U7tJSBcGEHkDHo9FK2EnInH`, the account
default, cancel at period end with reason collection (§12) — so the bare
session already serves cancel and the env var is optional. Portal cancellations
produce the same webhook shape as in-app ones and need no code of their own;
they simply skip the audit row and our confirmation email, which is why the
settings page steers to the in-app flow.

### Verification

All migrations applied to a scratch Postgres 16 from empty, 0101 re-applied to
prove idempotency; every CHECK exercised (empty reasons, NULL element, invalid
reason, `other` without and with a blank note, 501-char note, bad lead_type);
RLS confirmed on with zero policies; both indexes present; FK cascade confirmed
on customer delete. 0101 was then applied to `znlfwbnvhlacwzgfalcf` and the
same assertions re-run (0 pending cancellations, 4 paused customers at apply
time). `cancelOptions` went through 20 vitest cases including the mechanical
CHECK-vs-lib equality; the full suite is 167 green and `next build` passes.
**Not rehearsed against a live Stripe subscription** — see §12's test-mode
item before leaning on it.

### Deployment order — migration BEFORE code

0101 first (done). The webhook writes `(gr_)cancel_effective_at` on every
`customer.subscription.*` event, so code arriving before the columns would
fail those updates. The portal configuration + env var can land any time —
the route degrades gracefully without them. Nothing here touches a balance,
counter, pacing or capacity column.

---

## 30. Customer-owned leads *(0102)*

A customer can bring their **own** leads into the database — by uploading a
spreadsheet or typing one in — and work them alongside the leads we sell them.
Free, unlimited, and visible to that customer and admin alone.

`/dashboard/leads/add` · `POST /api/customer/my-leads` (+ `/import/preview`,
`/import/commit`) · `DELETE /api/customer/my-leads/[id]`.

Until now every row in `leads` was ours: sourced from Monday, sold to up to
`max_assignments` operators, escalated when ignored, pooled at day 25. An owned
lead is the same row shape with one column set, and that column is the whole
feature.

### 30.1 — The rule, and where it is enforced

**An owned lead is never given to anybody else.** Not by ordinary routing, not
by escalation, not by the pool, not by an admin force-assign.

⚠️ **Superseded in part by §32 (0107, 0108).** An owned lead that has been
through a PAID analysis and come back with trustworthy figures is now sold to
exactly one other operator. The pool half of this rule is untouched and
`lead_pool_barred()` is unchanged — owned leads still never pool, qualified or
not. What changed is `lead_retired_from_allocation()`, which now retires an
owned lead only while `owner_resale_qualified_at` is null, and the consequence
for the table below: **`get_escalation_candidates` no longer inherits the
exclusion through that function** and carries its own `owner_customer_id is
null` clause (0107). Read §32.6 before changing anything here.

That is enforced in the two functions the codebase already treats as the single
expression of "may this lead be handed out" (invariant 11), each gaining one
`owner_customer_id is not null` branch:

| Function | What the one branch covers |
|---|---|
| `lead_retired_from_allocation()` | all three candidate functions, `get_next_customers_for_lead`, `get_escalation_candidates`, and `assign_lead_to_customer` under its row lock |
| `lead_pool_barred()` | `get_pool_entry_candidates` and the daily sweep |

Two paths consult **neither** and so are guarded directly:

- **`admin_assign_lead`** (body last touched in 0053) checks the duplicate, the
  capacity and the pause, then assigns. Without a guard an admin could hand one
  customer's private lead to another from the admin UI.
- **`find_duplicate_lead` (0070) — the dangerous one.** It matches a landlord
  across every lead of a product, and `ingestLead` treats a hit as
  "duplicate, skip". Without `owner_customer_id is null`, a customer importing
  their contact list would **silently poison ingest**: if landlord X sits in
  somebody's spreadsheet and X later enquires through Monday, the real sellable
  enquiry is discarded as a duplicate of a private copy. No error, no lead, and
  invisible on both sides. The two populations must not see each other here at
  all — a customer's private copy says nothing about whether we may sell that
  landlord. `get_duplicate_leads` (the admin *report*) stays inclusive, because a
  customer holding a private copy of a lead we also sell is worth seeing.

Belt and braces: owned leads are seeded `max_assignments = 1,
assignment_count = 1`, so a caller that consults nothing computes no free slots.
`autoAssignLead` also returns early — stated explicitly because the contention
branch (§28.5) can *raise* `max_assignments`, so "it has no free slots" is a
fact about today's code, not a guarantee.

### 30.2 — Visibility needs no RLS change

0014's `leads_select_assigned` exposes a lead only where a `lead_assignments`
row joins it to the caller's customer. So the owner's own assignment row is
**both** what shows them the lead and what hides it from everyone else, and the
realtime feed, the detail page, notes, files, stages and telemetry all work
unmodified. This is why `create_customer_leads` must insert the lead and the
assignment together (below): a lead without one is invisible to the person who
just added it while still being a row every sweep can see.

### 30.3 — `create_customer_leads()` and what it deliberately does not do

One transaction per batch, `service_role` only. Per row it returns `created`,
`duplicate` or `empty`.

- **It spends no credit and bumps no counter** — not `lead_balance`, not
  `leads_received_this_month`, not `management_lifetime_leads_received`. The
  odometer means "leads Stayful delivered" (§13) and these were not delivered by
  us. Charging for a customer's own contact list would be absurd, and quietly
  advancing their pacing counters would starve them of the marketplace leads
  they actually pay for.
- **It does not call `assign_lead_to_customer`.** That is the single money path
  and gates on balance, subscription and pause, none of which should stand
  between a customer and their own data — and it would refuse these outright now
  via `lead_retired_from_allocation`.
- **`price_paid = 0`**, which reads against invariant 4. That invariant is about
  leads *we* deliver; nothing was sold here.
- `income_report_status` is seeded `'no_report'` — true (there is no Monday item
  to carry an analysis) and it keeps owned leads out of the income-report
  backlog by construction rather than by a query filter.

**`lead_name` stays NOT NULL.** The form promises no required fields, so the
name is derived — name → email → phone → address → `'Untitled lead'` — rather
than weakening the column for a UI promise. `monday_item_id` **does** drop its
NOT NULL, replaced by a CHECK that every lead is either Monday's or a
customer's; the UNIQUE constraint stays, and Postgres allows unlimited nulls in
a unique index, so ingest idempotency (invariant 5) is untouched.

Dedupe reuses the DB's own `lead_identity_key()` (0070) **scoped to this owner
and product**, so "the same landlord" has one definition repo-wide. It needs all
three of name, email and phone, so a partial row never matches — under-matching
costs a duplicate, over-matching would silently discard a real lead.

### 30.4 — Parsing is tolerant because the confirmation makes it safe

`src/lib/leadImport.ts`. A real lead list has a title row above the headings, or
no headings at all, or a column called "Tel", or a "Notes from viewing" column
we have nowhere to put. None of that is a malformed file.

- `detectHeaderRow` scans the first ten rows and returns **null** for a
  genuinely headerless sheet, rather than eating its first lead as column names.
- Mapping is by header synonym first, then by **content** — a column of things
  containing "@" is an email column whatever it is called. Where a header
  disagrees with its own data ("Contact" full of phone numbers) the data wins.
- Single-claim targets (name/email/phone/address/bedrooms) may be used once;
  `notes` may be used many times, because a sheet often has several comment
  columns.
- **Unmapped columns are folded into `lead_profile` as `Header: value` lines**,
  so nothing on the spreadsheet is lost. That was the brief.
- `raw: false` on `sheet_to_json` is load-bearing: it yields Excel's own
  formatted text, so a phone stored as a number keeps its leading zero.
  Everything is stored as text.

**The confirmation screen is never skipped**, even when every column resolves
confidently. It is what licenses all of the above: a wrong guess costs one
dropdown change, where a silent import puts a landlord's phone number in the
address field of two hundred leads.

`enquiry_date` is deliberately not a mapping target — it is displayed nowhere
(§11), so offering it would let a customer believe a date they can see in their
sheet will appear somewhere it never does.

### 30.5 — The first model call in this codebase

`src/lib/claudeMapping.ts` asks Claude to map columns the heuristics could not.
It is structured so that adding a model dependency does not make the feature
depend on one:

1. **It only ever proposes** — the customer confirms.
2. **It is asked only when there is real doubt** (`mappingNeedsHelp`): an
   unplaced column that still holds data, or no header row found. A clean sheet
   costs nothing.
3. **Nothing it returns is trusted.** `validateMappingResponse` rejects unknown
   targets and out-of-range indices, clamps confidence, enforces the
   single-claim rule the prompt merely asks for, and leaves an unmentioned
   column alone rather than shifting the others along.
4. **Every failure returns the heuristic mapping** — missing `ANTHROPIC_API_KEY`,
   timeout, API error, malformed JSON. The import works with the model
   unavailable.

`claude-opus-5`, structured output via `zodOutputFormat`, `effort: "low"` (a
column mapping is a small judgement and the customer is waiting), 20s timeout.
`ANTHROPIC_API_KEY` is a **new env var** and `@anthropic-ai/sdk` + `zod` are new
dependencies; both are optional at runtime.

⚠️ **PII**: the preview sends up to 20 raw rows — real landlord names, emails
and phones — to the Anthropic API. Deliberate, and the reason the call is
skipped whenever the heuristics already suffice. Redacting the samples, or a
per-customer opt-out, is a one-line change if it is ever wanted.

### 30.6 — Two requests, and the staging table between them

`lead_imports` holds the parsed rows between preview and commit, so the commit
works from the bytes we parsed rather than anything the browser hands back — the
"client proposes, server re-derives" discipline `/api/customer/filter` uses for
the volume forecast. RLS on with **no policies**, as `subscription_pauses`: the
payload is the customer's raw spreadsheet, which must never be one missing
policy away from another customer.

`status = 'pending_mapping'` is the **idempotency claim**. A double-clicked
button or a stale tab finds the batch already `imported` and gets its tally back
rather than a second copy of every lead.

Uploads are multipart `formData`, not the browser→Storage pattern: that exists
for files that must *persist* (lead attachments), where a spreadsheet is needed
only for as long as it takes to parse. Caps are **2,000 rows / 4 MB**, and an
over-cap file is **rejected, not truncated** — importing the first 2,000 rows of
a longer file is the kind of loss nobody notices until they go looking for a
landlord who was never there. Both import routes set `maxDuration = 60`.

### 30.7 — Delete, and why the other three exits are refused

Reject, discard and close are all statements about a lead **we** supplied, and
all three now refuse an owned lead **server-side**, not merely in the UI.

**Discard is the one that matters.** It deletes the assignment row and
decrements `assignment_count` to return the lead to circulation. On an owned
lead that would leave the `leads` row alive with **no assignment at all** —
invisible to its owner under `leads_select_assigned`, absent from their feed,
and unreachable by the delete control, which resolves the lead through that same
assignment. A permanently orphaned row created by the one path that destroys the
evidence.

`DELETE /api/customer/my-leads/[id]` removes the lead itself and lets the 0001
cascade take the assignment, notes, files, events and notifications. Nothing was
charged and it was never offered to anyone, so there is no record to preserve.

⚠️ **Since §32 this is only one of two modes.** Once a lead has been sold to
another operator, deleting the `leads` row would cascade away the BUYER's
assignment, notes and files — a lead they paid £15 for. The route now calls
`delete_owner_lead_copy` (0107), which decides under a row lock: whole lead when
nobody else holds it, the uploader's copy alone when somebody does. See §32.7 for
the two things it must never do.
"No such lead", "not yours" and "not an owned lead" all return one
indistinguishable 404.

**`Mark as contacted` is deliberately still offered** on an owned lead, which is
why `showActions` in `LeadDetail` is unchanged rather than narrowed — narrowing
it would have hidden that button from a *marketplace* lead carrying notes at a
non-cold stage.

### 30.8 — Kept out of everything the marketplace measures

Owned leads are in the customer's own figures and out of ours. Each exclusion
has a specific consequence, which is why they are listed rather than summarised:

| Where | What it would otherwise do |
|---|---|
| `fetchLeadVolumeData` (§28) | inflate the volume figure we **quote** a customer applying a filter — a number we would then fail to deliver |
| `publicStats` (count + ticker) | overstate a public claim about our own supply |
| `/api/admin/leads/assign-pending` | sell an imported lead to another customer within a day |
| `/api/cron/parse-income-reports` (**all five** queries) | feed a null `monday_item_id` into Monday's `items(ids:)`; they would fail nightly for ever, occupying batch capacity. The `no_report` seeding keeps them out of the backlog, but the 30-day re-check selects exactly the recently-created `no_report` rows they are |
| `/admin` awaiting-assignment, `/admin/leads` counters and waiting figures | report a backlog no admin action could ever clear |
| Goals won count (§13) | let a customer import fifty existing clients, mark them won, and "achieve" a marketplace goal on their own book |

**Deliberately NOT excluded:** the inactivity nudge and the weekly progress
report. Those describe the customer's own pipeline and should cover every lead
they are working — which is the point of the feature. Recorded here so nobody
later "fixes" the asymmetry.

**Still outstanding (0103):** the cross-customer aggregates that compare
operators — `get_customer_engagement_scores`, `get_engagement_benchmarks`,
`get_wins` / `get_customer_scoreboard` / `get_assignments_awaiting_outcome`,
`capture_operator_proof` **and** `get_operator_proof` (which duplicate one
population and must change together, §20), and the leads-scanning CTEs in
`get_service_capacity`. ~~All need `l.owner_customer_id is null`.~~ ⚠️ **That instruction is now wrong
for at least two of them** — see §32.8. Since a customer may BUY an owned lead,
the predicate must be `l.owner_customer_id is distinct from c.id`:
`get_customer_engagement_scores` and `get_wins` / `get_customer_scoreboard`
would otherwise drop a buyer's paid assignment out of their own engagement score
and leaderboard standing. They were held
back from 0102 deliberately: they are eight large function bodies, all
reporting, and rewriting them beside the safety-critical work above would have
put a transcription slip in a reporting CTE next to the code that stops a lead
being sold twice. **Until 0103 lands, a customer's own leads dilute their
engagement score and their standing on the leaderboard**, and read as
marketplace supply in the capacity panel.

### 30.9 — Where it shows

Entry sits **beside the Export button**, in both places `ExportButton` renders
(`/dashboard` and `/dashboard/leads`), plus the Leads nav group. That is where a
customer is already thinking about their leads as a spreadsheet.

A "Your lead" badge on the card and the detail page; a source filter in
`LeadsList` shown only once the customer has any; `"Added by you"` in the export
Source column (`leadSourceLabel()` is the one definition); and an analytics
breakout on the §19.9 claimed-leads pattern — counted in every figure, shown
separately, because how their own sourcing converts against ours is exactly the
question somebody importing their book is asking.

Admin lists them with a Source column naming the owner, and excludes them from
bulk-assign selection and every counter. The lead detail page swaps the override
controls for a line saying who added it — `admin_assign_lead` refuses them
anyway, and an offered control that 400s reads as a bug.

### Verification

All 98 migrations applied to a scratch **Postgres 16** from empty, 0102
re-applied twice for idempotency. Every CHECK exercised: bad `owner_source`,
both halves of a half-owned row, a lead with neither identity, and a valid owned
lead with a null `monday_item_id`; `monday_item_id` UNIQUE confirmed still
enforced for real ids. The partial index and the FK cascade confirmed.

Behaviour, against seeded rows: `create_customer_leads` returning
created/duplicate/empty correctly, deriving a lead name from a phone-only row,
seeding the flags, writing `price_paid = 0`, and **touching no customer
counter**. The owned lead then absent from `lead_retired_from_allocation`
(true), `lead_pool_barred` (true), `get_next_customers_for_lead` (0),
`get_pool_entry_candidates` (0), `get_escalation_candidates` (0) and
`find_duplicate_lead` (null); both assign functions raising.

**The regression that mattered**: a marketplace lead still allocating normally,
still deduping, and still returning candidates. ACLs re-asserted and audited
with `has_function_privilege` on all five redefined functions, including that
`get_engagement_benchmarks` remains `authenticated`-executable (invariant 7).

The import **seam** was then driven end to end, which is the check the unit
tests structurally cannot make (§23.10, §25): a generated xlsx carrying a title
row and a blank line above the headings, "Landlord"/"Mobile No."/"E-Mail"
spellings, a phone Excel stores as a number, an unmapped notes column, a blank
spacer row, a notes-only row and an in-batch duplicate — through the real
parse → detect → map → normalise → RPC path. Header found at row 2, all six
columns mapped, **the leading zero survived the real xlsx round-trip**, the
unmapped column landed on the lead profile, both empty rows skipped, the
duplicate caught, no counter moved.

203 vitest cases green (36 new), `npm run build` passes. **The Claude mapping
call itself has not been exercised against the live API** — no key was available
in the build session — only its validation and fallback paths, which are unit
tested. Set `ANTHROPIC_API_KEY` and run one messy sheet through before relying
on it; without the key the heuristic path is what runs, and that *has* been
exercised end to end.

### Deployment order — migration BEFORE code

**0102 is applied to `znlfwbnvhlacwzgfalcf` (2026-08-25).** It went on AFTER the
code reached a preview deployment rather than before, which is how the ordering
rule gets its evidence: the preview returned "Could not find the function
public.create_customer_leads … in the schema cache" on every manual add, and
`/dashboard/analytics`, `/dashboard/goals`, `/admin/leads` and
`assign-pending` all failed alongside it. Two failed *silently* and are the
reason the rule is worth keeping: `fetchLeadVolumeData`'s paging loop breaks on
the error and returns an empty result, so the filter forecast quotes ZERO
volume, and the admin awaiting-assignment tile swallows its error into
`data: null` and reads 0. Production on `main` was unaffected throughout, since
`main` carried none of this code.

Before applying, production's live `prosrc` for all four rewritten functions
(`lead_pool_barred`, `lead_retired_from_allocation`, `admin_assign_lead`,
`find_duplicate_lead`) was diffed against the migration-file bodies they are
copied from and found identical — worth doing rather than assuming, because §11
records that production has drifted from `supabase/migrations/` before. After
applying: all 430 existing leads untouched and none owned, both CHECKs and the
partial index present, `lead_imports` RLS on with zero policies, and the ACL
audit clean — including that `get_engagement_benchmarks`,
`get_operator_proof`, `get_recent_wins_anonymised` and
`set_management_customer_goal` all remain `authenticated`-executable
(invariant 7).

0102 first. It is inert on its own — every new filter matches nothing until code
starts writing owned leads — while code selecting `owner_customer_id` against a
schema without it would fail every leads read. `ANTHROPIC_API_KEY` can land any
time; the import degrades to heuristic mapping without it. Nothing here writes a
balance, counter, pacing or capacity column, so a lagging migration cannot
affect lead allocation.

---

## 31. Paid lead analysis *(0104, 0105, 0106)*

A customer pays **£3 a lead** to have their **own** leads (§30) run through the
Stayful property analyser. The result is a lead that is indistinguishable from
one that came through the marketplace: projected occupancy, nightly rate, gross
income, the management fee, and the full analysis PDF.

`/api/customer/lead-analysis` (+ `GET /[jobId]`) · `/api/cron/run-lead-analysis`
· `POST /api/internal/analyse` on the analyser app.

### 31.1 — Why the gap existed at all

§25's figures come from parsing a PDF attached to a lead's **Monday item**. An
owned lead has no Monday item — 0102's CHECK says so explicitly — so the one
path that produces those figures could never fire for the leads this feature is
about. A customer importing two hundred leads got two hundred rows with a name,
an address and nothing to decide with.

### 31.2 — The insight the whole design rests on

**Almost none of the write path needed writing.** `IncomeReportOutcome`
(`incomeReport.ts`) already carries every figure column *and* `bytes` for the
PDF; `incomeReportPatch()` produces the column patch and `syncStoredReport()` is
the only writer to the `lead-reports` bucket. So the worker's entire database job
is to build one `IncomeReportOutcome` from the analyser's JSON and hand it to the
two functions the Monday sweep already hands it to.

That is what makes an analysed owned lead render identically with **no display
code at all**: it is not *like* a parsed lead, it **is** one. Every piece of UI in
this feature sells the analysis; none of it shows it.

`NO_FIGURES` is exported for the same reason it exists — there are now two
producers of `IncomeReportOutcome`, and a figure added to one has to reach both
or the other quietly starts reporting stale values.

### 31.3 — The analyser call, and how Monday is kept out of it

`POST /api/internal/analyse` on the analyser repo, gated on `x-internal-secret`
(404 when unset, the `reports/count` fail-closed pattern). It wraps
`runAnalysis()` — the same function the public form and the admin bulk upload
use — and renders the PDF itself.

**Nothing reaches Monday, and that is enforced by omission rather than a flag.**
`persistAndSync()` returns before any Monday work when it has no email, phone or
item id, so the request carries **none of the three** and the route rebuilds the
body field by field rather than forwarding it. A caller cannot reintroduce a
signal by sending one. It is also why no landlord PII leaves this app: the
analyser is sent the property and nothing else.

The `analyser_reports` insert sits *before* that early return, so the run is
still persisted and attributable as `source: 'lead_db'`.

**No `sideEffectGate` is passed** — a gate vetoes a CRM write and there is none.
The same verdict is computed and returned as `quality_ok`, because the caller is
about to charge somebody and refunds a row that comes back false.
`getShortLetData()` swallows upstream failures and returns a *plausible synthetic
estimate*, so that flag is what stands between an Airbtics outage and a customer
paying for a page of invented valuations.

### 31.4 — ⚠️ Occupancy is a fraction there and a whole percent here

`ShortLetData.occupancyRate` is **0–1**. `leads.occupancy_rate` is the percentage
as printed (63, not 0.63) and its CHECK is `>= 0 and <= 100` — **which `0.63`
passes silently.** A lost multiplication writes a believable wrong number that no
constraint catches, and the only visible symptom is `incomeBasis()` quietly
switching to the comp-set wording.

The conversion therefore happens **once**, in `toOccupancyPercent()` on the
analyser side, and is **re-asserted** on this side in
`buildOutcomeFromAnalyserResponse`. It refuses a value already in percent rather
than passing it through: tolerating both units is how
`analyser_reports.occupancy` came to hold both. Rate and occupancy are stored as
a pair or not at all (0091).

Two other guards there exist because the column cannot catch them itself:
`monthly_revenue_profile` has a `cardinality = 12` CHECK that aborts the **whole
lead update**, not just its own column; and a zero-length PDF is never a
legitimate state — 159 of them once shipped as reports operators could open
(§25).

### 31.5 — Nothing is analysed before it is paid for

A job is created `awaiting_payment`, and `claim_lead_analysis_rows` only ever
looks at jobs that are `running`. The **only** thing that makes that transition
is `record_lead_analysis_success`. So the money gate is a property of the schema
rather than a rule somebody has to remember in a route.

The charge is a **sibling** of the top-up, not a copy. `chargeIntent.ts` now
holds the Stripe mechanics for both, and the doctrine is unchanged: **never
finalise a claim as failed unless the outcome is DEFINITIVE**, because a
connection error can be thrown after the money was taken. On an indeterminate
outcome the claim is released and the idempotency key makes a retry return the
original intent.

Three things differ deliberately:

| | Top-up | Lead analysis |
|---|---|---|
| Active-token index | `(customer_id, lead_type)` | **`(job_id)`** — a customer may hold an unredeemed top-up offer *and* buy analysis, and may buy two batches ten minutes apart |
| Credit | `+5` to `(gr_)lead_balance` | **nothing** — `credits_added: 0`. This buys analysis of leads already owned; crediting would hand them marketplace leads nobody paid for and move the pacing counters §13 measures delivery by |
| Eligibility | "never sell credit the customer cannot spend", so a **paused** customer is refused | a paused customer **may** buy: nothing here depends on assignment, and the figures land whatever their subscription is doing. Holding the product is still required |

**A £600 off-session charge nobody is present for is what issuers decline**, so
above `HOSTED_CHECKOUT_THRESHOLD_PENCE` the saved card is skipped entirely and
the flow goes to Stripe's hosted page, where a 3-D Secure prompt can actually be
answered. `forceHosted` is a real field on `ChargeSpec` — it was briefly passed
through an object spread, where excess-property checking does not apply, and so
silently did nothing.

### 31.6 — The late-succeeding charge, which is the subtle one

`record_lead_analysis_failure` cancels the job when a charge is definitively
declined. A `payment_intent.succeeded` can still arrive afterwards, for an intent
that settled late — and the money is then genuinely gone from the customer's
account.

`record_lead_analysis_success` therefore **revives a cancelled job and its rows**,
not merely an `awaiting_payment` one. Without that the first version recorded the
payment and left the batch closed: charged, and nothing done. A **completed** job
is still never revived — it already ran, and its refund may already have been
paid.

### 31.7 — What is owed back, and why it is not a count of failures

A row is refundable when it is terminally dead: attempts exhausted, or figures
the analyser told us not to trust. The refund is issued **once per job**, at the
end of a worker run, with an idempotency key derived from the job.

**The doctrine inverts here.** A charge whose outcome is unknown releases; a
refund whose outcome is unknown is **left `due`** and re-attempted. Worst case we
refund twice, which the idempotency key and `uq_payments_stripe_refund` both
prevent anyway. The failure that must never happen is marking a refund done that
never was, because nothing looks at it again.

⚠️ **`finalise_lead_analysis_job` computes the refund as `row_count -
succeeded`, NOT as a count of failed rows**, and that is a fix rather than a
style. `lead_analysis_rows.lead_id` cascades from `leads`, so a customer who
deletes one of their own leads in the half hour between paying and it running
takes its row with it. Counting failures then found nothing to refund: paid for
three, received two, owed nothing. Counting what was paid for and subtracting
what was delivered cannot miss a row, because it never looks at the rows at all.

### 31.8 — The worker, and ⚠️ the plan this repo thinks it is on

**§2 says "The account is now on Pro". The Vercel API reports this team as
`hobby`**, and the owner confirmed it. That matters more than a doc correction:

| | Hobby | What this repo does |
|---|---|---|
| Function ceiling | **60s** | `parse-income-reports` and the 0092 backfill both ship `maxDuration = 300` |
| Crons | **2, daily only** | `vercel.json` declares **11** |

So some existing crons may not be firing at all, and any route relying on more
than 60 seconds is being cut short. **Neither is caused by this feature and
neither is fixed here** — recorded because the next person to trust §2's Pro
claim will size something against 300 seconds and be wrong.

What this feature does is stop depending on either. The worker is
`maxDuration = 60` with a 50-second claim budget and a 46-second reserve, and it
**chains rather than loops**: one invocation does one row and hands off to a
fresh one, fired immediately after the claim and before the analysis, so a
successor is already on its way while the row runs and an invocation killed
mid-row cannot take the chain down. Overlap is harmless — claiming is atomic and
the in-flight cap lives inside the claim function, so an early successor finds
nothing and exits.

`after()` from `next/server` would be the right way to defer that until the
response has flushed, as the analyser's bulk worker does; it is Next 15+ and this
app is 14.2.15, so the request goes out during the handler instead.

The cron is therefore a **daily backstop**, not the driver. Three things start
the queue: the purchase itself, the chain, and the progress panel's poll. The
cron exists for the case where all three failed.

`ANALYSIS_ROW_TIMEOUT_MS` is **45s** and must stay under the ceiling — we have to
still be alive to record the outcome after giving up on a row, or it sits
`running` until the stale window reclaims it. A worst-case 70-second property
will be killed; that is survivable rather than ignored, because the client treats
a timeout as retryable and the analyser's durable report cache means the retry
re-reads the report already paid for.

**On Pro, three numbers change together**: `maxDuration` to 300 on both this
worker and the analyser's `/api/internal/analyse`, the budget to ~240s, and the
row timeout to 90s. The chain can stay — it costs nothing.

`claim_lead_analysis_rows` is a transcription of the analyser repo's
`claim_bulk_rows`. `p_max_inflight` (default 3) is a **spend-rate throttle, not a
latency knob**: every in-flight row is an external report we pay for whether or
not we keep the answer. `attempts` increments **at claim**, so a row that
hard-kills its worker burns an attempt rather than looping forever buying the
same report.

Failures are sorted by whose fault they are. A rejected input or a property that
will not geocode is terminal. A 5xx, a dropped connection or a timeout is
retryable — a timeout especially, since the analyser may well have finished and
paid for the report after we stopped listening, and its 24-hour cache means the
retry does not buy it twice. A missing or refused secret, or a 429, is
**blocked**: the row hands its attempt back and the run stops rather than
marching the rest of a paid batch into the same wall.

### 31.9 — Where it sells

The bulk offer sits **after the import commits**, which is the design and not an
accident of layout: that is the first moment we know which rows became *real*
leads, so quoting earlier would bill for duplicates — which `create_customer_leads`
creates nothing for — and for blank rows. It also means a declined card costs
nothing, because the leads are already in.

The mapping screen carries a **non-binding** estimate so the price is seen before
committing to anything. It is computed **server-side over every row**: the client
holds only the ten preview rows, and "8 of 10 look ready" for a two-hundred-row
sheet is a wrong number dressed as a precise one. It hides itself the moment a
mapping it depends on changes, rather than restating a stale figure.

Arm-then-confirm everywhere, never a modal — the repo vendors no dialog
primitive, and a single click must never move £552.

**The postcode became an import target of its own** (`leadImport.ts`). It used to
be a synonym for `address`, and since `address` is single-claim, a sheet with
both an Address and a Postcode column had them fight: the loser was folded into
`lead_profile` as prose. That cost nothing while the postcode was only ever read
back out of the address, and is the difference between an analysable lead and an
unanalysable one now the analyser is sent it as a field. `toRpcRow` prefers an
explicit postcode and appends it to the address when the address lacks it.

### 31.10 — Guaranteed Rent

**In scope, with the fee line suppressed.** `IncomeProjection` used to refuse a
non-management lead outright, which was right when nothing could produce figures
for a GR lead and wrong now that this can. What was always true is that the FEE
is what a *management* operator earns: a GR operator earns the margin between the
rent they guarantee and what the property makes, so a management fee is a **wrong**
number for them rather than a missing one.

So gross, nightly rate and occupancy render for GR — they are exactly what a GR
operator prices their guarantee against — and the fee half does not. **Do not
restore the early return**: it would now silently hide figures somebody paid for.

### Verification

**100 migrations applied to a scratch Postgres 16 from empty**, 0104 and 0105
each re-applied twice. Every CHECK exercised; RLS confirmed on with zero policies
on all three tables; ACLs audited with `has_function_privilege` on all seven new
functions, and invariant 7 re-checked on the four that must stay
`authenticated`-executable.

The claim RPC was driven under contention: an unpaid job's rows refusing to be
claimed; the in-flight cap taking 3 then 0; attempts incrementing at claim; a row
abandoned by a killed worker reclaimed after the stale window and one that had
burned both attempts never reclaimed again; **eight concurrent claimers taking
twelve rows with twelve distinct ids and no double-claim.**

The money path: two concurrent submits claiming one token with the second getting
nothing; success flipping the job to `running` with `credits_added` 0 and every
balance untouched; a replay adding no second payment row; a release letting the
same token retry while a paid one is never reopened; a definitive decline
cancelling the job and its rows; and the late-payment promotion reviving all three
rows into a claimable state.

**Regressions, on a fresh database:** a marketplace lead still not retired, not
pool-barred, still returning a candidate, still allocating and spending exactly
one credit, and still deduping. An owned lead still retired, still pool-barred,
absent from pool and escalation candidates, and refused by **both** assign
functions when a *second* customer asks for it. And the one that matters most —
`find_duplicate_lead` returning null for a landlord who exists only as somebody's
private copy, so an owned lead still cannot poison ingest (§30.1).

**The seam drive**, against a real analyser (`PIPELINE_FAKE=1`, so £0) and a real
Postgres holding the real schema: occupancy stored as 55 and not 0.55;
`rate × 365 × occupancy` reconciling with gross to 0.65%, so the lead reads
"Based on £159 a night at 55% occupancy" rather than falling back to the comp-set
wording; both management-fee derivations agreeing exactly; twelve monthly values;
every CHECK satisfied; **the PDF 20,416 bytes at the analyser, 20,416 decoded and
20,416 handed to storage, byte-identical and still beginning `%PDF-`**; no
customer counter moving across the write; the lead still carrying no Monday item;
and not one Monday line in the analyser's log.

**Not exercised against live Stripe.** The charge, the hosted-checkout fallback
and the refund have been driven only against stubs and the RPCs. Rehearse them in
test mode before relying on them — the same standing item §12 records for the
tier swap and the cancel flow.

### 31.11 — Where admin sees it *(0106)*

`/admin/imported-leads`. Customer-owned leads are excluded from every
marketplace counter (§30.8), which is right — they are not our supply — and
left them invisible rather than merely uncounted: nothing anywhere could answer
"how many leads have customers brought in".

Three readings of one population, because they answer different questions: all
time (is the feature used), by month (is it growing), by customer (is it one
operator or forty). Each row links through to the lead list filtered to it.
"Analysed" counts a non-null `gross_annual_income` — deliberately not
`income_report_status = 'parsed'`, which is also true of a marketplace lead read
off Monday and would quietly start counting something else if the two
populations ever met.

**Counted in SQL, not by counting rows in the page.** The admin leads page reads
every lead with no limit and gets away with it at ~430; this is the population
that grows in 2,000-row steps. `idx_leads_owner_customer` already indexes
exactly these rows. The lead list itself is filtered in the query and capped,
and says so when it truncates.

⚠️ **Months are cut in Europe/London, not UTC**, and `src/lib/importedLeadMonths.ts`
exists to make the page agree with the SQL. A lead added at 00:30 BST on the 1st
of August is 23:30 UTC on the 31st of July: a naive cut would count it in July
while the list beside it printed August, and clicking a month would fetch a
window an hour out at each end. The helpers are unit-tested across both clock
changes, and were cross-checked instant by instant against `date_trunc(... at
time zone 'Europe/London')` in Postgres.

### Deployment order — migrations BEFORE code

**0104, 0105 and 0106 are applied to `znlfwbnvhlacwzgfalcf` (2026-08-25)**,
ahead of the code this time rather than after it — §30's own account of what
the other order costs was enough of an argument.

Pre-apply: no name collision on any of the three tables, eleven functions or the
`payments.stripe_refund_id` column. Post-apply: 432 leads and 39 customers
untouched, three tables with RLS on and zero policies, and **all eleven function
bodies byte-identical to `supabase/migrations/`** by `md5(prosrc)` — the check
§11 says not to assume. Migrations were applied with their outer comment blocks
stripped, which was proven schema-identical first: same `prosrc` md5, same
columns, same constraints, against a scratch build from the full files.

Supabase's linter then flagged one thing that was ours —
`touch_lead_analysis_updated_at` with a mutable `search_path`. Pinned in both
places. It is SECURITY INVOKER and needs a trigger context to do anything, so
that is hardening rather than a hole; the reason to fix it anyway is that a new
warning left in the list is how the list stops being read. `prosrc` is unchanged
by it — `search_path` lives in `proconfig`.

The remaining `rls_enabled_no_policy` notices on the three new tables are the
deliberate deny-all posture, shared with twenty-odd existing tables.

Then the code. Both are inert on their own: nothing
selects from these tables until the worker lands, and no row can be worked until
a charge lands. Code arriving first would query tables that do not exist on every
import commit, which now quotes the offer.

`ANALYSER_API_URL` and `ANALYSER_INTERNAL_SECRET` can land any time — without
them the queue simply does not drain, which is the safe direction: nothing is
charged for work that cannot happen. `INTERNAL_API_SECRET` must hold the **same
value** on the analyser app.

---

## 32. Leaving, coming back, and reselling a lead you brought in *(0107, 0108)*

Three changes that share one theme: what a customer keeps when they stop paying,
and what happens to the leads they bring in themselves.

### 32.1 — The database is free, and always was *(no migration)*

A customer who pauses or cancels could already log in and read everything.
Nothing in `middleware.ts` or `dashboard/layout.tsx` gates on subscription
state, and `getCurrentCustomer()` resolves the row on the service role
regardless. What was shut was the half that makes it a CRM rather than a
delivery channel: `/dashboard/leads/add` refused them, and both
`POST /api/customer/my-leads` and `.../import/preview` 403'd on `holdsProduct()`.

So the gate became **"is this a pipeline you have ever run"**, not "are you
paying". They keep their login, every marketplace lead already delivered with
its notes, files, stages and export, and the ability to add and import their own
leads free and unlimited. **The only thing that stops is new allocation.**

`availableLeadTypes()` in `src/lib/products.ts` is the single definition, built
on `previouslyHeldProduct()`:

| Product | Test |
|---|---|
| Management | `account_status = 'cancelled'` **or** `cancelled_at` non-null |
| Guaranteed Rent | `gr_cancelled_at` non-null (GR has no `account_status` — invariant 6) |

**Those columns are the point.** The Stripe webhook is their only writer and it
only ever stamps them on a real cancellation, so a **waitlisted or invited
account can never satisfy them**. That is what lets the same predicate serve as
the re-subscribe gate below without reopening self-serve acquisition.

`lead_type` is resolved from history rather than offered as a free choice.
`create_customer_leads` scopes its duplicate check to `(owner, lead_type)`,
pipeline stages differ per product, and the analysis route filters on it — a
selector would hand a customer silent duplicates spread across two pipelines. A
never-subscribed account gets `[]` and keeps its existing card.

**Paid lead analysis follows the same rule** (`analysisIneligibilityReason`).
Nothing about it depends on assignment, which is the argument that already
admitted a *paused* customer; a cancelled one is the same case. Consequence
worth knowing: a non-subscriber can therefore generate resale supply for paying
ones.

Still gated, deliberately: goals, filtering, the expired pool, packages
checkout, top-ups.

### 32.2 — Saying so, before they decide

`src/lib/retentionCopy.ts` — `KEEP_CRM_POINTS` and `keepCrmBulletsHtml()`. Four
surfaces state this promise (the pause form, two steps of the cancel flow, both
confirmation emails) and four copies of one promise is four chances to drift.
The same discipline `cancelOptions.ts` uses for its reason list.

Placement is part of it:

- In the pause card, **above the arm button**, not inside the armed form. It can
  only change a decision if it is read before the decision.
- In the cancel interstitial, **below both columns**, not inside either. It is
  equally true of pausing and cancelling; put in one column it reads as a point
  scored for that option.
- In the `reasons` step's consequences box, immediately above the irreversible
  click.

**The last bullet is the limitation** — no new leads are allocated. A list that
only says what they keep reads as a sales pitch and buries the thing they most
need to understand.

"Coming back later needs a new signup" was removed from the cancel column. 32.3
makes it false.

### 32.3 — Two ways back in

**Resume, for a paused customer.** `POST /api/customer/subscription/resume`.
There was no in-app resume at all before this: the daily cron resumed them on the
date they originally chose, and the only early exit was the Stripe billing
portal, which is a billing screen rather than somewhere anyone looks for "send me
leads again".

`src/lib/resumePause.ts` holds the body, shared **verbatim** with
`/api/cron/resume-paused-subscriptions` — the cron keeps its query, its
`cancel_at_period_end = false` filter, its tallies and the pause-ending notice
block, and its behaviour does not change. Every step of that body is
load-bearing and none of it is worth having twice: Stripe first so a failure
leaves the row paused for the next run; the clear **guarded on `paused_at` still
being set**, which is what decides who sends the "you're back" email when the
webhook races us; the pacing re-baseline that stops a stale anchor reading as a
maximal deficit and flooding them on return; `lead_balance` untouched.

The manual route **refuses a pending cancellation** rather than resuming it, and
for a different reason than the cron's. The cron skips so it never un-pauses
somebody behind their back; here they are asking for it, but their subscription
is still on record as ending, so resuming would restart collection for a period
they closed. It points at "Keep my subscription", which is self-healing — that
clears the flag and the next daily run resumes them normally.

⚠️ **The copy must not promise a charge today.** A `void` pause leaves Stripe's
billing cycle running underneath and resuming only stops the voiding, so the next
real charge lands at the next natural cycle boundary (§11). Leads restart
immediately; billing does not.

**Re-subscribe, for a cancelled customer.** `/api/customer/subscribe`'s 403 gains
one exception: `previouslyHeldProduct(customer, leadType)`. A waitlisted prospect
is still refused — that is the guard's whole purpose (§17) — and the columns
behind the predicate make that structural rather than a matter of care.

Everything else in that route stays exactly where it is: the allocation write
**before** `checkout.sessions.create` (§17's trap), activation as the webhook's
job, and `invoice.paid` promoting `account_status` out of `'cancelled'` (§23.9).
Unused credits are kept (§18E).

`/dashboard/packages` mirrors the gate **per product, not per page**: holding the
other product buys either, having once held *this* one buys only this one back.
A customer who cancelled management sees a checkout for management and support
copy for GR, because buying GR would be acquisition.

### 32.4 — One resale, and only one

**An owned lead that has been ANALYSED goes to exactly one other operator.**

Qualification is a **paid** analysis (§31) that returned figures we trust. A run
rejected for `quality_ok = false` — the analyser's tell-tale for a synthetic
estimate from `getShortLetData()` — never qualifies, and neither does a failure
of any other kind. Those leads stay unsellable for ever.

| | |
|---|---|
| Reach | Uploader **+ exactly 1**. Never more |
| Price | £15, one credit, ordinary routing — indistinguishable from any other lead |
| To the uploader | **Never.** Not by routing, not by admin, not out of the pool |
| Pool | **Never.** Qualified or not |
| Uploader's reward | None |
| Notice to the uploader | **None** — see 32.8 |

Two columns, because there are two questions:

- **`owner_resale_allowed`** — consent, stamped `true` at creation by
  `create_customer_leads` and never changed. This **is** the new-uploads-only
  rule: anything added before 0108 keeps the default of `false` and can never
  become sellable, however it is analysed later.
- **`owner_resale_qualified_at`** — the event. Non-null **is** the sellable
  state, and it is what `lead_retired_from_allocation` reads.

**A property of the row rather than a clock, deliberately.** The obvious
alternative is a cutoff timestamp in `system_settings` compared against
`created_at` — the `reclaim_enabled_from` shape (§7). Rejected: a global like
that is one bad read from enrolling the entire back catalogue at once, and it
does not survive a restore into a different timeline. A per-row boolean
defaulting to `false` fails in the safe direction by construction.

`qualify_owned_lead_for_resale()` is **claim-by-write** (the `credit_invoice`
discipline, §19.5) and every clause in its `WHERE` is load-bearing:

| Clause | Why |
|---|---|
| `owner_resale_qualified_at is null` | Idempotent. The worker retries on a failed write, and a customer may buy a **re-run** of an already-analysed lead — neither may raise the cap twice |
| `max_assignments = 1` | Refuses to overwrite a cap an admin moved by hand. Better unsellable than silently rewritten |
| `gross_annual_income is not null` | The same test `/admin/imported-leads` uses for "analysed" (§31.11), **not** `income_report_status = 'parsed'` — which is also true of a marketplace lead read off Monday |
| `postcode_area is not null` | ⚠️ **Not redundant.** It is what `get_filtered_candidates_for_lead` matches on, so a lead without one reaches unfiltered customers only — sold, quietly, to the wrong half of the book. `analysability()` already refuses a lead with no clear postcode, so this should never bite; if it does, the lead stays unsellable rather than mis-routed |

The cap goes to 2 **in the same statement** that stamps the timestamp, so the
sellable state and the room to sell into can never disagree.

### 32.5 — A clear postcode is already the price of entry

`analysability()` in `src/lib/leadAnalysis.ts` refuses `no_postcode` and
`ambiguous_postcode`, and `analysisQuote()` drops those rows from the quote. So
a customer **cannot pay** to analyse a lead without a clear postcode, and
nothing can qualify for resale without one. Nothing enforces this beyond what
was already there — which is the point: a resold lead carries the same shape as
every other lead in the book, and routes through the same filters.

### 32.6 — Every place the cap of one could break

Eight paths could raise or bypass `max_assignments`. Six are SQL and are stopped
in **0107**, which is a pure tightening migration that enables nothing:

| Path | Guard |
|---|---|
| `escalate_lead_assignment` | raises the column by one — refused outright |
| `get_escalation_candidates` | feeds it. Excluded **explicitly**, NOT via `lead_retired_from_allocation`, which 0108 relaxes — leaving only `max_assignments < 5`, which a qualified lead at 2 satisfies |
| `get_reclaim_candidates` | a reclaim slot is **added on top of** `max_assignments` inside `assign_lead_to_customer` |
| `assign_lead_to_customer` | caps owned leads at `least(max_assignments, 2)` under the lock, and ignores reclaim slots for them entirely |
| `admin_swap_lead_assignment` | rewrites `max_assignments = assignment_count` on the outgoing lead, which would silently **un-qualify** a sold lead. Both directions refused. (0109 later added a lead-filter guard to the same function — §34) |
| `discard_lead_assignment` | decrements `assignment_count`, reopening the slot (§19.6's argument) |

Two are **not** in SQL and could not be guarded there:

- **The contention branch in `ingest.ts`** — the dangerous one. It writes
  `max_assignments: 4` straight through PostgREST, bypassing the row lock and
  every 0107 guard, and its own `.lt("max_assignments", 4)` predicate is no
  protection because a qualified lead sits at 2. `shouldRaiseContentionCap()`
  in `src/lib/leadResale.ts` excludes owned leads, qualified or not.
- **`PATCH /api/admin/leads/[id]`** — refuses an owned lead outright.

**The pool is not on that list**, because owned leads never enter it.
`lead_pool_barred()` keeps its `owner_customer_id is not null` clause, unchanged
and deliberately so. Until 0108 that function and
`lead_retired_from_allocation()` agreed by coincidence; **from here they mean
different things**, which is why only one of them moved. `customer_can_see_pool_lead`
gains the owner exclusion anyway — a second independent bar, and the one that
answers "the uploader must never be offered their own lead back; they already
have it on their system". `claim_pool_lead` calls that same function before it
locks, so one clause covers the listing and the claim (§19.4).

### 32.7 — The uploader is excluded EXPLICITLY, and why that is new

Every candidate function skips a customer who already holds an assignment for
the lead, and the uploader holds one — so they were excluded incidentally.
**`delete_owner_lead_copy` breaks that**, and it is why the explicit
`c.id is distinct from l.owner_customer_id` had to be added to all three
candidate functions and to `assign_lead_to_customer` under its row lock.

Delete now has two modes, chosen **under a row lock inside the function**:

| | |
|---|---|
| Nobody else holds it | The lead goes, as before. Nothing was charged and it was never offered to anyone |
| Somebody bought it | Only the uploader's copy goes. The buyer keeps the lead, notes, files and stages they paid £15 for |

An RPC because of the lock: reading "does anyone else hold this?" in TypeScript
and then deleting leaves a window for a resale to land in between, and the route
then destroys a lead somebody bought a moment earlier.

Two things it must never do: **decrement `assignment_count`** (the freed slot
would outlive the deleted row, and routing would sell the lead again) and
**null `owner_customer_id`** (it is the provenance, and it is what stops the
lead being sold back to its uploader). The uploader loses sight of it through
the existing `leads_select_assigned` policy, which is the intended effect.

The file cleanup is scoped to the caller's own assignment for the same reason —
deleting by lead id would take the buyer's attachments with the uploader's.

### 32.8 — Ownership is relative to the reader

`isOwnedLead()` and `leadSourceLabel()` asked whether a lead **has** an owner,
which stopped being the same question as whether it is **yours**. Read as a bare
null check, the buyer of a resold lead is told *"Your lead · you added this
yourself, it is only visible to you"*, gets "Added by you" in their export, is
offered a Delete that 404s, and **cannot reject or close a lead they paid £15
for**. Three of those are on the first screen.

`leadSourceLabel` needed no new parameter: an assignment row already carries the
`customer_id` it belongs to. A resold lead reads **"Allocated"** to its buyer —
true, and silent about the operator who brought it in (§19.7).

**`viewerScopedLead()` nulls another customer's id at the page boundary**, and
**their `lead_profile` with it.** The customer lead surfaces select
`lead:leads(*)`, so a resold lead would otherwise ship the uploader's primary key
to the buyer's browser. It does **not** replace the viewer argument: server-side
callers read the columns directly and must never depend on a sanitisation step
having run upstream — which is why the export and `serializeAssignment` call it
explicitly, the latter taking the viewer as a REQUIRED parameter because
`customer_id` is in `NEVER_EXPOSED` and therefore never selected.

⚠️ **The profile is the half that matters.** On a marketplace lead that column is
our own qualification blurb, written to be read by whoever holds the lead. On an
IMPORTED one it is whatever the spreadsheet had left over: `leadImport.ts` folds
every column it could not map into it as `Header: value`, plus every column
mapped to notes. That is the uploader's own working material — margins, source
attribution, "will take 12%, spoke to Dave" — and handing it to a competing
operator is a different act from handing over the landlord's phone number. We
cannot tell the useful lines from the private ones, so the buyer gets none of
them; they still receive the contact details, the address, the bedrooms and the
full analysis, which is everything needed to price a call.

⚠️ **It is a presentation control, not a security boundary.**
`leads_select_assigned` (0014) grants any holder `select` on the whole `leads`
row, so a buyer with their own Supabase session can read both columns from the
browser directly. What that yields is an opaque customer UUID that resolves to
nothing (`customers` is select-own) and text they were arguably sold. Anything
that must be genuinely unreachable needs RLS or a column that is never selected.

Reject and close now refuse only when the caller **is** the owner. **Discard
stays refused for both parties**, for different reasons — for the uploader it
would strand a lead they own and cannot see; for the buyer it reopens the slot.
They have reject and close.

Two aggregates were counting backwards and are now viewer-relative:
`/dashboard/analytics` would have scored a bought lead as the buyer's **own
sourcing**, and the goals won count excluded every lead with an owner including
one the buyer paid for. §30.8's "imported fifty clients and marked them won"
argument is about the **uploader's** book, not somebody else's.

⚠️ **This corrects §30.8's instruction for the unwritten 0103.** Those eight
reporting functions need `l.owner_customer_id is distinct from c.id`, **not**
`is null` — at least `get_customer_engagement_scores` and
`get_wins`/`get_customer_scoreboard`, which would otherwise drop a buyer's paid
assignment out of their own engagement score and leaderboard standing.

### 32.9 — What is deliberately unchanged

- **`find_duplicate_lead()` stays blind to owned leads** (§30.1). A private copy
  must never make a real Monday enquiry look like a duplicate and get discarded.
  ⚠️ The accepted consequence: **one landlord can be sold both as a resold owned
  lead and, separately, as an ordinary marketplace lead** — possibly to the same
  operator. The two rows are distinct `leads` ids and nothing refuses it. "Why
  have I got this landlord twice" is a support answer, not a bug.
- **The §28 / §30.8 exclusions stay.** `fetchLeadVolumeData`, `publicStats` and
  the admin counters still filter owned leads out, so resale supply is invisible
  to the filter forecast and the public ticker. Resale volume depends on how
  many customers upload *and* pay £3 *and* pass the quality gate — none of which
  we can forecast — and under-quoting a filter is the safe direction. It does
  mean a customer's forecast reads low by exactly the leads we then deliver
  them, which is worth revisiting if resale ever becomes material.
- **`parse-income-reports` must keep its exclusion regardless.** A resold lead
  still has no `monday_item_id`, and feeding null into Monday's `items(ids:)`
  fails nightly for ever (§30.8).
- **Nothing tells the uploader.** No opt-in tick, no notice on the import
  screens, no line in the £3 purchase flow, and nothing on the lead itself
  saying it has been matched to another operator. A settled product decision,
  recorded here so the behaviour is discoverable in the codebase even though it
  is not surfaced in the product.

### Verification

Scratch Postgres 16 from empty, all 103 migrations, 0107 and 0108 each
re-applied twice for idempotency. Every redefined function confirmed
`service_role`-only by `has_function_privilege`, and invariant 7 re-checked on
the four that must stay `authenticated`-executable.

**0107 asserts nothing changed**: a marketplace lead still not retired, not
pool-barred, still returning candidates, still allocating and spending exactly
one credit, still deduping; an owned lead still retired, still pool-barred,
absent from pool and escalation candidates, refused by both assign functions,
and invisible to `find_duplicate_lead`. Then the new guards: swap refused in
both directions, discard refused, and `delete_owner_lead_copy` returning
`lead_deleted` / `copy_deleted` / `not_found` with `assignment_count` and
`owner_customer_id` **untouched** on the copy path — and the buyer's row intact.

**0108's 22 assertions** cover qualification refusing a lead with no figures,
succeeding once they exist, raising the cap 1 → 2, being idempotent on a second
call, the lead leaving retirement, **the uploader never appearing as a
candidate** (including with their assignment row deleted, which is the case the
explicit exclusion exists for), the one resale landing and spending a credit, a
**second resale refused**, selling back to the uploader refused, the cap holding
under the row lock **even with `max_assignments` forced to 5**, and a pre-0108
upload never qualifying.

353 vitest cases green; `npm run build` passes.

**Not rehearsed against live Stripe.** The re-subscribe checkout and the manual
resume join §12's standing list (the tier swap, the cancel flow) — test mode
before relying on them.

### Deployment order — migrations BEFORE code, and 0107 BEFORE 0108

**0107 first, verified to have changed nothing, and only then 0108.** Landed
together, a transcription slip in an exclusion clause goes live at the same
instant as the relaxation it guards against, and the symptom is a customer's
private lead sold to a competitor.

Code after both. `ingest.ts`, the analysis worker and `assign-pending` all
select `owner_resale_qualified_at`, and §30's own account records what code
arriving first costs: a preview returned "Could not find the function … in the
schema cache", and worse, `fetchLeadVolumeData` swallowed the error and quoted
**zero** volume while the admin tile read 0.

One gap is intended and worth stating so it is not mistaken for drift: leads
uploaded between 0108 and the code get `owner_resale_allowed = true` and are
never qualified, because nothing writes the stamp yet.

---

## 33. Believe the invoice, not the note *(no migration)*

`/api/customer/subscribe` writes `monthly_allocation` **before** creating the
Stripe Checkout Session — §17 calls this "the one trap" — and `invoice.paid`
credited from that row rather than from the invoice. The row is a note about
what somebody was **about to** buy; the invoice is what they actually bought.
When the two disagreed, the note won.

### It is not an exploit, it is ordinary browsing

Nobody has to be scheming. Anyone who looks at **both plans before buying**
leaves the note on whichever they clicked *last*, not on what they paid for:

1. Click £150/10 → note says `10`, Stripe session A opens for £150.
2. Click £300/20 → note is overwritten to `20`, session B opens for £300.
3. Pay session A — **£150**.
4. `invoice.paid` reads the note: `20`. Credits **20 leads**.
5. Every month after: **£150 charged, 20 leads delivered.**

Ten extra leads a month at £15 is **£150/month given away**, per customer,
indefinitely — the £300 plan for £150.

**And it was invisible**, which is why it survived: admin MRR is computed as
`planForAllocation(monthly_allocation).priceGbp` summed
(`src/app/admin/page.tsx`), so that customer also *reports* as £300 of revenue.
The over-delivery and the over-reporting point opposite ways and cancel out on
the dashboard. Everything reads consistent while money leaves at both ends.

### Two jobs, split by who can see the truth

The row is kept honest by **`customer.subscription.*`**, which reads the
subscription's CURRENT price. The credit is decided at **`invoice.paid`**, which
overrules the row in exactly one circumstance: a subscription's **activating
invoice** — the first invoice for a Stripe subscription we have not recorded
against that customer yet.

**Both products.** GR has had the price-keyed re-size since its £300/20 plan
launched, but it had the same activation race and the same pre-payment write in
its checkout route, so it gets the same override from the same function.

| | Who decides | Result |
|---|---|---|
| Activating invoice (incl. a re-subscribe) | invoice | credit the price, correct the row |
| Tier change (portal, admin) | subscription event | re-size the row; the invoice never chases it |
| **Comp** — admin sets 20 on a £150 sub | neither | row wins, drift logged. Never re-sized |
| Comp on a customer who cancels and returns | invoice | reset from the price. The comp was attached to a subscription that no longer exists; the log says to re-apply it |
| Ordinary renewal | — | row wins |
| Unrecognised **or ambiguous** price | — | row wins, no drift reported |
| **Bespoke allocation** — admin sets 30 | neither | row wins, drift logged. Never normalised to a tier |

**Why the invoice only acts at activation.** That is the one moment the row can
be stale — nothing has corrected it yet — and the one moment no comp can exist,
because that subscription has never been billed to comp against. Afterwards an invoice is a
*worse* authority than the subscription: an upgrade with default proration puts
**both** tiers on the next invoice, and a `past_due` charge collected after an
upgrade is at a price the customer has already left. Acting on either would
downgrade somebody permanently, because from the next renewal nothing
re-examines it.

⚠️ **Activation is PER SUBSCRIPTION, not per customer.** "Has this customer ever
paid us" is the wrong question: a cancel-and-return customer (§32.3) has paid
before, and if they come back to the tier they previously held the subscription
branch sees no price change either — so the bug would survive untouched for
exactly the population that flow was built for. A re-subscription is a new
Stripe subscription id, so the test compares the invoice's subscription against
`(gr_)stripe_subscription_id`.

Deliberately **not** inferred from a null `stripe_price_id`: that column arrived
in 0088 with no backfill, so a long-standing comped customer can still be
carrying null, and reading that as activation would strip the comp this design
exists to protect. `stripe_subscription_id` predates it by a long way and is now
stamped at every paid invoice on both products, so a row that lacks one is
either genuinely new or has never had a subscription at all (a comped account —
§18A — which never reaches `invoice.paid`).

⚠️ **A BESPOKE ALLOCATION IS NEVER NORMALISED**, at activation or anywhere else.
`/api/admin/customers/[id]/allocation` accepts any integer, and the MANAGEMENT
invite route deliberately does not round it to a tier (only the GR half does) —
a customer comped 30 leads is invoiced at the nearest plan and keeps their 30
for pacing and weighted capacity. `30` is not a disagreement with the £300
price; it is an arrangement the price cannot express, and rewriting it to 20
would silently change what that customer is owed.

So every re-size and the credit decision are gated on `isPlanAllocation()`:
only a row already sitting on a tier can be a MIS-SET tier, which is the only
thing any of this is here to correct. The disagreement is still logged.

**A new subscription id is a change too**, on both halves. A customer who
cancels and returns to the tier they previously held has an unchanged price, so
a price-only test fires nothing — and the same event stamps the new subscription
id, so `invoice.paid` then reads an established subscription and credits the
stale row. Nothing is protected by holding back: any comp was attached to a
subscription that no longer exists.

The null-is-not-a-change rule governs the rest of the re-size: on
`customer.subscription.created` the price is the truth (nothing to protect
yet); on `updated`/`deleted` with nothing recorded we record the price and leave
the allocation alone.

⚠️ **Accepted gap.** That last case loses one tier change: a pre-0088 row whose
first post-deploy event is an `updated` that is also a price change records the
new price without re-sizing, and no later event can detect a move that has
already been absorbed. The alternative — re-sizing on it — strips a comp, which
is the thing §17 and §24 spent two sections refusing. It is not silent either
way: the invoice-time drift log fires every month for as long as the row and the
price disagree, which is what makes it correctable rather than lost.

**This is GR's rule.** Guaranteed Rent has had the price-keyed re-size since its
£300/20 plan launched (`gr_stripe_price_id !== subPriceIds[0]`). Management was
deliberately left without it. §33 closes that gap.

### Three pieces

- **`allocationForPriceIds()`** in `plans.ts` — the strict twin of
  `grAllocationForPriceIds`. ⚠️ **Do not reach for `allocationFromPrices()`
  instead**: it never returns null, guessing from the invoice subtotal and
  returning **20** for a null subtotal, a £0 invoice, or any unrecognised price
  at or above £225. Fine for the post-call-offer label it was written for, and
  the wrong failure direction for a credit. Returning null is what lets a
  bespoke or Payment-Link price mean "leave the row alone". Honours
  `STRIPE_MONTHLY_PRICE_ID`, the historical alias for the £300/20 plan.
- **`resolveCreditAllocation()`** in `allocationCredit.ts` — the decision, pure.
  Extracted rather than inlined because the Stripe webhook is the least testable
  file in the repo and this is the part of it that decides money. The whole
  credit path had **zero** test coverage before this.
- **The webhook**, from that one function so the sites cannot disagree:
  `customer.subscription.*` re-sizes the row, and `invoice.paid` decides the
  credit and logs drift. **Both products**, both halves.

Every re-size calls `repriceFilterForecast` (§28.3), as
`applyPendingPlanChange` already did — an allocation change that left the stored
forecast behind would quote a count above the new cap at the old plan's price.

### Why the credit decision is duplicated at the invoice

The re-size alone would be enough if Stripe guaranteed
`customer.subscription.created` arrives before `invoice.paid`. It does not — and
`credit_invoice()` is idempotent per invoice (§19.5), so a stale row at invoice
time is a **permanently** wrong credit for that cycle, not something the next
event repairs. Hence the same test in both places.

### Drift is always reported, and says which case it is

Mirroring GR's message, with one addition: it states whether the price moved.
From two bare numbers a deliberate comp and a mistake are indistinguishable, and
only a human can tell them apart — so the log says which it is looking at and,
when the row won, points at admin.

### Verification

**19 cases** in `src/lib/__tests__/allocationCredit.test.ts`. The decision: the
bug itself (activating invoice, stale row → credit the invoice), the mirror case
(paid more than the row says → do not under-credit), the comp preserved, a cancel-and-return
customer, the §24 pending stand-down, an unrelated pending change that must NOT
shield drift, an unrecognised price, a post-fix renewal, and — the guard against
everything the review caught — that after activation the row wins in **both**
directions.
The helper: each tier, the historical price id, unknown prices, a repeat of one
tier, an unrelated line item, and the **two-tier proration invoice that must
resolve to null**.

**Not rehearsed against live Stripe** — §12's standing item. Before relying on
it: subscribe at the £150/10 price with the row hand-set to 20 and confirm the
first invoice credits **10**, the row is corrected and the drift line appears;
then hand-edit the row to 20 with the price unchanged and confirm the next
renewal credits **20** and does not re-size.

### Still true, and still worth fixing separately

**Admin MRR is derived from the allocation column, not from Stripe.** That is
what hid this bug. The drift log now surfaces a disagreement, but the revenue
figure still infers price from allocation. Pointing it at Stripe is a separate,
larger change.

---

## 34. A swapped-in lead must match the customer's filter *(0109)*

`/admin/customers/[id]` lets an admin replace one assigned lead with another —
`SwapLeadControl` → `GET/POST /api/admin/assignments/[id]/swap` →
`admin_swap_lead_assignment`. Its guards stopped at won, duplicate, capacity,
paused, product and customer-owned. **None of them was the customer's lead
filter**, so a customer who filtered to "3+ beds in BS, GL" could be handed a
one-bed in Sheffield as a replacement.

That is not a cosmetic mismatch. A swap calls the same `completeAssignment`
ingest and the admin force-assign call, so the customer gets the ordinary
new-lead email and text and has **no way to tell a replacement from a lead the
engine chose for them** — and they were quoted a volume forecast and a cost per
lead on exactly the selection being ignored (§28). Allocation, escalation and
the expired pool all honour the filter; the swap was the one hole.

### The predicate is not written again

`lead_matches_customer_filter()` (0074) is the single expression of "does this
lead pass this customer's filter", and it is already what
`customer_can_see_pool_lead` delegates to (§19.4). Two of its properties are why
it, and not the inlined copy in `get_filtered_candidates_for_lead`, is the right
one to call here:

- **`filter_status = 'off'` returns `true`** — no filter is not an empty filter.
  An unfiltered customer's swap therefore behaves exactly as it did before 0109,
  with no branch anywhere saying so, in SQL or in the picker.
- The inlined copy answers a **different question**: "is this customer in the
  filtered pool", which excludes `off` customers entirely. That is right for
  routing and wrong for a swap.

Carried over unchanged: `pending_lift` counts as filtered, and a lead whose
postcode area or bedroom count will not parse matches no filtered customer.

### The override, and what makes it deliberate

A swap is a support action — the lead had a dead number, the landlord had
already sold, and the customer is owed a replacement **today**. A narrow filter
may have nothing matching in stock at that moment, and a hard refusal would
leave the admin with an empty dropdown and no way to make them whole. So:

- the refusal is the **default**: `p_allow_filter_mismatch` must be passed
  `true`, and nothing infers it;
- the picker **groups** rather than hides — `Matches their filter (N)` and
  `Outside their filter (N)` — and names the filter above the select;
- choosing an off-filter lead raises a block naming that lead, that filter and
  the consequence, gated on a tick that resets whenever the selection changes.
  Only then does the POST carry the flag.

`allow_filter_mismatch` is read with a strict `=== true`. The flag has to be
sent, so the picker cannot forget to opt in — it has to opt in.

### ⚠️ The new argument has NO DEFAULT, and that is load-bearing

Adding `p_allow_filter_mismatch boolean default false` to the existing function
would **not** replace it. Postgres would create an overload, and every
two-argument call — including the one running in production at apply time —
would then fail with `function is not unique`.

Two distinct signatures, neither defaulted. The two-argument form is kept as a
shim that delegates with `false`, which is also what makes migration-before-code
genuinely safe here: the deployed route keeps working the moment 0109 lands,
enforcing the filter with no override, which is the safe direction for the
window between apply and deploy.

### `get_swap_candidates_for_assignment`

The route's own rule is that the picker can never offer something the swap would
then refuse. It now also needs to know *which* candidates match, and answering
that in TypeScript would be a **fifth** hand-written copy of the predicate. So
the candidate list is a function: it resolves the product, applies every
eligibility rule (same product, room left, not already held, not withdrawn, not
customer-owned, not the outgoing lead itself), attaches `matches_filter` per
row, and returns matching leads first. The route does not re-sort and knows
nothing about filters.

This also moved `assignment_count < max_assignments` out of the route's
post-fetch filter, where it only lived because PostgREST cannot compare two
columns, and retired the separate `lead_type` lookup and its "fail loudly"
branch with it.

The customer's filter is still read in TypeScript for **display** —
`activeLeadFilters()` / `filterSummary()` / `filterTooltip()` from
`src/lib/leadFilter.ts`, unchanged. `filter: null` for a customer with no active
filter on that product is what collapses the picker back to its old rendering.

### Deliberately unchanged

- ~~**`admin_assign_lead` / `/api/admin/assign` still ignores filters.**~~
  **Closed by 0110 — see §35.** The instinct recorded here was right about the
  shape: it did need its own acknowledgement rather than a shared one, and a
  guard on `admin_assign_lead` alone would have closed only half of it.
- **The won check and the management pause are not in the candidate query.** The
  first is a fact about the *outgoing* assignment and the UI already gates on it;
  the second the function raises on in plain language, which the route passes
  straight through.

### Verification

All 104 migrations applied to a scratch **Postgres 16** from empty (0002 skipped
— `pg_cron` is not available there), then 0109 re-applied twice for idempotency.
ACLs audited with `has_function_privilege`: both `admin_swap_lead_assignment`
signatures and `get_swap_candidates_for_assignment` are `service_role`-only, and
invariant 7's four `authenticated`-executable functions re-checked.

Against seeded rows, on a filtered customer (`{BS}`, 3+ beds): a BS 4-bed
accepted with no override; a wrong-area lead, a 1-bed, a lead with a null
`postcode_area` and one with `bedrooms = 'studio'` each refused; both of the
first two accepted **with** the override; the two-argument shim accepting a match
and refusing a mismatch; `pending_lift` behaving as `active`; every pre-existing
guard (cap, product, already-held, same-lead) still firing.

Three that mattered most: **a refusal mutates nothing** — the assignment is still
there, `withdrawn_at` still null, `max_assignments` still 3; **an `off` customer
is untouched** — every candidate comes back `matches_filter = true` and a 1-bed
anywhere still swaps in with no override; and **a successful swap still moves no
money** — balance, monthly counter and odometer all unmoved, the replacement
carrying the same `price_paid`.

The GR mirror was driven separately, on a customer carrying a GR filter of
`{BS}`/3+ **and** an unrelated management filter of `{ZZ}`/9+: the GR swap reads
`gr_` and only `gr_` (invariant 6).

384 vitest cases green, `npm run lint` clean, `npm run build` passes.

### Deployment order — migration BEFORE code

0109 first, as ever — though the two-argument shim means code arriving late
merely enforces the filter without an override rather than breaking swaps.
Nothing here touches a balance, counter, pacing or capacity column.

---

## 35. Admin force-assign must respect the filter too *(0110)*

0109 closed the swap. This closes the last two routes that can put a lead in
front of a customer who filtered it out: `POST /api/admin/assign` and
`/api/admin/assign/bulk`. Both call `completeAssignment`, so the customer gets
the ordinary new-lead email and text — the same argument §34 makes about a
replacement, and the reason §34's "deliberately unchanged" bullet is now struck
through rather than left standing.

### Guarding one function would have closed half the hole

Each route branches on `override`, and the two branches call **different**
functions:

| `override` | RPC | What it bypasses |
|---|---|---|
| `false` | `assign_lead_to_customer` | nothing — spends a credit |
| `true` | `admin_assign_lead` | the paid-credit / subscription gate |

So both got the guard. Guarding only `admin_assign_lead` — the obvious target,
being the one named "admin" — would have left every ordinary force-assign
untouched.

### Why it sits inside the money path, and why that is inert

`assign_lead_to_customer` is the single money path, and the guard goes under its
existing row lock — **exactly where invariant 11 already asserts
`lead_retired_from_allocation`**, and for the reason that function's own comment
gives: it is the only place under a lock, and anything that acquires a lead id
from elsewhere arrives here.

It is a **no-op for every automatic path**, which is a claim to verify rather
than assert:

- `get_filtered_candidates_for_lead` inlines this same predicate, so every
  candidate it returns already passes.
- `get_unfiltered_candidates_for_lead` selects `filter_status = 'off'`
  customers, and `lead_matches_customer_filter` returns **true** for them — no
  filter is not an empty filter. That is what keeps a lead with an unparseable
  postcode area or bedroom count flowing to the unfiltered pool, exactly as
  before.
- Inactivity escalation routes through those same two pools.
- `claim_pool_lead` does not call this function at all and checks the filter
  itself through `customer_can_see_pool_lead` (§19.4).

The verification below asserts that inertness directly rather than reasoning
about it: an `off` customer still takes a null-`postcode_area` lead and a
`studio` with **no** override.

### ⚠️ Neither new argument has a DEFAULT, and here it bites harder

The trap §34 records, repeated — and worse, because **both functions already
carry `p_lead_type ... default 'management'`**. A defaulted fifth argument would
not replace them; it would create an overload, and every four-argument call —
including the ones running in production at apply time — would fail with
`function is not unique`.

With no default on the new argument, a five-argument call resolves only to the
new function and a three- or four-argument call only to the old one. Both
four-argument forms are kept as shims delegating `false`, which is what lets
0110 land ahead of the code: ingest, escalation, the sync top-up path and both
admin routes keep working the moment it applies, enforcing the filter with no
override — the safe direction for that window.

### `allow_filter_mismatch` is NOT `override`

`override` means "bypass the credit gate". `allow_filter_mismatch` means
"bypass what the customer asked for". They are separate fields on both routes
because folding them would make **every** credit override silently a filter
override too — and the credit override is the routine one, used whenever a GR
lead needs placing with a customer who is out of credits.

Both are read with a strict `=== true`. The flag has to be sent, so a picker
cannot forget to opt in; it has to opt in.

### The two screens differ, deliberately

- **`/admin/leads/[id]`** offers ONE lead to MANY customers, so the filter
  question is per customer and worth answering inline. The page calls
  `customers_matching_lead_filter` once for the not-yet-assigned ids;
  `AdminLeadControls` groups the pool into **Matches their filter (N)** and
  **Outside their filter (N)**, notes what each off-filter customer actually
  wants on their row, and gates the confirm on a tick that names them. The tick
  resets on every selection change, so it can never carry over.
- **The bulk assigner** is a leads × customers cross product. Marking every pair
  would be a matrix and is not worth it; instead one **"Allow leads outside a
  customer's filter"** tick sits beside the existing override tick, off by
  default, and each refusal lands in the existing per-pair failure list — which
  is how that screen already reports capacity, product and pause refusals.

`customers_matching_lead_filter(uuid, uuid[])` exists so the page can mark its
list **without a fifth hand-written copy of the predicate in TypeScript** — the
trap 0109 avoided with `get_swap_candidates_for_assignment`. The page's read
**fails closed**: an id it gets no verdict for is treated as outside the filter,
so the picker warns rather than quietly offering something the RPC would refuse.

### Verification

All 105 migrations applied to a scratch **Postgres 16** from empty (0002 skipped
— `pg_cron` is not available there), 0110 re-applied twice for idempotency. Both
function bodies were diffed against 0107 and differ by exactly the signature
line and the guard block. ACLs audited with `has_function_privilege`: all four
`assign_lead_to_customer` / `admin_assign_lead` signatures and
`customers_matching_lead_filter` are `service_role`-only, and invariant 7's four
`authenticated`-executable functions re-checked.

**The regression that matters — ordinary routing is untouched.** A filtered
customer is still returned by `get_filtered_candidates_for_lead` and a matching
lead still allocates with no override, spending exactly one credit (10→9),
moving the monthly counter (0→1) and the odometer (0→1). An **`off` customer
still takes a null-`postcode_area` lead, a `studio` and any area with no
override**, and is still returned by `get_unfiltered_candidates_for_lead` —
which is the whole basis for putting the guard in the money path.

Then the new refusals, on a filtered customer (`{BS}`, 3+ beds), through **both**
functions and **every** signature: wrong area, wrong bedrooms, null
`postcode_area` and `studio` each refused; each accepted with the flag;
`pending_lift` behaving as `active`; the four- and three-argument shims refusing
a mismatch and accepting a match; and **a refusal mutating nothing** — no
assignment row, no credit spent, counter and `assignment_count` unmoved.

The GR mirror was driven on a customer carrying a GR filter of `{BS}`/3+ **and**
an unrelated management filter of `{ZZ}`/9+: the GR assign reads `gr_` and only
`gr_` (invariant 6), on both functions.

384 vitest cases green, `npm run lint` clean, `npm run build` passes.

### Deployment order — migration BEFORE code

0110 first. The four-argument shims mean code arriving late merely enforces the
filter with no override rather than breaking assignment. Nothing here changes a
balance, counter, pacing or capacity column.

## 36. Checking a lead before it is sold *(0111)*

Nothing checked a lead's contact details before this. `ingestLead` wrote whatever
Monday or n8n handed it — the management branch writes `""` for every absent
field rather than null — and `autoAssignLead` sold the row minutes later. An
operator pays £15 for a landlord whose "mobile" is a Dubai landline, reject does
not refund (invariant 4), and we keep the money.

`src/lib/leadQuality.ts` · `POST /api/admin/leads/quality-check` ·
`POST /api/admin/leads/[id]/quality` · `LeadQualityPanel`.

### 36.1 — Syntactic only, and no new env var

Format, junk name, UK-mobile shape, email shape. Pure string work over three
columns already on `leads`, so it runs inside `ingestLead` with no network,
nothing to time out and nothing that can fail the money path. **No environment
variable was added.**

What it cannot do is tell you the number is answered or the mailbox exists. The
privacy policy already names **Twilio Lookup** and **ZeroBounce** as processors
for exactly that and **neither is implemented** (§36.7). Adding one belongs
*behind* these columns — a queue on the `run-lead-analysis` chaining pattern,
never in the sync's 60s budget, and failing **open** unlike the syntactic gate.

### 36.2 — ⚠️ The normaliser exists for one shape

**89 of 193 live management leads store the phone as `+44` followed by a FULL
NATIONAL number** — `+4407304208011`. Strip `+44` and prefix `0` and you get
`007304208011`, rejecting **46% of the management book**.

`normaliseUkMobile()` therefore strips the country code, then strips any leading
zeros, then adds exactly one back. Both `+4407304208011` and `+447711387707`
land on the same national form. Do not "simplify" it to a `startsWith("+44")`
slice. All **390 distinct live phone strings** were run through the real
function: 360 valid, 17 `foreign`, 10 `not_mobile`, 2 `placeholder`, 1 `missing`
— every rejection inspected and correct.

### 36.3 — A junk detector, not a name format

**A one-word name is the NORM.** 87 of 437 live leads are "Adam", "Ann",
"Josh" — all with valid mobiles and working emails. Requiring a surname would
discard a fifth of the book to catch three bad rows (an email pasted into the
name field, `Dbncc`, `inin`). So the test fails only on evidence the value is
*not* a name — contains `@` or a digit, no letters, a repeated-character run, a
placeholder word, four-plus basic-Latin characters with no vowel — and passes a
lone first name, a lowercase one, an accented one and a non-Latin one.

The no-vowel rule is gated on the name being basic Latin. Applied blindly it
fails every name in every other script.

### 36.4 — `pending` does not block, and that is the whole safety property

| Status | Meaning | Blocks? |
|---|---|---|
| `pending` | never judged — predates 0111, or a path that does not stamp | **No** |
| `passed` | checked, usable | No |
| `failed` | checked, `lead_quality_codes` says why | **Yes**, unless overridden |

It is the default, so **0111 changes no behaviour on apply** — the migration-
before-code rule holds in its strong form. It is also the safe direction: an
unchecked lead sold is recoverable, an unchecked lead silently withheld is not.

The override is a **separate column**, not a fourth status, so both facts
survive — what the checker thought and what an admin decided. Clearing it
restores the block with no re-check. `refreshLeadQuality` never touches it, so
an admin's decision is not quietly undone the next morning.

### 36.5 — Enforced in BOTH predicates, and re-judged on every sync

⚠️ **A check at insert time is not enough.** `ingestLead`'s `monday_item_id`
branch skips the insert and calls `autoAssignLead` directly, and both syncs run
daily — so an insert-only gate would withhold a bad lead for one day and sell it
every morning after. That branch now calls `refreshLeadQuality`, which makes the
gate self-healing: a number corrected on the board clears the block on the next
sync, with no admin action and no separate job.

⚠️ **`lead_pool_barred()` needs the clause as well as
`lead_retired_from_allocation()`.** They are separate predicates that agree
about owned leads only by coincidence (§32.6). Without it, a blocked lead that
was never assigned pools on the `unassigned` basis at day 25 and becomes
claimable, free, by every subscriber — the worst outcome available, since the
pool's whole pitch is that ringing costs nothing. Asserted on scratch: the
blocked lead is absent from `get_pool_entry_candidates()` while the other three
are present.

Two paths consult neither and are guarded in TypeScript, as §32.6 does for the
cap writes: the **contention branch** in `ingest.ts` (a direct PostgREST write)
and **`admin_assign_lead`** via the admin assign routes. Bulk assign *skips*
blocked leads with a per-lead reason rather than failing the whole request.

`admin_assign_lead` is deliberately **not** rewritten here — see 34.8.

### 36.6 — The backfill is a route, not SQL in the migration

The rules live in TypeScript and the migration does not restate them. A SQL copy
of the normaliser is a second implementation that must change in step and
silently would not — §20's `capture_operator_proof`, §26.7's `presentationSeed`.
Given 34.2, getting it wrong blanks half the book.

So `POST /api/admin/leads/quality-check` (also the **Check lead quality** button
on `/admin/leads`) runs `assessLeadQuality` over `pending` rows. Claim-by-write
on `lead_quality_status = 'pending'`, so it is re-runnable, self-draining, and
two concurrent runs cannot fight.

⚠️ **A lead already SOLD is marked but not blocked** — stamped `failed` and given
an override in the *same write*. Invariant 4: a delivered lead is chargeable, and
retiring one an operator is working withdraws something they paid for. On today's
book that is 16 leads, 15 of them the `+44` shape — so if the normaliser were
ever wrong the blast radius is the 24 unsold rows, not the live book. Owned leads
(§30) are skipped entirely.

**Run on 2026-08-27 against the live book: 41 of 440 failed — 25 blocked, 16
marked only.** Every rejection was inspected: overseas numbers (Netherlands,
Saudi, France, Switzerland, Australia, Panama, Portugal, Qatar, Hong Kong,
Ireland, Malta, New Zealand, UAE), a London landline, two placeholders, two rows
with no contact details at all, and the three junk names. Nothing surprising and
nothing borderline.

It was driven from the shipped `assessLeadQuality` rather than the route (which
needs an admin session), by running the real function over the distinct names and
the distinct phone strings and then matching in SQL on **exact string
membership** — so no rule was restated in SQL at any point.

⚠️ The predicted figure was 40 of 437. Two things moved it, both worth knowing:
the book grew by three leads between measuring and running, and **the real
normaliser is stricter than the SQL approximation used for the estimate** on
`0447 711910109` — which it rejects, correctly, and which the test suite pins as
the case that must never be mangled into a valid number. The estimate was the
thing that was wrong.

### 36.7 — What this does NOT close

`/policies/lead-quality-and-data` tells customers that rejecting a lead as
"invalid email or mobile" triggers an immediate automated check and restores
their allocation. **None of that exists**: `reject_lead_assignment` takes no
reason parameter and no verification vendor is called. Softening that copy, or
building it, is separate work.

⚠️ Separately: the landing page, the privacy policy (twice) and that same policy
page all state a **maximum of two operators** per lead. The default has been 3
since 0055, escalation reaches 5, contention 4, and a pool claim bypasses the cap
entirely — **21 live leads have gone to 3 operators and 3 to 4**. In the privacy
policy that is a consent statement, not marketing copy.

### 36.8 — Migration drift, mostly closed

Numbered **0111, not 0109**, because at the time it was written production
carried two migrations that were **not in `supabase/migrations/`** —
`swap_respects_lead_filter` and `admin_assign_respects_lead_filter`, both applied
2026-08-27 ahead of their code. **Both have since been committed** as 0109 and
0110 (§34, §35), so that half of the drift is resolved and the 0111 number was
the right one to take.

~~⚠️ **`worked_conversion` (2026-08-23) is still missing from the
directory.**~~ **Closed — committed as `0100a_worked_conversion.sql`**, its SQL
recovered verbatim from `supabase_migrations.schema_migrations`.

⚠️ **It was not merely a documentation gap: the repo could not rebuild from
empty.** 0124 issues `CREATE OR REPLACE FUNCTION get_customer_scoreboard()`
against the FOURTEEN-column signature `worked_conversion` introduces
(`worked_past_cold`, `wins_per_worked_past_cold`). Built from the directory
without it, 0068's twelve-column version is what exists and 0124 fails outright
with 42P13 "cannot change return type of existing function". Production was
unaffected because it has the migration; only a rebuild was broken, which is
why nothing surfaced it.

**Hence `0100a` and not the next free number** — it has to sort BEFORE 0124,
and its real apply date sits between 0100 and 0101. Its own header calls itself
0097; that number was taken by `backfill_postcode_areas` while it sat
uncommitted.

Nothing in `src/` calls `get_worked_conversion`, `worked_past_cold` or
`assignment_worked_past_cold`, and the `src/lib/workedConversion.ts` mirror its
comments reference **has never existed** — the SQL half shipped and the
application half did not. That is why the drift went unnoticed for a week.

**Verified**: all 120 migration files applied to a scratch Postgres 16 from
empty, 0 failures; 0100a re-applied twice for idempotency; and every
`public` function fingerprinted by `md5(prosrc)` against production —
102 of 103 identical, the one difference being `apply_lead_rejection` (below).

It is also why `admin_assign_lead` is guarded from the routes rather than
rewritten in 0111: when this was written that function had been replaced by an
uncommitted migration, so copying its live body in would have lost or fought
0110 depending on apply order. `admin_block_check_lead_quality()` is the guard
instead — the arrangement `leadResale.ts` uses for cap writes SQL cannot see
(§32.6). Now that 0110 is committed the two compose cleanly: the quality gate is
asserted in the route before the RPC, and 0110's filter opt-in reaches the RPC
after it, so a blocked lead never gets as far as a filter question.

### Verification

**103 of 104 migrations applied to a scratch Postgres 16 from empty** (the one
failure is `create extension pg_cron`, unavailable locally), 0111 re-applied
twice for idempotency. CHECK exercised on an invalid value and all three valid
ones; both partial indexes confirmed.

Behaviour: a `failed` lead is retired **and** pool-barred, returns **0**
candidates from `get_unfiltered_candidates_for_lead` and
`get_next_customers_for_lead`, is refused by `assign_lead_to_customer`, and is
absent from `get_pool_entry_candidates()`. The same lead with an override set
allocates normally; withdrawing the override re-blocks it in both predicates.
Regressions: a `passed` lead allocates and spends **exactly one** credit
(10 → 9, counter 1), a `pending` lead allocates unchanged, and
`find_duplicate_lead` still matches.

ACLs audited with `has_function_privilege` on both replaced functions — anon
`false`, authenticated `false`, service_role `true` — and invariant 7 re-checked
on all four functions that must stay `authenticated`-executable.

**462 vitest cases green** (78 new), `npm run build` passes. The normaliser was
run over every distinct live phone string (34.2).

**Applied to `znlfwbnvhlacwzgfalcf` on 2026-08-27, BEFORE the code** — the order
§30 argues for, rather than §30's own account of finding out the hard way.

Pre-apply: zero collisions on the six columns, the function name, both indexes
and the CHECK. And the check §11 says not to assume — production's live `prosrc`
for **both** replaced functions was diffed against the bodies this migration
embeds, with the new clause removed, and matched exactly. Worth doing rather
than assuming here specifically: another session had replaced
`admin_assign_lead` earlier the same morning (34.8), so "nothing has moved since
I copied it" was a live question, not a formality.

Post-apply: **437 leads, 332 assignments and 40 customers untouched; all 437
rows `pending`; zero blocked** — the migration is inert exactly as designed. All
six columns, both partial indexes and the CHECK present. ACLs re-audited —
anon `false`, authenticated `false`, service_role `true` on all three functions
— and invariant 7 confirmed on all four that must stay
`authenticated`-executable. The column adds, the CHECK and both indexes were
re-run to prove a second apply is clean.

The predicates were then exercised **on production itself**, inside a `DO` block
that raises at the end so every write is rolled back: a real unsold lead read
`pending → f/f`, `failed → t/t`, `+ override → f/f`, `passed → f/f`, and the
row count afterwards confirmed nothing changed. Supabase's linter reports **no
new advisory** — all three functions pin `search_path`.

### Deployment order — migration BEFORE code

0111 first — **done**. Every leads read now selects `lead_quality_status`, so
code arriving first would fail them all; §30 records what that costs (a preview
quoting **zero** filter volume from a swallowed error). Then the code, then press
**Check lead quality** in admin to run the backfill. Until that button is
pressed every lead stays `pending` and nothing is blocked, so the code is safe to
deploy at any point after the migration.

**`vercel.json`'s `buildCommand` was `next build`, which overrode
`package.json`'s `vitest run && next build`, so the suite gated nothing on
deploy.** It now runs the tests. The phone normaliser's only defence is a unit
test, and it was one CI never executed.

---

## 37. The operator's own branding *(0112)*

`public/income-presentation/` is the deck a management customer walks a landlord
through. Since §26 it arrives filled in — the property's figures from its
analysis, the operator's fee and terms from their profile. What it still was, up
to here, was **ours to look at**: Stayful green throughout, and the operator's
identity reduced to one line of text, "prepared by <name>".

That is the same argument §26 already makes about the management fee. The report
charges 15% of gross because that is *Stayful's* fee, and an operator quoting it
to a landlord would be quoting ours — so it comes from their profile and never
from the report. Their colours are the same fact one step out. **Full
white-label: their logo, their colour, and no Stayful mark on any slide.**

### 37.1 — One colour is stored. Everything else is derived

`customers.presentation_brand` (jsonb) holds an accent hex and a pointer at a
logo. `derivePalette()` in `src/lib/presentationBrand.ts` produces the other
eight colours on every render.

**A customer who could store nine colours could store nine colours that render a
slide unreadable, in front of a landlord, with no way to see it coming.** Each
derived token fixes its own *lightness* and borrows only the hue and a fraction
of the saturation, so the dark slide ground is dark whatever arrives and the
near-white type stays near-white. The one thing a hostile pick can still move is
the accent itself, and that is guarded:

> **Contrast, and why there is only one guard.** The accent is both a button
> fill with white text on it *and* accent-coloured text on a white slide. WCAG
> contrast is symmetric, so a single requirement — accent against white ≥ 4.5:1 —
> makes both legible at once. A pale yellow is darkened 1% of lightness at a time
> until it passes, and `palette.adjusted` says so on the settings card rather
> than silently showing a colour they did not choose.

⚠️ **`DEFAULT_PRESENTATION_BRAND` and the derived defaults mirror the hex
literals the tool shipped with, and the two must change together.** Every
customer starts on the default accent, so if the derivation drifted, this
feature would silently restyle every deck in the business on the day it
deployed. `presentationBrand.test.ts` pins each token to within four parts in
255 of the colour it replaced.

**Presets resolve to a hex on save; the preset's name is never stored.**
Re-tuning "Slate" a year from now must not restyle a deck an operator has
already presented from.

### 37.2 — The palette reaches the static file as CSS custom properties

Sixty brand-colour literals in `index.html` became `var(--sf-*)`, defaulted in
`:root` to exactly the hexes they replaced, and `applyBrand()` overwrites them
with nine `setProperty` calls. `cssToObj` in `support.js` splits a declaration
on `;` then the first `:` and passes `--custom` props through verbatim, so a
`var()` in an inline style attribute survives the runtime's conversion to React
style objects.

| Token | Was |
|---|---|
| `--sf-accent` / `--sf-accent-dark` / `--sf-accent-mid` | `#2f7d4f` · `#245f3c` · `#3a9560` |
| `--sf-accent-soft` / `--sf-accent-bright` | `#8fbf9e` · `#8fe0a6` |
| `--sf-ink` / `--sf-ink-text` | `#16241c` · `#f4f8f2` |
| `--sf-tint` / `--sf-tint-deep` | `#f0f6f1` · `#eef4ec` |

**Not brandable, deliberately:** the greys (`#1a1a19`, `#55564f`, `#8a8b84`),
the page ground (`#f2f3ef`), and **`#c26b3d`, which marks a NEGATIVE delta and
must never become somebody's brand orange**. The `rgba(244,248,242,α)` text
tints are also left alone — a near-white at alpha reads correctly on any dark
ground.

### 37.3 — The logo is inlined, not linked

`data:` URI in the payload the tool already fetches, never a signed URL.

The tool vendors React locally *specifically* so it survives a bad network
during a live meeting. A signed URL puts back exactly what that avoids: a second
request, to a host that may be unreachable, for an asset that **expires on a
clock** — so the failure lands mid-presentation rather than at the start where it
would be noticed. A logo is a few kilobytes.

`brandLogoDataUrl()` **fails to null and never throws**: a missing or unreadable
object costs the operator their logo and nothing else.

### 37.4 — The bucket, and why the bytes go through a route

`presentation-brand`: private, image types only, 2 MB, and **no
`storage.objects` policy at all** — deny-all to the browser, following
`lead-reports` (0092) rather than `lead-files`. That other bucket keys every
policy on `auth.uid()` because each object is a customer's own file; a logo is
read by our route on the service role and by nobody else, so a signature is the
whole authorisation story and a policy would be a second one to keep in step.

The browser therefore cannot upload directly, **which is the point**: the file is
checked server-side, and it is checked by **sniffing its own bytes**. The
declared content-type is the client's word for it, and the bucket's
`allowed_mime_types` checks that same client-supplied string, so neither is
evidence. PNG, JPEG and WebP have magic numbers; SVG has none and is recognised
by its opening tag after any BOM or whitespace.

⚠️ **SVG is accepted, and safe only because of where it is rendered.** Inside an
`<img>` browsers refuse scripts and external references. It must never be
inlined into the page's own markup. It is held to a tighter cap (512 KB) than
raster — a vector logo is a few kilobytes, and anything approaching that is a
pasted-in bitmap or an embedded font dump.

⚠️ **The path is fixed: `<customer_id>/logo`, no extension.** One object per
customer, replaced by overwrite, so there is nothing to garbage-collect and a
png→jpg swap cannot orphan the old file. The mime lives in the jsonb, which is
also what makes an extensionless path safe to serve.

### 37.5 — Two timestamps, because they answer different questions

`presentation_brand_updated_at` is **separate from
`presentation_settings_updated_at`** and must stay so. That column is the "have
they set their terms up yet" test (§26.5), and it is NULL-versus-set rather than
a test of the blob's contents. Sharing it would mean uploading a logo silently
answers a question nobody asked: the tool would stop prompting an operator about
the fee and contract terms they have never looked at, and they would present
Stayful's generic wording under their own logo.

### 37.6 — Any subscriber, and the blank tool too

Branding is offered to **management and GR alike**, which is why
`PresentationBrandCard` sits *outside* the `subscription_status === 'active'`
gate that `PresentationSettingsCard` sits inside. The lead-seeded presentation is
management-only because a management fee is not what a GR operator sells
(invariant 6); a logo is not a product.

With a lead, the brand rides with the seed. With none — the tool opened from
Documents — `GET /api/customer/presentation/brand` fetches it alone, and fills
in the company name where the operator has not typed one. The blank tool is
otherwise untouched: same form, same six slides, same storage key.

⚠️ `applyBrand` is called from **all three** fetch paths — `seedFromLead`,
`checkProfile` and `loadBrand`. `checkProfile` is the one that is easy to miss
and the most commonly taken: it is the path a lead with saved work goes down, so
omitting it would lose an operator their branding on exactly the leads they have
been working.

---

## 38. What the analysis says about the market *(0113)*

§25 takes the money out of the property-analysis PDF: gross, rate, occupancy,
cost percentages, the long-let comparison, the seasonal curve. The analyser
states more than that, and the rest is what an operator needs when a landlord
asks the obvious question — *is anyone actually booking round here?*

A seventh slide now carries it: comparable-set size and radius, their average
guest rating and review count, the market's occupancy against the property's,
the analyser's direct-booking score and its risk verdict.

### 38.1 — Only what the report states

Nothing on that slide is derived, estimated or inferred from figures we already
hold — no "direct booking potential" computed from the platform fee, no risk
band invented from occupancy. **A number an operator repeats to a landlord has
to be one the document behind it actually prints**, or the analysis stops being
the thing that makes the deck credible.

The one exception proves the rule: `market_occupancy_rate` is not new work at
all. `OCCUPANCY_RE` has captured it as its second group since 0090 and thrown it
away. It is printed on the report; we were simply discarding it.

### 38.2 — Two producers, and the constant that keeps them honest

`NO_FIGURES` was exported when §31 added a second producer of
`IncomeReportOutcome`. That paid off immediately here: adding eight fields to
the type made `leadAnalysis.ts` **fail to compile**, which is exactly the
failure that constant exists to force.

| Producer | Source | Reaches |
|---|---|---|
| `parseIncomeReport` | the Monday PDF's text layer | Monday-sourced leads |
| `buildOutcomeFromAnalyserResponse` | the analyser's JSON | customer-owned analysed leads (§31) |

The analyser half needed the analyser itself extended — `AnalyseFigures` in
`ZacStayful/Stayful-STR-estimate-software` now carries the same eight fields,
read off `deriveReportData`, **the same derivation the PDF renders from**, so the
JSON and the document in one response cannot state different numbers.

**Every new field is optional on our side.** The analyser deploys separately, so
a build of it that predates them must go on producing perfectly good leads:
absent means "the analysis did not say", exactly as a missing figure in a PDF
does. Deployment order is therefore one-way and safe — analyser first, or not at
all, and nothing breaks either way.

### 38.3 — The anchors read plain captions, and the trap next door

§25 documents why the headline block is unmatchable — its labels are
letter-spaced in the text layer (`AVG N I G H T LY R AT E`). These four anchors
are on the *Comparable Properties* and *Local Demand & Risk* pages, which render
in ordinary type, so they read the caption directly:

```
48 active Airbnb listings within 1.50 km ·      → size + radius
Avg Rating 4.8 ★   Avg Reviews 42               → rating + review count
Direct Booking Potential Score: 72/100 — GOOD   → direct booking
Low-Medium Risk · 38/100                        → risk verdict
```

⚠️ **The risk paragraph explains its own scale as "(0 = Low Risk, 100 = High
Risk)" and sits ABOVE the verdict.** Reading that as the verdict would report
every property in the book as high risk — plausibly, and silently. The
separator class admits no comma, which is what keeps the explanation out.

⚠️ **The rating prints as `4.8 ★` and Helvetica has no star**, so what survives
into the text layer varies. The pattern stops at the number and never asserts
what follows it. An unrated comp set prints an em dash, which simply does not
match — the right outcome.

**There is no cross-check to run, and that is deliberate.** Unlike the money
figures, none of these has a second printing to agree with, and inventing an
arithmetic relationship between them would be inventing the thing §38.1 says not
to. What guards them instead is **range**: a rating outside 0–5 or a score
outside 0–100 is a match that has wandered into another number, and is dropped.

### 38.4 — ⚠️ The two scores run in opposite directions

`risk_score` is **0 for LOW risk**. `direct_booking_score` is **100 for the
best**. Both are stored exactly as printed and worded accordingly on the slide.
Normalising one to match the other would invert a number an operator reads aloud
to a landlord.

Two pairings are enforced on both producers, for different reasons: a comp-set
count without its radius does not say how hard the analyser had to look for it,
and a risk score without its wording is a number a landlord cannot read.

### 38.5 — The deck is a sequence now

The tool's fixed `s1…s6` became a **sequence array**: `go()` walks it, the
counter reads `pos / seq.length`, and the market slide is in the sequence only
when the lead supplied at least one market figure. The blank tool and every lead
without them still walk exactly the six slides this file has always had.

The property's **own** occupancy does not count as evidence for that test — it is
already on the income slide, and a slide about the market carrying one restated
figure is worse than no slide. Every card inside the slide is independently
present, so a report that stated only a risk score produces one card rather than
a broken slide.

⚠️ **`Number(null)` is 0, not NaN.** The first cut of `marketFrom()` used a bare
`Number()` and turned every absent figure into a legitimate-looking zero, so a
lead whose report said none of this arrived claiming a market occupancy of 0%
and a comp set of nothing — and the slide appeared on every lead in the
database. Caught by the seed tests, which is what they are for.

### 38.6 — No backfill, deliberately

The sweep's third pass selects
`income_report_path.is.null OR platform_fee_pct.is.null`, and every
already-parsed lead fails both — so nothing here reaches the leads that already
carry figures. **That is a decision, not an oversight**: those leads work, their
decks render today, and re-reading hundreds of documents to add a slide is not
worth the chance of disturbing one that is live.

New leads get these at ingest, through the same parse that writes the gross;
`presentationFiguresPatch()` carries them too, under its existing add-only rule,
so any lead still in that pass for a missing `platform_fee_pct` picks them up
free. Should the backlog ever be worth clearing, adding `risk_score.is.null` to
that `.or()` is the whole change.

### Verification

`npm run test` — 481 → 504 cases in this repo, and 192 → 195 in the analyser's, all pure units, so they stay inside the suite
that gates `next build`. Among them: the default palette reproducing all nine
shipped hexes, every preset clearing 4.5:1 unaided, the contrast guard on a pale
yellow, the byte sniffer against a PDF renamed `.png` and an XML preamble with
no `<svg>` after it, the risk-scale explanation not being read as the verdict,
both "pair or nothing" rules on both producers, and the seed round-tripped
through the tool's **own** `merge()` to pin §26.7's array-shrink trap.

**The parser was run over a real report**, rendered from the analyser's own
generator (`deriveReportData` → `StayfulReport` → `renderToBuffer`) rather than
sampled: 8 comparables within 3.00 km, avg rating 4.6, avg reviews 50,
`Low-Medium Risk · 48/100`, direct booking 70 — all eight market figures read
back exactly, **and the nine existing figures came back unchanged**, which is the
regression that would have mattered. Generating the document rather than
sampling one is the stronger check: it exercises the template as it stands
today, so a change to the report's wording fails here rather than in production.

All **108 migrations applied to a scratch Postgres 16 from empty**, then 0112
and 0113 re-applied to prove idempotency. Every new CHECK exercised on its
boundaries (0, 100, 5, 0.001, 500 accepted) and on eight invalid values (all
refused). The bucket's row confirmed private with the four image types, and
`pg_policies` confirmed to name **no** policy on `presentation-brand` — the
only `storage.objects` policies are `lead_files_*`.

The tool was rendered in Chromium four ways: blank (six slides, original form,
default palette, no logo, no page errors); blank with branding (navy palette
applied to `:root`, logo on the cover, company name filled); a seeded lead with
market figures (**seven** slides, counter `3 / 7`, every card rendering); and a
seeded lead without them (six slides, unchanged).

### Deployment order — migrations BEFORE code

0112 and 0113 first. The seed route selects the new lead columns on every
request, `getCurrentCustomer()` reads `customers` with `select("*")`, and the
settings page reads the brand blob — so code arriving first would query columns
that do not exist. Both are additive and inert on their own, and neither touches
a balance, counter, pacing or capacity column, so a lagging migration cannot
affect lead allocation.

The analyser's own change is independent and can land in either order (§38.2).

---

## 39. A new filter starts delivering now, not at renewal *(0114)*

Applying a lead filter has always been instant (§28, 0026): the apply route
writes `filter_status = 'active'` and `get_filtered_candidates_for_lead` honours
it on the very next lead. What is **not** instant is supply.

`(gr_)lead_balance` is the allocation gate (invariant 1), spent one credit per
assignment and topped up only by `credit_invoice` on `invoice.paid`. A customer
who has consumed this cycle's credits receives nothing — filtered or not — until
renewal, so applying a filter mid-cycle looks exactly like a filter that
"activates on billing cycles". The apply route made it slightly worse: a fresh
enable clamps the balance to `min(balance, allocation)`, so applying a filter
could only ever *reduce* what was left to spend.

The leads that customer is already holding are the missing credits.

`/api/customer/filter` (apply) · `LeadFilteringPanel` · `/admin/customers/[id]`

### 39.1 — What "instant" means here, and what it does not

It means the **filtered flow starts now**. It is **not** a lead-for-lead swap,
and nothing promises a replacement for each lead returned. The customer is
knowingly trading unused stock for the chance of leads on their filter as those
arrive, and the apply confirmation captures consent to exactly that.

Two consequences, both deliberate:

- **No synchronous re-offer.** A released lead drops back under its
  `max_assignments` cap and is redistributed by the ordinary machinery (§4).
  Nothing in the apply path loops over `autoAssignLead`. That would be the
  like-for-like swap this is explicitly not — and on a Hobby 60s function cap
  (§2), against a route that already pages the whole leads table twice for the
  forecast, a loop of `completeAssignment` calls (each an email, an SMS and five
  round trips) is also how the route starts getting cut short mid-release.
- **No stock guarantee.** Nothing counts or promises how many matching leads are
  in the book right now. The volume forecast (§28) is the one expectation this
  product sets; a second one would be a promise nobody has modelled.

### 39.2 — The rule

> A lead is releasable only if the customer has **not touched it** AND it
> **fails the filter being applied**.

| Situation | What happens |
|---|---|
| **Discard** | Release everything releasable. A credit back for each. |
| **Keep**, credits remaining | Release nothing — nothing is in the way of the filter delivering. |
| **Keep**, credits spent | Release `min(forecast − balance, releasable)`, oldest first. |
| Nothing releasable | Release nothing. The filter is live and starts delivering at renewal. |

That last row is the "applies next billing cycle" case, and it needs **no new
`filter_status` value and no scheduled-apply machinery** — an `active` filter
with an empty balance already behaves that way, and it correctly binds the admin
swap (§34), admin force-assign (§35) and pool visibility (§19.4) meanwhile,
which a `pending_apply` state would not.

`src/lib/filterRelease.ts` holds the arithmetic and `canSpendRefund`; the
predicate for *which* leads is `releasable_filter_assignments`, in SQL, because
it has to agree with the router about what "matches this filter" means.

### 39.3 — Why only NON-MATCHING leads, against the brief

The brief asked that the forecast number simply be taken back from the existing
allocation. Restricting it to leads that **fail** the new filter is what keeps
this feature out of the routing engine entirely.

Every candidate function excludes customers who already hold the lead via
`not exists (select 1 from lead_assignments …)`. Releasing **deletes that row**,
so the exclusion goes with it — and a released lead that *matched* could be
re-offered straight back to the same customer, who would then spend the refunded
credit on the lead they had just given up. Avoiding that otherwise needs an
exclusion table consulted by three privileged predicates.

Restricting releases to non-matching leads makes the customer's own active
filter the exclusion mechanism, for free. It is also better behaviour: we only
ever take back leads they have just told us they do not want.

### 39.4 — ⚠️ The accepted gap: a lift reopens the door

Deleting the assignment removes the "already holds it" guard. While the filter
is **active** the released lead fails it, so nothing happens. But a **lift** sets
`filter_status = 'off'`, and the lead becomes eligible for that customer again —
through routing, and through the pool.

**Accepted deliberately.** A lift is deferred to renewal (0026), so the window
opens a month away at the earliest, by which time the lead is usually sold,
pooled or expired; a customer who has lifted is asking for any lead again; they
would pay full price; and they never opened it. Closing it means
`create or replace` on `get_filtered_candidates_for_lead`,
`get_unfiltered_candidates_for_lead` and `customer_can_see_pool_lead`, with the
§11 ACL trap each time, for a benign outcome.

`filter_lead_releases` records every release, so **if this ever becomes a real
complaint the fix is a one-clause addition to those three and the data to prove
it is already there.**

### 39.5 — What 0114 does NOT touch

`get_filtered_candidates_for_lead`, `get_unfiltered_candidates_for_lead`,
`get_next_customers_for_lead`, `customer_can_see_pool_lead`,
`get_escalation_candidates`, `assign_lead_to_customer` and `credit_invoice` are
**all untouched**. That is the payoff for §39.3, and it is what lets a reviewer
confirm the blast radius by inspection.

Also untouched by the release: `(gr_)pool_debit` (invariant 12 — settled only
inside `credit_invoice`) and `management_lifetime_leads_received` (invariant 9 —
only counts up).

### 39.6 — Three traps the predicate exists to avoid

- **A swap-withdrawn lead (0059).** The swap withdraws a lead by clamping
  `max_assignments` DOWN to `assignment_count`. Releasing another holder's copy
  decrements the count while the clamp stays put, putting a deliberately
  withdrawn lead back *under* its cap and straight into ordinary routing.
  `l.withdrawn_at is null` bars it.
- **A pool-claimed lead (§19.6).** A claim must never reopen its slot.
  `discard_lead_assignment` sets `pool_expired_at` instead of decrementing for
  exactly this reason; rather than reproduce that branch, a claimed lead is
  simply not releasable — the operator rang the landlord before keeping it,
  which is the opposite of untouched anyway.
- **`nudge_sent`.** Excluded from the event scan for the usual reason (§3).
  Counting our own reminders as the customer's activity would lock exactly the
  leads nobody has touched — the ones this feature exists to recover.

### 39.7 — The balance clamp moved into the RPC

The apply route used to write `update[c.balance] = Math.min(balance, allocation)`
from a value read at the *top* of the request — a blind read-modify-write, so any
credit an ingest spent in between was silently handed back. It now happens inside
`release_unmatched_assignments` under the customer row lock, alongside the
refunds.

⚠️ **The RPC is therefore called on every fresh enable, even with nothing to
release**, and its `p_max <= 0` early return sits *below* the clamp. Move that
return to the top and every customer with no releasable leads quietly stops being
clamped.

### 39.8 — Refusal order in the apply route is fixed

`forecast_not_acknowledged` (400) → `forecast_changed` (409) →
`existing_leads_decision_required` (409). The client sends
`acknowledge_forecast`, `quoted_expected_leads` and `existing_leads` in **one**
request, so a forecast that moves while the customer is deciding cannot 409 the
apply and silently discard the choice they just made. The panel clears the
decision in the same `useEffect([selectedAreas, minBeds, maxBeds])` that already
voids the acknowledgement — the answer is about a specific set of leads, and a
changed selection excludes a different set.

The question is skipped entirely — filter applies, nothing released — when
nothing is releasable, when no forecast could be offered (the Keep branch has no
number to size a release with, and `null - balance` is `NaN`), or when
`canSpendRefund` is false: paused (§21), archived (§18D) or cancelling (§29)
accounts would be credited for leads they will never receive.

The `releasable_filter_assignments` read **fails OPEN** — code deployed ahead of
the migration must not refuse every filter apply on the platform. Same argument
`autoAssignLead` makes for `lead_is_closed`.

### 39.9 — 0060 is a hard dependency

`notifications.lead_assignment_id` was created NO ACTION; deleting an assignment
that had produced a notification raised a foreign-key violation until 0060 made
it `ON DELETE CASCADE`. Every release deletes an assignment that *has* produced a
new-lead notification. **Do not revert 0060.**

### Verification

- `npm run test` — `src/lib/__tests__/filterRelease.test.ts` covers the
  arithmetic, including the not-offerable forecast and the per-product
  `canSpendRefund` split (invariant 6: `paused_at` must never gate GR).
- On a Supabase branch, with a customer at `lead_balance = 0` holding unworked
  leads across mixed areas plus one worked lead: apply a narrowing filter and
  check the 409 lists exactly the unworked non-matching ones; `discard` removes
  them, decrements `assignment_count`, raises `lead_balance` by the same number,
  lowers `leads_received_this_month`, and writes `filter_lead_releases`;
  `keep` at zero balance releases exactly `min(forecast, releasable)`; `keep`
  with balance ≥ forecast releases nothing.
- Confirm a swap-withdrawn lead and a pool-claimed lead are never offered.
- Re-apply the same filter twice — the second pass must release nothing.

### Deployment order — migration BEFORE code

0114 is purely additive (one table, two new functions) and redefines nothing, so
applying it ahead of the deploy is inert. Deployed the other way round, the
`releasable_filter_assignments` call fails open and filters apply exactly as they
did before — which is the safe direction for the window.

---

## 40. Messaging a landlord from the database *(0115–0118)*

An operator connects **their own** TimelinesAI workspace, and messages the
landlord from the lead page. What was sent, what came back, and every delivery
signal in between is stored against the assignment.

⚠️ **This section was written as §28 in the code and that number was already
taken** by the filter volume forecast. Everything messaging now says §40; the
filter-forecast `§28` references in `filterPrediction.ts`, `filterRelease.ts`,
`planChanges.ts`, the Stripe webhook and 0109/0111/0114 are the original sense
and were deliberately left alone.

`/dashboard/settings/messaging` · `POST /api/customer/messaging/{send,draft}` ·
`/api/webhook/timelines/[token]` · `/api/cron/poll-whatsapp-status`.

### 40.1 — Why the customer owns the connection

The alternative is one Stayful WhatsApp number and one Stayful sending domain
for the whole book. Both fail for the same reason: the landlord would be
messaged by us and reply to us, when the entire product is that the **operator**
is the one making contact. It also concentrates the risk — a QR-linked WhatsApp
sending at volume is the classic profile for restriction, and one restricted
number would take every customer's messaging down at once.

So the credential is theirs, encrypted per customer, and the number at risk is
their own. That is stated plainly in the setup panel rather than buried, because
it is the customer's decision to take.

**AES-256-GCM in `src/lib/crypto/secretBox.ts`**, with the AAD bound to
`<purpose>:<customer_id>` — so a ciphertext lifted from one customer's row
cannot be decrypted against another's. Supabase Vault was the obvious reach and
is wrong here: the service role can read `vault.decrypted_secrets`, so every
route in the app would be one typo from a plaintext workspace token.

### 40.2 — What these vendors actually are, verified rather than assumed

| | |
|---|---|
| TimelinesAI | A **QR-linked device**, like WhatsApp Web — NOT the official WhatsApp Business API. The connected account returns `447957516879@s.whatsapp.net`, a WhatsApp WID, not a Meta phone-number-id. No templates, no 24-hour window, and real ban risk at volume |
| Webhook auth | **None at all.** Their spec states request authentication and custom headers are unsupported |
| Delivered / read | **No webhook exists.** Polled, which is why §40.6 exists |
| Rate limit | 30 req/s **per IP**, and every tenant shares Vercel's egress — one bucket for the whole platform, unlike Resend's per-account limit |
| Resend | No OAuth; two key scopes only. Returns **400, not 401**, for an invalid key — verified live |

Two traps found in the live workspace rather than in the docs, both now guarded
in `whatsappIdentity.ts`: WhatsApp **LID** identifiers, which are not phone
numbers and must never be matched as one; and a chat whose number is literally
`"+0"`, which passes a naive `@s.whatsapp.net` JID check and is rejected by
`normalised_phone` (0070) instead.

### 40.3 — ⚠️ Preview means LIVE FOR THIS VIEWER, on all three surfaces

`messaging_enabled` is a fact about the **platform**. Admin preview is the whole
reason it can stay off during rollout, so it has to mean the same thing
everywhere — visibility, connectedness *and* sending — or the rehearsal it
exists for is impossible. `messagingActiveFor(admin, isAdmin)` is the one
definition.

This was the phase-2 bug, and it is worth recording precisely because the
half-fix looks complete. `channelAvailability` read:

```ts
const waConnected = enabled && whatsapp?.status === "connected";
```

`enabled` was answering three different questions and preview only overrode the
first. A **connected** admin therefore read as not connected and the modal
offered setup for ever. **Connectedness is a fact about the customer's account
and was never the switch's business** — the `&&` was dead logic for a customer
(the early return already caught them) and wrong for an admin. Fixing that line
alone would still have 503'd on Send, which gates separately.

⚠️ **It follows, and nothing else says it: while the switch is off, an admin's
own customer row sends real WhatsApp messages to real landlords.** That is the
intent. It is the only way to test the thing.

### 40.4 — Email is hidden, not deleted

Seven DNS records, three of them 60-character DKIM CNAMEs, is not something a
property operator completes. Measured against the first real user, not guessed.

`messaging_email_enabled`, seeded `false` (0117), with the same admin bypass.
Hidden means **absent from the channel list**, not a disabled button — and the
send route and the domain route each refuse the channel independently, so the
API is not a way round the UI.

The code stays dormant rather than deleted, because what would be thrown away is
the four-layer defence against putting an MX record on a customer's **apex**
domain. `stayful.co.uk` resolves MX to `smtp.google.com`; an apex mistake stops
a live Google Workspace receiving mail. The sending name is **constructed** from
a website domain plus a prefix — a customer cannot supply a finished subdomain
even deliberately — and `preflightDns` refuses a target that already receives
mail. `domainRules.test.ts` is the highest-value test file in the feature.

### 40.5 — "Generate a draft"

A button in the composer that writes a first WhatsApp about that specific
property. It **never sends by itself**; the operator edits and sends.

The model integration follows `claudeMapping.ts` exactly — client constructed
inside the call with a timeout, `messages.parse` with `zodOutputFormat`,
`effort: "low"`, and its **never-throw discipline**. A draft button that 500s is
worse than one that quietly offers an empty box.

#### ⚠️ The PDF is already in the database

The ask was to use "the PDF that is attached". Its contents are already
extracted into cross-checked columns by §25/§26/§38. Feeding those is strictly
better than re-parsing: they cannot drift into OCR noise, they cost no download,
and re-extraction would reintroduce §25's pdf.js buffer-detach hazard. **No PDF
reading. The structured figures ARE the PDF.**

#### ⚠️ Do NOT reuse `buildPresentationSeed()`

Its stated contract is that the seed must be **complete**, so it fills every gap
with `TOOL_INCOME_DEFAULTS` — gross £60,000, £185 a night, 60% occupancy. Right
for a form, catastrophic for a prompt: half the live book has no analysis (15 of
30 when this was written), and the model would tell those landlords their
property grosses £60,000 on the strength of a placeholder.

`src/lib/messaging/draftContext.ts` states the inverse rule at the top of the
file and is the only reason it exists as a separate module:

> **ABSENT IS NULL, AND NULL IS OMITTED. Never a default, ever.**

The one thing shared is `numOrNull`, which encodes the `Number(null) === 0`
trap — exported from `presentationSeed.ts` rather than written twice.

#### The exclusion list, and why each column is on it

| Excluded | Why |
|---|---|
| `net_annual_income` | Net of **Stayful's** 15%, and rendered nowhere by design (§26.1). It is not the operator's net and never was |
| Any fee, theirs or ours | The report's 15% is ours; `presentation_settings.fee` has a `basis` of net or gross that changes the number materially. A first message settles it by quoting neither — including "no fee", which is still a price claim |
| `risk_score` | **Inverted**: 0 means LOW risk. A model told "risk 12" writes "low risk"; told "risk 88" it may still reassure. The report's own `risk_label` wording is passed instead |
| `market_occupancy_rate` when 0 | A real value meaning **no comparable listings were found**, not 0% occupancy |
| Comp-set figures, `income_estimate` | `income_estimate` is the operator's own typed number (§25) and says nothing to the landlord |

`lead_profile` is included, and **must be viewer-scoped first**. On a
marketplace lead it is Stayful's qualification blurb and the best material here;
on an imported one it is whatever the spreadsheet had left over — §32.8 spells
it out as *"margins, source attribution, 'will take 12%, spoke to Dave'"*. On a
**resold** lead, selecting it straight from `leads` would have the model
paraphrase another operator's private margin note into a WhatsApp to the
landlord. The route calls `viewerScopedLead(lead, customer.id)` before building
context, and the prompt fences what survives as background never to be quoted.

#### Three layers, and the third one REJECTS

Omission, then the prompt's prohibitions, then `validateDraft()` — pure and unit
tested. It refuses any `£` or `%` when no figures were supplied, any money
figure that does not round-trip to a supplied one within 5%, any pricing word,
**any URL** (the strongest spam signal in a cold WhatsApp, and the number at
risk is the operator's), over 480 characters, and a message that never uses the
landlord's name.

⚠️ **It rejects; it does not repair, and the fallback is the EMPTY TEXTAREA.** A
truncated message or one with a number quietly deleted is worse than no draft,
because the operator sends it believing we checked it. And unlike
`claudeMapping.ts` there is no duller fallback: a canned template pasted into
WhatsApp is exactly the mass-outreach pattern that gets a number restricted.

Only bare-marked numbers are checked. A bedroom count or "before 6" is not a
figure, and refusing those would refuse perfectly good messages.

`generated_by` records `llm` for an unedited draft and `human` for one the
operator rewrote — resolved **server-side** by re-reading
`message_draft_requests.draft_text` and comparing normalised text, not by
trusting a client flag. That distinction is what will answer "which messages
convert".

### 40.6 — Messages are RENDERED in the timeline, never written as notes

The ask was "store sent messages as a note so this is trackable". Investigating
how turned up the reason not to.

⚠️ **`lead_notes` is not a log. Around twenty-five predicates read it, and a row
in it is a CLAIM THAT THE OPERATOR DID WORK.** The four load-bearing ones:

| Reader | What one note does |
|---|---|
| `lead_pool_barred()` (0073) | **Permanently bars the lead from the expired pool** (§19.3) |
| `get_assignment_engagement_scores` (0063) | `note_added` is 0.40 against a day-10 threshold of 0.35 — one note alone exempts the lead from escalation |
| `discard_lead_assignment` (0010) | Refuses to discard a lead carrying any note |
| `releasable_filter_assignments` (0114) | Reads it as "touched", so it **blocks the credit refund** when a filter is applied (§39.2) |

Plus `lead_last_activity_at`, the capacity model, the scoreboard, churn risk,
`get_operator_proof`'s "Write it down" row, and `GET /v1/leads/{id}/notes` — so
a customer's own MCP agent would read their outbound WhatsApps back as notes.

So `LeadNotes.tsx` takes a `messages` prop and renders **one merged
time-ordered list**: a typed note looks exactly as it did, a message carries a
channel badge and its delivery state, which a note could never show anyway. The
trackability the ask was for, without four routing changes by accident.

Reporting on messages therefore joins `lead_messages`, never `lead_notes`.

#### ⚠️ Deleting a lead orphans its conversation, silently

`lead_messages.assignment_id` and `.lead_id` are `ON DELETE SET NULL` (0116),
and the timeline is keyed on `assignment_id`. So deleting a customer-owned lead
(§30.7) leaves every message row intact and **unreachable** — the conversation
disappears from the dashboard while the audit trail survives. The `message_sent`
rows in `lead_events` do not survive at all: that FK is `ON DELETE CASCADE`
(0043), so they go with the assignment.

Both behaviours are right. What was wrong is that it happened with no warning:
the delete confirmation promised only that "notes and files go with it". It now
names the message count when there is one, and says the messages **stay in our
records** rather than that they are deleted — because they are not, and copy
that said otherwise would be a plain lie about what the database does (§19.7:
copy is part of the mechanism). The count is free, since `LeadDetail` already
holds the assignment's messages for the timeline.

This is how the first live test lost its own evidence: the test leads were
deleted mid-run, so three messages, two threads and every inbound reply ended
up matching nothing.

### 40.7 — A sent message is contact. An inbound reply is not. *(0118)*

The one routing effect that **is** wanted, and the only migration in this phase
that changes who gets leads.

The evidence hierarchy is incoherent without it. §6 excludes `mailto_click`
*"because a mailto click guarantees nothing was sent"* and includes `tel_click`
because it is an attempt to ring. **A delivered WhatsApp with a provider message
id is stronger than both** — not an attempt at contact, it *is* contact. Left
out, genuinely-worked leads escalate to a competitor at day 10 and pool at 25.

Measured before it shipped: 352 assignments, **12 contact clicks in total**
against 577 `detail_opened`, while 210 assignments carry `first_contacted_at`.
Roughly 198 assert contact with no evidence at all. That gap is the reason this
feature exists.

- Through **`lead_events`**, not a second trigger on `lead_messages` —
  `lead_events` is "the engagement basis for everything" (§3) and already owns
  this route into `mark_assignment_contacted`. A parallel trigger would be a
  second undocumented path, and it would not be weightable.
- `message_sent` is weighted **0.60**, above `tel_click`'s 0.50.
- ⚠️ **A weight row alone is a silent no-op.** `get_assignment_engagement_scores`
  has a FIXED `present` CTE, so the signal must be added in **four** places: the
  CTE, the weighted sum, the `passive_only` negation and the breakdown jsonb.
  Missing the third would let a messaged lead still read as passively held,
  which the caller treats as inactive whatever the score says.
- ⚠️ **`message_sent` must never enter `CLIENT_LEAD_EVENT_TYPES`** — the §3 trust
  boundary. A customer able to POST it could shield every lead they hold.

**Inbound gets no trigger and no weight, deliberately.** A landlord replying is
the landlord's act — the `nudge_sent` rule (§3) in a more damaging form. An
operator who sends one message, gets an eager reply and then ignores it for
three weeks is exactly who escalation exists to take the lead from, and letting
the landlord's own reply shield it would be this feature's worst failure. It is
also the sharpest argument against the note mechanism above: a note row for an
inbound reply would have done precisely that, silently, at 0.40.

#### ⚠️ `lead_last_activity_at` was an EXCLUSION filter, and that is now fixed

It read `and e.event_type <> 'nudge_sent'`, so **every event type added to the
vocabulary would silently start feeding the §19.2 pool clock**, with nothing to
review and nobody deciding. 0117 added two types; both would have been swept in
automatically, `message_received` included.

For the pool clock specifically, including both is right — the pool asks "is
this lead alive", and a landlord who replied three days ago plainly is. But that
must be a decision, not an accident. 0118 flips it to an **explicit inclusion
list**. Behaviour-identical on today's data, and verified as such: both
`lead_last_activity_at` over 200 leads and `get_assignment_engagement_scores`
over 200 assignments fingerprinted **identical** before and after the apply.

⚠️ **Knock-on for §12 Deferred:** flipping to `contacted` makes the lead
**undiscardable** (discard requires `status = 'new'`), widening the gap §5E
already records for `tel_click`. Sending a message is a far more deliberate act
than clicking a phone number, so it is the right trade — but it is a new way to
lose the discard button. Reject still covers the case.

### 40.8 — The inbound receiver, and the four defences

TimelinesAI **cannot sign a webhook**, so nothing from one is trusted:

1. An unguessable token in the URL path — payloads carry no tenant identifier,
   so the URL is how we know whose workspace an event describes.
2. **Claim by INSERT** into `message_webhook_events` — the `stripe_events`
   discipline. The claim is deleted on a throw so a retry works.
3. ⚠️ **Read-back before any state change.** `getMessage()` against that
   customer's own workspace is the decisive defence; an unverifiable payload is
   stored `verified: false` and changes nothing. Where the read-back cannot
   finish inside TimelinesAI's 5-second budget, verification is deferred rather
   than skipped.
4. **Match to a lead, or discard.** Not stored as an unmatched thread — dropped.

⚠️ **This route was registered in phase 1 and did not exist.** The connect route
creates four webhooks pointing at it, so the live workspace was POSTing to a 404
for a day. Recorded because the shape recurs (§23.10, §25's `items(ids:)`
pagination, §27.8's `!inner`): the pieces either side were tested and the seam
between them was not.

#### ⚠️ And then it dropped everything, for the same reason one layer down

Twenty events arrived, every one was claimed, and `lead_messages` held nothing
but outbound sends from the composer. The receiver took the counterparty from
`payload.chat.jid` — a field the body does not carry in the shape assumed — so
`rawPhone` was null and every event died at `not_dialable` with a 200.

Two lines further on, the same mistake again: `TimelinesMessage` declared a
`direction` field the API does not return. The real discriminator is
**`from_me`**, and the counterparty is `sender_phone` or `recipient_phone`
depending on which way the message went. So anything that HAD matched would have
been filed as `outbound` — a landlord's reply included.

**The principle both bugs broke is layer 3's own.** The route fetches the
authoritative message precisely so we believe the API and not an unsigned body,
and then reached back into that body for the two facts that decide where the
message goes. `resolveWebhookIdentity()` in `whatsappIdentity.ts` is now the one
place either is derived: read-back first, body only as a fallback, and
`normalisePhone` still the gate so the LID and `"+0"` traps hold either way.

Three things changed so this class of bug is visible next time:

- **The payload is stored on EVERY event**, not only deferred ones. Diagnosing
  this needed a round trip to the vendor because twenty claimed rows had kept
  nothing of what was sent — the one part that cannot be reconstructed later.
- **Every drop is logged.** `not_dialable`, `no_matching_lead` and `no_uid`
  returned a 200 with a note nobody could see, which is exactly why twenty
  discarded events looked healthy.
- **`verified` means something.** It is `NOT NULL DEFAULT true` and only the
  failure path ever wrote it, so every row read `true` whatever happened. The
  claim now inserts `false` and the read-back promotes it.

#### ⚠️ And a SECOND bug, in the same path: the thread key

Fixing the identity resolution was not enough — replies still vanished. The
payload, once it was finally being stored, showed why: `chat.phone` had been
there all along (`447788643769`), so the `not_dialable` theory was wrong. The
events were dying one step later.

`lead_message_threads` is UNIQUE on `(customer_id, counterparty_phone_norm)` —
a generated `normalised_phone(counterparty_phone)`. Both call sites looked the
thread up by the **raw string**. The send path stores what the lead's row holds
(`07788643769`); an inbound webhook carries the same number as
`+447788643769`. Different strings, same key — so the lookup missed, the insert
then violated the unique index, and the event was discarded for having no
thread. **Every reply on a number we had already messaged died there**, which is
every reply worth having.

`findOrCreateWhatsappThread()` in `threads.ts` is now the one definition, used
by the send route and the webhook ingest, matching on the key the constraint
uses and re-reading on 23505 — which also closes the genuine race between two
events arriving together. The send path had the same bug latently and only got
away with it because it always uses the lead's stored phone.

`no_thread` also stopped being a `dropped` reason. Failing to create a thread is
OUR failure, and `dropped` is terminal — that verdict is reserved for an event
genuinely not ours to keep.

⚠️ The lesson is the one this file keeps recording (§23.10, §25, §27.8): each
piece was tested and the seam was not. Here there were two seams in nine lines,
and fixing the first one made the second one the whole problem.

#### The recovery pass *(0119)*

An event we could not read back inside the 3-second budget used to be lost for
ever, and it looked exactly like a landlord who never replied — which is why
nobody would ever have reported it.

⚠️ **The vendor's own retries cannot rescue one.** TimelinesAI retries twice,
but the receiver claims by INSERT *before* it reads back, so every retry
short-circuits on 23505 and does nothing. Claiming first is right — it is what
stops double-processing — and it makes recovery ours alone.

`ingestTimelinesEvent` (`src/lib/messaging/ingestTimelinesEvent.ts`) is layers 3
and 4 lifted out of the route **so that two callers can run them**: the webhook
at 3s, and a second phase of `/api/cron/poll-whatsapp-status` at 8s. That cron
already runs every five minutes, already holds a wall clock and already goes
through `consume_provider_budget` — the shared 30-req/s TimelinesAI bucket a
separate job would contend with blindly — so the pass lives there rather than in
a cron of its own, after the status phase and inside its own `try/catch`.

| | |
|---|---|
| Due | `verified = false`, `customer_id` set, `next_attempt_at <= now()` |
| Backoff | `webhookRetry.ts` — 1m → 5m → 15m → 1h, then flat |
| Give up | 24h after `received_at`: `next_attempt_at` nulled, **row kept** |
| On our own error | Defer. Never settle an event because *we* failed |

⚠️ **`customer_id` had to be added to the table for this to be possible at all.**
The claim id is `timelines:<event_type>:<uid>` and carries no tenant, the payload
has no reliable customer field, and the read-back needs *that* customer's token —
so an event nobody can attribute is an event nobody can retry. The receiver knew
it all along and simply never wrote it down.

⚠️ **Retrying is only safe because the ingest is idempotent, and it was not.**
The `lead_messages` insert dedupes on `(provider, provider_message_id)`, but the
`unread_inbound_count` bump and the thread timestamps did not — so a second run
showed the operator two unread replies where the landlord sent one. Already
reachable before any retry existed, because the claim id carries the EVENT TYPE
and one message can arrive under two of them. Both are now guarded on the insert
having actually inserted.

Existing rows are excluded by construction: they predate payload storage and
carry `verified = true` from the old default, so the partial index never sees
them.

#### Phone-sent messages are captured, and that is the point

`message:sent:new` fires for messages the operator sends from **their own
WhatsApp app**. Those are captured — matched to one of that customer's own leads
via `matchKeyFromChat()`, and **anything else discarded before any write**.

This is the highest-value part of the feature. The 12-clicks-against-352-
assignments gap is precisely operators working leads on their phone where we
cannot see it; capturing it closes the blind spot without asking anyone to
change how they work. The match-or-discard rule is the containment: the
workspace holds hundreds of chats that are nothing to do with any landlord, and
a personal conversation must never enter the database because a number happened
to be in range.

### 40.9 — The status poller

`/api/cron/poll-whatsapp-status`, every five minutes. TimelinesAI has no
delivered/read webhook, so `next_poll_at` — written on every outbound send since
phase 1 — is read here. Until this existed nothing read it, and every WhatsApp
sat at `sent` for ever while the timeline offered two states it could never
reach.

Bounded three ways: **backoff** (1m → 5m → 15m → 1h → 6h, abandoned at 48h),
**round-robin by customer** so one operator's morning burst cannot starve
everyone else, and a **wall clock** plus the shared per-second budget through
`consume_provider_budget`, which fails CLOSED.

Two rules inside it:

- ⚠️ **A poll never marks anything `failed` on OUR error.** A timeout, a 429 or
  an unreadable token defers; only the vendor's own `failed` writes `failed`.
  The opposite turns a bad afternoon on their side into a lead history saying
  the operator never reached the landlord.
- Statuses are **ranked**, not last-wins. `status_history` has no documented
  ordering guarantee, and a poll must never walk a message back from Read to
  Sent. `delivered_at` / `read_at` are first-observation-wins, the
  `first_contacted_at` discipline (§6).

### 40.9A — ⚠️ Two rules about a phone number, and the send path used the wrong one

The first live send failed with `The message could not be sent (http_400)`.
The number was `+44778643769` — **nine digits after the country code where a UK
mobile has ten**. TimelinesAI was right to refuse it. What was wrong was that it
ever got that far, and that the operator was then told nothing useful.

This codebase has two phone predicates and they answer different questions:

| | Question | Used by |
|---|---|---|
| `normalisePhone` / `normalised_phone` (0070) | **Are these two records the same person?** Seven digits, not all zeros — deliberately loose, because under-matching costs a duplicate | duplicate detection, thread keying, `toE164` |
| `normaliseUkMobile` (§36.2) | **Is this a UK mobile?** Strict `07\d{9}` after the country-code dance | the lead quality gate |

`toE164` is built on the first, so the send path was validating deliverability
with the *identity* rule. It now consults `normaliseUkMobile` and refuses before
any provider call, saying that a digit is probably missing. **An explicitly
foreign number still goes through** — a landlord abroad is a fact, not a mistake
— and the provider decides.

The vendor's own explanation was also being discarded: `sent.detail` held
whatever TimelinesAI said and nothing read it. It is now always logged, and
shown to an admin (the `messagingConfigError` split).

**Customer-added leads are normalised on the way in.** `toRpcRow` is the one
choke point both the manual add and the bulk import pass through, so
`07700 900123`, `+44 7700 900123`, `447700900123` and `7700900123` all store as
`07700900123` — the postcode precedent in that same function, applied to phones.
A customer should not have to know what shape we want, and Excel will have eaten
a leading zero off at least one column.

⚠️ **Anything it cannot resolve is stored EXACTLY as typed, never blanked.** A
number one digit short is something the operator has to be able to SEE to
correct; §36.4 makes the same argument for keeping a failed lead rather than
deleting it. The import result names how many of the new leads carry a number
nothing can message — counted after the commit over the leads actually created,
because before it duplicates and blank rows would be counted as problems the
customer cannot act on.

⚠️ **Customer-added leads still carry `lead_quality_status = 'pending'`.** The
§36 gate runs at ingest and its backfill skips owned leads, so nothing judges
them. That is harmless for allocation — owned leads are never allocated — but it
means the phone verdict above is the only check they get, and a §32.4 resale
candidate reaches qualification unjudged.

### 40.10 — Send caps are enforced, not merely displayed

The setup panel told the operator *"Sending is limited to 40 a day to protect
your number"* and the send route selected `daily_send_cap` and dropped it. **A
stated safety limit that does nothing is worse than none**, on the one risk
borne by the customer's own phone number. Both `daily_send_cap` and
`min_send_interval_secs` are now enforced (429 `daily_cap_reached` / `too_soon`),
and drafts are capped separately at 3 per assignment per day and 50 per customer
per day from `message_draft_requests`.

### 40.11 — Two external links that must not drift

`TIMELINES_SIGNUP_URL` carries `refby=5adca00be2612e9c` — **a referral link**,
and a code that silently drops off one of its two placements is revenue nothing
would ever alert us to. `TIMELINES_SETUP_VIDEO_URL` is the setup walkthrough,
offered above the setup steps and beside "Begin setup" in the composer's
not-connected state — the two moments people actually stall.

Both are **exported constants with a unit test pinning the parameter**, never
URLs typed into JSX. Same discipline as `featureRequest.ts` (§21.8).

⚠️ **The Drive file must be shared "Anyone with the link → Viewer".** Restricted,
every customer lands on a request-access page, which reads as the product being
broken rather than the video being missing.

### 40.12 — Two contact limits: WHEN, and HOW MANY OF US *(0120)*

§40.10's caps are about volume and are both **per customer**. Neither asks what
time it is, and neither can see the other operators holding the same landlord.
Both gaps were measured rather than assumed:

| | |
|---|---|
| Outbound WhatsApps sent at the time of writing | 17, across one lead |
| Sent outside 09:00–20:00 London | **6 of 17**, all at 20:xx |
| Leads held by 2+ operators | **145** of 441 |
| Leads held by 3+ | **28**. One is held by **5** |
| Landlords messaged by two operators so far | **0** — the book is one operator testing |

Neither problem has bitten, and both are structurally guaranteed to the moment a
second operator connects.

#### Quiet hours refuse, they do not defer

09:00–20:00 Europe/London, **seven days a week**, WhatsApp only.

⚠️ **There is nowhere to defer to.** Every send is synchronous and
operator-initiated: no queue, no `send_after`, no sending cron — the only
messaging cron reads delivery status and re-runs unverified inbound events.
Building a queue would also collide with 0116's own note that TimelinesAI has no
idempotency key, so a stale queued WhatsApp is never auto-retried. A queue whose
entries cannot be safely retried is not worth inventing for this.

**Seven days, and no bank holidays.** `businessTime.ts` is the wrong calendar
twice over: a landlord is a **consumer**, so a Saturday may land better than a
Tuesday; and `fetchUkBankHolidays()` makes a live gov.uk request with an 8s
timeout, which is fine in the batch crons that call it and not fine behind a
Send button.

**No admin bypass.** §40.3 establishes that preview means live *for this viewer*
— an admin's own row sends real messages to real landlords while the switch is
off — so a real WhatsApp at 22:00 is precisely what this prevents, whoever sends
it.

⚠️ **`sendWindow.ts` is the first time-of-day helper in the codebase.**
`businessTime.ts` is date-granularity only, and nothing anywhere asked what hour
it is in London. Vercel runs in UTC and Britain is an hour ahead for over half
the year, so reading the server clock would message people an hour early from
late March to late October — and would have looked correct in every winter test.
That case is pinned.

Everything in the module is **pure**, deliberately: `service.test.ts` tests
`assignmentSendable` with no fake client at all, so the decision is testable in
that style rather than through the fake — which is the seam `draft.test.ts`
warns about.

⚠️ **A missing setting means the DEFAULT WINDOW — not fail-open, not
fail-closed.** The two precedents point opposite ways (`messagingEnabled` fails
closed, `fetchUkBankHolidays` fails open) and neither fits a *restriction*:
failing closed would refuse every send to avoid sending at the wrong hour, and
failing open would lift the rule exactly when we cannot confirm it. The default
**is** the rule; `messaging_quiet_start_hour` / `_end_hour` only move it.

It is also reported **before** the operator writes, through a new `quietUntil`
on `ChannelAvailability` — being told at the end that three hundred characters
cannot go anywhere is the version of this that stops the feature being used.

#### The cross-operator cooldown, and what it may not say

No two **different** operators may message one landlord within
`messaging_lead_cooldown_hours` (24). A cooldown rather than a lifetime cap: the
risk worth preventing is the same-morning pile-on, and a lifetime cap would block
the operator who legitimately arrives fifth through no fault of their own.

**Keyed on the phone, not on `lead_id`.** §18's duplicate-landlord problem means
one person can arrive as several `leads` rows — 28 exact groups when 0070 was
written, and deliberately no unique constraint on the identity key — so `lead_id`
under-counts in exactly the case that matters: three operators each holding a
different row for the same landlord. `counterparty_phone_norm` is the identity
key the rest of this feature already uses, for that same reason.

⚠️ **This is the only customer-agnostic read in the feature**, and it breaches on
purpose what 0116's header calls the containment guarantee — *"the leading
customer_id in every unique key … one customer's conversation is structurally
unreachable from another's"*. Every other read in `src/` is
`.eq("customer_id", …)`. So the crossing is confined to one function, and:

⚠️ **It returns a boolean and nothing else.** No id, no name, no count, no
timestamp, not even how long is left. §19.7 removed previous-holder information
from the pool row set entirely *"so no later UI change can reach for it"*, and
the rule covers the count, the identity **and whether they acted at all**. A
richer return value is a probe: operator A learns when operator B is working a
shared landlord.

⚠️ **Which is why the copy names no time.** *"You can message them again after
4pm tomorrow"*, minus a cooldown anyone can measure by experiment, **is** the
other operator's send time — §19.7 arrived at by subtraction. The message
attributes the block to us, asserts nothing about anybody, and names what the
operator can still do, because a refusal with no alternative reads as the product
being broken. Two unit tests pin it: the verdict has exactly one key, and the
sentence contains no digit and no time word.

⚠️ **And it is deliberately absent from `channelAvailability`.** Quiet hours is
knowable from the clock and safe to show up front; greying a button because
*another operator* messaged this landlord would announce their activity on page
load. The cooldown appears only in the response to an attempted send.

**Fails OPEN on a query error**, the opposite way to the send route's other
guards. Those protect the operator's own number; this one protects a landlord
from a second message. Refusing every send because one read failed would take a
paid feature down to prevent a duplicate.

`lead_message_threads_counterparty_idx` (0120) is what keeps the lookup off a
sequential scan — the existing unique index leads on `customer_id` and cannot
serve a customer-agnostic query. Confirmed by `EXPLAIN` over 5,000 seeded
threads: index scan on both sides, no seq scan.

**Nothing is retroactive.** Verified read-only against production before
shipping: over the 145 leads held by two or more operators, the predicate blocks
**zero** today.

### Verification

`npm run test` — **159** cases across the messaging suite, 34 of them added by
0120 (the figure recorded here before that was 111, which was already short —
count it rather than incrementing it). Among them: the quiet-hours window read
in BST as well as GMT and across both DST boundaries, the §19.7 pins on the
cooldown verdict and its wording, and the apex
defence (the file that stops us breaking a customer's live Google Workspace),
the crypto AAD binding, the LID and `"+0"` identity traps, prompt assembly
asserted against the **rendered prompt** rather than the context object, the
`channelAvailability` preview regression in both directions, every
`validateDraft` rejection, and the `refby` parameter.

Against the live systems rather than the docs: Resend's endpoints probed (400,
not 401, for a bad key), the real TimelinesAI workspace read back
(`connected`, `+447957516879`, four webhooks registered, quota 29/500), and
`normalisePhone` checked against the SQL `normalised_phone` over ten cases.

0115–0118 applied to `znlfwbnvhlacwzgfalcf`. 0118 was applied alone, with
`lead_last_activity_at` (200 leads) and `get_assignment_engagement_scores` (200
assignments) fingerprinted before and after — **identical**. ACLs re-audited
`service_role`-only on both replaced functions, invariant 7's four
`authenticated`-executable functions re-checked, and `message_draft_requests`
confirmed RLS on with zero policies.

**Not yet exercised:** an inbound reply against real webhook traffic, and the
draft call against the live Anthropic API — `ANTHROPIC_API_KEY` must be set in
Vercel **and the project redeployed**, since Vercel bakes env vars in at build
time. That is the same trap that cost the previous round.

### Deployment order — migrations BEFORE code, and 0117 BEFORE 0118

0115, 0116, 0117 and 0120 are additive and inert; nothing reads them until the
code ships. 0120 in particular carries no column and no constraint — three
settings rows and one index — so it can be applied well ahead of its code, and
the index is what keeps the cooldown lookup off a sequential scan once that
code is live. 0118 touches allocation and is revertible on its own — deployed
0117-only, everything works and messages simply do not mark contacted, which is
the safe direction for the window between them.

---

### 40.13 — Follow-up sequences *(0121)*

An operator builds a ladder — "straight away, then 3 days, then 7" — and puts
leads into it, one or two hundred at a time. Each step is written for that
specific landlord and property the evening before it is due, waits overnight in
a review queue, and sends itself in the morning unless they cancel it.

`/dashboard/follow-ups` · `/api/cron/draft-sequence-messages` ·
`/api/customer/messaging/sequences/**` · the third phase of
`/api/cron/poll-whatsapp-status`.

Everything §40 shipped before this was one message at a time from one lead page.
What the book actually needs is not one message: across the top twelve operators
there are ~247 workable leads and ~50 new assignments a week, and two distinct
failures — **never contacted at all** (21 for one operator) and **contacted once
then abandoned** (19 for another, every one of theirs). A sequence is the
machine for both, and the two halves of the original ask map onto them exactly.

#### ⚠️ The codebase argued against this, and the objection is respected

`send/route.ts` and §40.12 both record, in terms:

> There is nowhere to defer to: every send is synchronous and operator-initiated,
> there is no queue, no `send_after` column and no sending cron. Building one
> would also collide with 0116's own note that TimelinesAI has **no idempotency
> key**, so a stale queued WhatsApp can never be safely auto-retried. **A queue
> whose entries cannot be safely retried is not worth inventing for this.**

That is about a queue of unsent **provider payloads** — rows handed to a sender,
crashed mid-flight, unreplayable. This is not one.

**What is scheduled is an INTENT, not a payload.** A `message_sequence_drafts`
row says "this text is due at 09:00". When it comes due the sender walks
`sendOneMessage`, which claims a `lead_messages` row on
`(customer_id, idempotency_key)` and only then calls the provider — the same
synchronous path a human Send takes. A crash after the provider call leaves a
`queued` row the operator can see, which is exactly what a manual send does
today. **Nothing is ever auto-retried against TimelinesAI.**

`sequenceIdempotencyKey(runId, step)` is `seq:<run>:<step>` — **derived, never
generated**. The sending phase runs every five minutes, so one step being
considered twice is the ordinary case, not a rare one; a random uuid would
defeat the unique index completely and message the landlord again. It is keyed
on the run and the step rather than the draft row, so a draft cancelled and
somehow re-created gets no second chance at the same step.

The objection rules out a retry queue. It does not rule out a schedule.

#### `sendOneMessage()` came first, alone

The send route's body was 250 inline lines in a route handler and the only place
that knew how to message a landlord. `service.ts`'s header already claimed "ONE
DEFINITION OF SEND ELIGIBILITY, shared by the send route and the button" — true
of `assignmentSendable` and never true of the send **path**, because there was
only ever one caller.

Duplicating it for a cron would duplicate seven rules that each fail silently
when two copies drift: the daily cap, the minimum interval, quiet hours, the
cross-operator cooldown, the idempotency claim, the thread bookkeeping and the
`message_sent` engagement event. The extraction shipped as its own commit with
no behaviour change.

Two shapes in the new signature are load-bearing:

- **Quiet hours always REFUSE there, and the verdict carries `quietOpensAt`.**
  ⚠️ **This is the one place §40.12's rule inverts, and it is correct.** A manual
  send has nowhere to defer to, so it is refused; a scheduled step has a
  schedule, so its caller moves `send_after`. One rule, two remedies — possible
  only because the function reports the reopening time rather than acting on it.
- `generated_by` defaults per caller (`human` for the composer, `system` for the
  scheduler) but **a draft found in our own ledger always wins and records
  `llm`**. Provenance is still read back from the ledger, never taken from the
  caller.

What stayed in the route is what only an HTTP caller can answer: ownership (a
foreign assignment id must be indistinguishable from a nonexistent one) and the
two switches that take "is this viewer an admin", which is meaningless to a cron.

#### ⚠️ What stops a run is the most important thing in the feature

A ladder that keeps going after the landlord has answered is worse than never
shipping it. Four things stop one, and three cost nothing to maintain:

| | |
|---|---|
| **The landlord replies** | `stopRunsForAssignment`, from the inbound webhook |
| **The assignment goes away** | the 0121 cascade — discard (§30.7), the filter release (§39) and a swap all stop a run with **no edit to any privileged function** |
| **The lead becomes unsendable** | `assignmentSendable` re-read at both the draft and the send |
| **The operator says so** | `stopRun` |

⚠️ **The reply case is deliberately NOT the same decision as §40.7.** That
section is right that an inbound message must never count as *operator*
engagement — it would shield an ignored lead from escalation. "Does not shield
the lead" and "does not stop us messaging them again" are different questions
with opposite answers, and this is the only place a reply can be seen.

It sits **outside** the `!alreadyHad` guard in `ingestTimelinesEvent`. Stopping a
run twice is a no-op (`stopRun` filters on `status = 'active'`), where MISSING a
reply because its event arrived under a second event type would leave the ladder
running. The two directions are not symmetric.

`stopRun` also sweeps every `pending` draft on the run to `skipped`. Leaving them
would send the next step of a ladder we had just stopped.

#### Schema

| Table | Note |
|---|---|
| `message_sequences` | ⚠️ Partial unique on `(customer_id, lead_type, channel) where trigger = 'on_assignment' and is_active` — at most one standing rule per product, or a new lead is enrolled twice and messaged twice on day one |
| `message_sequence_steps` | `delay_days` is **calendar** days; `brief` is what the step is *for*, fed to the drafter |
| `message_sequence_runs` | ⚠️ **Unique on `assignment_id` ALONE**, not `(assignment_id, sequence_id)`. A lead is in at most one sequence: two ladders on one landlord from one number is the failure this must not ship with. `on delete cascade` from `lead_assignments`, because a run is **live state** where `lead_messages` is the record |
| `message_sequence_drafts` | The review queue. `body` is a **copy** the operator may edit; `message_draft_requests.draft_text` keeps what the model wrote |

Plus `message_draft_requests.origin` and three settings. RLS on, no policies, as
every other messaging table.

⚠️ **The interactive rate limits could not be reused for bulk.** The draft route
caps a customer at 50 drafts a rolling day and one operator's workable backlog is
37 leads; worse, the counter cannot tell somebody hitting "regenerate" four times
from the engine drafting step 2 for two hundred leads, so one would silently
starve the other. `origin` separates them — the interactive caps now count
`origin = 'operator'` only, and the scheduler has its own ceiling in
`system_settings`. `message_draft_requests`' own "~110k rows a year" comment is
derived from the interactive cap and stops being true.

#### Two crons, and why they are two

**Drafting** is its own daily job at 17:00 UTC, `maxDuration = 300`. A model call
is ~20 seconds against the poller's 45-second wall clock, so squeezing it in
there would starve the status phase it shares a budget with, on every run.

**Sending** is a third phase inside `poll-whatsapp-status`, and that route's own
recovery-phase docblock makes the argument verbatim: it already runs every five
minutes, already goes through `consume_provider_budget` — the shared 30-req/s
TimelinesAI bucket a second job would contend with blindly — and already holds a
wall clock.

⚠️ **The sending phase runs AFTER the recovery phase.** A landlord's reply that
this run has just rescued from the deferred queue stops the ladder before the
next step goes out. The other order would act on it one message too late.

⚠️ **`messaging_sequence_review_hours` is 18, and that number is arithmetically
tied to the drafting cron's schedule.** 17:00 UTC to a 09:00 send is sixteen
hours; a twelve-hour window would therefore miss every ordinary morning step,
draft it the following evening, and turn "drafted overnight" into "sent a day
late". Move the cron or shorten the window and check that sum again.

Failure handling is split by where the refusal happens, and the split is not
stylistic: **every rescheduled code is refused BEFORE the claim insert**, so
retrying it is genuinely free. Everything after the claim is terminal for that
step, because the row already carries its key — retrying would collide on 23505
and report a failed send as a successful one.

| | |
|---|---|
| Reschedule | `quiet_hours` (to `quietOpensAt`), `too_soon`, `daily_cap_reached`, `lead_cooldown`, `thread_failed`, `claim_failed` |
| Stop the run | `not_sendable`, `no_recipient`, `bad_phone`, `not_connected`, `credential_unreadable` — every later step would fail the same way |
| Skip and advance | everything else, i.e. a provider failure |

**A failed DRAFT writes nothing and is retried tomorrow, never a template** —
validateDraft.ts's own argument about its fallback. The only bound is time: a
step still undrafted seven days after it fell due stops the run with
`drafting_failed`, so a model outage surfaces as a stopped ladder rather than a
silently frozen one.

#### Drafting steps 2..n

⚠️ **The existing prompt is shaped for a cold opener and reads wrong as a
follow-up.** It says "open with the landlord's first name" and "name the
property so it does not read as a scam"; used unchanged for step 3, every
message reintroduces the operator to somebody they have already messaged twice —
which reads as an automated blast, which is the one thing this must not look
like.

- `DraftContext` gains a `step` block: number, the earlier messages and how long
  ago they went, and the operator's brief. **Absent means first message**, and
  that is the only way to say it.
- ⚠️ **There is deliberately no "has the landlord replied" field.** A reply stops
  the run, so nothing is ever drafted for a conversation that has one, and the
  sending phase re-checks. A flag would be a second, weaker answer to a settled
  question — and the first time the two disagreed we would follow up mid-reply.
- `PROMPT_VERSION` is **per shape** (`wa_first_v1` / `wa_followup_v1`). One
  constant would collapse the only join that can answer "does chasing work".
- ⚠️ `validateDraft`'s `missing_landlord_name` relaxes **for follow-ups only**.
  "Any thoughts on this one?" is a good fourth chase and the rule rejects it —
  and enforcing it would push the model to shoehorn the name into every message,
  which is the repetitive pattern the follow-up prompt exists to avoid. Every
  other rule holds: no links, no pricing, no unsupplied figures, 480 characters.
- `buildDraftContext` requires a `viewerScopedLead()` lead and the drafting cron
  scopes every one. On a resold imported lead `lead_profile` is the uploading
  operator's private working notes (§32.8); the interactive route scopes one
  lead because a person asked for it, this scopes two hundred unwatched.

#### Cadence

`src/lib/messaging/cadence.ts`, pure, on sendWindow.ts's stated reasoning.

⚠️ **The time of day is held in LONDON WALL CLOCK, not in milliseconds.** Adding
`days * 86_400_000` is right for 51 weeks and wrong across the last Sunday in
March and October, where it moves the whole remaining ladder by an hour — a
five-step sequence that starts as a 9am message ends as an 8am one, and 8am is
outside sending hours, so the last step is silently deferred rather than sent
when it was meant to be.

⚠️ **The next step is measured from the previous SEND, not from its schedule.** A
step held overnight by quiet hours or by the daily cap pushes the rest of the
ladder with it. Otherwise a backlog enrolled at the cap fires steps 1 and 2
within hours of each other the moment the cap clears — the burst profile that
gets a number restricted, produced by the limit meant to prevent it.

#### Enrolment, and the two screens

**Bulk, from the leads list.** ⚠️ "Select all" means the **filtered** list, and
that is the point rather than a shortcut: `filtered` already is "3+ beds in
Bristol I have never opened", so the operator has done the segmenting with the
filters and the bulk action inherits exactly it.

⚠️ **The confirmation states how long the backlog will take.** `daily_send_cap`
defaults to 40; three steps over two hundred leads is six hundred messages,
fifteen days. An operator expecting it out this afternoon would first hear
otherwise from a landlord ringing about a message sent a fortnight late.

The multi-select checkbox sits **outside** the card's expanding button — nested
it would be invalid markup and, worse, ticking it would expand the card and mark
the lead viewed, so selecting forty leads would clear forty "new" badges the
operator was using to find them.

**The review queue is the consent.** Every message on it sends itself, from a
real person's number, to a member of the public. Requiring approval instead
would put the feature back to one lead at a time, which is the problem; a queue
nobody can see would make the promise half a promise.

⚠️ **"Not this one" and "Stop chasing" are separate verbs.** Cancelling one draft
advances the ladder as though that step had sent, so the next arrives on its
normal cadence. One button doing both would either lose somebody a whole
sequence over a wording they disliked, or — far worse — message a landlord again
in three days after they had decided to leave them alone.

**Archiving a sequence stops its live runs**, and names the count first. Leaving
them would keep messaging landlords from a sequence the operator believes they
have switched off.

**The standing rule** hooks `completeAssignment()` — the single shared
follow-through for all five assignment paths, so a lead arriving by any route
enrols identically. It **enrols only**: that function is downstream of the single
money path and must not grow a blocking third-party call, and it **never
throws**, like every other follow-through there. ⚠️ Deliberately **not** gated on
`sendThresholdWarnings` — that flag is about credit warnings, and bulk assign and
swap pass `false` for reasons that have nothing to do with messaging.

It does not check `messaging_sequences_enabled`: enrolling while the switch is
off is inert, and it is the right side to fail on — a lead that arrived during
the rollout is then already in the ladder when it is turned on, rather than
permanently missed.

#### ⚠️ The `!inner` on the embedded run

`DUE_DRAFT_COLUMNS` and `REVIEW_QUEUE_COLUMNS` live in `sequences.ts` rather than
inline in the routes so a test can pin them. §27.8 records what the absence
costs: in PostgREST a filter on a **non-inner** embedded resource filters the
EMBEDDED RESOURCE, so every draft comes back with its run nulled rather than
excluded — a 200 that paginates normally and is wrong. Here it would have the
sending phase walk drafts belonging to **stopped** runs: messaging landlords who
have already replied.

### Verification

All 121 migrations to a scratch Postgres 16, 0121 applied twice for idempotency,
and **17 schema assertions**: the second standing rule refused and archiving
freeing the slot, one run per assignment, one draft per step, every CHECK on its
boundaries, `origin` defaulting to `operator`, RLS on with zero policies on all
four — and the one that matters, that discarding a lead cascades the run away
and leaves `lead_messages` standing.

Then an **eight-assertion lifecycle rehearsal** over the exact selectors the two
crons use: the drafting window finds both runs, the sending phase finds both
drafts, a reply stops the run **and** its queued message so only one remains, a
re-run collides on the derived key rather than re-sending, a different step is a
different key and goes, archiving stops every live run, and the sent messages
survive all of it. It also asserts that a **left** join in place of the inner one
does over-return, rather than trusting the §27.8 note.

785 vitest cases, including cadence across both DST boundaries in both
directions, the enrolment tally under a mid-batch collision, and that
`enrolOnAssignment` never throws whatever the database does.

**Not yet exercised:** a live end-to-end run against a real TimelinesAI
workspace, and the follow-up prompt against the live Anthropic API. Do a
two-step sequence on one real lead before enabling it for anybody, and check the
second message does not reintroduce the operator.

### Deployment order — migration BEFORE code

0121 first. It is additive and inert — four tables with no readers, one column
with a default that preserves today's meaning, three settings — and it redefines
no function and touches no balance, counter, pacing or capacity column.

⚠️ **`messaging_sequences_enabled` ships `false`**, like `messaging_enabled` did
and for a sharper reason: what it gates sends unattended messages from a real
person's own number to members of the public. `ANTHROPIC_API_KEY` must be set in
Vercel **and the project redeployed** — env vars are baked in at build time,
which is the trap §40's own verification section already records.

---

### 40.14 — The switches, and writing the message yourself *(0122)*

Two things that came out of using §40.13 for a day.

#### The switches had no UI at all

`messaging_sequences_enabled` ships `false`, and the only way to change it was
SQL against production. Every messaging setting was in the same state:
`messaging_enabled`, the email channel, quiet hours, the cross-operator
cooldown, the TimelinesAI ceiling and the two sequence limits. `/admin/api` had
had a proper kill switch since §27; messaging had nothing. **A kill switch
nobody can reach is not a kill switch.**

`/admin/messaging` now holds all nine, on `ApiKillSwitch`'s shape: switching OFF
confirms inline and names what stops, switching on does not, because restoring
service is not something anybody needs protecting from.

⚠️ **THE KEY COMES FROM AN ALLOW-LIST, NEVER FROM THE BODY.** `system_settings`
is one table that also holds `escalation_enabled`, `pool_enabled`,
`max_active_customers` and the pool clocks, so a route that upserts whatever it
is handed could stop lead allocation for the whole platform from the messaging
screen. §16 set the precedent for the capacity route — "a request can never name
a key the reader does not know" — and `adminSettings.ts` is the same rule with
more keys. A test asserts the list against a literal rather than deriving it
from the source (§27.2), and separately that six allocation keys are refused.

⚠️ **The quiet-hours pair is judged against what will be STORED**, not against
what happens to be in the request. An admin moving only the start must still be
checked against the end already in the database, or `start = 20` lands beside a
stored `end = 20` and the window never opens again — every manual send refused
and every scheduled step rescheduled for ever.

⚠️ **One real bug, caught by the test rather than by review:** `Number(true)` is
`1` and `Number(null)` is `0`, both finite integers, so a boolean posted against
a number field would have stored as `"1"` and a null as `"0"` — and a cooldown
of 0 disables the cross-operator guard entirely. The type check comes before the
coercion.

The live position sits beside the switches — connected numbers, active
sequences, leads mid-sequence, messages in review, 24h sent/replied/failed. A
switch with no reading next to it is a switch nobody dares press.

#### Hand-written steps

A step may be written by the operator instead of the model, with `{{fields}}`
filled in per lead so it still reads as being about that landlord.

⚠️ **PER STEP, NOT PER SEQUENCE**, which is why `mode` is on
`message_sequence_steps`. The useful ladder is mixed: let the model open, where
it has the property's own figures, then chase in the operator's own words. A
sequence-level flag would force two sequences, and a lead may only be in one
(0121's unique on `assignment_id`).

`src/lib/messaging/mergeFields.ts` is the whole of it, and pure.

⚠️ **THE CATALOGUE IS CLOSED AND EVERY FIELD HAS A NAMED RESOLVER.** Nothing
takes a column name from the browser and reads it — the §27.1 standing rule.
Without it `{{lead_profile}}` pastes the *uploading* operator's private working
notes into a message to the landlord on a resold imported lead (§32.8), and
`{{lead_quality_override_note}}` pastes an admin's private note. An unknown
field is a **save-time** error, never an empty string at send time.

Deliberately absent, each for its own reason: `lead_profile` (above); any fee or
percentage (the report's 15% is *Stayful's* — §26.1); `net_income` (net of that
fee, rendered nowhere by design); and `{{town}}`, because `extractCity()`
resolves on 173 of 446 addresses **and is wrong on the common shape** — "212
Gill Avenue, Bristol BS16 2PH" has its postcode-bearing last segment filtered
out and returns the street. A field that is confidently wrong is worse than one
that is missing.

#### ⚠️ What checking the live data changed, twice

**The design question is not substitution, it is absence** — and the first
reading of the numbers was wrong in a way that would have shipped bad copy.

Across the whole `leads` table the analysis figures fill on **39%**, which reads
as "a field to use with care". Split by product they fill on **90% of management
leads and on NOT ONE of 252 guaranteed rent leads** — §25's analysis is
management-only by design, and `IncomeProjection` used to refuse a GR lead
outright. So `{{income}}` on a GR sequence reaches **nobody at all**.

That is now a **refusal at save time**, not a warning: `productOnly:
"management"`, and the picker does not offer them on a GR sequence. A feature
that silently sends nothing reads as broken rather than as a rule.

The same pass found a second one. `firstNameOf` asks only for 2–40 characters
containing a letter, which `natalyanaq@gmail.com` and `Dbncc` — both real
`lead_name` values — satisfy. That is a fair rule where it lives, because
`draftContext` hands the name to a **model**, which is not going to paste an
email address into a greeting; substitution has no such judgement. §36.3's
`isJunkName` is asked first. **Reusing it rather than writing a second name rule
is the point** — and §36.3 carries the measurement (87 of 437 leads are a lone
first name) that keeps it neither too strict nor too loose.

`cleanAddress` and `cleanBedrooms` exist for the same reason. The column holds
`"4+ bed"`, `"1 Bed"`, `"2 bedrooms"`, `"3/4 bedrooms"`, `"E bedrooms"` and, on
two live rows, a whole sentence somebody typed into it — so `"your {{bedrooms}}
property"` would read `"your 2 bedrooms property"` untouched. Every shape in the
test file is a real value from the book.

#### The reach line

`POST /api/customer/messaging/sequences/preview` returns, over that customer's
own workable leads of that product: how many the template reaches, which fields
account for the rest, and a **sample rendered against one of their real leads**.

⚠️ **This is the most valuable thing in the feature and the reason "skip the
lead" is a safe answer.** Without it an operator types `{{income}}`, saves, and
loses a tenth of their sends — or all of them on GR — finding out weeks later if
at all. Shown while the wording can still be changed, it is the number that
changes the decision: the same discipline as §28's filter forecast and §40.13's
"state how long the backlog will take".

#### Rendering, and the two refusals

⚠️ **A manual step is still drafted the night before, not rendered at send
time.** It costs nothing and needs no model, so rendering later would be
tempting — and it would take the message out of the **review queue**, which is
the consent the whole design rests on (§40.13). Drafting it now also means the
operator reads the resolved text, with the real name in it, rather than their
own template.

⚠️ **`renderTemplate` NEVER RENDERS A GAP.** `"Hi , about your place at ?"` —
sent from a real person's number to a member of the public — is what a missing
value would otherwise produce. A lead missing a field is skipped, recorded as
`skip_reason = 'missing_field:income'`, and the run **advances** rather than
stopping, because the next step may not need what this one did.

⚠️ **A typed URL is refused, and `{{booking_link}}` offered instead.** Links are
the strongest single spam signal in a cold WhatsApp and the number at risk is
the operator's, so one stored, `https`-checked link inserted by name is safe
where forty pasted ones are not. `customers.messaging_booking_link` holds it, on
`customers` rather than the connection row because `getCurrentCustomer()` reads
that table with `select("*")` — no join, no RLS work, the way `presentation_brand`
was done (§37).

⚠️ **It does NOT apply `validateDraft`'s model rules.** Those exist because a
*model* might invent a figure or stray into pricing; an operator quoting their
own fee in their own words is their business. What survives are the two rules
that are about the operator's own number at scale: no raw links, and 480
characters.

A manual step makes **no model call and no `message_draft_requests` row** —
that table is the model's ledger and its rate limits are about model spend — so
`draft_id` stays null and `sendOneMessage` records `generated_by: 'human'`.
`template_key` / `variant_key` already carry the sequence and step, so "did
hand-written or AI convert better" is a join rather than a migration.

⚠️ **The drafting cron's missing-key check stopped being an early return.** A
hand-written ladder needs no model, so an absent `ANTHROPIC_API_KEY` must skip
the AI steps and let the manual ones through — otherwise one env var silently
freezes every sequence in the business, including the ones that never needed a
model.

### Verification

0122 applied twice to a scratch Postgres, with seven assertions: an AI step
needing no template (which is what keeps the migration inert), a manual step
with none refused, whitespace refused, an unknown mode refused, and — the one
worth keeping — that switching a step from manual to AI **keeps** what the
operator wrote, so the round trip does not destroy their words.

**47 cases on the merge engine**, including the closed catalogue refusing nine
column names an operator might guess at, the seven real address shapes, the real
bedrooms junk, the email-as-a-name, and the GR refusal in both directions.

A mixed-ladder rehearsal on scratch: one AI step and two manual ones, a lead
with figures and a lead without, sequences **off** — asserting that only the
RESOLVED message reaches the send queue (`body` containing `{{` fails the test),
and that the skipped lead is recorded with the field that was missing.

**847 vitest cases green**, lint clean, `next build` passes.

**Not yet exercised:** a hand-written step against a real TimelinesAI workspace.
Send one to yourself before enabling it for anybody.

### Deployment order — migration BEFORE code

0122 first. Additive, and every default preserves today's behaviour: `mode`
defaults to `'ai'`, so a step written before it applies keeps behaving exactly
as it does. The admin page needs no migration at all and shipped ahead of it.

### 40.15 — Sending with no connection at all: the wa.me hand-off *(0123, 0124)*

§40.1 put the WhatsApp connection in the customer's hands deliberately. The bill
for that decision is visible in production: **one of twenty-one active customers
has a connected workspace.** For the other twenty, "Send WhatsApp" opened a modal
that said *a TimelinesAI account (from $25 a month), one token pasted, roughly
five minutes* — and then offered Cancel or Begin setup. Nothing was ever sent.

The engagement table says the same thing from the other side. Across the whole
book: **612 `detail_opened`, 10 `tel_click`, 2 `mailto_click`, 3 `message_sent`.**
Operators open a lead sixty times for every time they act on one.

So this adds a third way out of that modal. Compose the message here — the
existing **Generate a draft** works, because that route never required a
connection — then hand it to the operator's own WhatsApp through a `wa.me` deep
link. The link carries who to message and what to say and nothing else, so their
app opens with the text in the box and pressing send sends from **their** number.
No account, no token, no fee, nothing to configure, and Stayful's number never
appears in the conversation.

It is the floor, not a replacement. The connected path keeps replies, delivery
status, sequences and mass messaging; the modal says so in those words, and
**Begin setup stays the primary action** until the operator explicitly chooses the
hand-off, at which point the two swap emphasis rather than the upsell vanishing.

#### ⚠️ A tap is a click, not a send

The link leaves the browser and nothing comes back — no provider id, no receipt,
no reply. So it is **not** `message_sent`, and it writes **no `lead_messages`
row**: every status in that table is a delivery claim, and one we cannot observe
would corrupt the thread view, the poller and the reporting joins.

0117 already settled the shape of this argument — *"a customer able to POST it
could shield every lead they hold"* — and the honest precedent is already in
`CLIENT_LEAD_EVENT_TYPES`. `tel_click` is an attempt to ring, not proof of a
call; a `wa.me` tap is the same kind of fact. Hence `whatsapp_click`, weighted
**0.50**, reported through `POST /api/customer/events` like the other two.

That route is also why **no new endpoint exists for this**. It is already the
only way to write `lead_events`, and it already carries the ownership 404, the
60-second dedupe and the 600/hour cap — so a double-tap costs nothing.

On the weight: the obvious reading is 0.30, because `mailto_click` sits there
precisely for opening a client "with no guarantee anything was sent", and on that
test a hand-off is identical. It is 0.50 because of what it now **does**: it flips
the assignment to contacted, and both signals already trusted to do that are
≥ 0.50. A signal that marks a lead contacted while scoring below one that does
not would make that table disagree with itself.

#### ⚠️ Two limits it escapes, and one of them matters

Every send limit counts rows in `lead_messages`, so a hand-off is invisible to
all four. Quiet hours is the harmless half — the advisory notice is shown and
nothing blocks.

The **8-hour cross-operator cooldown** is the real cost: two operators holding
the same landlord can now both message them the same day, which is exactly what
§40.12 exists to prevent. Accepted deliberately. The alternative is letting a
click feed the cooldown, and then one operator can block another for eight hours
by tapping and never sending — including by accident, by opening the draft and
changing their mind — while §19.7 forbids the block explaining itself, so the
blocked operator would see a refusal for something that never happened. Stated
here rather than discovered later; it is also an honest reason to connect.

#### ⚠️ A click is contact, and that has three consequences

`whatsapp_click` joins the `lead_events_mark_contacted` trigger, and 0124 puts it
in every list that asks "has this operator done anything with this lead". So one
tap:

- flips the assignment to `contacted`, which makes it **undiscardable** — discard
  requires `status = 'new'`. 0118 recorded the same consequence for
  `message_sent`, and §5E records it as unresolved for `tel_click`;
- takes it out of **`get_reclaim_candidates`**, so it is no longer taken back;
- counts it as **worked** and resets the customer's `quiet_days`.

One tap per lead is therefore enough to make a whole book look worked. That is
the accepted price of treating a tap as contact, and the 0.50/0.60 gap to
`message_sent` is what still separates it from a message with a provider id.

#### ⚠️ TWELVE functions hard-code the event list, not the four §40.7 describes

§40.7 says a new engagement signal needs adding in four places. That is true of
`get_assignment_engagement_scores` alone and was read as the whole job. An audit
of `pg_get_functiondef` on production found **27 mentions of `tel_click` across
12 functions**: `get_assignment_engagement_scores` (7),
`capture_engagement_snapshots` (4), `get_engagement_benchmarks` (3),
`get_customer_risk`, `get_customer_scoreboard`, `get_paused_customer_facts`,
`get_service_capacity` (2 each), and `get_customer_engagement_scores`,
`get_lead_outcome_report`, `get_outcome_evidence`, `get_reclaim_candidates`,
`lead_last_activity_at` (1 each).

Two idioms run through them and the new signal belongs to both:
`('detail_opened', 'tel_click', 'mailto_click')` is ANY activity;
`('tel_click', 'mailto_click')` is a real CONTACT ATTEMPT.

**The bodies in 0124 are production's, not the original migrations'.**
`supabase/schema.sql` is stale (§459) and several had been revised in place, so
each was taken from `pg_get_functiondef` and re-stated with the token added —
which also makes the migration chain converge on what production actually runs.

#### ⚠️ No backfill, and the step it leaves in the charts

The signal counts from deployment forward only. No historical `lead_events` row
is invented and no `customer_engagement_snapshots` row is rewritten, so nobody's
score, risk band or reclaim status changes retroactively.

The cost is a discontinuity on the deployment date: assignments after it can
carry a signal earlier ones could not, so `worked_rate`, `contact_rate` and the
benchmark series step upward for a reason that is not a change in operator
behaviour. Do not read that step as one.

### Verification

`normaliseUkMobile` (§36) is the normaliser, **not** `toE164` — the latter is the
loose 0070 identity rule, and §40.9A records what happened last time the send
path used the wrong one. Ported into SQL and run over all 449 live leads:
**410 UK mobiles + 22 foreign = 432 (96.2%) produce a working link**; 17 do not
(11 landlines, 4 missing, 2 placeholders). Of the 188 currently held, **183
(97.3%)**. The ~20% of rows stored as `+44` followed by a national trunk zero are
the case that would silently have produced dead links; `leadQuality.ts:131` is
the line that saves them, and there is a test named for it.

**24 cases on the hand-off module**, built from the shapes the database actually
holds rather than invented ones, plus the encoding half — line breaks, an
ampersand that would otherwise truncate the message, apostrophes, accents and
emoji all surviving the round trip — and the ceiling refusing rather than
truncating, because half a sentence sent from the operator's own number is worse
than a refusal. **871 vitest cases green**, lint clean, `next build` passes.

Every one of the 12 rewritten bodies was verified byte-for-byte against
production before the migration was considered done: ten hash-identical to
`pg_get_functiondef` with the token inserted, `get_engagement_benchmarks`
differing only by the stale comment corrected in it, and
`get_assignment_engagement_scores` reducing exactly to the original when its four
structural additions are stripped.

0123 and 0124 were rehearsed inside a transaction on production and rolled back,
including calling the rewritten scorer against 50 real assignments — the
constraint, weight row, trigger and function were all confirmed absent
afterwards. **Supabase branching needs the Pro plan and this project is on Free**,
which is why the rehearsal was transactional rather than on a branch.

The deep link was then confirmed on a real handset: WhatsApp opens with the whole
message intact and it arrives from the operator's own number, not Stayful's.

**Not yet exercised:** the three consequences above observed on live data rather
than reasoned from the SQL — a clicked lead losing its discard button, dropping
out of `get_reclaim_candidates`, and resetting `quiet_days`.

**Applied to production on 2026-08-29**, migrations before code, and both were
verified against the live database rather than assumed:

- **All 12 function bodies hash-match the repo file**, `get_engagement_benchmarks`
  included — its stale comment is corrected in a separate statement, because the
  token transform by construction inserts tokens and cannot rewrite prose.
- **Behaviour is unchanged**, which is the check that matters: with zero
  `whatsapp_click` rows in the table, `get_reclaim_candidates` (71),
  `get_service_capacity`, `get_customer_risk` (18), `get_customer_scoreboard`
  (36), `get_lead_outcome_report` (14) and `get_paused_customer_facts` (4) all
  return output byte-identical to the baseline captured immediately beforehand.
  A hash check proves the bodies were transcribed correctly; only this proves the
  token went in the right PLACES.
- Row counts untouched: 449 leads, 383 assignments, 797 events, 40 customers.

**2026-08-29 is therefore the date to read the step from** in `worked_rate`,
`contact_rate` and the benchmark series.

⚠️ **And there is now a THIRD step in that series.** §42 puts contact buttons
back on the pipeline card, reversing 0079, so actions that were always happening
in the list finally get recorded. Read both dates as definition changes, not as
operators improving. Assignments after it can carry a signal
earlier ones could not; that is a definition change, not a change in operator
behaviour.

### Deployment order — migrations BEFORE code, and 0123 BEFORE 0124

0123 first, and it is inert on its own: it adds the event type, the weight and
the trigger arm, but nothing emits the event until the UI ships. 0124 is the half
that changes behaviour — reclaim eligibility and engagement scoring — and is
split out for exactly that reason. Code last.

### 40.16 — The Resend receiver that was never written *(no migration)*

Resend disabled our webhook on 29 Aug 2026, having failed to deliver to it since
07:09 UTC that morning. **The endpoint had never existed.**

`POST /api/customer/messaging/email-domain` has registered one since phase 1 —
nine event types, pointed at `${APP_URL}/api/webhook/resend/<token>` — and
`src/app/api/webhook/` contained only `n8n/`, `stripe/` and `timelines/[token]/`.
Every delivery got a 404, Resend retried, and then it stopped trying and emailed
us.

⚠️ **THIS IS THE SAME BUG AS §40.8, ONE VENDOR OVER.** That section already
records it in terms: *"this route was registered in phase 1 and did not exist…
the live workspace was POSTing to a 404 for a day."* The TimelinesAI half was
found and fixed in phase 2. The Resend half was not — because §40.4 hides the
email channel behind `messaging_email_enabled = false`, so the only account that
could reach the connect flow was an admin using the §40.3 bypass, and nothing
ever exercised it. **A feature switched off is a feature nothing tests.**

The trigger was one real connection: `leads.stayful.co.uk`, connected
2026-08-28 13:17 UTC on the Stayful admin row, `status = 'verifying'` — the DNS
was never completed, so nothing was ever going to flow through it anyway. Live
sending was unaffected throughout: Stayful's own transactional mail (§15) goes
through `RESEND_API_KEY` and never touches a webhook, and a disabled webhook
stops event delivery, not sending.

#### The four layers, and why two of them differ from TimelinesAI

| | |
|---|---|
| 1 | An unguessable token in the PATH identifies the customer. One 404 for every refusal, so it cannot enumerate customers or tokens |
| 2 | ⚠️ **The Svix signature**, against that customer's own signing secret |
| 3 | Claim by INSERT on the svix id — the `stripe_events` discipline |
| 4 | Match-or-discard, scoped to the customer, in `ingestResendEvent` |

⚠️ **LAYER 2 IS A REAL AUTHENTICATION BOUNDARY, AND THE TWO RECEIVERS MUST NOT
BE HARMONISED.** TimelinesAI cannot sign anything — its own spec says so — so
that route treats every payload as an unverified assertion and reads the message
back from the API before believing a word of it. Resend signs, so a verified
payload **is** evidence and there is no read-back here. Do not add one to make
the pair look alike, and do not remove the one over there.

That difference propagates to failure handling. A deferred outcome here
**deletes the claim and returns 500**, so the vendor's own retry actually runs.
0119 had to build a recovery pass because TimelinesAI retries twice within
seconds, which is no use to a read-back that just timed out; Svix retries out to
ten hours, and our claim is the only thing in the way — leave it and every retry
short-circuits on 23505 and does nothing.

#### ⚠️ The 5-minute tolerance every Svix library ships with would re-break this

Svix re-sends the **original** signed payload with its **original**
`svix-timestamp` on every retry. A five-minute window therefore rejects every
retry past the first few — and rejects them as forgeries — which is precisely
the 4xx loop that got the endpoint disabled. `svixSignature.ts` uses 48 hours and
says why: the HMAC is what makes a request trustworthy, the window only bounds
replay, and the claim-by-INSERT already makes a replay a no-op.

No `svix` dependency: the algorithm is thirty lines of `node:crypto`, and the
repo already hand-rolls HMAC in `threadAddress.ts`.

#### It does not gate on `messaging_email_enabled`

That switch governs **sending**. Refusing events while it is off would discard
delivery state for mail already sent, and would put the endpoint straight back
into the loop that got it disabled. A receiver that only works while the feature
is on is a receiver that gets disabled every time it is turned off.

It **fails closed** on the signature, though: no stored secret, an unreadable
one, or a bad signature is a 401 and nothing is written. A forged delivery event
can mark a message the landlord never received as delivered.

#### Status events

`email.sent/delivered/delivery_delayed/opened/clicked/bounced/complained/failed`
match `data.email_id` against `lead_messages`, and the lookup is **scoped by
`customer_id`** — that id is the one identifier arriving from outside, and 0116
calls the leading `customer_id` in every key "the containment guarantee".

- ⚠️ **`opened` and `clicked` do NOT move the status.** 0116 already says an open
  is never a fact: Apple Mail Privacy Protection loads the pixel
  unconditionally, so a prefetch and a human are indistinguishable. They stamp
  `first_opened_at` / `first_clicked_at` and write an event row. `delivery_delayed`
  moves nothing either — the message is still in flight.
- Statuses are **ranked**, never last-wins, the §40.9 rule. ⚠️ **The failure
  states rank ABOVE `delivered`**: an asynchronous bounce after a delivery notice
  is real, and it is the fact the operator needs.
- An **unranked** current status is left alone, so a stray event cannot rewrite
  an inbound `received` row into the outbound vocabulary.
- Stamps are first-observation-wins (§6). Event rows are not — an open is a
  repeatable act and each one is its own row (0116).

#### `email.received`

⚠️ **Resend publishes no payload for this event.** Every accessor in
`resendEvents.ts` therefore reads several plausible locations, and the route
stores the payload on **every** event — the first real landlord reply is the only
specification of it we will ever get. §40.8 is why: `chat.jid` was read from the
TimelinesAI docs, is not actually sent, and silently discarded twenty events.

Correlation is two routes, in order:

1. **The reply-address token** (`threadAddress.ts`) — our own HMAC, and the
   primary route because it survives the landlord replying from a different
   address, forwarding, or a client that strips threading headers. The thread
   lookup is scoped to the customer who owns the receiving domain, and the MAC
   is re-checked on top.
2. **An EXISTING thread with that sender.** ⚠️ **It may find, never create.** A
   `From` header is trivially forged, so this must not be able to bring a thread
   or a lead binding into existence — it only files a reply into a conversation
   this customer demonstrably already has, which is the case it exists for: a
   landlord replying to the plain `hello@` address.

Anything else is dropped and logged. Mail arriving at a public address that
correlates to nothing is somebody else's — a bounce notice, a newsletter, a
stranger — and storing it would put it in front of an operator inside a landlord
CRM.

- `to_address` holds the **counterparty**, not the envelope recipient. 0116 is
  explicit, and the WhatsApp path already stores the landlord's number in
  `to_phone` on an inbound row.
- ⚠️ **The landlord answered, so the sequence stops** (§40.13) — outside the
  `alreadyHad` guard, exactly as on the WhatsApp side: stopping a run twice is a
  no-op, where missing a reply leaves a ladder running at somebody who has
  already answered. Still **not** an engagement event (§40.7): a reply is the
  landlord's act and must never shield an ignored lead from escalation.
- ⚠️ **`body_fetch_pending` is set when no body arrived and NOTHING DRAINS IT.**
  The message, its thread and the sequence stop are all correct regardless, so
  the operator still sees that the landlord replied. Draining it needs an
  inbound-body endpoint confirmed against the real wire, which is work for when
  real inbound mail exists.

### Verification

`npm run test` — **1141 cases**, 42 of them added here, all pure units so they
stay inside the suite that gates `next build` (§36.8: `vercel.json`'s
`buildCommand` runs it). Counted on the merged tree rather than incremented from
a figure taken before §41 and §42 landed — §40.13 records what incrementing that
number instead of counting it cost last time.
`npm run lint` clean, `npx tsc --noEmit` clean, `npm run build` passes and
registers `ƒ /api/webhook/resend/[token]`.

The signature cases sign with an **independent** implementation written from the
Svix spec rather than by calling the module under test — signing with the
function we verify with would pass however wrong both halves were, the reason
§27.2 duplicates its expected field list instead of deriving it. Among them: a
body altered by one byte, another customer's secret, a signature bound to a
different svix id, a non-v1 version not being accepted under v1 rules, and **the
six-hour retry that a stock five-minute tolerance would reject**.

The ingest cases are driven through a fake that matches on **every** filter it is
given — a fake that ignored `customer_id` would pass the containment cases while
the real thing leaked one customer's events into another's messages. Both
containment cases are pinned: a status event for another customer's `email_id`,
and a reply-token belonging to another customer's thread.

⚠️ **One case was written wrong and the failure was the useful part.** "Refuses a
forged token" PASSED at first, because the sender fallback found that landlord's
existing thread and stored the reply anyway — correctly, but with the MAC check
contributing nothing to the outcome. It now uses an unknown sender, so the token
is the only route in, and a second case asserts the other half: a **valid** token
from an unexpected sender IS accepted, which is the whole reason
`threadAddress.ts` makes the token primary over the headers.

**Not yet exercised against real traffic.** No event has ever reached this route
— the domain is `verifying` and the channel is off — so the signature has not
been checked against a genuine Resend delivery, and `email.received` has been
built against a payload nobody has published. Send one test event from the Resend
dashboard after re-enabling, and read `message_webhook_events.payload` before
trusting the inbound half.

### Deployment order — code, THEN re-enable

No migration: 0115–0117 already carry every column this uses, including
`body_fetch_pending`, which was added for exactly this and had no writer.

Deploy first, then **re-enable the endpoint in the Resend dashboard** — it stays
disabled until somebody does, and re-enabling it before the code is live simply
starts the 404 loop again. Then send a test event and confirm a `message_webhook_events`
row appears. If the stored signing secret has drifted from the webhook's, every
delivery 401s and Resend disables it again: that is the intended failure, and the
repair is to delete the webhook and reconnect the domain so a fresh secret is
stored.

---

## 41. Introducing the operator to the landlord *(0126)*

When a lead is allocated, Stayful emails the **landlord** introducing the
operator who has just been given their enquiry — name, company, phone, email,
and the operator's own words about themselves. The first introduction for a lead
also asks three questions behind a link, and the answers land on the lead where
every operator holding it reads the same copy.

**It was already sold before it existed.** `src/app/page.tsx` carries a mock of
this email under the badge *"Your key differentiator"* and asserts "Before any
assignment fires, the landlord gets a Stayful email introducing you. They've
consented. They're expecting your call." `/policies/lead-quality-and-data` tells
customers the same, and the privacy policy makes it the **lawful basis** for the
whole referral (§5.1), states details are shared "only after the referral email
described in section 5.1 has been sent" (§6), and names Resend as its processor.
None of it existed. This is the implementation of a promise already published.

`completeAssignment()` → `sendLandlordReferral()` · `/p/[token]` ·
`POST /api/public/lead-preferences` · Phase 4 of `poll-whatsapp-status`.

**Live since 2026-09-01 11:01 UTC**: 20 introductions to 20 landlords in about
48 seconds, zero failures.

### 41.1 — ⚠️ FORWARD-ONLY, and structurally so

The only call site is `completeAssignment()`, which runs when a lead is
allocated. **Nothing walks existing leads and nothing may ever be added that
does** — a landlord who enquired in July must not be written to because a
feature shipped in August. Both `0126`'s header and `landlordReferral.ts`'s say
this in terms.

The one thing that later came close is §41.4's reminder sweep, and what makes it
admissible is a cutoff row rather than an exception.

### 41.2 — The answers live on the LEAD, and that is the fairness property

`landlord_contact_method` ∈ `whatsapp | email | phone`, `landlord_contact_time`,
`landlord_wants text[]`, `landlord_note`, `landlord_prefs_step`.

On **`leads`**, never on `lead_assignments`. There is exactly one copy, so two
operators cannot hold different answers and one cannot have them while another
does not. 0014's `leads_select_assigned` grants a holder the whole `leads` row
and is evaluated **at read time**, so an operator assigned next month sees them
the moment they are assigned — no backfill, no copying forward, nothing to keep
in step.

**They must never be added to `viewerScopedLead()`'s strip list.** Sharing them
is the point.

⚠️ **One consequence worth knowing.** A landlord answers "WhatsApp, Tuesday
morning" with **one** named operator in mind. Shared with three, it routes all
three onto the same channel in the same window. §40.12's cross-operator cooldown
absorbs that for §40 messaging and **nothing covers phone calls**, which is why
`describeAnswers()` renders it as *"Asked to be contacted by WhatsApp"* rather
than as an instruction.

### 41.3 — Asked once, and the race that makes it true

`claim_landlord_referral()` takes the **lead row lock**, claims the assignment,
and only then decides whether this introduction carries the questions. Exactly
one operator per lead is told to ask, however many are assigned at the same
instant — and they can be: `autoAssignLead` places to up to three operators in
one sequential pass, and bulk assign runs `completeAssignment` at
`NOTIFY_CONCURRENCY = 8`.

Claim by write, then act — the `credit_invoice()` discipline (§19.5).

**`claimed_at` and `sent_at` are separate columns on purpose.** The claim is
written BEFORE the send, so a single stamp would later tell an operator "the
landlord was told about you" about an email that 429'd. The lead page keys on
`sent_at`.

**The failure rule differs by failure type, and getting it backwards is a real
bug.** Retryable (429, timeout, 5xx) **keeps** both stamps and schedules a
retry — releasing would let the *next* operator's referral ask the same
questions again. Permanent (a rejected address) releases, so the next
introduction carries them instead.

### 41.4 — Chasing a landlord who never answered *(0129)*

`landlord_referral_first_sent_at` is stamped at **claim** time, so the questions
counted as asked whether or not anyone read them — and every later operator's
introduction came through with `ask_questions = false`. A landlord who received
the email and ignored it, or who answered card 1 and closed the tab, was never
chased by anything. Phase 4 only ever sees introductions **Resend never
accepted**, so it cannot see them either.

⚠️ **Since §42 that gap has a price.** `firstAttemptChannel()` uses
`landlord_contact_method` to pick attempt 1 of the five-attempt contact plan,
and says so: absence "leaves the default cold call in place".

Two mechanisms, complementary:

| | |
|---|---|
| **A — re-ask on the next allocation** | `claim_landlord_referral`'s rule widens from "nobody has been asked" to "nobody has **answered**, under the cap (3), and last asked over `landlord_prefs_reask_days` ago". Rides an allocation that was happening anyway |
| **B — the reminder sweep** | Phase 5 of `poll-whatsapp-status`. Two emails, 48h and 72h after a **delivered** introduction, then it stops |

⚠️ **UNANSWERED IS TESTED ON THE SPINE, NEVER ON `landlord_prefs_submitted_at`.**
That column is stamped by *any* single answer, so gating on it would abandon
exactly the partial-answer case both mechanisms exist for.

⚠️ **THE RE-ASK FLOOR IS LOAD-BEARING.** Without a time floor, one
`autoAssignLead` fan-out sends three emails all carrying the same questions —
the exact failure the once-only design prevents. 7 days blocks a same-day
fan-out and admits the day-10 escalation.

⚠️ **`release_landlord_referral` gives the ASK back too**, not just the
first-flag. Otherwise a bounced address burns one of three asks and silences the
lead for a week over an email that never went.

#### Stop conditions, and the one that is a product decision

Spine complete · **any assignment has `first_contacted_at`** · any assignment
`won`/`rejected` · lead closed · not referable · over the cap · **no assignment
with `landlord_referral_sent_at`**.

The `first_contacted_at` stop is Zac's call: once the operator has rung, the
warm-up happened live and asking how they would like to be contacted reads as
noise. Its cost is that with contact plans on, attempt 1 lands fast, so the
reminder's real population becomes **leads whose operator did nothing for two
days** — a different set from "everyone who did not answer", and one to watch in
the admin figures rather than assume.

The delivery anchor is the sharp one: `first_sent_at` is stamped at claim and
does not prove delivery, so anchoring there would chase somebody about an email
they never got — and it is also what keeps a lead in Phase 4's retry queue out
of Phase 5 with no coordination between them.

#### ⚠️ The due list is a FUNCTION because PostgREST cannot ask the question

The conditions span **sibling assignments** — some assignment delivered, **none**
contacted — and a PostgREST filter on a to-many embedded resource matches ANY
row, never "none of them". §27.8 records what the near-miss costs: a 200 that
paginates normally and is wrong. Here it would chase landlords whose operator had
already rung them. `get_due_landlord_nudges()` answers it set-wise.

#### ⚠️ The reminder is NOT an operator approach

0127's `landlord_approach_ok` caps approaches to one landlord at 1/day and
3/week, counting `tel_click`, `whatsapp_click`, `mailto_click` and
`message_sent`. Its own header states the rule: *"our own reminders and the
landlord's own reply are not approaches by anybody."* So nothing in §41.4 calls
that function or writes an event in its counted set. A Stayful email about who is
going to ring must not eat an operator's ration of actual contact.

#### The forward-only guard, and why a global cutoff is safe here

`landlord_nudge_from`, seeded to the apply instant and compared against
`landlord_referral_first_sent_at`. §32.4 rejected a global cutoff as "one bad
read from enrolling the entire back catalogue" — answered here the way 0128
answers it: the read **fails closed**, and the shape check happens before the
cast so a malformed value yields NULL rather than raising.

⚠️ **It excluded the first real cohort.** 0129 applied at **12:14:51Z on
2026-09-01**, and the 20 landlords introduced at 11:01 that morning fall before
it — so they are never chased. That is the safe reading and not obviously the
right one; moving the row back to just before `2026-09-01T11:00:00Z` enrols
them, and it is one UPDATE.

#### The two release rules point opposite ways, deliberately

`release_landlord_referral` **keeps** a claim on a retryable failure because
another sender exists and releasing would ask the landlord twice.
`release_landlord_nudge` **releases** one, because there is no other sender and
releasing just means "try again next run" — bounded by the 48h/72h windows
themselves.

⚠️ **The second reminder needs a minimum 12-hour gap since the first**, on top of
the 72h test. Both windows measure from delivery, so a first reminder held back
by quiet hours can land at 71h — and the 72h test alone would then send the
second an hour later.

### 41.5 — Where the switches are

Four settings on `/admin/messaging`'s existing allow-list, following §42's
precedent of one closed list rather than a second:
`landlord_referral_nudge_enabled` (ships **false**, separate from
`landlord_referral_enabled` so introductions can run while reminders do not),
the two hour settings, and the re-ask floor — whose **minimum is 1, never 0**,
because zero removes the fan-out guarantee.

`landlord_nudge_from` deliberately stays out of that list: it is a date set once
at go-live, 0128's position for `contact_notify_from`. Moving it is a SQL edit.

The referral's own switch and its test send keep their bespoke route
(`/api/admin/settings/landlord-referral`), which predates §42's consolidation.

### Verification

All 123 migrations to a scratch Postgres 16 from empty, 0129 re-applied twice;
every CHECK on its boundaries; all three new functions `service_role`-only and
invariant 7's four still `authenticated`-executable. **Eight concurrent claimers
on one lead returned exactly one `ask_questions = true`.** The due list returned
exactly the two intended leads out of eleven seeded cases, and dropped a lead the
moment a **sibling** assignment was contacted — the case the RPC exists for.

36 unit cases, mutation-checked: letting the figure through on a GR lead,
repeating it on the second reminder, dropping `esc()` from the operator line, and
asking a landlord who has already answered each fail exactly one test and no
others.

Applied to production before the code. Post-apply: 456 leads, 407 assignments and
40 customers untouched, `ask_count` zero on every row, **nothing due**, and no new
Supabase advisory.

### Deployment order — migration BEFORE code

0126, then 0129. Both are additive and inert: every default reproduces the
behaviour before it, and both switches ship false. Nothing here touches a
balance, counter, pacing or capacity column.

### 41.6 — The details in that email, editable by the customer *(0131)*

The referral renders a details table — Who, Company, Phone, Email — straight off
the account row (`landlordReferral.ts:148-152`), and `operatorLabel()` puts the
company in the subject line and both intro sentences. §41.5's card let a customer
edit exactly one thing in that email, the blurb. A customer whose company had been
renamed, or who wanted enquiries arriving somewhere other than their login inbox,
could change none of the rest.

Four columns now sit beside `operator_intro`: `referral_contact_name`,
`referral_business_name`, `referral_phone`, `referral_email`.

#### ⚠️ OVERRIDES, NOT COPIES — which is the whole design

Each is **nullable, and NULL means "use my account details"**. The obvious way to
build this is to copy the four fields and let the customer edit the copies, which
gives two sources of truth that drift the moment one is edited and the other is
not. Nullable-with-fallback means a customer who has set nothing still has exactly
ONE value; a difference exists only where somebody chose one on purpose, and
`/admin/customers/[id]` prints a "Landlords see:" line whenever they have.

It is also what makes the migration inert: all 44 live rows arrive null, so the
email renders byte-identically the day it applies. That is asserted directly —
`buildReferralCopy` through the resolver against `buildReferralCopy` on the raw
row, compared as **rendered HTML**, not as a field-by-field guess.

#### ⚠️ NONE OF IT REACHES THE ACCOUNT, and that is why it is safe

The four account columns underneath are among the most load-bearing in the
schema, which is what ruled out simply making them editable:

- `email` is the **login** and the Stripe billing address. §43.3: move it without
  Stripe and the next unmatched invoice sends `provisionPaidSubscriber` down its
  `.eq("email", …)` fallback, which **creates a duplicate customer row and a
  second auth user**. Changing a login stays an admin action, deliberately.
- `business_name` / `contact_name` are Monday matcher **tier 3** — the only tier
  that resolves two of eighteen live customers (`mondayStatus.ts:450-454`).
- `phone` is where the operator's own SMS alerts go.

`referral_email` is correspondingly **not unique and never normalised into a
lookup**: two operators in one office may publish the same `enquiries@` inbox.

#### One resolver, and the four selects that would otherwise drift

`resolveReferralOperator()` returns the existing `ReferralOperator` shape, so
`buildReferralCopy`, `operatorLabel` and the nudge's `operatorLine` are unchanged
— they receive resolved values instead of raw ones. A second, override-aware path
through the copy builder is how the subject line and the details table would
eventually disagree about who the operator is.

⚠️ **`REFERRAL_OPERATOR_COLUMNS` exists because the operator is selected FOUR
times**: `landlordReferralSend` reads it on the send path **and again forty lines
later on the retry path**, and `landlordNudgeSend` and the admin test route read
it once each. Changing one and missing another means a *retried* referral silently
reverts to the account details — invisible until a landlord is looking at the
wrong phone number.

#### It also moves the drafted WhatsApps

`{{my_name}}` / `{{my_company}}` and the `OPERATOR:` line in the draft prompt are
landlord-facing too, so they resolve through `resolveOperatorNames`. Left on the
account columns, an operator who set a public company name would introduce
themselves to the **same landlord** under one name by email and a different one by
WhatsApp, which is worse than either name alone. Only the names: the drafter is
never given a phone or an email.

**Deliberately unchanged:** Stripe, the Monday matcher, admin tables, MRR, exports,
the public API `/account`, and every transactional email to the customer.

#### The preview is what makes the fallback legible

An empty box meaning "fall back" is invisible in a form full of empty boxes, so
each field is placeheld with the account value and
`POST /api/customer/settings/referral-details/preview` renders the resolved rows
live. It builds them through `buildReferralCopy` rather than reassembling them —
a preview with its own idea of which rows appear would eventually disagree with
the email. A route rather than a client render because `landlordReferral.ts` pulls
`esc` from `emails.ts`, which constructs a Resend client.

The card also says, in words, that changing these does **not** change the address
they log in with or where invoices go — the one thing a customer cannot work out
from the form and would otherwise assume.

#### Verification

All 123 migrations to a scratch Postgres 16 from empty (0002/0014/0065 skipped —
`pg_cron` is unavailable locally), 0131 applied twice for idempotency. Eight CHECK
assertions including **the floor of 1**: an empty string and a whitespace-only
value are both refused, because `buildReferralCopy` pushes a row for any truthy
value and `"Phone:"` with nothing beside it would go to a member of the public.
Two customers sharing one `referral_email` confirmed allowed.

23 unit cases, **mutation-checked**: swapping the `??` order so the account wins
fails 2 tests, and treating whitespace as a real value fails 1. 1201 vitest cases
green overall, lint clean, `next build` passes.

Applied to production before the code. Post-apply: 4 columns, 4 CHECKs, **0
customers with any override** — so the email is unchanged for all 44 — and 44
customers, 471 leads, 449 assignments, 63 sent referrals and 1 operator_intro all
untouched.

⚠️ **0131 also drops four `lead_intro_*` columns and a `lead_intro_sends` table.**
A parallel session shipped §41 while another was part-way through building the
same feature under that name; the loser's migration reached production before the
collision was noticed and its code never did. Re-verified empty immediately before
the drop: 0 rows, 0 customers with any value, no `system_settings` row, nothing in
`src/`. Left in place they were exactly the drift §11 warns about. **The lesson is
§43's, one turn later: a free migration number is only free at the moment you
look, and so is an unbuilt feature.**

#### Deployment order — migration BEFORE code

0131 first. The additive half is inert (all-null columns, no reader until the code
ships); the drop half removes only objects nothing references.

---
## 42. The contact strategy, and a plan per lead *(0127)*

Customers say the leads are poor. The database says the leads are barely
touched: **342 of 356 open assignments (96%) have never had a single contact
action**, the most any lead has ever had is **4**, and the median gap between an
operator's first touch and their last is **0.0 days** — 97 of 121 gave up the
same day. Against 666 `detail_opened`. Nobody has ever worked a lead properly
here, so "they never reply" has never actually been tested.

Every lead now carries a **contact plan**: five attempts over nine days, each
with a channel and an **objective — what the attempt is FOR, never a script**.
The lead page shows where that landlord sits in it; one click does the attempt;
the click is the record.

### 42.1 — Where the numbers come from, and the two that must never appear

Stayful's own Management Leads pipeline, traced end to end over July–August
2026: every call attempt and its outcome, every email, cross-checked against
real calendar bookings rather than CRM status labels. One operator's data — a
benchmark, worded that way everywhere it is shown, never a guarantee.

| | |
|---|---|
| Booked a meeting, worked to a structured cadence | ~**77%** |
| Of everyone who ever responds, responded by attempt 4–5 | ~**89%** |
| Cold call answered | ~**17%** |
| The same call, once a message or email went first | **0–4%** |

⚠️ **NO ATTENDANCE OR SHOW-UP RATE, ANYWHERE.** An "83% of booked meetings are
attended" figure was measured and discarded: Calendly sends three reminders of
its own before any meeting, so it describes Calendly's dunning rather than this
strategy. Quoting it would promise an outcome we do not influence.

⚠️ **NO PERCENTAGE ATTACHED TO SPEED.** Attempt 1 falls on day 0 and
`SPEED_RULE` says so, because the business judgement is that speed matters. The
speed test in the sample showed no clear effect — the fastest-contacted leads
included both wins and total failures, and several landlords engaged only after
three to seven weeks — so the rule must not borrow the credibility of the three
figures that *were* measured. It is presented as how we expect leads to be
worked; they are presented as findings. That is the difference between a
customer disagreeing with our advice and catching us out on a claim.

`contactStrategy.test.ts` asserts both mechanically against the rendered copy
rather than trusting review.

### 42.2 — Cold call first, and why the button we shipped is attempt 2

| # | Day | Channel | Objective |
|---|---|---|---|
| 1 | 0 | **Call** | Tenanted or empty? Nothing sent ahead of it. |
| 2 | 0 | WhatsApp | Same day, only if the call went unanswered. |
| 3 | 2 | Email | Something to read in their own time. |
| 4 | 5 | **Call** | A different time of day from the first. |
| 5 | 9 | WhatsApp | Last nudge, then de-prioritise. |

The intuitive order is the wrong one. Warming a landlord up before ringing costs
roughly three quarters of the answer rate — so §40.15's `wa.me` hand-off, the
most prominent contact action on a lead, is deliberately **attempt 2**. Nothing
about the button changed; where it sits in the sequence did.

⚠️ **Five, not eight and not fifteen.** An earlier working figure of "ideally 15
attempts" predates the measurement and is superseded by it: 89% of responders
arrive by the fifth, so a longer ladder spends the operator's time on approaches
that do not convert and the landlord's patience on approaches they have already
ignored.

⚠️ **De-prioritise, never discard.** Several landlords engaged only after three
to seven weeks. The end of the plan is the end of active chasing and nothing
more.

⚠️ **The landlord's own stated preference outranks attempt 1.** §41's referral
email asks how they would like to be contacted and stores it on the lead;
having asked the question, opening with a cold call anyway is indefensible.
Attempt 1 only — a landlord who asked for email has not asked never to be rung.

### 42.3 — Nobody builds anything

§40.13 shipped a sequence builder and production carried **0 sequences, 0 runs,
0 drafts**. Two reasons, and both are closed here:

1. Every path ended at `sendOneMessage`, which refuses without a connected
   TimelinesAI workspace — and there are **zero** connected workspaces. A plan
   would have died on attempt 1 with `stopRun("no_connection")`.
2. The only entry point was hidden unless connected.

`message_sequences.delivery` is the fix and **the safety boundary of the whole
feature**: a `'manual'` plan never goes near `sendOneMessage`, and the sending
phase skips it. `ensureContactPlan` creates the standard plan on the first
assignment, so a customer who has to design a ladder before following anybody up
— and therefore never does — no longer has to. An operator who HAS built their
own standing rule keeps it.

That changed `enrolOnAssignment`, and an existing test asserted the old
behaviour ("does nothing when they have none"). **That assertion was the
defect**; the test now pins the new contract.

### 42.4 — ⚠️ The trust boundary: a click is not a tick

`lead_events` is the engagement basis for escalation, pooling, reclaim and the
scoreboard (§3), and `CLIENT_LEAD_EVENT_TYPES` is deliberately narrow so a
customer cannot manufacture engagement. A "mark complete" that wrote `tel_click`
would hand every customer a way to shield any lead from ever being escalated
away from them.

| | Writes an event | Completes the attempt | Counts toward engagement |
|---|---|---|---|
| **Click** (WhatsApp / Call / Email) | yes | yes, with `done_event_id` | yes |
| **"I did this another way"** | **no** | yes, `done_source='manual'` | **no** |

Enforced three times over: the application refuses the pair even when asked, the
route hard-codes `source` rather than reading it from the body, and a DB CHECK
refuses `done_event_id` alongside anything but `'click'`. Removing the
application guard fails a test — checked, not assumed.

**Adherence counts both**, because holding an operator to their own word is the
point, and admin sees the split. `detail_opened` closes nothing and is absent
from `CONTACT_EVENT_TYPES`: reading a lead is not contacting it (§6), and 666
opens against 15 contact actions **is** the finding.

⚠️ **An answered call STOPS the plan.** Attempt 2 is "same day, only if the call
went unanswered", so a `tel_click` alone cannot decide it — the timeline asks.
Putting the next approach in front of a landlord who has just picked up is the
one way this feature could actively embarrass an operator. Voicemail advances.

### 42.5 — The limit goes on the landlord, not the operator

**126 of 182 open landlords (69%) are held by two or more operators**, 37 by
three. Five attempts each is fifteen approaches to one person. Reducing
`max_assignments` is a *supply* decision, not a policy one — management ingests
92–104 leads/month against **220** of committed allocation, which is why 0055
raised the cap to 3, and GR already averages 1.06 operators per lead.

So `landlord_approach_ok` caps approaches at **one a day and three a week across
every operator holding that landlord**, keyed on the normalised phone rather
than `lead_id` because one landlord arrives as several `leads` rows (§18). An
attempt over the limit has its due date pushed a day rather than being created.

⚠️ **It returns a bare boolean and nothing else** — §40.12's rule, and §19.7's
before it: a count or a timestamp is a probe telling operator A when operator B
is working a shared landlord. The rationing is therefore **silent**; an operator
sees a slower plan and is never told why, and cannot be.

⚠️ **It fails OPEN**, unlike the operator's own send limits. Those protect the
operator's number; this protects a landlord from a second approach, and refusing
every attempt because one read failed would take a working feature down to
prevent a duplicate.

### 42.6 — ⚠️ 0079 is reversed, deliberately

0079 removed the landlord's phone and email from the pipeline card because *"114
of 308 assignments were expanded in the feed and never opened on the detail
page — roughly half of all engagement leaving no usable trace"*. **The objection
was that a click there left no trace.** Buttons that record `tel_click` /
`whatsapp_click` / `mailto_click` *are* the trace, so the reason is gone and
keeping the gate now costs the very signal it protected. Operators work from the
list, and `tel_click` reading 13 against 666 opens is partly an artefact of
there being nothing on the list to click.

Nothing was ever withheld: `leads/page.tsx` selects `lead:leads(*)`, so both
fields were already in the payload reaching the browser. It was a rendering
choice over data the client already had.

The card's long comment is **replaced, not deleted** — a reader finding contact
links back with no explanation would reasonably think 0079 was undone by
accident. And it is the **third** definition change to `detail_opened`
(0079 → 0123 → here), so contact actions will step up sharply and part of that
is measurement rather than behaviour.

### 42.7 — Where it shows

- **`/dashboard/guide`** — "How to contact a lead", rendered from
  `contactStrategy.ts` so guidance and the plan cannot drift.
- **The lead page** — the timeline: five rungs at once, done ones dated, the
  current one with its objective and button, future ones greyed. Seeing what is
  LEFT is the point.
- **The pipeline card** — the three contact buttons.
- **`/admin/outcomes`** — due / made / missed / adherence, worst first, plus the
  share of completions that came from a real click rather than a manual tick.
- **`/admin/messaging`** — the switch, and the four limits. Added in 0128's
  commit: 0127 shipped `contact_plans_enabled = false` with no UI at all, which
  is precisely the fault §40.14 fixed for messaging — **a kill switch nobody can
  reach is not a kill switch.** They go in the existing closed allow-list, never
  written from the body, for the reason at the top of `adminSettings.ts`.
  `contact_notify_from` (below) deliberately stays out: that list is booleans
  and bounded integers, and a date would need a third field kind for a value set
  once at go-live, which is where `reclaim_enabled_from` has always sat.

### 42.8 — ⚠️ THE 91 RUNS, and why the boundary was asserted but never written

0127's own migration comment calls `message_sequences.delivery` "the safety
boundary of the whole feature", and the pull request said in terms that a manual
plan never reaches `sendOneMessage`. **The filter did not exist.**

Within six minutes of the backfill the five-minute `poll-whatsapp-status` cron
picked up 91 of 357 runs, handed each to `sendOneMessage`, got `not_connected`
back — there are zero connected TimelinesAI workspaces — and `SEQUENCE_STOP_CODES`
mapped that to `stopRun("no_connection")`, sweeping 91 attempts to `skipped`. The
plans were destroyed faster than anyone could have noticed them being created.

**Why the testing missed it is the part worth keeping**, because it is a shape
this file has now recorded five times (§23.10, §25's `items(ids:)`, §27.8's
`!inner`, §40.8's two seams):

- the scratch seam test checked the query **shape** by hand-writing equivalent
  SQL, so it asserted a query that was never the one running;
- the unit test asserted the filter on `completeAttempt` — the **completion**
  path, not the **sending** path.

Both passed thoroughly, against nothing. `src/lib/contact/__tests__/sendingPhaseGuard.test.ts`
therefore asserts the **exported constant the route selects with** and the
**route file's own text**, and both halves were mutation-tested before being
kept. Recovery: switch off, add the embed and the `.eq(…, "auto")`, deploy,
revive the 91 runs and their attempts, switch back on.

⚠️ Two rules follow. `DUE_DRAFT_COLUMNS` needs `!inner` on **both** embeds — a
left join returns a manual draft with the sequence nulled, which is a scan that
looks correct and is wrong (§27.8). And a test that writes its own copy of a
query is not testing the query; anchor on the real constant or the real file.

### 42.9 — Being told, and the cutoff that makes it survivable

The timeline is a page nobody is asked to open. Between shipping §42 and this,
production carried 357 plans and nothing anywhere prompted a single operator to
work one — the same failure §40.13 had, one level up.

`/api/cron/contact-followups`, 08:15 UTC daily, does two things because they read
the same adherence figures and two crons would disagree about who is behind:

1. **The daily prompt** — what is due today, by channel, with a time estimate
   (`followUpSummary.ts`: 2 minutes a call, 1 a message). Email plus a text.
   **Nothing at all on a day with nothing due**, which is what stops it becoming
   the thing people filter.
2. **The falling-behind notice** — weekly at most, and only when adherence is
   below `followup_adherence_notice_pct` **and** at least
   `followup_adherence_notice_min_overdue` attempts are actually overdue. Both
   conditions: a customer with two missed calls is not neglecting anything.
   Factual, no ranking (§20 refuses to rank, and the operators most likely to
   drift are the ones a ranking punishes).

⚠️ **`contact_notify_from` is what stops switch-on being a wall.** The backfill
gave every open lead a plan so the timeline reads the same everywhere; it does
**not** follow that 342 landlords who enquired months ago are now chased. Those
attempts are all `pending` with a `send_after` in the past, so the obvious "what
is due today" query returns **326 across 23 customers** — one email that is
filtered to trash on day one, and there is no recovering from that. The scan is
bounded by the cutoff on `lead_assignments.assigned_at`, and **fails CLOSED**: an
unreadable cutoff prompts nobody rather than prompting about everything. The
backfilled plans stay workable from the lead page; they are simply not chased.

`contact_followups` is one opt-out key for both, not two: they are two halves of
one conversation about work that is due, and a customer wanting the notice but
not the prompt does not exist. §21.7's four-place rule applies, and
`followUpPreference.test.ts` pins all four plus the migration's `||` backfill —
the panel half being the one that matters, because for a DAILY email a missing
toggle is the worst of the four.

The text rides `sms_alerts_enabled` separately, as `completeAssignment` treats
the new-lead SMS. Bank holidays are skipped, fail-open like `inactivity-nudge` —
an unreachable gov.uk must not stop the day's work.

### Verification

All 122 migrations applied to a scratch Postgres 16 from empty (0002 skipped —
`pg_cron` unavailable locally), 0127 re-applied twice for idempotency. Every new
CHECK exercised on its boundaries, including the trust boundary in both
directions; both new functions confirmed `service_role`-only and invariant 7's
four re-checked; the rate limiter confirmed to block a second operator reaching
the same landlord through a **different** `leads` row and to ignore `nudge_sent`
and `detail_opened`; adherence confirmed to exclude not-yet-due and
out-of-window attempts.

The lifecycle was then driven on scratch against the real schema: attempt 1
materialised, the exact query `completeAttempt` issues returns it, a **stopped**
run returns nothing (the §27.8 trap, asserted rather than reasoned about), a
click closes it and stamps `done_event_id`, the 0123 trigger flips the
assignment to `contacted` off that click, and adherence reports it attributed to
a click.

Regression: a marketplace lead still allocates and spends exactly one credit,
and both retirement predicates are unchanged. **1063 vitest cases green**, lint
clean, `next build` passes.

Since the incident, the three guards that were missing are pinned rather than
reviewed, each mutation-tested by breaking it and watching the test fail:
`sendingPhaseGuard.test.ts` (§42.8), `followUpCronGuard.test.ts` (the cutoff and
both `!inner`s), and `followUpPreference.test.ts` (§21.7's four places).

**Production, after the fix:** 24 plans, 357 runs all active, 356 open attempts,
17 of them reconstructed from real prior contact history carrying that event's
own date and `done_event_id`, **0 skipped**. Verified 14 minutes after the
sequences switch went back on — roughly three firings of the five-minute cron
against the 91 losses the first six minutes cost.

⚠️ **Still not exercised in a browser, and no plan has yet been materialised by
the real cron** — every plan in production came from the backfill. The daily
prompt has not sent to anybody, because `contact_plans_enabled` is still false.

### Deployment order — migration BEFORE code

0127 first. It is inert on its own: every column is nullable or defaults to
today's meaning, `contact_plans_enabled` ships **false**, and no existing
function, predicate or trigger is redefined. Nothing touches a balance, counter,
pacing or capacity column, so a lagging migration cannot affect lead allocation.

**0128 the same**, and inert for a sharper reason: the cron that reads both of
its additions returns `contact_plans_disabled` before touching anything while the
switch is off. The `contact_notify_from` row is seeded to the apply instant, so a
fresh build prompts about nothing until leads start arriving — the safe direction,
and the same one the switch picks.

**Applied to `znlfwbnvhlacwzgfalcf` on 2026-09-01, before the code**, and
re-applied to prove idempotency. Pre-apply: no `contact_notify_from` row, 40
customers, none carrying the key, and **zero explicit `false` on any stream** —
so the merge had nothing to preserve, but it was checked rather than assumed,
because a `set` in place of the `||` would have wiped the lot. Post-apply: 40 of
40 opted in, the cutoff at `2026-09-01T07:23:18Z`, and **an md5 of every
customer's preferences with the new key removed that is byte-identical to the
one taken beforehand** — the merge added one key and touched nothing else. The
re-apply left both the cutoff and that fingerprint unchanged. 357 runs still
active throughout.

⚠️ **Before flipping `contact_plans_enabled`, move `contact_notify_from` to that
moment**, or every lead assigned between the apply and go-live is silently never
prompted about:

```sql
update system_settings
   set value = to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
 where key = 'contact_notify_from';
```
---

## 43. Getting locked out, and getting back in *(0130)*

Two auth defects, found the same afternoon by the same customer. Emanuela Sharra
paid £150 for Guaranteed Rent on 2 Sep, had 10 GR leads assigned at 06:43 the
next morning, and could not open her account for a day.

Her row was healthy throughout: paid, credited, `user_id` linked, leads waiting.
What was wrong was everything around it.

### 43.1 — The reset route answered every failure with "check your inbox"

She signed up as `emanuelasharra@yahoo.co.uk` and works from
`contact@vellaukproperties.co.uk`. Resetting with the business address hit

```ts
if (linkError || !link) return generic;   // the old route, line 76
```

which swallowed `generateLink`'s "no such user" and returned `{ok:true}`. The
page said an email was on its way; none was sent; nothing anywhere could tell
her the address was wrong. `/api/signup` would have told her — it says plainly
when an address IS a paying account — so the silence was not even a
platform-wide posture, just this one route's.

Three outcomes now, all **200** because the request itself was fine:

| Outcome | Condition |
|---|---|
| `sent` | token minted, Resend accepted it |
| `unknown_email` | no auth user **and** no `customers` row |
| `no_login` | no auth user, but a `customers` row exists |

**`no_login` is not a nicety.** 17 of 41 customers have no auth user — 14 of
them active waitlisted prospects — so folding them into `unknown_email` would be
a lie to fourteen people who genuinely are on our records, and it is the one
group most likely to try a reset and give up.

⚠️ **`classifyGenerateLinkError` IS THE SAFETY PROPERTY OF THIS FEATURE, and it
is an allowlist.** `no_user` is only returned for a positively identified
missing user — `code: "user_not_found"`, a 404, or a 400 whose message names it.
Every other shape, including one we have never seen, returns `transport` and the
route answers 500. Get this backwards and a Supabase outage or a stale
service-role key tells **every customer on the platform** that their account
does not exist, at the moment they can least check. Unit tests pin a 500, a 429,
a 401, an unrelated 400, a bare string and a plain `Error` as `transport`.

⚠️ **The lookup that separates `no_login` from `unknown_email` uses `.eq`, not
`.ilike`.** An address may legitimately contain `_`, which ilike treats as a
single-character wildcard, so ilike can match a different customer's row.
Measured first: no customer row carries a mixed-case or untrimmed address, so
the exact match is right for all live data and the wildcard hazard is not worth
trading for. `normaliseEmail` (`src/lib/emailAddress.ts`) is the one definition
of the canonical form, shared with §43.2 so the two cannot disagree.

### 43.2 — Disclosure and the rate limit are ONE change

The old throttle was `new Map<string, number>()` at module scope, and its own
comment justified the leak *"because the endpoint only ever emails an address
that already has an account."* **That sentence stops being true the moment the
route discloses**, and a per-instance Map then leaves an account oracle bounded
only by one serverless instance's memory.

So 0130 adds `reset_rate_windows` + `consume_reset_budget`. Do not ship the
disclosure without it, and do not "simplify" the limiter back into memory.

- **The subject is a SHA-256 hash, never the address.** A plaintext table here
  would quietly become a list of every email anyone has typed into a public
  form — a list we have no reason to hold.
- **`returns jsonb`, never `returns table`** (§27.4), and all three windows are
  consumed in one round trip because this is a user-facing request path.
- **Increment then compare**, the `credit_invoice` discipline.
- **Fails closed.** An unreachable limiter refuses, because the moment it breaks
  is the moment it is under load.
- Limits live in TypeScript (`src/lib/authReset.ts`) so they tune without a
  migration: 1 per minute and 5 per hour per address, 20 per hour per IP. The
  minute is the old Map's job — not flooding an inbox; the hours are what make
  disclosure safe. IP comes from the existing `clientIp()` in `src/lib/api/log.ts`.

### 43.3 — Changing a customer's email *(no migration)*

`POST /api/admin/customers/[id]/email`, and `AdminEmailPanel` beside the
password panel. There was previously **no way to do this at all** — it meant
hand-written SQL across two stores.

⚠️ **STRIPE IS NOT OPTIONAL.** `provisionPaidSubscriber` falls back to
`.eq("email", …)` when the by-Stripe-id lookup misses, using the address off
`stripe.customers.retrieve`. Move `customers.email` and leave Stripe behind and
the next invoice that misses the id lookup **provisions a duplicate customers
row and a second auth user**, and can repoint `stripe_customer_id` on the way
through. The primary webhook path is safe either way — `customerMatchFilter()`
matches on the id — which is exactly what makes the fallback easy to forget.

`planEmailChange` (`src/lib/customerEmail.ts`) is the pure decision: normalise,
refuse `invalid` / `unchanged` / `no_login`, and return the **deduped** union of
`stripe_customer_id` and `gr_stripe_customer_id`. The two are frequently the
SAME id (§17), and deduping is what stops a second pointless API call.

**Ordering, which matches neither existing precedent.** §24's plan route rolls
Stripe back on a DB failure; §29's cancel route deliberately does not roll back.
Here:

1. **auth.users** — the only cheaply reversible step and the likeliest to fail.
   ⚠️ `email_confirm: true` is mandatory: without it GoTrue mails a confirmation
   through **Supabase's built-in relay**, the ~2/hour shared test sender §15
   forbids outright. This route sends no email at all.
2. **customers** — on `23505` the address is taken, so the auth email is **put
   back** before returning. Two stores disagreeing is worse than either failure,
   and the both-failed case gets its own message naming both addresses.
3. **Stripe** — best effort, and **never unwinds 1 and 2**. The login is what
   the customer is waiting on; a stale billing address is hand-fixable. Reported
   in the response so the admin knows, not swallowed.

⚠️ **`auth.identities` carries its own copy of the address** (verified on
production: `email`, `email_verified`, `phone_verified`, `sub`). Whether
`updateUserById` syncs it is GoTrue-version-dependent and nothing here had ever
changed an auth email, so the route **reads it back and reports** `updated` /
`stale` / `unknown` rather than assuming. It does not patch that table — it is
GoTrue's.

Session-auth only, deliberately not the `x-admin-key` fallback: that exists so
crons can call in, and repointing a login should need a real admin session.

**Unchanged:** the Monday link survives (`mondayStatus.ts` short-circuits on a
stored `monday_item_id`, so `monday_link_matched_by` keeps a stale `"email"` —
inert); post-call offers follow the new address automatically; no balance,
counter, pacing or capacity column is touched.

### 43.4 — Deliberately not built

A "has leads but has never signed in" detector was designed and dropped. It is
the thing that would have caught this without the customer having to write in —
`auth.users.last_sign_in_at` via `listUsers()` is the honest signal, ⚠️ **not
`customers.first_login_at`, which 0030 backfilled to `now()` for every row that
existed then and which therefore cannot identify anyone who predates it.**

### ⚠️ Auth OTP expiry is over an hour

Supabase's linter reports `auth_otp_long_expiry` on this project. It means a
recovery link stays valid far longer than the hour Supabase recommends — which
is why Emanuela's set-password token was still unconsumed and possibly still
live 15 hours after it was minted. Not changed here, and worth a decision:
shortening it makes an unclicked invite fail *faster*, which argues for §43.4
existing before it is tightened.

### Verification

Scratch Postgres 16.13, migration applied twice for idempotency: RLS on with
zero policies, both CHECKs exercised (a non-hash subject and an unknown
`subject_kind` both refused), ACLs `service_role`-only. The limiter was then
driven: six calls incrementing both windows together, a second address getting
its own counters while **sharing** the IP counter, a null IP tolerated and
returned as null, and — the one that matters for the semantics — a short window
rolling over to 1 while the long window went to 2. The opportunistic cleanup
removed a 5-day-old row and kept the live ones.

Applied to `znlfwbnvhlacwzgfalcf` on 2026-09-03, before the code. Post-apply:
41 customers and 471 leads untouched, RLS on with 0 policies, both CHECKs and
the index present, ACLs `anon`/`authenticated` false and `service_role` true.
The only new linter notice is the deliberate deny-all posture shared with some
thirty other tables.

1,178 vitest cases green after rebasing onto the parallel branch (37 of them
new here), `npm run lint` clean, `npm run build` passes.

**Not yet exercised end to end**: the three reset outcomes against a deployed
preview, and an actual email change against a real Stripe customer. Rehearse the
latter on a throwaway customer first — the identity read-back (§43.3) is a
genuine unknown until it has run once.

### Deployment order — migration BEFORE code

0130 first — **done**. The route FAILS CLOSED on an unreachable limiter, so code
arriving first would throttle every password reset on the platform.

⚠️ **It was applied as `0127_reset_rate_limit` and the file is `0130_`.** When it
went on, `supabase/migrations/` ended at 0124 and production carried four
migrations that were in no file at all, so 0127 was the first number that looked
free. It was not: a parallel branch landed 0126–0129 — including a *different*
`0127_contact_plans` — while this was being written, and committed the four
missing files at the same time. The file was renumbered to 0130 before merging;
`supabase_migrations.schema_migrations` still records the apply under its
original name, which is a cosmetic mismatch and not worth a second apply.

The lesson is worth more than the incident: **a free migration number is only
free at the moment you look**, and this repo's numbering has drifted before
(§36.8, `worked_conversion` — now committed as `0100a`). Re-check the highest
number on `origin/main`, not just on disk, immediately before pushing.

---

## 44. Telling a customer their card was declined *(0125)*

Monday group **`group_mm5p94x0`** — "Wants to pay but declined payment" — is where a
customer's item lands when their payment fails. Nothing drags them there by hand: board
automation `7921219522` moves an item into it when the Status column changes to
`Wants to pay card declined`, and that label is written **only** by
`mondayStatusLabelFor()` rules 3 and 6, i.e. when `(gr_)subscription_status` becomes
`past_due`. That write comes from our own `invoice.payment_failed` handler.

**So the group is downstream of this codebase, and this feature needs no Monday polling and
no Monday webhook receiver** — the app already causes the transition it would be observing.
The direct signal is the webhook, which fires seconds earlier, already knows the customer and
the product, and is the only place the Stripe decline detail is reachable at all.

Until this shipped that handler wrote a failed `payments` row, set `past_due`, pushed the
label — **and told the customer nothing**. Five payments failed across three customers in the
fortnight before it was built; one of them was still `past_due` weeks later, sitting in that
Monday group, never having been emailed.

`src/lib/declineDetail.ts` · `src/lib/declineReason.ts` · `src/lib/cardDeclines.ts` ·
`sendCardDeclinedEmail` · `/admin/customers` **Declined** tab.

### 44.1 — ⚠️ `invoice.payment_intent` IS GONE ON THIS ACCOUNT

`getStripe()` pins no `apiVersion`, so the account default decides the payload shape — the
hazard `subscriptionIdFromInvoice`, `priceIdsFromInvoice` and `subscriptionPeriodEnd` each
already work around. `subscriptionIdFromInvoice`'s own comment says this account is on basil.
`invoice.payment_intent` went the same way as `invoice.subscription`, and nothing had noticed:
both `credit_invoice` call sites pass `(invoice.payment_intent as string | null) ?? null`, and
production says what that is worth —

```
select count(*), count(stripe_payment_intent_id) from payments
 where status='paid' and payment_type in ('subscription','gr_subscription');
→ 30 rows, 0 with an intent id
```

**Zero of thirty.** Read naively, this whole feature would have reported "no reason given" for
every decline — silently, plausibly, and indistinguishably from Stripe declining to tell us.
`paymentIntentIdFromInvoice()` reads both shapes and is the two-line fix for those two
`credit_invoice` call sites too; that has **not** been done here.

⚠️ **The basil branch walks `payments.data` IN REVERSE.** That array holds one entry per
attempt, newest last, so reading it forwards attributes attempt 1's decline reason to attempt
4's email. There is a test named for it.

### 44.2 — Store the truth, say less

`declineReason.ts` is pure and is the only thing that decides what a customer is told.
`lost_card`, `stolen_card`, `pickup_card`, `fraudulent`, `merchant_blacklist`,
`restricted_card`, `revocation_of_authorization` and `security_violation` **all collapse to
one neutral message**: *your bank declined it, call the number on your card.* Three reasons,
each sufficient — it tells somebody testing a stolen card how much we can see; issuers use
these as catch-alls, so a perfectly legitimate customer gets `stolen_card` surprisingly often
and accusing a paying customer of card theft is not a recoverable email; and it is the
issuer's to say, not ours.

Suppression is checked on **every** code field **before any table lookup**, so no later branch
can leak one. `card_declined` is deliberately **absent** from the table — it is the outer code
that accompanies a specific `decline_code`, and in the table it would shadow every specific
reason and collapse the feature into one generic message.

The raw codes are still stored, and still shown to admins. That split is the whole point.

⚠️ **`charge.outcome.seller_message` must never reach a customer.** Stripe's own name for it
says who it is for, and it spells the suppressed code out in plain English. Enforced
structurally rather than by comment: `customerSafeDecline()` is an allow-list with a test
pinning its exact key set, and `sendCardDeclinedEmail` **has no parameter** for it.

### 44.3 — ⚠️ `past_due` DOES stop lead delivery

An earlier draft of this work claimed it did not, on the strength of a check that tested which
column *names* appeared in the candidate functions rather than what they were compared to.
All three candidate functions and `customer_can_see_pool_lead` carry
`and c.subscription_status = 'active'` in their AND chain — verified against the live
`pg_get_functiondef`, not inferred from the migration files.

`holdsProduct()` counting `past_due` as held is about whether to **sell** them the other
product (§17), not about routing. So the email says **new leads are paused until it clears**,
and says in the same breath that nothing has been taken away — leads, notes, files and
remaining credits are all untouched, and delivery restarts the moment the payment goes
through. Both halves are load-bearing: the first is the reason to pay, the second is what
stops it reading as a threat.

### 44.4 — Every attempt, claimed by INSERT

Stripe Smart Retries makes ~4 attempts over 2-3 weeks and **each one emails**. That is not a
guess: invoice `in_1U9po1…` failed on 29 Aug, 30 Aug and 1 Sep before recovering.

`card_decline_events` is unique on **`(stripe_invoice_id, attempt_count)`** and the row is
claimed by INSERT *before* the send — the `credit_invoice` / `announcement_deliveries`
discipline. Checking "have we sent?" and then sending leaves a window; claiming by write does
not.

- **The key excludes `customer_id` deliberately.** A Stripe invoice belongs to exactly one
  Stripe customer, so adding it buys no uniqueness and actively weakens the guard:
  `customerMatchFilter()` resolves GR through an `.or()` across two columns, so if that lookup
  ever landed on a different row between a delivery and its retry, a customer-scoped key would
  not collide and a second email would go out.
- **Both key columns are NOT NULL.** A unique index treats NULLs as distinct, so a nullable
  half would silently disable the whole guard.
- **A second layer behind `stripe_events` is not redundant.** The webhook's outer catch
  DELETES its event claim on any throw so Stripe retries — and `credit_invoice` throws by
  design on the sibling `invoice.paid` path. Without this index one webhook wobble is a
  duplicate decline email.
- **A missing `attempt_count` is logged, never silently defaulted.** Quietly using 0 would
  collapse every attempt on an invoice onto one row and email only the first.
- A claim that succeeds and a send that then fails means that attempt is never emailed.
  Accepted openly: **missing beats duplicate**, and three more attempts are coming.

⚠️ **`reason_key` has no CHECK, on purpose.** At the call site a `23514` is indistinguishable
from the `23505` that means "already handled", and the claim-then-send rule would read it as
*skip* — so one key forgotten in a SQL list would mean no email ever sent for that decline
code. The TS union is the contract; the test over `DECLINE_COPY` is the enforcement.

### 44.5 — Nothing may throw

`notifyCardDeclined` returns a result object and swallows everything, the same contract
`setEnquiryStatus` and `syncCustomerMondayStatus` hold. An exception escaping it would delete
the `stripe_events` claim and have Stripe redeliver an event that has already written
`past_due`, a `payments` row and a Monday label. It is called **last** in the branch, after
`pushMondayStatus`, so a slow Stripe lookup cannot delay the board push.

A Stripe lookup failure **still emails**, with the generic copy: the customer needs to fix the
card whether or not Stripe would tell us why. Only `pi_resolved` records that we could not say.

Two things the branch did not do before and now does: **log the customer lookup error**, and
**log when no customer matched**. `customerMatchFilter` is an `.or()` with `.maybeSingle()`,
so two matching rows error into `customer = null` — silence there used to mean "we did not
mark them past_due" and now also means "we never told them their card failed".

⚠️ **The email is gated on `subscriptionIdFromInvoice(invoice)`.** Unlike `invoice.paid`, this
branch has never checked, so a one-off invoice an admin raises also writes `past_due` — a
pre-existing oddity, left alone, but it must not now tell somebody their leads are paused when
they are not.

### 44.6 — Recovery needs no clearing

The admin badge is keyed on the **live** `(gr_)subscription_status`, never on
`resolved_at`. Paying clears it when `invoice.paid` writes `'active'`; churning clears it when
the status becomes `'canceled'`. Neither depends on the best-effort stamp having landed — and
it means the one customer whose decline predates 0125 still reads `Card declined` rather than
showing nothing.

`resolveCardDeclines` is called per product in each half of `invoice.paid` (invariant 6 — a
customer can be past_due on GR while management is healthy). ⚠️ Its **blanket update is
deliberate**, and is a departure from `stampEpisodeEnded` / `closeOpenCancellation`, which
forbid one: their worry is that an older un-stamped row would be given today's date and invent
a boundary that never happened, where here every open row for the product genuinely *is*
resolved by this payment.

### 44.7 — Admin sees the code; the customer never does

`/admin/customers` gains a **Declined** tab (the in-app view of `group_mm5p94x0`) and a
per-product badge beside the subscription badge — `Mgmt card declined — insufficient funds ·
visa ••4242 · retry 12 Sep`, with the raw code, the attempt number and whether Resend actually
took it in the tooltip. **Admin-only is what makes the raw code legal there**, and the account
badge still reads `active` where it is: the new badge carries the extra fact rather than
replacing a true one, as §21 and §23.7A both do.

Keyed `customerId:leadType`, never on the customer alone — a customer-keyed map would print
the GR reason beside the management badge. No Stripe call per row: the reason was resolved and
stored when the decline happened.

### Verification

All migrations applied to a scratch **Postgres 16** from empty (with `auth`/`storage`/`cron`
shims; `pg_cron` is not installable locally), 0125 re-applied twice for idempotency. Then
against seeded rows: the first claim inserts, **the same attempt collides with 23505**, the
**next** attempt on the same invoice inserts, a *different customer* cannot re-claim the same
attempt, both CHECKs refuse their bad values, an unrecognised `reason_key` is accepted, RLS is
on with **zero** policies, and the FK cascades on customer delete.

**953 vitest cases** (82 new), `npm run lint` clean, `npm run build` passes. Among them: every
suppressed code neutralised on all three fields with the copy asserted to contain none of the
raw vocabulary; both API-version shapes resolving the same intent id, and the reverse-iteration
case; an unexpanded `latest_charge` treated as absent; `customerSafeDecline`'s exact key set;
the claim proven to happen **before** the send; a 23505 sending nothing; a Stripe outage still
emailing; and `notifyCardDeclined` never throwing whatever the database does.

The email itself was **rendered** and read: the reason, the product, the card, the paused-leads
copy, and — with no `hosted_invoice_url` — the Pay button dropped, the settings link promoted,
and the prose changed with it so it never points at a button that is not there.

**Not yet exercised against live Stripe.** The standing §12 item, and sharper here because this
is the first code in the repo to read any of these fields. Before relying on it, run test-mode
declines through `4000000000009995` (insufficient funds), `4000000000000069` (expired),
`4000000000003220` (3-D Secure) and `4000000000009979` (**stolen — assert the email says only
that the bank declined it, while the row records `stolen_card`**), then replay one
`invoice.payment_failed` from the Stripe CLI and confirm no second email.

### Deployment order — migration BEFORE code

0125 first. It is purely additive and inert on its own — nothing reads the table until the code
ships — while code arriving first would fail the claim insert on every decline and, under the
claim-then-send rule, send **no email at all**. Nothing here touches a balance, counter, pacing
or capacity column, so a lagging migration cannot affect lead allocation.

---

## 45. Measuring the adverts *(no migration)*

Facebook ads drive traffic to `leads.stayful.co.uk` and **nothing measured what
converted**. There was no tracking of any kind in the repo — no pixel, no GA, no
`next/script`, no analytics dependency — and in the ad account the pixel
(`StayfulFBPixel`) had not fired since April 2026 and had **never** received a
server-side event. All six custom conversions were 2024 URL rules pointing at
the retired Airbnb Mastery Academy funnel on `www.stayful.co.uk`; nothing
anywhere referenced this product.

Two transports, one dataset. The browser reports `PageView` and `Lead`; the
server reports `Lead` (deduplicated against the browser's) and `Purchase`.

`src/lib/meta/` · `src/components/MetaPixel.tsx` · hooks in
`api/enquiry/route.ts` and the `invoice.paid` branches of the Stripe webhook.

### 45.1 — The server half is the RELIABLE one, not a backup

Two things specific to this funnel make a browser-only pixel under-report badly,
and neither is a general "ad blockers exist" argument:

- **There is no thank-you page.** `enquiry/page.tsx` fires
  `window.location.href = CALENDLY_URL` in the same tick as the successful POST.
  A same-tick hard navigation to another origin cancels the beacon, and `fbq`
  offers no completion callback — so the browser event is lost a good part of
  the time. It is also why a **URL-rule custom conversion can never fire here**
  and why the six stale ones in the account would report zero forever.
- Roughly a third of visitors block `fbevents.js` outright.

So the browser `Lead` is close to pure redundancy: everything it would add to
match quality — `_fbp`, `_fbc`, IP, user-agent — the server reads off the very
same request. It is kept because during setup you want Pixel Helper to show
something and Events Manager to show browser/server dedup collapsing into one
row, and a half-lost browser event makes that verification confusing. The
redirect is delayed **250 ms** so the beacon survives; `loading` is deliberately
not reset, so the button stays disabled and a double-click cannot produce two
Leads with two ids.

### 45.2 — Inert until configured, and that is asserted

With `NEXT_PUBLIC_META_PIXEL_ID` or `META_CAPI_ACCESS_TOKEN` unset: no script is
injected, no cookie is written and `fetch` is never called. The `sms.ts` "no
credentials, no-op" pattern. `meta.test.ts` asserts the fetch stub is **never
called** when unconfigured — that test is what proves merging changed nothing in
production until Vercel was configured.

⚠️ **`NEXT_PUBLIC_*` is baked in at BUILD time.** Setting it in Vercel without a
redeploy does nothing. The same trap §40 records for `ANTHROPIC_API_KEY`.

### 45.3 — Four things that fail SILENTLY

Every one of these produces no error, no warning and no rejected request — just
a number that is quietly wrong. They are the whole reason this section exists.

| Trap | What happens |
|---|---|
| `eventId` instead of **`eventID`** (capital D) in `fbq`'s 4th argument | Silently ignored. **Two counted Leads per submission**, both looking legitimate. |
| Hashing `fbp` / `fbc` / `client_ip_address` / `client_user_agent` | These four go to Meta **in the clear**. Hashing one is a permanent non-match. `meta.test.ts` asserts the exact input strings survive. |
| `event_time` in milliseconds | `Date.now()` is ms; CAPI wants **seconds**. Reads as roughly the year 57,000 and is rejected in the response **body**, not the status code — which is why `capi.ts` logs `messages` rather than just `res.status`. |
| Hashing an unvalidated email or a junk name | A hash of `asdf` or `natalyanaq@gmail.com` matches nobody, for ever, and drags the dataset's Event Match Quality down. Omitting the field is strictly better, so `EMAIL_RE` and `isJunkName` (§36.3) gate them. |

### 45.4 — Phone normalisation is `normaliseUkMobile`, not a third rule

`normalisePhoneForMeta` is built on `normaliseUkMobile` (§36.2) deliberately: it
carries the finding that 89 of 193 live management leads store the number as
`+44` followed by a **full national** number, which a naive implementation turns
into `007304208011` and loses. That is 46% of the book's phone matches, silently.

Its failure branches need different treatment here, because it is a strict
UK-**mobile** gate and Meta has no such requirement — the number only has to be
the one on the person's Facebook account. `foreign` is a fact, not an error;
`not_mobile` (a UK landline) is perfectly matchable and falls back permissively;
only `missing` and `placeholder` are dropped.

`ln` is the **last token**, never everything after the first — Meta compares it
to the profile's `last_name`, so "jane smith" would never match "smith".

### 45.5 — `usePathname`, never `useSearchParams`

In Next 14.2 a client component calling `useSearchParams()` outside `<Suspense>`
is a hard `next build` failure, and wrapping this component — which lives in the
**root layout** — in Suspense de-opts *every* page under it to client-side
rendering, including the 2,500-line static marketing page. The build output is
the check: `/`, `/enquiry`, `/guaranteed-rent` and `/privacy-policy` must stay
`○ (Static)`.

The only thing lost is a `PageView` when just the query string changes, which is
not a pageview worth counting — and `fbq` reads `document.location` itself, so
the full URL still reaches Meta.

The first `PageView` is fired by the inline snippet, so the route-change effect
skips its own first run via a ref. Verified in Chromium across all four paths
(initial load, client-side nav, leaving to `/dashboard` and returning, and
browser Back): **exactly one PageView per navigation, no double-count on
remount.**

### 45.6 — `_fbc` is minted from `?fbclid=` by OUR bundle

⚠️ **This is the point of the block, and it looks redundant until you see why.**
An ad blocker blocks the request to `connect.facebook.net` — it does not block
our own code. So when the pixel is dead, `MetaPixel.tsx` still writes
`_fbc=fb.1.<ms>.<fbclid>` itself, and the enquiry route reads it off the request
cookies. Without it, exactly the conversions the Conversions API exists to
recover would land with **no click attribution at all**.

Only when `_fbc` is absent — when the real pixel is alive it owns that cookie,
and racing it gives one visitor two different values. The timestamp is
milliseconds. `_fbp` is deliberately **not** minted (`MINT_FBP = false`): it is a
random browser id no Meta system saw being set, so it adds almost nothing while
being an advertising cookie we write ourselves.

**Why the cookie and not the URL:** the real journey is `/?fbclid=…` → read the
landing page → click through to `/enquiry`, where the param is long gone. The
cookie persists 90 days. Do not try to read `fbclid` on the enquiry page.

### 45.7 — Purchase, and what it cannot tell you

Server-only, at the end of **both** `invoice.paid` branches, after every state
write. First paid invoice only (`billing_reason === "subscription_create"`);
renewals would file ~12 Purchases per customer per year, almost all outside any
attribution window, giving the optimiser a target it cannot influence.
`PURCHASE_ON_RENEWALS` is the one-word switch. Zero-value invoices are skipped
so a 100%-off coupon never teaches the optimiser that £0 is a win.

⚠️ **`pushMetaPurchase` must never throw, and the try/catch is the second stop
rather than decoration.** This handler deletes its `stripe_events` claim on any
throw so Stripe retries — so an exception escaping a Meta failure would
redeliver an invoice that has **already been credited** (§23.6).
`sendMetaConversion`'s type signature promises it never rejects; both layers stay.

Double-counting is stopped twice and **neither layer is redundant**: the
`stripe_events` claim covers a redelivery arriving more than 48 hours later,
which is outside Meta's dedup window; `event_id = stripe_invoice_<id>` covers
everything inside it.

It reads its **own** contact details rather than widening the branches' selects,
which read only allocation columns. ⚠️ `contact_name` first, `business_name`
only as a fallback — `api/enquiry/route.ts` writes the person's name into both,
so `business_name` is frequently a person and only sometimes a company.

**No browser counterpart, so nothing to deduplicate against.** The success URL
is `/dashboard?checkout=success`, behind middleware and inside the pixel's
exclusion. That is the right shape anyway: the real funnel is ad → enquiry →
Calendly call → admin invite → a Stripe link opened from an **email**, often days
later on another device.

⚠️ **Say this before anyone reads the ROAS column.** Purchase carries hashed
email/phone/name but no `fbp`/`fbc`/IP/UA, so attribution to a specific click
depends on the person still being inside the 7-day window. A customer who
enquires today and pays after a sales call three weeks later shows as an
**unattributed** Purchase. That is a property of the funnel, not a fault in the
code. The fix, if it ever matters, is two `text` columns on `customers` written
from the cookies the enquiry route already reads, replayed here — one migration,
about six lines, and not worth it until the sales cycle is known to be short.

### 45.8 — The pixel does not load on `/dashboard` or `/admin`

Those are paying customers and staff, not ad traffic. Counting them would
pollute the behaviour the optimiser learns from, and would track people's use of
a product they have already bought — which is not what the policy says the pixel
is for. `isTrackedPath` uses exact-or-followed-by-slash matching, never a bare
`startsWith`, which would also exclude a hypothetical `/dashboards`.

Confirmed in Chromium: loading `/dashboard` makes **zero** requests to Facebook
and leaves `window.fbq` undefined.

### 45.9 — No barrel in `src/lib/meta/`

`consent.ts` and `paths.ts` are imported by a client component; `hash.ts` and
`capi.ts` are server-only. An `index.ts` re-exporting all four would drag
`node:crypto` into the client bundle through the one import. Import by exact
path. `consent.ts` carries the warning.

### 45.10 — The privacy policy, and what a rewrite does NOT buy

Section 9 previously stated in writing that the service used no cookies for
analytics, advertising or tracking. Shipping the pixel made that false, so it is
rewritten: the pixel and the Conversions API, `_fbp`/`_fbc` named with
lifetimes, what is sent (hashed email/phone/name; unhashed fbp/fbc/IP/UA) and
what is not (enquiry contents, website, property count, landlord data), Meta as
**joint then independent controller — not a processor**, the US transfer, and
four opt-outs.

⚠️ **The `robots: { index: false }` was removed and a footer link added, and
that is part of the change rather than tidying.** The policy was noindexed and
linked from nowhere — its own header called it "deliberately undiscoverable". A
disclosure nobody can reach discloses nothing, so the rewrite alone would have
been a no-op.

⚠️ **Section 6's preamble says providers "are not permitted to use it for their
own purposes", which is FALSE of Meta.** The table row is qualified and the
preamble now names the exception. Dropping Meta in unqualified is the obvious
move and it turns that sentence into a misrepresentation.

**Accurate disclosure is not consent, and the code says so.** UK PECR
regulation 6 wants opt-in *before* non-essential cookies are written.
`src/lib/meta/consent.ts` returns `true` today and is called by every entry
point — the browser pixel, the `_fbc` mint and the server Lead — so adding a
banner is a one-line change there rather than a hunt. An `InternalNote` in the
policy records it for solicitor review. This was the owner's explicit decision
after the trade-off was put to them.

### Verification

901 vitest cases (30 new), lint clean, `next build` passes. The hash is pinned
against a **hardcoded** SHA-256 vector rather than a round-trip against our own
function — getting it wrong is invisible in production, so it has to be checked
against an outside answer. Also asserted: the no-op-when-unconfigured path never
touching `fetch`; `sendMetaConversion` **resolving** rather than throwing on a
network failure (the invariant the webhook's idempotency rests on); the token
appearing in the request body and never in the URL or an error string; and
`/dashboards` not being mistaken for `/dashboard`.

Then driven in real Chromium against a production build: `_fbc` minted correctly
from `?fbclid=` with the pixel script stubbed out, one `PageView` per navigation
across four path shapes, and zero Facebook requests on `/dashboard`.

**Not yet exercised against the live Meta API** — the standing §12 item. Before
relying on it, set `META_TEST_EVENT_CODE` on a Preview deployment and confirm in
Events Manager → Test Events that one enquiry produces **one** `Lead` row
carrying both Browser and Server. Two rows means the `eventID` casing or the
`event_id` in the POST body. Then repeat **with an ad blocker on**: Pixel Helper
should show nothing while Test Events still shows the Lead, with `fbc` present.
That single test is the entire justification for the server half.

### Deployment order — code only, but the account work is not optional

No migration. The code is inert until the env vars are set, so it can land at
any time. What it needs on the Meta side, before spend is read as meaningful:
domain verification for `stayful.co.uk` (DNS TXT; the root covers the
subdomain), Aggregated Event Measurement with `Purchase` ranked #1 and `Lead` #2
(⚠️ a **72-hour cool-down** on affected ad sets — do it before scaling, not
mid-flight), and the conversion domain set on each ad set.

⚠️ **Optimise on the standard `Lead` and `Purchase` events. Do not use the six
existing custom conversions** — they are 2024 URL rules for the retired funnel,
they cannot fire against a form that redirects off-site, and they will report
zero for ever while sitting in the dropdown looking selectable. To split `Lead`
by plan later, build it on the `content_name` parameter this already sends.

⚠️ `META_TEST_EVENT_CODE` **must be unset in production.** Events carrying a
test code are routed to the Test Events tool and are **not** used for delivery,
optimisation or attribution — so leaving it set means the campaign optimises on
nothing while Events Manager looks perfectly healthy.
