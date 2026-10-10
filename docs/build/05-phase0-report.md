# Batch 05 — Phase 0 report (not yet reviewed)

Written on 10 Oct 2026 for Zac's review. Nothing here is decided until he approves it. **The decision register is not in the repo** (it lives in the Claude project as `claude/decision-register.md`), so the batch prompt's locked decisions, committed alongside as `05-address-change-guard.md`, stand in for it.

The audit first ran on `main` @ `21cca1c` (6 Oct), before any Lead Brief code existed. It was re-run on `main` @ `104a2f2` (10 Oct). Line numbers below are for `104a2f2`.

## Orientation

- **This session:** batch 05, Phase 0 (audit only, then STOP).
- **Merged:**
  - Lead Brief Phases 0–5B: migrations 0161–0164, covering the engine, questionnaire, routing, labels and the "Your brief" editor. `lead_brief_enabled` is off.
  - Batch 01, folded into the Lead Brief Phase 0 report.
  - Batch 02, complete (0165, CLAUDE.md §75).
  - Batch 03 Part A, Phases 1–2 (0166, §76).
  - Batch 04, Phase 0 only: no code yet.
- **What 05 depends on:** batch 04 merged, because 05 ends on 04's confirm-on-login screen (index: "Never run together … 04 and 05. 05 needs 04's confirm screen"). Nothing depends on 05.
- **Docs read:** `00-index.md`, `lead-brief-build-prompt.md`, `01-lead-brief-additions.md`, `02-phase0-report.md`, `02-funnel-and-checkout.md`, `04-phase0-report.md`, `04-area-changes-pause-topups.md`, and this batch's prompt.

## 0. Status: blocked on batch 04

Phases 1–4 cannot run yet:

| What 05 needs | On `104a2f2`? |
|---|---|
| A stored base postcode | **Yes.** `customer_lead_briefs.base_postcode` / `base_outcode` (0162), one row per brief version |
| A `pending_confirmation` version | **Schema only.** It is in the status CHECK (0162). 0164 allows **one change in flight per customer**, `scheduled` or `pending_confirmation` (`customer_lead_briefs_one_in_flight`, 0164:61) |
| The "Your brief" editor | **Yes** (Lead Brief Phase 5B): `src/app/dashboard/leads/brief/page.tsx`, `BriefAreaEditor.tsx`, `/api/customer/lead-brief/edit` |
| The confirm-on-login screen | **No.** Batch 04 Phase 3, not built |

## 1. Where the business postcode is shown and edited today

- **Stored:** on each brief version (`customer_lead_briefs.base_postcode`, canonical `"YO10 5DD"` or just `"YO10"`).
- **Shown:** on the brief bar and in the editor (`editCopy.ts` `areaLine`), and in the questionnaire and funnel step `WhereStep.tsx`.
- **Written when a brief is first confirmed:** `POST /api/customer/lead-brief`. This happens once. A second confirm finds `lead_brief_completed_at` set and writes nothing.
- ⚠️ **It was editable after confirmation.** The area editor (`BriefAreaEditor.tsx`) rendered the postcode as an ordinary input. `POST /api/customer/lead-brief/edit` then saved the changed postcode as the `scheduled` version, and `/api/cron/activate-lead-briefs` makes that version active at the next renewal. That breaks locked decision 1 outright, and it is the gaming route this batch exists to close.
  - **Closed ahead of 05, with Zac's go-ahead on 10 Oct** (see §4): the editor now shows the postcode read-only, and both editor routes refuse a different one.
  - No customer could have used it. `lead_brief_enabled` is off, and production held **no `customer_lead_briefs` rows at all** on 10 Oct (one customer flagged `lead_brief_required`, none completed).
- **Funnel:** `funnel_sessions.base_postcode_locked` locks the postcode for a funnel link at its first preview (02 Phase 2).
  - ⚠️ **The lock does not carry past payment** (§3, conflict C2).
- **Not the business postcode:**
  - `filter_radius_outcode` / `_place` (0094, 0157): the lead-filter selector;
  - `leads.postcode` / `postcode_area`: the lead's own address;
  - `ad_profile.city` (0156): ad copy;
  - `referral_*` (0131): contact details.

## 2. Admin nav, and the pattern to reuse

**Nav.** `src/app/admin/layout.tsx:29-72` builds `navGroups`, and `MobileNav` flattens the same list. Add `{ href: "/admin/address-requests", label: "Address requests" }` to the **Customers** group, beside Customers and Offers.

**Pattern: the dead-lead claims flow (§51.8).**

- **Table:** `lead_quality_claims` (0137) has a `status` CHECK, plus `reviewed_by`, `reviewed_at` and `review_note`.
  - A partial index on pending rows serves the queue.
  - RLS is on with **no policies**. 0162 records the same choice for the brief tables (C19), over the select-own policy its prompt asked for.
- **Decision:** `resolve_dead_lead_claim` returns false when the claim is already settled, and the route turns that into a 409. The claim is made by the write.
- **Route:** `src/app/api/admin/quality-claims/[id]/route.ts`.
  - Admin session only, never `x-admin-key`.
  - The body is `{action, note}`, with `action` checked against a closed list.
  - A decline with no note is refused.
- **UI:** `src/components/admin/QualityClaimActions.tsx` arms Decline before confirming, and Decline stays disabled until a note is typed.
- **Arrival email:** `sendDeadLeadReviewEmail` (`src/lib/emails.ts:1754`) goes to `supportTo()` (`:217`).
- ⚠️ **On a decision, that flow emails only an upheld claim.** Batch 05 needs both an approval email and a decline email, and the decline carries Zac's note.
- **Cron:** register it in `vercel.json` and copy the auth from `src/app/api/cron/stayful-conflict-sweep/route.ts:33`. That pattern fails closed, falls back to an admin session, and exports both GET and POST.

## 3. Conflicts and questions for Zac

| | Question | What the docs say |
|---|---|---|
| **C1** | **An approved change against a change already in flight.** 0164 allows one `scheduled` or `pending_confirmation` row per customer (`customer_lead_briefs_one_in_flight`). An approved address change that comes due while the customer has a scheduled area change, or a pending monthly widening (A10, Lead Brief Phase 6), cannot be written. Which wins? Options: <br>(a) the address change replaces the waiting row; <br>(b) the cron waits until the slot is free; <br>(c) approval is refused while a change is in flight. | Silent. 05 was written before 0164. The nearest rule is 0162's "a second recompute replaces the waiting one" |
| **C2** | **A funnel payer can change their postcode when confirming.** The confirmation wizard (`BriefWizard.tsx`, 02 Phase 5) says "they can go back and change any answer", and `WhereStep` is not passed the lock there. Should the funnel lock carry into the confirmation? | Both docs say the postcode is locked. 05 locked decision 1: "For funnel customers it is already locked at their first preview." 02 prompt (`02-funnel-and-checkout.md:145`): "Changing it means contacting Zac." But 02's C1, approved 9 Oct, built a confirmation wizard where any answer can be changed. **Not changed here**, because it would override behaviour Zac approved |
| **C3** | **Which `origin` the applied version carries:** `customer`, `recompute` or `admin`. | Silent. The customer asked and Zac approved. `admin` reads truest |
| **C4** | **The RLS posture.** The prompt asks for a select-own policy. | 0162's header records C19 choosing RLS on with no policies, every read through a server route. Proposal: the same here |
| **C5** | **Testing on a preview.** Phase 3 asks for the flow to be verified on a preview. | A preview runs against production Supabase (§1.1) and returns 302 behind Deployment Protection (§45). Proposal: a SQL suite on scratch Postgres, guards, then one deliberate test on `leads.stayful.co.uk` with the delay shortened through a `system_settings` key in the `/admin/allocation` allow-list |
| **C6** | **The daily cron makes "72 hours" up to 96.** | The prompt says a daily cron. Either the copy says "from" a date, or the cron runs hourly |

## 4. What shipped with this report (10 Oct, with Zac's go-ahead)

The postcode lock in the editor. **No migration** and no flow: this does not build Phases 1–4, it only stops the editor contradicting locked decision 1 before `lead_brief_enabled` goes on.

- `basePostcodeChanged()` in `src/lib/leadBrief/editBrief.ts`.
  - It compares canonical forms, so "yo105dd" against a stored "YO10 5DD" is not a change.
  - It is strict between an outcode and a full postcode inside it ("YO10" to "YO10 5DD" is a change).
- Both editor routes answer 409 `postcode_locked` before any compute or write: `/api/customer/lead-brief/edit` and `/edit/preview`.
- `BriefAreaEditor` passes `postcodeLockedNote` to `WhereStep`, the same affordance the funnel uses, and names the refusal.
  - The new copy says to get in touch through Support.
  - It does not mention a review, because none exists yet.
- Phase 2 replaces that note with the "Request a change" link.
- Guards and unit tests, mutation-checked: 10 mutations, all caught.

Next: **re-run this Phase 0 once batch 04 is merged**, with C1–C6 answered.
