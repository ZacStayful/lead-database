# Phase 0 audit — inactivity-triggered assignment escalation

Audit only. No schema, no code. Findings against **live production** (`znlfwbnvhlacwzgfalcf`)
and `origin/main`, which is what Vercel deploys.

---

## 0. Before anything else: the branch was cut from a dead base

`claude/inactivity-escalation-5nlbqp` started 99 commits behind `origin/main`, at a
tree that predates migration 0026. Everything the brief asks Phase 0 to look for —
telemetry, engagement scoring, the nudge report — is invisible from there. Its 11
commits were the post-call-offer work, which `main` already carries as 0037.

The branch has been restarted from `origin/main`. Nothing was lost.

**This matters beyond housekeeping.** Several "locked decisions" and one "explicit
non-goal" in the brief describe the old tree, not the running system.

---

## 1. Four findings that change the brief

### 1.1 `max_assignments` already defaults to 3, not 2

Migration `0055_max_assignments_default_three.sql` (PR #55, "Send each new lead to
three operators instead of two"). Locked decision #1 — "global default stays at 2" —
is already false.

The default applies to **new** leads only. Production right now:

| `max_assignments` | Leads |
|---|---|
| 2 | 304 |
| 3 | 69 |
| 4+ | 0 |

So there is no global cap to reason about — a lead's reach is whatever its own row
says. A "2 → 3 → 4" ladder means different things on the two populations, and on
the 69 newer leads the first rung is already spent.

### 1.2 This feature already exists, and it is called soft reclaim

`0046_soft_reclaim.sql` + `/api/cron/reclaim-stale-leads`, live since 27 July,
running daily at 11:00. Compare to the brief:

| Brief | Soft reclaim (shipped) |
|---|---|
| Inactivity → release lead to one more operator | Same |
| Inactive = no passive activity | Same signals: `detail_opened` / `tel_click` / `mailto_click` / note / file |
| Original assignee keeps assignment, stays charged, no refund | Same, documented as the point of "soft" |
| Fires once per threshold per lead | Once per lead, ever |
| Only assignments after a cutoff date | `system_settings.reclaim_enabled_from` |
| Confirm a recipient exists before committing | Already does — a failed search leaves the lead unburned |

Differences: reclaim waits **three UK working days** (not 10/20 calendar), charges a
**reduced price** (£10 management, £7 GR), grants **one** extra slot rather than a
ladder, and picks the recipient by engagement score rather than pure deficit-first.

Shipping the brief as written produces a second system competing with this one for
the same leads, on the same signals, with a different clock.

### 1.3 Raising `max_assignments` is the mechanism soft reclaim rejected on purpose

Phase 2 step 4 says raise `leads.max_assignments` by 1. `0046` and `CLAUDE.md §9.3`
both document why that does not work:

> `ingest.ts` and `/api/admin/leads/assign-pending` both auto-fill any gap between
> `assignment_count` and `max_assignments`, at the **standard price through normal
> routing**. Incrementing the cap would hand the reclaimed slot away within 24
> hours, bypassing the discount and every reclaim rule.

The daily Monday sync (09:00) tops up every under-assigned lead. An escalation that
raises the cap at, say, 11:00 has until 09:00 the next morning before the sync fills
that slot through ordinary routing — ignoring the escalation's own intent.

Reclaim's answer: capacity = `max_assignments + lead_open_reclaim_slots(lead_id)`,
where the slot count is derived (granted − consumed) and normal routing is
structurally blind to it.

### 1.4 Lead filtering exists

The non-goal says postcode/bedroom/area filtering is "confirmed absent". It is live:
`0026_lead_filtering.sql`, `leads.postcode_area`, twelve `filter_*` / `gr_filter_*`
columns on `customers`, and `get_filtered_candidates_for_lead` /
`get_unfiltered_candidates_for_lead` — which are the functions `autoAssignLead()`
actually calls. `get_next_customers_for_lead` is now used only by the reclaim cron.

Any escalation slot routed "as normal" goes through the two-pool filtered/unfiltered
selection, not the single function the brief names.

---

## 2. The blocker: there is nobody to give an escalated slot to

| | Management | GR |
|---|---|---|
| Active customers | 20 | 2 |
| **With any lead credit** | **0** | **0** |
| Total credit across all active customers | **0** | **0** |

Every active customer has consumed their entire monthly allocation. Most did it
within a day or two of their billing anchor — Rory Gray took 20 of 20 between 10 and
11 August; Muazzam Ali 10 of 10 in the same window.

Meanwhile **265 of 374 leads are under-assigned** — they cannot place because no one
has credit. `CLAUDE.md §4` already frames this correctly: banked leads are inventory,
not a backlog.

The existing feature demonstrates the consequence:

- **57 assignments qualify as reclaim candidates right now.**
- **0 reclaims have ever been executed** since the feature went live on 27 July.

Every candidate is skipped as `no_eligible_recipient`. Escalation's locked decision
#13 — only raise the cap once a replacement is confirmed available — means it would
behave identically: run daily, find candidates, find nobody to give them to, do
nothing.

**Escalation does not unlock stuck leads. The binding constraint is subscriber
credit, not the per-lead cap.** That is also, in advance, most of the Phase 4 answer:
capacity is subscriber-bound, and lead supply already exceeds what the current
subscriber base can absorb.

---

## 3. Phase 0 questions, answered

**1. Is the engagement programme live?** Yes, fully.

| Piece | Where |
|---|---|
| Passive telemetry | `0043_lead_events_and_auto_contact.sql` → `lead_events` (421 rows) |
| Event vocabulary + `nudge_sent` | `0044_nudge_sent_event.sql` |
| Engagement scoring | `0047_engagement_and_benchmarks.sql` → `engagement_score_params()`, `get_customer_engagement_scores()` |
| Search-path fix | `0048_engagement_params_search_path.sql` |
| Notification preferences | `0034_notification_preferences.sql` |
| Soft reclaim (the consumer) | `0046_soft_reclaim.sql`, `/api/cron/reclaim-stale-leads` |
| Telemetry write path | `POST /api/customer/events` |
| Docs | `CLAUDE.md` §3, §6, §7, §10 |

**2. Last-login log and the uncontacted-leads report.** Both confirmed, as Zac said.

- **Last login** is `auth.users.last_sign_in_at`, maintained by Supabase Auth. 22 of
  25 users populated; range 21 Jul – 12 Aug. No app column mirrors it —
  `customers.first_login_at` (0030) is first sign-in only. An unmerged branch,
  `claude/admin-last-active-column`, surfaces `last_sign_in_at` in the admin table
  (2 files, no migration).
- **Uncontacted-leads report** is `/api/cron/inactivity-nudge`, Mondays 10:00.
  Selection: assignment in `status ∈ (new, contacted)`, `last_status_change_at` ≥ 48h
  ago (tunable via `STALE_LEAD_THRESHOLD_DAYS`), no note. One grouped email per
  customer, deduped by `customers.last_nudge_sent_at` and per-lead by a `nudge_sent`
  row. **140 nudges sent 3–10 August.** Supports `?dryRun=true`.

**3. `system_settings` schema.** `(key text primary key, value text not null,
updated_at)`, RLS on with no policies — service-role only. Four keys live:
`max_active_customers` (14), `gr_max_active_customers` (10), `reclaim_enabled_from`,
`telemetry_from`. New keys are pure inserts; zero risk to `max_active_customers`.
Note `POST /api/admin/settings/capacity` **upserts** — an `update` against an
unseeded key matches zero rows and still reports success. Copy the upsert.

**4. Is `UPDATE leads SET max_assignments` safe outside the assignment transaction?**
Technically yes — `assign_lead_to_customer` holds its `FOR UPDATE` row lock only for
the duration of its own call, so a plain `UPDATE` either waits briefly or proceeds;
no deadlock path, since the escalation job would take one lock and the RPC takes
lead-then-customer in a fixed order. **But see 1.3 — it is safe and still wrong.**

**5. Can `get_next_customers_for_lead` be dry-run?** Yes, no new variant needed. It
and both two-pool functions are `language sql` / `stable` with no writes — calling
them is already a read-only check. `/api/cron/reclaim-stale-leads` does exactly this:
calls it with a `CANDIDATE_POOL` of 10, filters, and only then commits.

One caveat to design around: the check is **advisory**. Credit can be spent between
the check and the assign, so `assign_lead_to_customer` re-checks capacity and balance
under lock and raises. It fails closed — treat a raised exception as "no slot", not
as an error.

**6. Report before Phase 1.** This document. No schema or code written.

**7. Overlap check.** Covered in 1.2 and 3.1. Nothing about engagement scoring is
"still just a brief" — it is live, documented, and already wired into routing for
reclaim recipients. Recommendation: **extend it, do not build alongside it.**

**8. Weighting proposal.** Below, for sign-off.

---

## 4. Engagement weighting — proposal, not a decision

### What already exists

`engagement_score_params()` holds every tunable in one place: open-rate weight 0.35,
contact-rate weight 0.65, 30-day window, 5-assignment minimum. That is a **per-customer
rate** model — "how hard does this operator work their leads in general" — and it
chooses reclaim recipients.

This feature needs a **per-assignment** score: "has anything happened on *this* lead".
Different question, same signals. Proposal: add the per-assignment weights to
`engagement_score_params()` as a second row rather than a new function, so both models
stay tunable in one migration and cannot drift.

### Proposed per-assignment weights

| Rank | Signal | Source | Weight | Reasoning |
|---|---|---|---|---|
| 1 | `tel_click` | `lead_events` | **0.45** | The only signal the system already trusts enough to auto-flip status to `contacted` (0043 §4d). Ringing the landlord is the act. |
| 2 | `mailto_click` | `lead_events` | **0.30** | Split from tel deliberately: 0043's own reasoning is that a mailto click opens a client with no guarantee anything was sent. |
| 3 | `note_added` | `lead_notes` | **0.25** | Direct evidence of work, and costly to fake. Already triggers the contacted flip. |
| 4 | `stage_changed` off `cold` | `lead_events` | **0.15** | Self-reported, but an operator who moves the pipeline has invested in the lead. |
| 5 | `detail_opened` | `lead_events` | **0.10** | Proves it was read, not worked. |
| 6 | Notification read | `notifications.read_at` | **0.05** | Weakest positive; its *absence* is the earliest warning. |
| 7 | Login in window | `auth.users.last_sign_in_at` | **0.05** | Necessary, not sufficient — and account-wide, so it says nothing about this lead. |

Score = sum of present signals, capped at 1.0. Proposed thresholds: **inactive below
0.20 at day 10**, **below 0.35 at day 20** — so an operator who opened the lead and
logged in (0.15) is still inactive at day 10, and one who opened it and emailed
(0.40) is not.

### Three corrections to the signal list in the brief

- **`contact_clicked_at` does not need building.** `tel_click` and `mailto_click` have
  been recorded in `lead_events` since 27 July, with a timestamp and an index. A new
  `lead_assignments.contact_clicked_at` column would be a second, disagreeing record
  of the same click. The brief calls this "the one genuinely new piece of tracking in
  this build" — it isn't; there is none.
- **Drop `viewed_at`.** `CLAUDE.md §11`: it is set *only* by expanding a card in the
  feed, never by opening `/dashboard/leads/[id]`. A lead read end-to-end via the email
  link leaves it null forever. `detail_opened` is the honest signal; scoring both
  double-counts one and misreads the other.
- **The strongest signal is almost never present.** Across 298 assignments there have
  been **2 `tel_click`s and 1 `mailto_click`** in 16 days, against 278 `detail_opened`.
  A model that leans on contact-clicks would mark essentially every assignment
  inactive. Either operators contact leads without clicking through the portal — they
  have the number in the email and the SMS alert — or they are not contacting. That
  question needs answering before any threshold built on click data can be trusted,
  and it is a better use of the next fortnight than the ladder itself.

---

## 5. Decisions needed before Phase 1

1. **Extend soft reclaim, or build a parallel escalation?** Recommend extending: turn
   its single slot into the 10/20-day ladder and keep the derived-slot mechanism, so
   the sync cannot defeat it. Building alongside gives two jobs racing for the same
   leads on the same signals.
2. **What is the ladder now that the default is 3?** With reclaim already able to add
   a fourth operator, "hard stop at 4" is currently reachable without this feature.
3. **Is this the right thing to build at all right now?** With zero available credit
   across every active customer and 265 leads unable to place, an escalation ladder
   has nothing to escalate into. Recommend running the Phase 4 capacity analysis
   *first* — it is independent of the build, and it addresses the constraint that is
   actually binding.
4. **Approve or adjust the weights** in §4, including the three corrections.

Phases 1–3 are on hold pending 1–4.
