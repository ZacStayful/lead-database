# Claude Code prompt — Batch 05: Business address change guard (brief customers)

Repo: ZacStayful/lead-database. Branch from main. Run only after: the Lead Brief, its additions, and batch 04 are merged. Batch 04 supplies the confirm-on-login screen. Read first: `docs/build/`. Then commit this file as `docs/build/05-address-change-guard.md`. Scope: Lead Brief customers only.

## What we are building

A brief customer's business postcode sets the centre of their service area, so changing it could be used to game the allocation. Customers can't change it directly. They request a change from the dashboard with a written reason. Zac approves or declines it from the admin dashboard, and an approved change takes effect after a delay.

## Locked decisions (Zac's spec)

1. The base postcode is locked once the brief is confirmed. For funnel customers it is already locked at their first preview.
2. To request a change, the customer submits a new postcode and a written reason from the dashboard.
3. Zac approves or declines from the admin dashboard. He has 48 hours to answer.
   - A Resend email alerts him when a request arrives.
   - Requests are never auto-approved.
4. An approved change takes effect 72 hours later. At that point:
   - the engine recalculates a new brief version as `pending_confirmation`;
   - the customer sees the confirm-on-login screen from batch 04.
5. The customer sees the request status: pending, approved (with the effective date), or declined (with Zac's note).

## Phase 0 — Audit only

Report:

- where the business postcode is shown and edited today;
- where an admin approval queue fits in the admin nav;
- whether there is an existing pattern for admin approvals to reuse.

STOP.

## Phase 1 — Data

Create `address_change_requests` with these columns:

- `id`, `customer_id`
- `current_postcode`, `requested_postcode`
- `reason` (text, required, minimum 20 characters)
- `status`: `pending` | `approved` | `declined`
- `admin_note`
- `requested_at`, `decided_at`, `effective_at`

RLS rules:

- Customers can read their own requests and insert a request only through the server route.
- All status changes use the service role.

Verify the migrations. STOP.

## Phase 2 — Customer side

- In the "Your brief" editor, show the postcode as read-only with a "Request a change" link.
- The request form asks for the new postcode and the reason. It explains: "Your postcode sets the centre of your coverage area, so changes are reviewed. You'll hear back within 48 hours, and an approved change takes effect 72 hours later."
- Only one pending request is allowed at a time.

Verify. STOP.

## Phase 3 — Admin side

- Build an admin queue page listing pending requests with the reason, the customer, and the time remaining of the 48 hours. Each request has Approve and Decline buttons, and Decline requires a note.
- Send a Resend email to Zac when a request arrives.
- On approval, set `effective_at` to 72 hours later. A daily cron (registered in `vercel.json`) applies due changes. It writes a new `pending_confirmation` brief with the new base postcode, which triggers the batch 04 confirm screen.
- Send the customer a Resend email on decision.

Verify the full request → approve → 72 hours → confirm flow on a preview, using a shortened delay in test. STOP.

## Phase 4 — Docs

Add a CLAUDE.md section for this guard. STOP for preview review before merge.

## Revision safety

Read every file before modifying it. Touch only the files named in an approved phase. If anything conflicts with the existing code, stop and describe the conflict.
