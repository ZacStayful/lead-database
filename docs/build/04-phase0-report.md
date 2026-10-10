# Batch 04 — Phase 0 report (approved 10 Oct 2026)

Zac approved this on 10 Oct 2026 and decided C1–C4 in that review. This is the repo copy, so later sessions can read the decisions behind 04. **The decision register is not in the repo** (it lives in the Claude project as `claude/decision-register.md`), so the C1–C4 decisions below should also be copied there.

The audit ran on `main` @ `46925a8` (9 Oct). It was then **re-run on `main` @ `362a83f`** (10 Oct), after Lead Brief Phases 3–5B, batch 02 and batch 03 Phases 1–2 had merged. Line numbers below are for `362a83f`.

## Orientation

- **This session:** batch 04, Phase 0 (audit only, then STOP).
- **Merged:**
  - Lead Brief Phases 0–5B: migrations 0161–0164, covering the engine, questionnaire, routing, labels and the "Your brief" editor.
  - Batch 02, complete (0165, CLAUDE.md §75).
  - Batch 03 Part A, Phases 1–2 (0166, §76).
  - Lead Brief Phases 6 (admin Lead Reach and A10 recompute) and 7 (copy and docs) are **not** built.
- **Depends on 04:** batch 05 needs 04's confirm screen. The batch 06 build runs only after 04 merges, and 04 and 06 must never build together, because both change which leads a customer can receive.
- **Docs read:** `00-index.md`, `lead-brief-build-prompt.md`, `01-lead-brief-additions.md`, `02-phase0-report.md`, `03-phase0-report.md`, and this batch's prompt (`04-area-changes-pause-topups.md`).
- **Next free migration:** 0167.

## Decisions (10 Oct)

| | Decision |
|---|---|
| **C1** | **Stop after Phase 0.** Phases 1–5 resume once Lead Brief Phases 3–5 are merged. ⚠️ The re-run on `362a83f` shows that condition **is now met** (see §0), so Phase 1 can start on Zac's go-ahead in a new session. |
| **C2** | **A paused brief customer banks no replacements.** Batch 04 locked decision 1 ("owed nothing for the paused period") overrides §61's "a paused customer does accrue", for brief customers only. This needs a brief branch in `replacement_monthly_grant` (SQL, 0153, applied in `reset_monthly_counts`) and in its TypeScript twin `monthlyReplacementGrant` (`src/lib/quality/deadLeadPolicy.ts:281`). Existing customers keep §61's rule. |
| **C3** | **Batch 04's wording wins.** A top-up lead's reason reads "From just outside your area, as part of your top-up." This one reason is exempt from A9's ban on "top-up" in label and reason copy. A9 still applies everywhere else, so the exemption has to be added to both banned-word scans (`src/lib/leadBrief/__tests__/labelCopy.test.ts:371`, `briefCopy.test.ts:95`) for that one string only. |
| **C4** | **A monthly widening keeps delivering on the current active area** until the customer confirms or it auto-accepts at 72 hours. Only a **return from pause** holds delivery, and it does so by keeping the customer paused until they confirm. No new delivery gate. |
| C5–C10 | Raised again at the STOP of the phase each one affects (see §4). |

---

## 0. Build state: the prerequisite

Batch 04's header says: "Run only after: the Lead Brief and its additions are merged."

**On `46925a8` (9 Oct)** only Lead Brief Phases 1–2 were merged. There was no gate, no routing, no labels, and no writer of `customer_lead_briefs`. On that basis C1 was decided as "stop after Phase 0".

**On `362a83f` (10 Oct)** Lead Brief Phases 3–5B are merged:

| What 04 needs | Where it is now |
|---|---|
| The Lead Brief dashboard gate, to sit beside | `needsLeadBrief` in `src/lib/leadBrief/gate.ts:23`, called in `src/app/dashboard/layout.tsx:54` (skipped while an admin is viewing as the customer) |
| Brief routing | `get_brief_candidates_for_lead(lead, max, include_pace)` (0163:247), the third pool in `autoAssignLead` after the legacy pools (`src/lib/ingest.ts:705-717`), and only while `lead_brief_enabled = 'true'` |
| Delivery respects `paused_at` | 0163:326 (`and c.paused_at is null`) |
| Labels and "why" | `recordBriefMatch` in `completeAssignment` (`ingest.ts:775`); copy in `src/lib/leadBrief/labelCopy.ts` |
| Brief versions | 0164: a `scheduled` status, **at most one change in flight** (`customer_lead_briefs_one_in_flight`, 0164:61), `save_scheduled_lead_brief`, `promote_lead_brief` (both under a per-customer advisory lock), and the daily `activate-lead-briefs` cron (00:20 UTC) |
| A10 monthly recalculation (it writes the widening's `pending_confirmation` rows) | **Not built.** Lead Brief Phase 6 |

**What this means for 04:**
- Phases 1–3 for **returns from pause** can be built now.
- The **monthly-widening** use of the confirm screen only becomes live once Lead Brief Phase 6 writes the `pending_confirmation` rows.
- Phase 4 (top-ups) can plug into `get_brief_candidates_for_lead`.

**Production (10 Oct):**
- 1 customer has `lead_brief_required`.
- 0 have `lead_brief_completed_at`.
- 0 rows in `customer_lead_briefs`.
- `lead_brief_enabled = false`, `funnel_enabled = false`.
- 7 customers are paused.

## 1. Pause: where it lives, how long, billing and credits

None of these files changed between `46925a8` and `362a83f`, except the webhook, whose line numbers moved.

**UI** — `src/components/dashboard/SettingsPanel.tsx:400-628` (`pause-subscription-card`).
- Shown only to an active Management subscriber (262–264).
- Durations: 1, 2 or 3 months (`src/lib/pauseOptions.ts:56`, default 3).
- At least one reason is required (`PAUSE_REASONS`). An optional note can be added, up to 500 characters.
- When paused, the card shows a "Start my leads again" button (423–474).
- The cancel flow offers a pause first (`CancelSubscriptionCard.tsx:233-291`).

**API** — `src/app/api/customer/subscription/pause/route.ts`.
- Requires an active Management subscription with a Stripe subscription id (144–156). Refuses if the customer is already paused.
- The return date is **fixed when they pause**, using `setMonth(+months)` (165–167). That rolls over on short months, so 31 Jan + 1 month = 3 Mar.
- Writes first, as a guarded update (172–188), then calls Stripe with `pause_collection: { behavior: "void" }`.
  - No Stripe `resumes_at` is set, deliberately (§11): two resume authorities would let Stripe unpause without the database knowing.
- Rolls back if Stripe fails.
- Best-effort afterwards: the `subscription_pauses` row, the email, and the Monday "Paused" label.

**Maximum length**
- 3 months per pause, enforced by `isPauseMonths` and by `subscription_pauses.months integer not null check (months in (1, 2, 3))` (0084:55).
- No cumulative cap: `pause_count` gates nothing.
- **No route to extend a pause.**

**Resume**
- `resumePausedCustomer` (`src/lib/resumePause.ts:96-213`) is shared by the button (`api/customer/subscription/resume`) and the cron (`api/cron/resume-paused-subscriptions`, `0 8 * * *`, `maxDuration = 60`).
- It unpauses Stripe first, then does a guarded clear.
- It resets `billing_cycle_anchor` to today and `leads_received_this_month` to 0, and leaves `lead_balance` untouched.
- The cron skips customers with a pending cancellation, and sends the "pause ends soon" email 7 days ahead (stamped `pause_ending_notice_sent_at`).
- The webhook's resume detection is at `src/app/api/webhook/stripe/route.ts:857` onwards.

**Billing and credits during a pause**
- Invoices are voided, so `invoice.paid` never fires and `credit_invoice` never runs. **No lead credit accrues**, and the existing balance carries over. Locked decision 1 already holds for lead credits.
- Stripe's billing cycle keeps running underneath, so the first real charge after a resume lands at the next natural cycle boundary (§11).
- ⚠️ **The replacement grant DOES accrue while paused**, by the owner's decision in §61 (`replacement_monthly_grant`, 0153:90–105, applied in `reset_monthly_counts`, 0160:406). This is C2.
- The monthly batch review excludes paused customers (0160:233).

**Routing and capacity**
- `paused_at` is honoured by every candidate function, including the brief pool (0163:326).
- It is also honoured by `assign_lead_to_customer`, `admin_assign_lead`, `admin_swap_lead_assignment`, the expired pool, and the §64 owed-replacement functions.
- Paused customers are excluded from `src/lib/capacity.ts` and `get_service_capacity`.
- They are **not** excluded from `fetchAreaContention` (`src/lib/filterPrediction.ts:809-811`).

**Production:** 7 pause episodes, 6 of 3 months and 1 of 2 months. None at 1 month.

## 2. Top-ups: the purchase flow exists

| Piece | Where |
|---|---|
| Portal | `src/app/dashboard/topup/`, then `src/app/api/customer/topup/route.ts` |
| Emailed link | `src/app/topup/[token]/`, then `src/app/api/topup/[token]/route.ts` |
| Stripe logic | `src/lib/topupCharge.ts`, `src/lib/chargeIntent.ts` |
| Pack | 5 leads for £75 (`src/lib/topup.ts:22-25`) |
| Credit granted by | `record_lead_topup_success` (latest body: 0153:298–356), called from the webhook at 1698–1800 (`checkout.session.completed` and `payment_intent.succeeded`). Batch 02 also changed this file. |
| Eligibility | `topupIneligibilityReason` (`topupCharge.ts:164-199`) refuses paused and past-due Management customers. |
| §69 filter acknowledgement | Always null for a brief customer, because brief customers are `filter_status = 'off'`. |

⚠️ **Top-up credit is not tracked once granted.** `record_lead_topup_success` adds 5 to `lead_balance` and banks one replacement. Nothing remembers which credits came from a top-up. "Top-up credits draw from beyond the area" therefore needs a new counter (Phase 4 design below).

## 3. Counting short pauses as committed demand

- **The engine has no allocation-based committed demand.** `leadShare` / `weightedSupplyByOutcode` (`src/lib/leadBrief/eligibility.ts:59`, `:77`) share each lead by headcount (`maxPerLead / competitors`).
- Competitors come from:
  - legacy filtered customers, through `fetchAreaContention`;
  - other **active** briefs, through `fetchOtherBriefs` / `toOtherBriefs` (`src/lib/leadBrief/supply.ts:143-177`), which also feed first picks.
- **Neither excludes paused customers.** So a customer on a short pause is already counted, and locked decision 2 holds with no change.
- **A long pause** (locked decision 3) needs one change: `toOtherBriefs` skips a brief customer whose current pause does not hold the area. That frees their area and their first picks for new sign-ups.
  - The change stays inside `supply.ts`: widen the select and add one branch to a pure function, with a unit test.
- `fetchAreaContention` is left alone. It also drives the §28 filter forecast, and existing customers must not change. Brief customers are filter-off, so they never appear in it anyway.

## 4. Conflicts, each quoting the doc section checked

- **C1. Sequencing.** "Run only after: the Lead Brief and its additions are merged" (batch 04 header). See §0. Decided.
- **C2. Replacements while paused.** Batch 04 locked decision 1 ("owed nothing for the paused period") against CLAUDE.md §61.1 ("A paused customer does [accrue]"). Decided: brief customers stop accruing.
- **C3. "top-up" in reason copy.** Additions A9 ("Never use: … top-up (in label or reason copy)") against batch 04 locked decision 6 ("From just outside your area, as part of your top-up."). Decided: batch 04 wins for that one reason.
- **C4. Holding delivery on a monthly widening.** Batch 04 Phase 3 ("Delivery is held until they confirm") against A10 (the widening is a new `pending_confirmation` version while the old one stays active) and A1 ("Every lead you pay for is delivered"). Decided: only returns are held.
- **C5. "Switch to 10 leads" while paused.** Batch 04 Phase 3 offers it on the confirm screen. The plan route refuses a paused Management customer (`src/app/api/customer/subscription/plan/route.ts:127-135`). Proposal: the screen confirms first (which resumes them), then switches. *Raise at Phase 3.*
- **C6. "Pause for 4 weeks" against month-based pauses.** Batch 04 Phase 2 ("[Pause for 4 weeks] [Choose a longer pause]", "28 days or fewer") against the existing 1/2/3-month choice. "1 month" can run 31+ days, which would make it a long pause. A brief pause needs a day- or date-based return, so `subscription_pauses.months` (`not null`, CHECK 1–3) must allow a null. *Raise at Phase 1.*
- **C7. Top-up distance cap.** Batch 04 locked decision 6 ("never beyond the plan maximum distance (40 or 75 miles)") against the engine. `computePaceOutcodes` (`src/lib/leadBrief/areas.ts:95`) is called with `service.capMiles` (`preview.ts:146`), which is the smaller of the travel limit and the plan maximum. The 0162 comment on `pace_outcodes` says "out to the plan maximum". *Raise at Phase 4.*
- **C8. The WhatsApp event for n8n.** Batch 04 Phase 2 ("emit an event n8n can pick up"). No outbound event mechanism exists: the only n8n code is inbound (`src/app/api/webhook/n8n`, `N8N_WEBHOOK_SECRET`). The options are a polled outbox table or a signed POST to an env-var URL. *Raise at Phase 2.*
- **C9. One change in flight (new on `362a83f`).** 0164's `customer_lead_briefs_one_in_flight` allows only one of `scheduled` or `pending_confirmation` per customer, and `save_scheduled_lead_brief` supersedes a pending row ("a customer's own area save supersedes a pending one"). The editor does not refuse a paused customer. So:
  - a long-paused customer who saved an area change blocks the recalibration's pending row;
  - an area save made after the recalibration cancels it.

  Proposal: recalibrate from the scheduled row's inputs and replace it, so the customer's newer choice is the one recalibrated. *Raise at Phase 2.*
- **C10. Confirming a pending brief (new on `362a83f`).** `promote_lead_brief` (0164:162) only promotes a `scheduled` source. Extending it would replace a 0164 function that Lead Brief Phase 6 may also touch. Proposal: a new `confirm_pending_lead_brief` that takes the same advisory lock (`'lead_brief:' || customer_id`) and supersedes before it activates (the one-active index is not deferrable). *Raise at Phase 3; run the function-overlap check against Lead Brief Phase 6.*

## 5. Existing pause defects found (affect every customer; out of scope for 04, reported only)

1. **A customer with a pending cancellation can still pause.** The pause email then promises an automatic restart that never comes (`pause/route.ts:128-163`, `src/lib/emails.ts:806`).
2. **The "pause ends soon" email offers "Change plan"** (`emails.ts:971`), but the plan route refuses paused customers.
3. **The pause card shows for customers with no `stripe_subscription_id`.** The route then returns 409 (`SettingsPanel.tsx:262-264`).
4. **The route writes `paused_at` before the Stripe call.** A subscription event processed in between, or one delivered out of order, can clear the pause (`webhook/stripe/route.ts:857` onwards). That leaves Stripe paused and the database not.
5. **`fetchAreaContention` counts paused customers**, so legacy filter quotes read low. That is the safe direction.
6. **A stale comment**: `pauseOptions.ts:10` points at `0077_…`; the file is `0084_…`.

---

## Phase plan (each ends with STOP, a status-row update in `00-index.md`, a draft PR, and a merge on approval)

- **Phase 1 — Data**, one new migration (0167, or the next free number at merge):
  - `customers.pause_holds_area boolean`: live state, null when not paused. This follows §21's split: live state on `customers`, history in the table.
  - `subscription_pauses` gains `hold_area`, `recalibrated_at` and `pending_brief_id`, and `months` may be null for a date-based brief pause (C6).
  - `customer_lead_briefs` gains `effective_at` (the return date, or the widening's renewal date) and `auto_accepted_at`. `confirmed_at` already exists.
  - The C2 brief branch in `replacement_monthly_grant`, plus its TypeScript twin.
- **Phase 2 — Pause flow:**
  - Brief-only branches of the pause card and route: 28 days, or a return date up to today + 3 months. `hold_area` is true at 28 days or fewer. The non-brief path stays byte-identical, pinned by a guard test.
  - `toOtherBriefs` releases customers on a long pause.
  - The resume cron:
    - recalibrates long-paused brief customers 7 days out: `loadBriefSupply`, then `computeBriefPreview`, then a `pending_confirmation` row with origin `recompute`, then the Resend email, then the n8n event (C8), handling C9;
    - does not auto-resume a customer whose pending brief is still unconfirmed.

    Existing customers have a null `pause_holds_area`, so their path is unchanged.
- **Phase 3 — Confirm screen:**
  - A gate in `dashboard/layout.tsx` next to `needsLeadBrief`, skipped while an admin is viewing as the customer (§62).
  - `confirm_pending_lead_brief` (C10). On confirm, first picks are recomputed, then `resumePausedCustomer` runs if this was a return.
  - "Extend my pause" as a new action, bounded by the existing maximum.
  - "Switch to 10 leads" (C5).
  - A daily 72-hour auto-accept cron, registered in `vercel.json`, sending the Resend email.
  - "Area updated [date]" on the "Your brief" bar.
- **Phase 4 — Top-ups:**
  - A `customers.brief_topup_credits` counter, increased by a redefined `record_lead_topup_success`. Run the function-overlap check against any batch touching it.
  - Spent through a wrapper RPC that calls `assign_lead_to_customer` unchanged and then decrements the counter in the same transaction.
  - Admission of beyond-area outcodes: a NEW function or a non-defaulted signature beside `get_brief_candidates_for_lead`, never a defaulted extra parameter (the §34/§35/§63.3 overload trap). Respect C7.
  - The "How top-ups are delivered" notice, for brief customers only.
  - The C3 reason.
- **Phase 5 — Docs:** a CLAUDE.md section "Area changes, pauses and top-ups (brief customers)", with `npm run gen:context`.

## Verification (every phase)

- `npx tsc --noEmit`, `npm run lint`, `npx vitest run`, `npm run build`, plus the SQL suites for any migration (scratch Postgres from empty, re-applied for idempotency).
- Guard tests prove existing customers' pause, top-up and area behaviour is byte-identical.
- Migrations are applied to production after the rebase and renumber, just before the merge (`00-index.md`, parallel merge rule 3).
- Anything needing a signed-in session is checked on `leads.stayful.co.uk` after the merge. Previews answer 302 to `vercel.com/sso-api` (§45) and run against production Supabase (§1.1).
