# Batch 03 Part A — Phase 0 report and phase plan (approved 9 Oct 2026)

This is the audit Phase 0 asks for. Zac approved it on 9 Oct 2026, with **E1–E10 decided as proposed** (numbered only within batch 03). Later phases cite them by number.

## Orientation

- **This session:** batch 03 Part A, Phase 0 (audit only). Part B (Monday labels, n8n messages, the Meta thank-you screen) runs in a Claude chat and is not touched here.
- **Merged:** Lead Brief Phases 0–5B. 01 is folded into the Lead Brief Phase 0 report. **02 is complete**: Phases 0–6 merged 9 Oct (CLAUDE.md §75, migration 0165). 03–07 have not started.
- **Depends on 03:** nothing downstream. 03 Part A needed 02 merged, and it now is.
- **Docs read:**
  - `00-index.md`;
  - `02-funnel-and-checkout.md` and `02-phase0-report.md` (C1–C9);
  - `lead-brief-build-prompt.md` and `01-lead-brief-additions.md`;
  - CLAUDE.md §75 (the funnel), §55 and §57 (the enquiry chase and sync), §23 (Monday sync) and §70 (retention).
- **Not in the repo:** `decision-register.md`. The index says it lives in the Claude project. The 03 prompt's "Locked decisions" stand in for the register, as the 02 prompt's did.

**Live state, read 9 Oct (production and Monday board 18420649520):**

| Item | State |
|---|---|
| `funnel_enabled` | `false` |
| `lead_brief_enabled` | `false` |
| `prospect_nudge_enabled` | `false` |
| `enquiry_sync_enabled` | `true` |
| `funnel_sessions` | 0 rows |
| `post_call_offers` | **0 rows**: the app's post-call code has never been issued |
| `customers.signup_source` | `call` on all 110 rows |
| Board labels "Funnel started" / "Funnel finished, not paid" | **not created yet** |
| Board column "Sign-up source" | **not created yet** |

**n8n, read-only, the workflows Part B will edit:**
- **"Lead Database: Enquiry Chase (2 min + 10 days)"** (`9p0fmPvbjGS2Xwph`, active) sends the instant WhatsApp and email (T1, within minutes), then touches on days 2, 4, 7 and 10, and sets "Chased no booking" on day 11.
- **"Lead Database: Post-Call Follow-up (9pm + 10 days)"** (`BX8AxHa68UX0UkV0`, active) is the 9pm message. It hard-codes the raw `buy.stripe.com` Payment Links: management 10 and 20, and GR 10. It never calls the app's post-call offer route, which is why `post_call_offers` is empty.
- **"Lead Database: No-Show Rebook Sequence"** (`E8E5zHyVd1DpVLx0`, active).

---

## Q1 — The Monday client helpers, and how status is written today

All Monday writes are in `src/lib/monday.ts`, and each returns a result object rather than throwing. The one exception is `createEnquiryContact`.

| Helper | Line | What it writes |
|---|---|---|
| `setEnquiryStatus` | :658 | Status `color_mm5eda07` **by label text** (`{ label }`, :686), plus optional start date, end date and `text_mm6c5qba`, in one `change_multiple_column_values` with `create_labels_if_missing: false` (:713). Any board but `enquiryBoardId()` (:183) is refused |
| `setEnquiryCancellation` | :800 | The precedent for a second status column (`color_mm7n8j39`, by text, :841). It reads both cells first and skips when they are unchanged |
| `setEnquiryMobile` | :615 | The phone text cell |
| `createEnquiryUpdate` | :754 | An item update; no columns |

**Reads:**
- `fetchEnquiryItem` (:1135) reads one item: its board, emails, phone key and **current status text**.
- `fetchEnquiryBoardIndex` (:939) reads the whole board.

**Labels:**
- `ENQUIRY_STATUS` (:263) holds the six labels the code owns.
- `ENQUIRY_CHASE_STATUS` (:290) and `ENQUIRY_NEW_LABEL` (:307) hold the chase and new-enquiry labels.
- **No env var holds a label id today.** Every status write is by text.

**The guard Phase 2 needs already exists:** `mayWriteChaseLabel` (:328). It allows an empty cell, "New Enquiries", "Chasing to book" or "Chased no booking", which is exactly the Phase 2 allow-list. Its one caller reads the cell, applies the guard and only then writes: `writeChaseLabel` in `src/app/api/cron/prospect-nudges/route.ts:487`. Because it is an allow-list, it also protects every label the prompt lists as never to be overwritten.

**"Management Customer" on payment** comes from `syncCustomerMondayStatus` (`src/lib/mondayStatus.ts:316`, item resolution at :611). The webhook calls it in `invoice.paid` Management at `src/app/api/webhook/stripe/route.ts:1506`. `completeFunnelPayment` runs earlier, at :1203. It puts the session's Monday item onto the customer row, so that push finds the item (§75.7). A Sign-up source write belongs after :1506, in its own try/catch (§23.6: nothing may throw out of the webhook).

**Finding an item for a cancelled customer:** `pushCancellationToMonday` (`src/lib/cancellationMondaySync.ts:42`) and `pickCancelItem` (`src/lib/mondayCancel.ts:141`) match by email, falling back to the linked item. They never create an item.

## Q2 — Can the post-call flow create a funnel session for a "meeting sat" enquirer?

**Yes.** The hook point is the bearer path of `POST /api/admin/post-call-offer` (`src/app/api/admin/post-call-offer/route.ts`). Since 02 it:
- issues the code through `issuePostCallOffer` (`src/lib/postCallOfferIssue.ts:81`). This is the one path for a code, shared with the funnel discount, and it returns a live code unchanged;
- returns `/pay` links (`computeCheckoutUrls`) in place of Payment Links (route :89–110).

Adding a funnel session there means:

1. **Find or create** the open session for the prospect's email. One open session per email (§75.2) means it reuses the session from the instant message if one exists. Set `entry_point = 'post_call'` (subject to E1).
2. **Link the offer** as the session's `discount_offer_id`. The funnel discount (`issueFunnelDiscounts`, `src/lib/funnel/discount.ts:67`) skips a session that already has a code, so there is **never a second code**. `funnelSessionForOffer` (`src/lib/funnel/server.ts:78`) already maps an offer to its session.
3. **Return `start_url`** beside the existing `checkout_url_10` / `checkout_url_20`.

Three things this depends on:
- **The 9pm message does not use this route today** (see the n8n note above). Part B step 5 is what makes n8n call it.
- **The recap pays through `startFunnelCheckout`** (`src/lib/funnel/checkout.ts:39`). That refuses `preview_required` and `payment_not_open` (:45–46), the second while `lead_brief_enabled` is off. It also turns the payer into a Lead Brief customer (`lead_brief_required`, `src/lib/funnel/payment.ts:139–140`), unlike `/pay`. See E5.
- **The post-call body has no `monday_item_id`** (route :43–66). n8n has it, so the route can accept it. Otherwise the session takes the customer row's link.

## Q3 — Which admin page should hold the route report

**Proposed: a new page, `/admin/enquiry-routes`, in the Insights group** (`src/app/admin/layout.tsx:48–53`, beside Retention and Lead feedback).
- `/admin/retention` starts from a customer's first paid invoice and has no source dimension.
- `/admin/messaging` is the System group's switch page.
- No enquiry → paid report exists anywhere today.

The page reuses `MIN_COHORT = 5` (`src/lib/retention.ts:752`) and §70.5's rule that every rate prints its denominator. All the arithmetic goes in a pure `src/lib/enquiryRoutes.ts`, because vitest here runs pure units only.

---

## Conflicts and gaps, each quoting the doc section checked (all decided 9 Oct as proposed)

| # | Doc says | Conflict | Proposed |
|---|---|---|---|
| E1 | P1: "`entry_point`: instant / chase / no_show / post_call. It is passed by n8n to `POST /api/funnel/session`" | §75.1/§75.2: one email has one open session, and every later call returns `existing` (`session/route.ts:75–79`). Part B step 2 creates the session at the instant message, so every session would read `instant` and the Phase 4 split would be empty. The docs don't say which call wins | `entry_point` is the last one n8n sent **before the first answer**. It can be overwritten while the session has no answers, and freezes at the first answer. `offer_order` is written once, by the call that creates the session, and never overwritten: it is the cohort the alternate-week test reads. Unknown values are refused (400) |
| E2 | P2: "Funnel finished, not paid — same condition" (current status must be New Enquiries, Chasing to book or Chased no booking) | After the first transition the cell reads "Funnel started", so a literal reading never allows the second | The "finished" allow-list adds "Funnel started". The "started" list stays as written |
| E3 | P2 verify: "each transition writes once" | `funnel_sessions` has an `updated_at` touch trigger (0165:143–146). The discount selector (`discount.ts:82–93`) and "unpaid after 1 hour" both read `updated_at`. A claim column on that row would reset both clocks. Linking a discount also touches it, which would push the "finished" check back an hour | Claims go in a separate table, `funnel_monday_writes` (`session_id`, `transition`) primary key. Each is claimed by INSERT before the Monday call. The "finished" pass shares the discount's selector and runs **before** the discount pass in `/api/cron/funnel-discounts`, so neither moves the other's clock |
| E4 | P2: "Payment, any route → Sign-up source → funnel or call"; P4: "60-day churn split by `signup_source`" | §75.8: `signup_source = 'funnel'` when `completeFunnelPayment` made the login. A post-call recap payer goes through that path, so it reads `funnel`. C2's set-password prompt also keys on it. The docs don't say whether someone who sat a call but paid on the recap page is call or funnel | Leave `customers.signup_source` as 02 defined it. The Monday cell and the report use one pure `signupRoute()`: `call` when `signup_source = 'call'` **or** the paid session's `entry_point = 'post_call'`, otherwise `funnel` |
| E5 | P3: "The existing post-call step creates a funnel session … plan and pay through the guarded checkout" | The recap pays through `startFunnelCheckout`, which refuses while `lead_brief_enabled` is off and makes the payer a Lead Brief customer. `/pay` does neither | The route returns `start_url` **only** when `funnel_enabled` and `lead_brief_enabled` are both on. Otherwise n8n keeps sending the `/pay` links |
| E6 | P3: "skips the three questions if no answers exist and starts at a recap page: 'Here's what we covered', followed by the preview inputs" | A preview needs the where, travel and essentials answers, so "skips the questions" and "followed by the preview inputs" can't both apply to the same screens. The docs don't say what the inputs screen is | A recap screen, then the three inputs on **one** screen (the same step components), then the preview and the plan screen. A session that already has answers sees the recap, then resumes as today (`resumeScreen`, `src/lib/funnel/answers.ts:183`). The copy goes in `src/lib/funnel/copy.ts` for Zac to approve at the Phase 3 STOP |
| E7 | P2: write "Funnel started" on the first answer | §57: the enquiry sync ingests only items on "New Enquiries" (`src/lib/enquiry/enquiryItem.ts:73`), and anything else is **skipped and claimed for good** (:223). If a Facebook enquirer answers before the one-minute sync claims their item, they never get a waitlisted customer row. Payment still works, because `completeFunnelPayment` makes the row | Add both funnel labels to `INGESTABLE_STATUS_LABELS`. The sync's existing `already_linked` check still stops a duplicate |
| E8 | P4: "enquiries … enquiry → paid %" | Management vs GR is never stored in the database: `recordEnquiry` sends it to Monday only (`src/lib/enquiry/recordEnquiry.ts:150`). The session route refuses GR, so once Part B step 2 is live, every Management enquiry gets a `funnel_sessions` row | `funnel_sessions` is the enquiry ledger. "Paid via funnel" = session paid. "Paid via call" = the session's email became a Management customer with route `call`. The report counts from the n8n go-live date and says so |
| E9 | P4: "60-day churn split by `signup_source`" | The docs don't define it. §70.3 counts retention in invoices | Management customers whose first paid invoice is at least 60 days old. Churned = `cancelled_at` or `lapsed_at` within 60 days of that invoice. Paused excluded (§70.4), withheld below 5 customers, denominator printed. All 110 existing rows read `call`, so "since funnel switch-on" is shown apart from all-time. No figure until 60 days after the first funnel payer |
| E10 | Locked 1–2: label ids and the column id from env | House style writes labels by text with `create_labels_if_missing: false` (§23.1). The prompt doesn't say what type the Sign-up source column is | Locked, so followed. Write `{ index: <label id> }`, where Monday's `index` is the label's stable id, not its display position. A missing or non-numeric env var gives `skipped: "not_configured"`, never a text fallback. The guard still reads the current label's text. Proposed for Part B: make Sign-up source a **Status** column with exactly "Call" and "Funnel". The app writes those by text, and only the column id comes from env |

---

## Phases (each ends with STOP, a status-row update in `00-index.md`, a draft PR and a merge on approval)

**Phase 1 — data** (migration at the next free number, re-checked on main before the push; applied to production after the rebase and before the merge, per the index's merge rule)
- `funnel_sessions.offer_order` (`call_first` | `funnel_first`, nullable) and `entry_point` (`instant` | `chase` | `no_show` | `post_call`, nullable for rows from before 03), each with a CHECK.
- `funnel_monday_writes` (E3): RLS on, no policies, cascade from `funnel_sessions`.
- `POST /api/funnel/session` accepts both fields, checked against closed lists, with E1's overwrite rule.
- Verify: an SQL suite; the whole SQL suite on a scratch Postgres built from empty; a function-overlap check (03 replaces no function); a production fingerprint before and after.

**Phase 2 — Monday status sync**
- A pure `src/lib/funnel/mondayFunnel.ts` holding the E2 allow-lists, built on `mayWriteChaseLabel`, and `signupRoute()` (E4).
- A writer that writes a status by id from env, reading the cell first. It never throws.
- Wire it into:
  - the answers route on the first answer;
  - a "finished" pass in `/api/cron/funnel-discounts`, before the discount pass;
  - the Sign-up source write in `invoice.paid` Management after :1506, first invoice only, in its own try/catch;
  - the E7 change.
- File-text guards and a mutation check on every guard. Verify on one test item.

**Phase 3 — recap-and-pay**
- The post-call route's bearer path finds or creates the session, links the offer and returns `start_url` (E5).
- `/start/[token]` gets a recap mode (E6).
- Verify on a Vercel preview where possible. Deployment Protection (§45) leaves the signed-out funnel pages reachable only after merge, with `funnel_enabled` off.

**Phase 4 — route report**
- `/admin/enquiry-routes`, with the arithmetic in `src/lib/enquiryRoutes.ts` and its tests (E8, E9).
- Verify against direct SQL counts.

## Verification (every phase)

- `npx tsc --noEmit`, `npm run lint`, `npx vitest run`, `npm run build`, and every `supabase/tests/*_test.sql` on a scratch Postgres built from empty.
- A mutation check on each new guard (§42.8).
- Monday writes are checked on one test item that Zac picks, never on a real enquirer.
- **Before Phase 2 can be verified,** Part B step 1 must create the two labels and the Sign-up source column, and their ids must be set in Vercel.
