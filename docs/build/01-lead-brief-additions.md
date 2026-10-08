# Additions to the Lead Brief prompt — paste into the same Claude Code session

These decisions were locked on 6 October 2026, after the Lead Brief prompt was written. They amend that prompt. Everything in the original prompt still stands unless an item below changes it.

**How to apply:**
- If a phase has not been built yet, build it with these changes included.
- If a phase has already been built or merged and conflicts with an item below, **do not change it silently.** List what was built, what must change, and the files affected, then STOP and wait for approval.

---

## Step 0 — store the build docs in the repo

Create `docs/build/` and commit:
- `docs/build/lead-brief-build-prompt.md`: the original Lead Brief prompt, verbatim.
- `docs/build/01-lead-brief-additions.md`: this file, verbatim.

Later batches (02–07) will be added to the same folder. Read `docs/build/` before any later batch.

---

## A1. The guarantee is credit-based (replaces locked decision 2's wording)

The guarantee is not "full allocation every cycle." **Every lead a customer pays for is delivered, and any shortfall rolls over.** This is the existing credit and rollover model, unchanged.

- Customer-facing wording: "Every lead you pay for is delivered. If a month runs short, the balance carries forward."
- Remove "your full allocation every cycle" and any equivalent from Phase 3 copy and from the copy module.
- "Count guaranteed, mix expected" stays: the count is guaranteed through rollover, and the mix is shown as expected.

## A2. Remove the bonus rule

Delete "optional bonus rule" from Phase 3 screen 3. Do not build it anywhere.

**No leads outside a customer's scope are ever given as free extras.** Doing so gives valuable leads away and dilutes quality for other customers.

## A3. Service-area cap by plan

The service-area widening cap becomes:

> cap = the smaller of `travel_limit_miles` and the plan maximum (**10-lead plan: 40 miles; 20-lead plan: 75 miles**)

- Keep the plan maximums as named constants in the pure engine module.
- "Widen, never block" still applies inside that cap.
- If the cap is reached before the target, store the brief anyway and record that the mix will lean to Nearby. Any shortfall rolls over.

## A4. The engine must run without a customer row

The pre-payment funnel (batch 02) calls the engine before anyone has paid. Phase 2 functions must therefore accept a plain brief input, not a `customers` row:

- Inputs: base postcode, extra areas, travel limit, essentials, plan.
- Expose one pure entry point, `computeBriefPreview(input, plan)`, returning: service radius, service outcodes, first-pick outcodes, similar areas with matched figures, competition tiers, trade-offs and expected mix.

Persisting a brief stays a separate step.

**Anything sent to a client must never include area lead volumes or forecast counts.** Expected mix as a split of the customer's own allocation (e.g. 12 / 5 / 3 of 20) is allowed.

## A5. Both plans in the preview

The preview shows the service radius for **both** the 10-lead and 20-lead plan, side by side.

Copy, with figures filled in by the engine:

> **Your coverage area**
> 20 leads a month: within [X] miles of [postcode]
> 10 leads a month: within [Y] miles of [postcode]
>
> Your area is set from live lead supply, so every lead you pay for is delivered. A tighter area means fewer landlords enquire there each month, so a smaller plan keeps your area tighter. Pick the balance that suits how far you're willing to travel.

## A6. Up to three trade-offs

This replaces "Biggest bottleneck: one suggestion only."

- Offer up to **3** trade-offs, ranked by miles saved. Each relaxes one priority by one step.
- Frame each as a gain, never a loss. For example: "Including £50k+ properties brings your area in by 20 miles."
- Never write "drop your requirement" or similar.

## A7. When requirements can't be met

If essentials or the area cannot be met inside the plan cap, the screen offers exactly three options:

1. **Widen your area**
2. **Switch to 10 leads a month**
3. **Book a call**, linking to `https://calendly.com/zac-stayful/stayful-lead-database`. Store this as an env var: `NEXT_PUBLIC_BOOKING_URL`.

**There is no waitlist anywhere.**

## A8. The shortened questionnaire (replaces Phase 3 screens 0–3)

Three questions, then the preview.

**Q1. Where do you operate?**
- Business postcode, which becomes `base_postcode` / `base_outcode`.
- Optional "Add another area" for `priority_outcodes`.

**Q2. How far will you travel?**
- Options: 10 / 25 / 50 miles, or anywhere. This sets `travel_limit_miles`.
- Derive `operating_mode`; do not ask for it: 10 miles → local, 25–50 → growing, anywhere → anywhere.
- "Anywhere" still respects the plan cap from A3.

**Q3. Anything a lead must have?**
- Up to 2 essentials: minimum bedrooms and/or minimum projected revenue, or "No, show me everything".

**Priorities are not asked.** Default the ranking to: location, then the chosen essentials, then revenue, bedrooms, occupancy. Store it in `priorities` jsonb. The customer can change the ranking later in the "Your brief" editor (Phase 5).

**Preview screen** (replaces screen 4) shows:
- the radius for both plans (A5)
- similar areas, with the top one pre-ticked as "Recommended for your brief"
- competition tiers
- up to 3 trade-offs (A6)
- expected mix
- first-pick areas
- the can't-be-met options when relevant (A7)

The old screen 0 explanation of the four labels becomes a short block on this preview screen.

**If the customer arrived through the funnel (batch 02)**, a preview snapshot already exists. The onboarding screen then becomes a **confirmation**, prefilled from that snapshot. It asks nothing new; the customer reviews and confirms. Recompute against live supply at confirmation. If the radius changed, say so plainly.

## A9. Words to avoid in all customer-facing copy

- **Never use:** filter, minimum, restricted, expanded, override, top-up (in label or reason copy), outside your criteria, non-matching.
- **Use:** priorities, matches, service area, opportunities.

Add a test that scans the copy module for the banned words.

## A10. Monthly recalculation and area-change states

Recompute each brief customer's service area **monthly** as well as at renewal.

- **Tighter area:** apply it at the next renewal. Send a good-news email through Resend plus an in-portal notification: "Your coverage area is now [N] miles tighter."
- **Wider area:** never apply it silently. Create a new brief version with status `pending_confirmation`. Batch 04 builds the confirm-on-login screen that activates it.

Add to Phase 1 schema: `customer_lead_briefs.status`, with values `active` | `pending_confirmation` | `superseded`. Exactly one `active` row per customer.

## A11. Behind-pace widening (Phase 0 to propose, then STOP)

When a brief customer is behind pace, routing may include leads from outcodes **beyond** their service area, nearest first. Limits:

- Never beyond the plan maximum distance (A3).
- Temporary: the stored service area does not change.
- Labelled **Nearby opportunity** with the reason: "Just outside your usual area, sent to keep your [N] leads on track. You're on [x] of [N], with [d] days left in your cycle."

Phase 0 proposes how to do this without changing the body of `assign_lead_to_customer`. If it cannot be done that way, STOP and say so.

## A12. Extra Phase 0 checks (add to the existing Phase 0 report)

1. **Build state:** which phases of the original prompt have been built, merged or branched so far.
2. **"Not for me" vs the 15% replacement:** report how "Not for me" (chargeable reject) interacts with the 15% replacement allowance, and propose the rule. No customer-facing copy may mention replacement until Zac approves the rule.
3. **Repo visibility:** report whether `ZacStayful/lead-database` is public or private.
4. **For batch 04:** where the pause feature lives, the maximum pause length, what happens to credits during a pause, and whether any top-up purchase mechanism exists.
5. **For batch 02:** every place the app creates or links to a Stripe Payment Link or Checkout Session, including post-call offers.
6. **For batch 07:** whether leads carry a source (Google vs Facebook), and where.

## A13. Phase 7 additions

- Grep `src/app/page.tsx` (landing FAQ) and every Management customer surface for "two operators", "maximum of two" and "one other operator". Change them to "up to three".
- Extend the CLAUDE.md section to cover A1–A12.

## Unchanged and re-confirmed

- **Existing customers are untouched.** No labels, no brief, no routing change.
- **The landlord hand-off email wording is unchanged.**
- **No pool.**
- **Up to 3 operators per lead.**
- **Outcode-level matching.**

## Which phases each item affects

| Item | Phases |
|---|---|
| A1 | 3, 5 (copy) |
| A2 | 3 |
| A3 | 2 |
| A4 | 2 |
| A5 | 2, 3 |
| A6 | 2, 3 |
| A7 | 2, 3 |
| A8 | 1 (priorities default), 3 |
| A9 | 5 |
| A10 | 1, 2, 5 |
| A11 | 0, 4 |
| A12 | 0 |
| A13 | 7 |

**Revision safety:** read every file before modifying it. Touch only files named in an approved phase. If anything here conflicts with existing code or CLAUDE.md, stop and describe it.
