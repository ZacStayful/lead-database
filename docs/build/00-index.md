# Build index: Lead Brief and self-serve funnel

Source of truth for decisions: `claude/decision-register.md`. Every prompt below is written from its LOCKED items only. If a decision changes, update the register first, then the affected prompt, then this index.

> **Where these files live.** `claude/decision-register.md` and `claude/build/0N-*.md` are paths in the **Claude project**, not in this repo. `docs/build/` is the repo copy: every batch reads it at the start and commits its own prompt file here. This file is the index, committed on 2026-10-08 with the corrections marked **Corrected** below. They come from checking the index against the codebase, not from the decision register.

## Run order — parallel waves

| Wave | Run together | Why they don't collide |
|---|---|---|
| 1 | **01** (same session as the Lead Brief prompt) + **03 Part B steps 1 and message drafts** (Claude chat) | 03 Part B is Monday labels and message wording only, no code |
| 2 | **02** + **04** in separate Claude Code sessions, plus the **06 Phase 0 audit** (report only) | 02 = funnel, checkout, Stripe webhook. 04 = pause, confirm screen, engine committed demand. **Corrected: they DO share one file** — see "02 and 04 share the Stripe webhook" below |
| 3 | **03 Part A** + **05** + **06 build** | 03A = Monday sync and route report. 05 = address queue. 06 = held-lead predicate. Different files, but run the function-overlap check in the merge rule: git cannot see two migrations rewriting the same function |
| 4 | **07** | Needs live brief data |

**Never run together:**
- **01 with anything that touches code.** Every batch depends on it.
- **04 and 06 builds.** Both touch which leads a customer is eligible for. 06 builds after 04 merges.
- **02 and 03 Part A.** 03A writes to `funnel_sessions`, which 02 creates.
- **04 and 05.** 05 needs 04's confirm screen.

### 02 and 04 share the Stripe webhook *(Corrected)*

`src/app/api/webhook/stripe/route.ts` (1,737 lines) handles both batches' areas:

| Area | Approx. lines | Batch |
|---|---|---|
| Pause resume-detection block in `customer.subscription.*` (CLAUDE.md §21) | ~800–860 | 04 (pause) |
| `invoice.paid`, both products | ~915–1400 | 02 (checkout) |
| `checkout.session.completed`, including top-up success via `record_lead_topup_success` | ~1635–1720 | 02 (checkout) **and** 04 (top-ups) |

Rules for running them in parallel:
- Each batch changes only its own branches of the file and does not restructure shared code.
- Whichever merges second rebases and re-runs the full `npx vitest run`. That includes the two guards that read this file: `src/lib/__tests__/lapsePastDueGuard.test.ts` and `src/lib/__tests__/mondayCancel.test.ts`.
- Remember CLAUDE.md §23.6: **nothing may throw out of the webhook**.

### Parallel merge rule (applies to every batch running alongside another)

1. Before merging, rebase on main.
2. Renumber this batch's new migrations to the next free number after main's latest. Never edit a migration that is already merged. **Corrected, renumbering also means updating:**
   - the matching `supabase/tests/0NNN_*_test.sql` filename;
   - every test that reads the migration by path. 17 test files do this today; find them with `grep -rn "supabase/migrations/0NNN" src`;
   - every CLAUDE.md reference to the old number.
3. **Corrected: apply the migration to production only AFTER this rebase and renumber**, just before merging. Never at PR-open while another batch is running in parallel. Renumbering a migration that is already applied leaves the file name and production's ledger (`supabase_migrations.schema_migrations`) disagreeing, which is the trap CLAUDE.md §43 records for 0130. §1.1's rule still holds — the migration goes on before the merge — this only pins *when* before.
4. **Corrected: check for function overlap.** List every function each batch's migrations create or replace (`create or replace function public.<name>`) and stop on any name both batches touch. Git shows no conflict, because the two files have different names, yet whichever sorts later silently replaces the other's function body. CLAUDE.md §34/§35 and §63.3 record the related overload trap: adding a defaulted parameter creates a second function instead of replacing the first.
5. Resolve CLAUDE.md conflicts by keeping both sections. **Corrected:** also renumber this batch's own `## N.` section to the next free number after main's latest, and fix its internal § cross-references. Two parallel batches will otherwise both write the same section number. This has happened before: §40 was first written as §28.
6. **Corrected:** run `npm run gen:context` after rebasing and commit the result. `scripts/generate-section-index.mjs` reads both the CLAUDE.md headings and the `supabase/migrations/` directory, and `src/lib/feedback/__tests__/sectionIndex.test.ts` fails the build if `src/lib/feedback/sectionIndex.ts` is stale.
7. Re-run that batch's verification on the rebased branch before merging: `npx tsc --noEmit`, `npm run lint`, `npx vitest run`, `npm run build`, and its SQL suites.

| # | File | Where it runs | Depends on | Wave | Status |
|---|---|---|---|---|---|
| — | `claude/lead-brief-build-prompt.md` | Claude Code (already pasted 5 Oct) | — | 1 | Phase 0 approved 8 Oct. Phase 1 (0161, 0162; applied to production) and Phase 2 (engine, not wired) merged 9 Oct. Phase 3 (questionnaire, no migration) merged 9 Oct. Phase 4 (routing; 0163 applied to production 9 Oct, `lead_brief_enabled` off) merged 9 Oct. Phase 5 Part A (labels, "why" and "Not for me" on the card, panel, email, text and home; no migration) merged 9 Oct. Phase 5 Part B (the "Your brief" bar and editor, with 0164 and the daily `activate-lead-briefs` cron) merged 9 Oct; 0164 applied to production 9 Oct, before the merge (in four parts: the save function was run by hand in the SQL editor and its ledger row added after). 0164: `customer_lead_briefs` gains a `scheduled` status (an area change saved in the editor, which becomes active at the next renewal) and allows one change in flight per customer (`scheduled` or `pending_confirmation`); priority levels the customer sets are stored with `"chosen": true`. Batch 04 and Phase 6 must build on both. A10's tighter-area email moves to Phase 6, beside the recompute. **Not complete: 02, 04 and 06 still wait** |
| 01 | `claude/build/01-lead-brief-additions.md` | **Same** Claude Code session as the Lead Brief prompt | Lead Brief prompt | 1 | Folded into the Phase 0 report (A12 checks answered); repo copy committed 8 Oct |
| 02 | `claude/build/02-funnel-and-checkout.md` | New Claude Code session | 01 merged | 2 | Started 9 Oct on Zac's go-ahead, with Lead Brief Phases 0–5B merged (6 and 7 are not needed by 02). Phase 0 approved 9 Oct: report and decisions C1–C8 in `02-phase0-report.md`, repo copy of the prompt in `02-funnel-and-checkout.md`. Phase 1 (0165: `funnel_sessions`, `duplicate_subscriptions`, `customers.signup_source` / `password_set_at`, `post_call_offers.source` gains `funnel`, `consume_funnel_preview`, `funnel_enabled` off) merged 9 Oct; 0165 applied to production 9 Oct, before the merge, in five parts (`0165_funnel_part1`–`part5`): the apply tool timed out on the whole file four times without reaching the database, and part 1 used `create or replace trigger` in place of `drop trigger` + `create trigger`. Every 0165 object matches a scratch build from the file except the two new `customers` columns' positions (135–136 in production, which keeps slots for dropped columns). Balances, counters and row counts unchanged; all 110 customers read `call`. Phase 2 (session and preview API, no migration) merged 9 Oct: `POST /api/funnel/session` (n8n bearer; the same link for one email; an existing Management customer gets the login URL), `POST /api/funnel/[token]/preview` (both plans through `previewForClient` only, 20 previews per token per 24 hours, the base postcode locked after the first preview, Guaranteed Rent refused), and `/start/[token]` (unknown token 404, an existing customer or a paid session redirected to `/login?notice=already_set_up`). Phase 3 (the funnel pages, no migration) merged 9 Oct: the three questions, the preview with "How your leads work", "Why it works" (demo video from `NEXT_PUBLIC_FUNNEL_DEMO_URL`, hidden when unset; a sample card; the FAQ with C4's corrections and C7's sentence left out) and the plan screen, at `/start/[token]`; every answer saved by `POST /api/funnel/[token]/answers` so the link resumes where the visitor stopped; "Book a call instead" and "Send to my partner" on every screen. The partner page `/start/[summary token]/summary` is opened by a second, read-only token (not the funnel token), reads no name, email or phone, and has no payment. C9 decided 9 Oct: the FAQ's "Each one is financially modelled" reads "More than 9 in 10 are financially modelled" (182 of the last 198 Management leads carry a figure). Phase 4 (the guarded checkout, no migration) merged 9 Oct: one door, `startManagementCheckout` (`src/lib/checkout/`), used by `POST /api/funnel/[token]/checkout` (source `funnel`; refused unless a preview exists and `lead_brief_enabled` is on) and `GET /pay/[offerToken]?plan=10|20` (source `call`). Checks in order: an existing Management customer (by email, or phone plus name per C5) gets the login link and no checkout; one Stripe customer per email; an open Management session that fits is reused and any other is expired; otherwise a new session with this person's live code applied. A waitlisted row is never linked to the Stripe customer before payment, so `invoice.paid` still provisions the login. Post-call offers now link to `/pay` (`computeCheckoutUrls`); no app code reads `STRIPE_MANAGEMENT_{10,20}_PAYMENT_LINK_URL`, which stay set. Webhook backstop (C3, `duplicateSubscription.ts`): `customer.subscription.*` and the top of `invoice.paid` Management detect a second live Management subscription for one person (same Stripe customer, or same email), record it, cancel it, refund its first invoice and email Zac; every later event for a recorded duplicate is skipped, and neither call can throw. Stripe test mode not exercised (connector not authorised): verified against in-memory stubs, 32 mutations caught. Phase 5 (provisioning and the funnel discount, no migration) merged 9 Oct: the one additive webhook call (`completeFunnelPayment`, `src/lib/funnel/payment.ts`) sits BEFORE the Management customer read, not after `pushMondayStatus` as Phase 0 proposed, approved by Zac on 9 Oct: at the later point the existing provisioning has already sent the set-password email. For a subscription's first invoice tagged `source = 'funnel'` it finds or creates the customer row, makes the login with no password, sets `lead_brief_required` (and `signup_source = 'funnel'` when it made the login), records the session's Monday item, marks the session paid by a conditional write and sends a Resend magic link to `/onboarding/brief`; linking, crediting and activation stay the webhook's own code, which then finds the login and sends no set-password email. The brief confirmation (C1) opens the wizard on the paid session's answers, recalculated, and says if the radius changed; a funnel customer with no password is offered one on the dashboard after the brief, and `/reset-password` stamps `password_set_at`. Funnel discount: `/api/cron/funnel-discounts` (every 15 minutes, only with `funnel_enabled` on) gives a session previewed and unpaid for an hour (and quiet for under a week) the 24-hour `FOUNDING10-` code through the admin route's own issuing path, now shared (`postCallOfferIssue.ts`), so one code per person across both routes; `post-call-offer-reminders` is registered every 15 minutes; a funnel offer's `/pay` link goes through the funnel's checkout (`startFunnelCheckout`). 43 mutations caught. All of it refuses while `funnel_enabled` is off. Phase 6 (docs only, no migration) merged 9 Oct, which completes batch 02: CLAUDE.md §75 "Self-serve funnel and guarded checkout" (the tables, the three tokens, the no-volumes rule, the one door and the four routes still outside it, the webhook backstop, provisioning, the signup source, the discount, GR excluded, the switch-on order); §2's cron table brought back into step with `vercel.json` (26 crons; three rows had never been listed); §3, §8, §12 and the stale §17/§18E lines corrected; `MESSAGING_TOKEN_SECRET`, `NEXT_PUBLIC_BOOKING_URL` and `NEXT_PUBLIC_FUNNEL_DEMO_URL` added to `.env.example`; README's post-call section corrected and a funnel section added |
| 03 | `claude/build/03-enquiry-workflow.md` | Part A: Claude Code. Part B: Claude chat | A: 02 merged. B: none for labels and drafts; the live n8n edits need 02 deployed | A: 3, B: 1 | Not started |
| 04 | `claude/build/04-area-changes-pause-topups.md` | New Claude Code session | 01 merged | 2 | Not started |
| 05 | `claude/build/05-address-change-guard.md` | New Claude Code session | 04 merged | 3 | Not started |
| 06 | `claude/build/06-lead-data-completeness.md` | New Claude Code session | Audit: 01 merged. Build: 04 merged and Zac's scope choice | Audit: 2, build: 3 | Not started |
| 07 | `claude/build/07-feed-learning-and-source-reporting.md` | New Claude Code session | 01 merged and live with data | 4 | Not started |

## How to use

1. Paste **01** into the Claude Code session that has the Lead Brief prompt. Let Phase 0 run with the extra checks.
2. Run each later batch in a fresh Claude Code session, only after the batch it depends on is merged to main.
3. Every batch starts by reading `docs/build/` in the repo and committing its own file there. The repo keeps the same history as the Claude project.
4. Every batch has a Phase 0 audit and STOP gates. Nothing merges without a Vercel preview review. A preview runs against **production** Supabase (CLAUDE.md §1.1), and Deployment Protection answers 302 to `vercel.com/sso-api` on previews (§45), so anything needing a signed-in session is checked on `leads.stayful.co.uk` after merge.
5. When a batch merges, update its status here.

## Decisions Zac still makes inside the batches

These questions are raised at a batch's Phase 0, not before.

- **01 A12, check 2:** how "Not for me" interacts with the 15% replacement. No replacement copy appears in the funnel until this is decided.
- **01 A11:** how behind-pace widening is implemented. It stops if it would need a change to `assign_lead_to_customer`.
- ~~**04:** whether a top-up purchase flow exists. If it doesn't, building one needs approval.~~ **Answered: it exists** (CLAUDE.md §31.5, §66.3, §69.4):
  - `src/app/dashboard/topup/` with `src/app/api/customer/topup/route.ts`
  - the emailed link `src/app/topup/[token]/` with `src/app/api/topup/[token]/route.ts`
  - the Stripe logic in `src/lib/topupCharge.ts` and `src/lib/chargeIntent.ts`
  - credit is granted by `record_lead_topup_success`, called from the Stripe webhook — the same file 02 changes (see above)

  04 builds on this flow rather than adding a second one.
- **06:** whether incomplete leads are held for brief customers only, or for everyone.
- ~~**01 A7, "Switch to 10 leads a month" after payment.**~~ **Answered 9 Oct:** the existing §24 tier change (`POST /api/customer/subscription/plan`), unchanged. The price swaps with no proration: nothing is charged or refunded today, the next invoice is £150, and the allocation becomes 10 when it is paid. The brief is saved for the 10-lead area. §24 still needs a Stripe test-mode run before a customer can use it (CLAUDE.md §12).

## Outside the code

- **Make the lead-database repo private.** **Corrected:** confirmed **public** on 2026-10-06 and again on 2026-10-08 (GitHub `"visibility": "public"`). CLAUDE.md names customers, so this matters beyond the build docs. Zac is switching it to private (GitHub → Settings → Danger Zone) on 2026-10-09. This file was committed the day before, while the repo was still public. Once it's private, check two things:
  - Vercel still deploys from the repo (the team is on Pro, which supports private repos);
  - GitHub Actions CI (`.github/workflows/ci.yml`) now draws on private-repo minutes.
- Batch 03 Part B: every WhatsApp and email message is drafted for Zac's approval before it goes live.
