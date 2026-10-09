# Claude Code prompt — Batch 02: Self-serve sales funnel and guarded checkout

**Repo:** ZacStayful/lead-database. Branch from main.
**Run only after:** the Lead Brief prompt and `01-lead-brief-additions.md` are merged. This batch uses the brief engine (`computeBriefPreview`).
**Read first:** everything in `docs/build/`. Then commit this file as `docs/build/02-funnel-and-checkout.md`.
**Product:** Management only. Guaranteed Rent enquiries stay on the call-only process and never enter the funnel.

**Parallel run:** this batch may run at the same time as batch 04 in a separate session. Before merging, follow the parallel merge rule in `docs/build/00-index.md`: rebase on main, renumber this batch's new migrations to the next free number, keep both CLAUDE.md sections, then re-run verification.

---

## What we are building, in one paragraph

A Management enquirer can either book a call or go straight to a short self-serve funnel at `/start/[token]`. The funnel:

1. asks three questions;
2. shows a non-binding preview of how the allocation system would serve them;
3. answers the common objections on one page;
4. takes payment.

Payment runs through **one guarded checkout** shared by every route, both the funnel and post-call. So nobody already signed up can be charged twice, and nobody is charged twice by paying in two tabs. Funnel payers become active customers without an admin invite. They land on the Lead Brief confirmation screen, prefilled from their preview.

---

## Locked decisions (do not re-ask, do not change)

1. **Two routes for every Management enquiry: call or funnel.** GR is excluded.
2. **Funnel sign-ups go straight to active.** No admin invite step.
3. **Funnel finishers get the same 24-hour discount as post-call prospects.** One code per person across both routes; never two live codes.
4. **People with a meeting booked can still pay through the funnel.**
5. **Never charge anyone twice.**
6. **The preview is non-binding.** It is recalculated at payment, and the customer is told if their radius changed.
7. **Preview responses never include area lead volumes or forecast counts.**
   - Allowed: miles, tiers, labels, and expected mix as a split of their own allocation.
   - First-pick areas are shown as "likely" before payment.
8. **Keep the funnel short:** three questions, then the preview.
9. **Exits on every screen:** "Book a call" (`NEXT_PUBLIC_BOOKING_URL`) and "Send to my partner".
10. **Widen, never block.** If requirements can't be met, offer: widen, switch to 10 leads, or book a call. **No waitlist.**
11. **The guarantee is credit-based:** every lead paid for is delivered, and any shortfall rolls over.
12. **Copy rules:**
    - Sentence case, no exclamation marks.
    - Words-to-avoid list from A9 of the additions applies.
    - Never mention "our network" or other operators beyond "up to three operators per lead".

## Standing invariants

All invariants and prohibited files from `docs/build/lead-brief-build-prompt.md` still apply. In particular:
- `assign_lead_to_customer` is unchanged.
- No code path asks Supabase to send email; all email goes through Resend.
- New migrations take the next free number after the last merged migration.
- New crons go in `vercel.json`.

## Prohibited — do not modify (in addition to the Lead Brief list)

- The **credit, invoice and provisioning logic** in `src/app/api/webhook/stripe/route.ts`.
  - Exception: Phase 4's duplicate-subscription backstop and Phase 5's funnel provisioning may each add **one additive call** at a point Phase 0 identifies and Zac approves.
- The existing invite and resend-invite flows for call-route customers. They keep working as today.
- Stripe Payment Link objects in the Stripe account. Do not delete or edit them. This batch only stops the app referencing them.

---

## Phase 0 — Audit only. Write no code.

Report with file paths and line numbers:

1. **Signup and invite path today:**
   - the signup route, the owner override, the invite and resend-invite routes;
   - the capacity check (`max_active_customers`, the 409 on full) and whether it still blocks anything;
   - how a customer becomes `active`.

   Propose how funnel payers become active without an invite, and how the capacity check applies to them. Zac's rule is widen, never block, so propose **no block**.
2. **Every place a Stripe Payment Link or Checkout Session is created or referenced:** app code, `post_call_offers`, emails, README. List the places **outside** the repo that you can see referenced (n8n, skills, email templates), so Zac can update them.
3. **The post-call offer system:**
   - `postCallOffers.ts`, migration 0026 and successors, `/api/admin/post-call-offer`;
   - how the 24-hour `FOUNDING10-` code is generated and redeemed;
   - the reminder cron, and whether it is registered in `vercel.json`.
4. **Stripe webhook:**
   - which events provision a Management customer;
   - where a duplicate-subscription check could be added as one additive call.
5. **Auth:**
   - how to issue a sign-in link for a new customer **through Resend**, using the Supabase admin `generateLink`, with no Supabase-sent email;
   - whether a password is currently required.
6. **Monday:**
   - where the app sets "Management Customer" on board 18420649520 on payment;
   - how the enquiry item (email in `text_mm50e3d7`) can be matched to a funnel session.
7. **The Lead Brief engine:** confirm `computeBriefPreview` exists and runs server-side with no customer row.
8. **Conflicts:** report any conflict with CLAUDE.md or the codebase.

**STOP. Wait for approval.**

---

## Phase 1 — Data (next free migration numbers)

**`funnel_sessions`:**

| Column | Notes |
|---|---|
| `id` | |
| `token` | unique, unguessable |
| `monday_item_id` | nullable |
| `name`, `email`, `phone` | |
| `answers` | jsonb: Q1–Q3 |
| `base_postcode_locked` | the first postcode previewed, locked for this token |
| `preview_snapshot` | jsonb: the last preview returned |
| `plan_selected` | `10` \| `20` \| null |
| `step` | `started` \| `questions_done` \| `previewed` \| `checkout_started` \| `paid` |
| `checkout_session_id` | |
| `customer_id` | nullable |
| `discount_offer_id` | nullable, references `post_call_offers` |
| `created_at`, `updated_at`, `paid_at` | |

**Other changes:**
- `customers.signup_source text`, values `call` | `funnel`. Backfill every existing row to `call`.
- **Preview rate limiting:** at most 20 previews per token per 24 hours. Use a counter on `funnel_sessions` or a small table; Phase 0 picks.
- **RLS:** no browser access to `funnel_sessions`. All reads and writes go through server routes on the service role.

**Verify:** migrations apply cleanly on a branch; every existing customer has `signup_source = 'call'`; no existing function changed. **STOP.**

---

## Phase 2 — Funnel sessions and preview API

**`POST /api/funnel/session`** (Bearer `N8N_WEBHOOK_SECRET`)
- Input: Monday item id, name, email, phone.
- Creates or returns the session for that email and returns the funnel URL.
- If the email already belongs to an active or paid Management customer, it returns the login URL instead.

**`GET /start/[token]`**
- Loads the session.
- If the token's email is already an active or paid customer, it redirects to login with "You're already set up".

**`POST /api/funnel/[token]/preview`**
- Server-side only. Calls `computeBriefPreview` for both plans.
- Returns:
  - radius per plan;
  - competition tiers;
  - similar areas with their matched figures;
  - up to 3 trade-offs framed as gains;
  - expected mix as a split of the allocation;
  - "likely" first-pick areas;
  - the can't-be-met options when relevant.
- **Never returns volumes or counts per area.**
- Enforces the rate limit.
- After the first preview, the base postcode is locked for that token. Changing it means contacting Zac.

**Verify:**
- Unit tests show the preview response contains no volume fields.
- The rate limit triggers at 21.
- A second postcode on the same token is refused.
- An existing customer's email gets the login redirect.

**STOP.**

---

## Phase 3 — The funnel pages

`/start/[token]`, mobile-first, brand tokens `#5D8156` / `#3B6D11` / `#EAF3DE`, card style `bg-white border border-black/10 rounded-xl`.

**Progress label:** "3 quick questions", then "Your preview". **No** "Step x of 6".

**Save and resume:** every answer saves to the session. Returning to the link resumes where they stopped.

### Screen 1: Where do you operate?
Postcode, plus optional "Add another area".

### Screen 2: How far will you travel?
10 / 25 / 50 miles, or anywhere.

### Screen 3: Anything a lead must have?
Minimum bedrooms and/or minimum projected revenue, or "No, show me everything". Maximum two.

### Screen 4: Your preview
Everything from the preview API, using the A5 coverage copy. Includes the can't-be-met options when relevant.

Add a short "How your leads work" block:
- Your leads are matched to what you've told us, best matches first.
- Every lead is labelled Top match, Strong match, First pick or Nearby opportunity, with a "Why you got this lead" explanation.
- Every lead you pay for is delivered. If a month runs short, the balance carries forward.

### Screen 5: Why it works
One scrolling page.

**At the top:**
- a 60–90 second dashboard demo video, with the URL from env `NEXT_PUBLIC_FUNNEL_DEMO_URL` (hide the block if unset);
- a sample lead card with an expanded label and "why" panel. Use anonymised sample data, and reuse the existing landing `LeadCardSample` if suitable.

**Below that, these questions as tap-to-open items, using this copy:**

- **How many other operators get the same lead?**
  Each lead goes to a maximum of three operators. Never more.
- **Are these leads any good?**
  Every lead is a landlord who searched Google for short-term let management and completed an enquiry form. Each one is financially modelled against the landlord's current income using live Airbnb data for their postcode. Before any lead reaches you, the landlord receives an email telling them a trusted local operator will be in touch. They're expecting your call.
- **How fast do leads arrive, and how do I contact them?**
  Leads arrive within minutes of assignment, by email, text and in your dashboard, with phone, email and WhatsApp options on every lead. Our contact strategy guide shows the sequence that works best: call first, up to five attempts.
- **What should I realistically expect?**
  The long-run conversion rate is 1 in 20, validated across more than 1,100 Google-sourced STR management enquiries over three years. Leads typically take 4 to 12 weeks from first contact to a signed management agreement. Operators who treat this as a consistent acquisition channel over 12–24 months see the strongest results.
- **How is this different from running my own ads?**
  A Google Ads click on a property management keyword costs £8–25 in the UK. That is a click — not a name, a phone number, or a completed enquiry form. At £15 per financially modelled, Google-intent enquiry, the cost is for the output of a campaign, not a step within one.
- **What if it doesn't work for me?**
  Cancel anytime — no lock-in, no penalty. You can pause for up to three months. Every lead you pay for is delivered. [Replacement sentence: insert ONLY after Zac approves the rule from A12 check 2; until then omit it.]

### Screen 6: Choose your plan and pay
- 10 leads (£150/month) or 20 leads (£300/month), each showing its radius from the preview.
- If a valid discount code exists for this session, show it applied with its expiry time.
- "Continue to payment" calls the guarded checkout (Phase 4).

### Exits on every screen
- **"Book a call instead"** links to `NEXT_PUBLIC_BOOKING_URL`.
- **"Send to my partner"** links to `/start/[token]/summary`: a read-only page with their answers, preview and the "why it works" content. It has no payment button and no personal contact data, so it is shareable.

**Verify:**
- A full run-through on a Vercel preview at phone width.
- Resume works.
- The summary page shows no email, phone or payment.
- The copy test (A9 banned words) passes.

**STOP.**

---

## Phase 4 — The guarded checkout (one door for every route)

Create one server function: `startManagementCheckout({ email, phone, name, plan, source, discountCode?, funnelSessionId? })`.

**Order of checks:**

1. **Look up existing customers** by email (case-insensitive) and by phone (normalised E.164).
   - Active, or has an active Management subscription: return `{ status: 'already_customer', loginUrl }`. **Do not create a checkout.**
   - Invited or provisioned but unpaid: reuse that Stripe customer and that customer row. If an unexpired Checkout Session exists, return it; otherwise create a new one for the same Stripe customer.
2. **Find or create the Stripe customer.** Search Stripe for a customer by email first; create one only if none exists. One Stripe customer per email.
3. **Avoid duplicate open checkouts.** If a funnel session already has an open Checkout Session, return it.
4. **Create the Checkout Session** for the 10- or 20-lead Management price, with the promotion code applied if valid. Put `source` and `funnel_session_id` in the metadata.

**Routes:**
- `POST /api/funnel/[token]/checkout` calls it with `source = 'funnel'`.
- `GET /pay/[offerToken]` calls it with `source = 'call'`. This replaces raw Payment Links in the post-call offer flow. Post-call offers now link to `/pay/[offerToken]`.
- Stop referencing `STRIPE_MANAGEMENT_10_PAYMENT_LINK_URL` / `_20_` in app code. Leave the env vars set.
- Give Zac a list of external places still using the raw links, from Phase 0 item 2.

**Webhook backstop:** one additive call, at the point approved in Phase 0.
- On `customer.subscription.created` for a Management price, if the same customer, or another Stripe customer with the same email, already has an active Management subscription:
  1. cancel the **newer** subscription immediately;
  2. refund its first invoice;
  3. email Zac through Resend with both subscription ids.
- Everything else in the webhook is unchanged.

**Verify (Stripe test mode):**
- An existing active customer gets `already_customer` and no checkout.
- An invited-unpaid customer gets their existing checkout reused.
- Two tabs paying at once end with exactly one active subscription, one refund and an email to Zac.
- The post-call `/pay` link works with the discount applied.

**STOP.**

---

## Phase 5 — Provisioning funnel payers, and the funnel discount

**Funnel payment provisioning** (one additive call in the webhook, approved in Phase 0). On first payment where `source = 'funnel'`:
- Create or activate the customer: `account_status = 'active'`, `signup_source = 'funnel'`, `lead_brief_required = true`.
- Create the auth user.
- Send a sign-in link through **Resend**, using admin `generateLink`. No password step.
- Write the preview snapshot as a `pending_confirmation` brief, so the onboarding screen is a confirmation (A8).
- Set the Monday item on board 18420649520 to "Management Customer", using the existing helper.
- Mark the funnel session `paid`.

**Funnel discount:**
- When a session reaches `previewed` and the customer has not paid within 1 hour, generate the existing 24-hour single-use `FOUNDING10-` offer through `postCallOffers.ts`, with a new trigger value `funnel`.
- **Never** generate a second live code for someone who already has one from either route.
- The existing 12h / 4h / 1h reminders apply.
- If Phase 0 found the reminder cron missing from `vercel.json`, register it.

**Verify:**
- A test funnel purchase creates an active customer.
- The sign-in email arrives through Resend.
- The first login lands on the prefilled brief confirmation.
- Monday is updated.
- No invite was needed.
- Only one discount code exists per person.

**STOP.**

---

## Phase 6 — Docs

- Add a CLAUDE.md section, "Self-serve funnel and guarded checkout", covering:
  - the tables;
  - the one-door checkout rule;
  - the webhook backstop;
  - the signup source;
  - GR exclusion;
  - the no-volumes rule for the preview API.
- Update the env var inventory: `NEXT_PUBLIC_BOOKING_URL`, `NEXT_PUBLIC_FUNNEL_DEMO_URL`.

**STOP** for Vercel preview review before merge to main.

## Revision safety

Read every file before modifying it. Touch only files named in an approved phase. If anything conflicts with existing code or CLAUDE.md, stop and describe it. Do not resolve it silently.
