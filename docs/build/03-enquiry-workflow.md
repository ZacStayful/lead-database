# Batch 03: Enquiry workflow (call or funnel)

This batch has two parts:

- **Part A** is a Claude Code prompt for the app. Run it after batch 02 is merged.
- **Part B** is done in a Claude chat in this project, not in Claude Code. It covers the n8n workflow, Monday board labels and the Facebook lead form thank-you screen.

**Before anything goes live, Zac approves every WhatsApp and email message word for word.**

---

# Part A — Claude Code prompt

**Repo:** ZacStayful/lead-database. Branch from main.
**Run only after:** batch 02 is merged.
**Read first:** `docs/build/`. Then commit this file as `docs/build/03-enquiry-workflow.md`.
**Scope:** Management only. GR is excluded.

## What we are building

The app tells Monday where each enquirer is in the funnel. It records which route and which option order each enquirer was offered, and it reports conversion and churn by route. All messaging stays in n8n.

## Locked decisions

1. **New Monday statuses** on board 18420649520 (status column `color_mm5eda07`): **"Funnel started"** and **"Funnel finished, not paid"**.
   - Zac or the Claude chat creates these labels before this batch runs.
   - The app reads their label ids from env: `MONDAY_STATUS_FUNNEL_STARTED`, `MONDAY_STATUS_FUNNEL_FINISHED`.
2. **A "Sign-up source" column** (call / funnel) on the same board, created beforehand. Its column id comes from env: `MONDAY_SIGNUP_SOURCE_COLUMN_ID`.
3. **Route order depends on the moment:**

   | Moment | What leads |
   |---|---|
   | Form submitted (thank-you screen, instant message) | Call first, funnel second |
   | No booking after about 3 hours | Funnel leads the chase |
   | No-show | Funnel straight away |
   | Meeting sat but not paid | Funnel as a recap-and-pay page |

4. **Alternate-week test** of which option comes first in the instant message. The app records which order each enquirer got.
5. **Measure by route:** enquiry → paid, and 60-day churn. These are what decide whether the funnel works.

## Phase 0 — Audit only

Report with file paths and line numbers:

- The existing Monday client helpers and how status is written today.
- Whether the post-call offer flow can create a funnel session for a "meeting sat" enquirer, so the 9pm message can link to `/start/[token]` as a recap-and-pay page.
- Which admin page should hold the route report.

**STOP.**

## Phase 1 — Data

- `funnel_sessions.offer_order`: `call_first` | `funnel_first`. It is passed by n8n to `POST /api/funnel/session`.
- `funnel_sessions.entry_point`: `instant` | `chase` | `no_show` | `post_call`.

**Verify** that migrations apply cleanly. **STOP.**

## Phase 2 — Monday status sync

| Funnel event | Monday update |
|---|---|
| First answer saved | Status → "Funnel started", **only if** the current status is "New Enquiries", "Chasing to book" or "Chased no booking". |
| Session reaches `previewed` or `checkout_started` and is unpaid after 1 hour | Status → "Funnel finished, not paid", same condition. |
| Payment, any route | Sign-up source → `funnel` or `call`. The status change to "Management Customer" already exists from batch 02. |

**Never overwrite these statuses:** "Web meeting booked", "Web meeting sat", any customer, paused, cancelling or cancelled status.

**Verify** on a test item that each transition writes once and protected statuses are never overwritten. **STOP.**

## Phase 3 — Post-call recap-and-pay

The existing post-call step creates a funnel session with `entry_point = 'post_call'`.

- The session's `/start/[token]` link skips the three questions if no answers exist and starts at a recap page:
  - "Here's what we covered", followed by the preview inputs;
  - then plan and pay through the guarded checkout.
- The 24-hour offer is the existing post-call one. Never generate a second code.

**Verify** on a Vercel preview. **STOP.**

## Phase 4 — Route report (admin)

Add to the admin page chosen in Phase 0. Show the last 30 / 90 days, split by `entry_point` and by `offer_order`:

- enquiries;
- funnel sessions started;
- previewed;
- paid via funnel;
- paid via call;
- enquiry → paid %.

Add **60-day churn** split by `signup_source`.

**Verify** the figures against a direct SQL count. **STOP** for preview review before merge.

---

# Part B — done in a Claude chat (n8n, Monday, Meta)

Do these in order. **Show Zac every message draft and wait for approval before publishing anything.**

1. **Monday:** create the two status labels and the "Sign-up source" column on board 18420649520. Record their ids for the Part A env vars.
2. **Instant message** (edit the existing n8n workflow; do not build a new one):
   - On a new Management enquiry, call `POST /api/funnel/session` with `offer_order` and `entry_point = 'instant'`.
   - Send WhatsApp (TimelinesAI) and email with both options. Order: call first, funnel second, unless the alternate-week flag says otherwise.
   - GR enquiries get the current call-only message, unchanged.
3. **Chase after about 3 hours with no booking:** the funnel leads the message (`entry_point = 'chase'`).
4. **No-show:** "Sorry we missed you. Here's everything we'd have covered", with the funnel link (`entry_point = 'no_show'`).
5. **9pm post-call message:** replace the raw Stripe payment link with the recap-and-pay `/start/[token]` link.
6. **Facebook Management lead form thank-you screen:** primary button "Book your walkthrough", plus a second link "Prefer to look yourself? 10 minutes". The thank-you screen can't alternate weekly, so it stays call-first. The weekly test runs in the instant message.
7. **Alternate-week flag:** a single n8n variable, switched each Monday. Run for 4 weeks, then read the Part A route report.
