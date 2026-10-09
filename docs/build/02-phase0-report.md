# Batch 02 — Phase 0 report and phase plan (approved 9 Oct 2026)

Approved by Zac on 9 Oct 2026, with C1–C4 decided in that review. This is the repo copy, so later batches can read the decisions behind 02. The Lead Brief's own Phase 0 report is not in the repo, which is why it is cited only by codes (C7, C21, D4).

## Context

A Management enquirer should be able to buy without a call. The flow is a short funnel at `/start/[token]` (three questions, then a brief preview), then one guarded checkout shared by every route, so nobody is charged twice. Funnel payers then become active and land on a Lead Brief *confirmation* screen.

Zac said on 9 Oct that 02 should start now, with Lead Brief Phases 0–5B merged. Current state of the dependency:
- `main` @ `78730a1` has Lead Brief Phases 0–5B merged (migrations 0161–0164; the engine, questionnaire, routing, labels and editor).
- Phases 6 (admin Lead Reach) and 7 (copy and docs) are not built. 02 depends on neither.
- The index row still reads "02 waits". Updating 02's own row at the end of each phase records Zac's go-ahead. Lead Brief rows are not touched.

**Orientation**
- **This session:** batch 02, Phase 0 first. The phases follow, each with its own STOP gate.
- **Merged:** Lead Brief Phases 1–5B (#141–#146). 01 is folded into the Lead Brief Phase 0 report.
- **Depends on 02:** 03 Part A needs 02 merged (it writes to `funnel_sessions`). 03 Part B's live n8n edits need 02 deployed. 02 shares the Stripe webhook with 04, so if 04 runs alongside, the parallel merge rule applies.

**Docs read:** `docs/build/00-index.md`, `lead-brief-build-prompt.md` and `01-lead-brief-additions.md`. **Not in the repo:** `decision-register.md` (the index says it lives in the Claude project) and the 02 doc itself. The 02 prompt's "Locked decisions" stand in for the register.

---

## Phase 0 report (re-run on `78730a1`)

**What is new since the first pass**
- Next free migration is **0165**.
- **The engine works without a customer row.**
  - `computeBriefPreview(input, plan, supply)` (`src/lib/leadBrief/preview.ts:104`).
  - `loadBriefSupply(admin, { excludeCustomerId: null })` (`supply.ts:226`).
  - `previewForClient` (`preview.ts:284`) already returns everything 02's preview needs: both plan radii, tiers, similar areas with figures, trade-offs, the mix as a split, first picks, and the `bottleneck` can't-be-met options. It contains no volumes.
- `NEXT_PUBLIC_BOOKING_URL` exists as `BRIEF_BOOKING_URL` (`briefCopy.ts:47`). The A9 banned-word test is `briefCopy.test.ts:80-96`, run over a listed set of files.
- **Nothing sets `lead_brief_required = true` anywhere.** 0162's header defers that to a "go-live migration (last in the build)" that flips the default.
  - 0163 excludes `lead_brief_required` customers from both legacy pools (lines 111, 210).
  - Brief routing only runs when `lead_brief_enabled = 'true'`, which is currently **off**.
  - ⚠️ So a funnel payer flagged as required **receives no leads while that switch is off**. The funnel ships behind its own switch, and checkout refuses to start (falling back to "Book a call") unless `lead_brief_enabled` is on.
- **There is no confirmation mode.**
  - `BriefWizard` always starts empty at question 1 (`BriefWizard.tsx:41-56`).
  - The confirm route already recomputes and answers 409 `radius_changed` with a fresh preview (`api/customer/lead-brief/route.ts:75-84`).
  - The editor has the prefill pattern to copy (`BriefAreaEditor.tsx:35-60`).
- These files are unchanged since the first pass: webhook, `provisioning.ts`, the invite route, `postCallOffers.ts`, `post-call-offer/route.ts`.

**Still true (first-pass findings, file:line on `78730a1`)**
- **Becoming active:**
  - `invoice.paid` (management) finds the customer by `stripe_customer_id` (1178).
  - Unknown Stripe customers go to `provisionPaidSubscriber` + `sendAccountReadyEmail` (1210–1246).
  - Then `credit_invoice` (1369), promotion to `active` from `invited`/`waitlisted`/`cancelled` (1416–1420), the `renewalUpdate` (1424–1466), and `pushMondayStatus` (1476) runs last.
  - Capacity blocks nothing anywhere.
- **Payment Links:**
  - The only code that reads them is `computeCheckoutUrls` (`postCallOffers.ts:45-59`).
  - That feeds `/api/admin/post-call-offer` (149–153, 217–221, 244–248), `sendPostCallReminderEmail` (`emails.ts:324-357`) and the reminder SMS (`post-call-offer-reminders/route.ts:107-138`).
  - The links also appear in `.env.example:41-42` and `README.md:84-85`.
  - Outside the repo: the n8n "Web meeting sat" workflow, the three web-meeting skills, and any hand-sent templates.
- **Post-call offers:**
  - Created by 0037. The CHECK reads `source in ('manual','auto_monday')`.
  - A partial unique index on `lower(prospect_email) where redeemed_at is null` already enforces one live code per person.
  - The `FOUNDING10-` promotion code is created with `max_redemptions:1` and a 24h expiry (`post-call-offer/route.ts:35-61`).
  - Redemption is marked from invoice discounts (webhook 1194–1208), which works unchanged with a Checkout Session `discounts`.
  - The reminder cron is **not** in `vercel.json`.
- **Webhook:**
  - The claim is at 382–390 and the outer catch deletes it (1729–1734).
  - The `customer.subscription.*` management branch runs 581–746. On `canceled` it sets `account_status='cancelled'` on whichever row matches the Stripe customer (678–680).
  - Nothing reads subscription metadata. There is no `subscriptions.cancel` and no `customers.search` anywhere.
- **Auth:**
  - Login is password-only (`login/page.tsx:62`).
  - `/auth/confirm` accepts any OTP type (so `magiclink` works).
  - Every link today is a hand-built recovery `generateLink`.
- **Monday:** the "Management Customer" label comes free from `pushMondayStatus` once the row is active (rule 4). Enquiry-item matching uses `fetchEnquiryItem` (`monday.ts:1135`) or `fetchEnquiryBoardIndex` + `emailsFromCell`.
- **Helpers to reuse:**
  - `ukMobileE164`, `UK_MOBILE_ERRORS` (`leadQuality.ts`)
  - `normaliseEmail` (`emailAddress.ts`)
  - HMAC token pattern: `deriveReviewToken` (`batchReview/review.ts:54`) on `MESSAGING_TOKEN_SECRET`
  - `recordEnquiry` (`enquiry/recordEnquiry.ts:120`)
  - n8n bearer check (`webhook/n8n/route.ts:10-14`)
  - limiter shape: `consume_reset_budget` (0130)
  - `syncCustomerMondayStatus` (`mondayStatus.ts:316`)

**Conflicts, each quoting the doc checked**

| # | Doc says | Conflict | Proposed |
|---|---|---|---|
| C1 | 02 P5: "Write the preview snapshot as a `pending_confirmation` brief" | `customer_lead_briefs.customer_id` NOT NULL; origin CHECK has no `funnel`, and 0162's own test asserts that (`0162_..._test.sql:319`); A10 gives `pending_confirmation` to 04; 0164 allows one in-flight row per customer | **Decided 9 Oct:** the snapshot lives on `funnel_sessions`. `BriefWizard` gets a confirmation mode that opens on a prefilled preview. No Lead Brief schema change |
| C2 | 02 P5: "sign-in link … No password step" | Docs silent on how they sign in a second time: login is password-only | **Decided 9 Oct:** a Resend magic link (`generateLink({type:'magiclink'})` → `/auth/confirm?type=magiclink&next=/onboarding/brief`). After the brief is confirmed, the dashboard prompts them to set a password for future visits, keyed on `customers.password_set_at` being null and `signup_source='funnel'` |
| C3 | 02 prohibited list: "one additive call at a point Phase 0 identifies and Zac approves" | Cancelling a same-customer duplicate fires `subscription.deleted`, which cancels the real row (678–680); a duplicate's `invoice.paid` can arrive first and credit leads | **Decided 9 Oct:** prevent in checkout, plus 3 guarded touch points. Detection runs on `subscription.created` and at the top of `invoice.paid` management, before credit. A skip guard at the top of `customer.subscription.*` ignores recorded duplicates. Duplicates go in a `duplicate_subscriptions` table. It never throws |
| C4 | 02 locked 12: "up to three operators per lead"; 02 P3 FAQ: "maximum of three operators. Never more." and "within minutes of assignment" | Escalation goes to 5 (§18; 67 leads at 3+, §51.11); one-a-working-day release (§54); "within minutes of assignment" is banned at `publishedClaims.test.ts:142-143` | **Decided 9 Oct:** "Each lead normally goes to up to three operators at once." Speed answer from `releaseCopy.ts`: one a working day, sent by email, text and dashboard the moment it's yours |
| C5 | 02 P4: look up by "email … and by phone" | §57.3: phone alone never merges two people | Default: email decides; phone blocks only if the name also matches, otherwise proceed and email Zac |
| C6 | 02 P1: `token` unique | n8n must get the same URL back on every call | Default: store `token_hash` only; URL = HMAC(`funnel:` + session id) |
| C7 | Index: "No replacement copy appears in the funnel until this is decided" | A12 check 2's answer is not in the repo | Leave the sentence out |
| C8 | 01 A4 / locked 7: no volumes | — | `previewForClient` only, plus a key-set test on the funnel response |

---

## Phases (each ends with STOP, a status-row update in `00-index.md`, a draft PR and merge on approval)

Branch: `claude/epic-darwin-vdqyp9`, reset to `origin/main`. It is restarted from main after each merged PR.

**Phase 0 close-out (docs only)**
- Commit the 02 prompt verbatim as `docs/build/02-funnel-and-checkout.md`.
- Commit this report as `docs/build/02-phase0-report.md`.
- Set 02's row to: "Phase 0 approved <date>; started 9 Oct on Zac's go-ahead with Lead Brief 0–5B merged."

**Phase 1: migration `0165_funnel.sql`** (additive; applied to production before merge, after re-checking the number)
- `funnel_sessions`
  - RLS on, no policies.
  - Columns per the doc, with `token_hash` replacing `token`. Also `answers` (raw `BriefInput` + ticked similar areas), `preview_snapshot` (the `ClientBriefPreview`), `plan_selected`, `step` CHECK, `checkout_session_id`, `customer_id` FK, `discount_offer_id` FK to `post_call_offers`, `preview_count`, `preview_window_started_at`, `base_postcode_locked`, and timestamps.
  - Partial unique on `lower(email) where step <> 'paid'`.
- `customers.signup_source text not null default 'call' check in ('call','funnel')`. This backfills every row to `call`.
- Widen `post_call_offers.source` to add `'funnel'`.
- `customers.password_set_at timestamptz` (C2). Null means the password prompt can show.
- `duplicate_subscriptions` (C3): `subscription_id` pk, `stripe_customer_id`, `kept_subscription_id`, `detected_at`, `cancelled_at`, `refund_id`, `emailed_at`. RLS on, no policies.
- `consume_funnel_preview(p_session_id uuid, p_limit int, p_window_seconds int) returns jsonb`: increments, then returns the count. Security definer, `service_role` only.
- `system_settings`: `funnel_enabled` = `'false'`.
- **Verify:** `supabase/tests/0165_funnel_test.sql` (CHECKs, deny-all, ACLs, limiter at 21, idempotent re-apply); scratch Postgres 16 from empty; the full SQL suite; a production fingerprint before and after.

**Phase 2: session and preview API**
- `src/lib/funnel/` (pure where possible): token derive/verify, the closed-field answer parser, and the client response built field by field from `previewForClient`.
- Routes:
  - `POST /api/funnel/session`: n8n bearer. An existing active or paid Management customer gets `loginUrl`.
  - `GET /start/[token]`: redirects existing customers to `/login` with "You're already set up".
  - `POST /api/funnel/[token]/preview`: computes both plans server-side, enforces the limiter and the postcode lock, and refuses GR.
- **Tests:** no volume keys, refusal at 21, the postcode lock, the existing-customer redirect, and wiring guards on the real files.

**Phase 3: funnel pages**
- `/start/[token]` with three questions, the preview, "Why it works" and the plan screen. It reuses the step components `WhereStep`/`TravelStep`/`EssentialsStep` and `BriefPreviewView`.
- Save and resume. Exits on every screen: book a call, and send to my partner (`/start/[token]/summary`, which shows no contact details and has no pay button).
- The sample card uses `MatchLabelBadge` + `WhyThisLead` with anonymised reasons and a top/strong label, which avoids the editor link.
- Copy lives in `src/lib/funnel/copy.ts`. Add it to the A9 scan and `publishedClaims.test.ts`.

**Phase 4: guarded checkout**
- `src/lib/checkout/startManagementCheckout.ts`, in order:
  1. Existing-customer check (C5).
  2. Find or create the Stripe customer.
  3. Write `stripe_customer_id` and `monthly_allocation` onto the row.
  4. Reuse any open Management session for that Stripe customer (`checkout.sessions.list`).
  5. Create the session with `discounts:[{promotion_code}]`, `subscription_data.metadata.{source,funnel_session_id}`, and `lead_brief_enabled` required for the funnel.
- Routes: `POST /api/funnel/[token]/checkout` and `GET /pay/[offerToken]?plan=`.
- `computeCheckoutUrls` returns `/pay` URLs under the same field names, so the email, SMS, admin panel and n8n switch over with no other edits.
- **Webhook backstop (C3):** `src/lib/checkout/duplicateSubscription.ts`, which never throws.
  - Detection: the same Stripe customer, or another Stripe customer with the same email, already has an active Management subscription. The newer one is cancelled immediately, its first invoice is refunded, and Zac is emailed via Resend.
  - Touch points: (1) `subscription.created` management, (2) the top of the `invoice.paid` management branch, before credit, (3) a skip guard at the top of `customer.subscription.*` for recorded duplicates.
  - Each is wrapped in its own try/catch (§23.6).
  - Tests in `lapsePastDueGuard` and `mondayCancel` still pass.

**Phase 5: provisioning and discount**
- One additive call after `pushMondayStatus` (1476): `completeFunnelProvisioning`, gated on a `funnel_sessions` row at `checkout_started` for this customer. It does the following:
  - sets `signup_source='funnel'` and `lead_brief_required=true`;
  - creates the auth user and sends the magic link via Resend (C2);
  - the dashboard shows a "set a password for next time" card after the brief is confirmed. `/reset-password` stamps `password_set_at` through a small session-only route;
  - marks the session `paid`.
- Confirmation mode per C1: `onboarding/brief/page.tsx` reads the snapshot and `BriefWizard` takes an `initial` prop and opens on the preview. The existing confirm route recomputes and reports a radius change.
- Funnel discount:
  - Sessions at `previewed` for more than 1h and unpaid get a `FOUNDING10-` offer with `source='funnel'`, reusing the promo-creation path. The index guarantees one live code per person.
  - Register `post-call-offer-reminders` in `vercel.json`.

**Phase 6: docs**
- CLAUDE.md §74, "Self-serve funnel and guarded checkout".
- Env inventory: `NEXT_PUBLIC_BOOKING_URL`, `NEXT_PUBLIC_FUNNEL_DEMO_URL`.
- Correct the stale lines in §17 and §2.
- `npm run gen:context`.

## Verification (every phase)
- `npx tsc --noEmit`, `npm run lint`, `npx vitest run`, `npm run build`, and every `supabase/tests/*_test.sql` on a scratch Postgres built from empty.
- Mutation-check each new guard (§42.8).
- **Stripe test mode is not reachable here:** the Stripe MCP needs authorisation. Phase 4's Stripe paths are verified against stubs, and §12's standing item is recorded for you to run.
- The browser check is on `leads.stayful.co.uk` after merge, with `funnel_enabled` still off. Previews are behind Deployment Protection (§45).
