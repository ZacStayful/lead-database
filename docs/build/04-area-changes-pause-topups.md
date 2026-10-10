# Claude Code prompt — Batch 04: Area changes, pauses and top-ups (brief customers only)

Repo: ZacStayful/lead-database. Branch from main. Run only after: the Lead Brief and its additions are merged. This batch can run before or after batch 02. Read first: `docs/build/`. Then commit this file as `docs/build/04-area-changes-pause-topups.md`. Scope: Lead Brief customers only. Existing customers' pause, top-up and area behaviour is not changed in any way.

**Parallel run:** this batch may run at the same time as batch 02 in a separate session. Before merging, follow the parallel merge rule in `docs/build/00-index.md`: rebase on main, renumber this batch's new migrations to the next free number, keep both CLAUDE.md sections, then re-run verification.

## What we are building

Every change to a brief customer's coverage area is shown to them before it takes effect, so their labels stay meaningful. Pauses work like this:

- Up to 4 weeks: the customer comes back to exactly the same area.
- Longer pauses: the area is recalibrated and confirmed on login before leads resume.

Top-ups deliver from the closest matching areas just beyond the customer's service area, with a notice explaining this.

## Locked decisions

1. **Nothing accrues while paused.** A paused customer pays nothing and is owed nothing for the paused period. Any credit balance they already had carries on under normal rollover when they return. There is no catch-up mechanism and no catch-up cap.
2. **Pauses of up to 4 weeks keep the area exactly as it is.** While paused, the customer still counts as committed demand in the brief engine's capacity maths, so new sign-ups nearby are sized around them.
3. **Pauses over 4 weeks** (up to the existing maximum, 3 months):
   - Their capacity is released at once, so leads sell to active customers.
   - The return date is fixed when they pause.
   - The area is recalibrated 7 days before return.
4. **The confirm-on-login screen is shown whenever a brief has a `pending_confirmation` version.** This covers recalibrated returns and any monthly recalculation that would widen the area (additions A10).
   - Leads resume when the customer confirms.
   - If they never log in, the new area is auto-accepted 72 hours after the return or effective date, and a confirmation email goes out through Resend.
   - Labels, first-pick areas and the "why" checklist are recalculated against the confirmed area at the moment of confirmation.
5. **"Switch to 10 leads a month"** is offered alongside pause, never hidden.
6. **Top-ups cost credits and follow rollover.**
   - A top-up delivers from the closest matching outcodes beyond the service area, nearest first, never beyond the plan maximum distance (40 or 75 miles).
   - Each top-up lead is labelled Nearby opportunity, with the reason: "From just outside your area, as part of your top-up."
   - A top-up never adds supply inside their area.

## Phase 0 — Audit only

Use the findings from additions A12 check 4. Report:

- where pause is implemented (UI, API, Stripe pause or schedule), its maximum length, and what happens to billing and credits during a pause;
- whether any top-up purchase mechanism exists. If none exists, STOP after the area-change and pause phases. Do not build a new purchase flow without Zac's approval.
- how the brief engine's capacity maths can include customers on a short pause as committed demand.

STOP.

## Phase 1 — Data

- `customer_pauses` (or extend the existing pause record):
  - `customer_id`, `paused_at`, `return_date`;
  - `hold_area` (boolean: true when the pause is 28 days or fewer);
  - `recalibrated_at`, `confirmed_at`, `auto_accepted_at`.
- Reuse `customer_lead_briefs.status` (`active` / `pending_confirmation` / `superseded`) from the additions.

Verify that migrations apply cleanly. STOP.

## Phase 2 — Pause flow (brief customers)

Pause screen copy:

> **Pausing your leads**
>
> While you're paused, no leads are sent and you're not charged.
>
> Pause for up to 4 weeks and nothing changes. You return to exactly what you have now: the same area, the same brief and the same quality of matches.
>
> Pausing for longer? Your brief, your quality of matching and every credit you're owed stay exactly the same. Your coverage area is recalculated from live supply before you return. If it changes, we'll tell you first and you'll choose what happens next.
>
> Prefer to keep leads coming at a slower pace? Switch to 10 leads a month and keep your area active.
>
> [Pause for 4 weeks] [Choose a longer pause] [Switch to 10 leads]

- "Choose a longer pause" asks for a return date, up to the existing maximum.
- Short pause (28 days or fewer): keep the customer in the engine's committed demand and keep the active brief unchanged.
- Long pause: remove them from committed demand at once.
  - 7 days before return, run the engine and write a `pending_confirmation` brief.
  - Send an email through Resend: "Your area has been updated. Review it before your leads restart on [date]."
  - Also emit an event n8n can pick up to send a WhatsApp. The WhatsApp wording must be approved by Zac; do not hardcode it.

Verify on a Vercel preview with test customers on a 2-week and an 8-week pause. STOP.

## Phase 3 — Confirm-on-login screen

Shown when a brief customer has a `pending_confirmation` brief and logs in. It gates the dashboard, in the same way the Lead Brief gate does. Delivery is held until they confirm. Credits roll over meanwhile.

> **Welcome back, [name]** (first line for returns; for monthly widening use: "Your coverage area has been updated")
>
> We've recalibrated your coverage area from live supply, so your leads match your brief as closely as possible.
>
> **Your area:** within [X] miles of [postcode] (previously [Y] miles) [map: old area outlined, new area shaded]
>
> **What stays the same:** your brief, your priorities and must-haves, and every credit you're owed.
>
> **What your labels mean now:** "Top match" and "First pick" are measured against this area. A Top match is still a lead that meets everything in your brief, inside your coverage area.
>
> **Want a tighter area?** Switching to 10 leads a month brings it to [Z] miles.
>
> [Confirm and start my leads] [Switch to 10 leads] [Extend my pause]

- On confirm: the pending brief becomes `active` and the old one `superseded`. Recompute first-pick areas.
- For the first cycle, the "Your brief" bar shows "Area updated [date]".
- Auto-accept job: a daily cron, registered in `vercel.json`, confirms any pending brief 72 hours past its return or effective date and sends a Resend email: "Your leads have restarted within [X] miles of [postcode]."
- Monthly widening (additions A10) uses this same screen. Tightening does not need it: tighter areas only get the good-news email.

Verify:

- Delivery is held until confirmation.
- Auto-accept fires at 72 hours.
- The first lead after confirmation is labelled against the new area.
- Existing (non-brief) customers never see the screen.

STOP.

## Phase 4 — Top-ups (only if Phase 0 found an existing top-up mechanism)

Notice on the top-up screen:

> **How top-ups are delivered** Top-up leads come from the closest matches to your brief, starting just outside your current area. Your area's supply is already set by your plan, so a top-up won't add more leads inside it. It extends how far your leads reach.

Routing: top-up credits draw from outcodes just beyond the service area, nearest first, capped at the plan maximum distance. Label and reason as in locked decision 6.

Do not change the body of `assign_lead_to_customer`. If this cannot be done without changing it, STOP and report.

Verify with a synthetic brief customer with top-up credits. STOP.

## Phase 5 — Docs

Add a CLAUDE.md section, "Area changes, pauses and top-ups (brief customers)". STOP for preview review before merge.

## Revision safety

Read every file before modifying it. Touch only files named in an approved phase. If anything conflicts with existing code or CLAUDE.md, stop and describe it.
