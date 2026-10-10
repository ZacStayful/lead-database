# Claude Code prompt — Batch 06: Required lead data before a lead is sold

**Repo:** ZacStayful/lead-database. Branch from main.
**Run only after:** the Lead Brief and its additions are merged. Phase 0 (audit only) can run in wave 2. Do not start Phase 1 until batch 04 is merged, because both batches change which leads a customer is eligible for, and Zac has made his scope choice.
**Read first:** `docs/build/`. Then commit this file as `docs/build/06-lead-data-completeness.md`.
**Scope:** Management leads.

---

## What we are building

Labels, matching and the "why you got this lead" checklist all depend on three fields. A lead that is missing any of them can't be matched honestly. So a Management lead must have all three before it is sold:

- **property postcode** (and therefore an outcode)
- **readable bedrooms**
- **a revenue estimate** (`gross_annual_income`)

## Locked decision

Property postcode, bedrooms and revenue estimate are **required before a lead is sold**.

## Upstream signal: the Monday "Property data" label (added 9 Oct 2026)

Monday now labels how complete each lead's property details are. This is set upstream by n8n before the lead reaches the for-sale board, so this batch should **read** it, not recompute it.

| Board | Column ID |
|---|---|
| Management leads for sale (18420117742), the board this app ingests from | `color_mm7z8pt0` |
| Management Leads (5891626711), upstream only | `color_mm7zanzk` |

| Label | Meaning | Proposed treatment |
|---|---|---|
| Full address | Street + full postcode | Sellable |
| Postcode only | Full postcode, no street. Revenue estimate ran on the postcode | Sellable. A postcode satisfies the locked rule |
| District only | Outcode only (e.g. NG8). Revenue estimate is district-level and rough | **Zac decides** at Phase 0: sell, or hold until the full postcode is collected |
| Area data thin | Analyser refused to attach figures, so no trustworthy revenue estimate | Hold |
| Check bedrooms | Bedroom answer unusable (e.g. "12/17") | Hold |
| No location | No postcode or district | Hold |
| (blank) | Lead predates the label, or is not from the Facebook pipeline (e.g. Google leads) | Fall back to checking the three fields directly |

Held leads get worked upstream: someone collects the missing detail from the landlord, n8n re-runs the report, and the label updates on Monday. The app must pick up that change, which is why Phase 0 point 5 matters.

## Open scope questions: Phase 0 must surface them, Zac decides

Holding incomplete leads affects supply to **every** customer, not only brief customers. The locked rule is that existing customers are untouched.

Phase 0 must quantify the impact. Then **STOP for Zac to choose** one of:

- **(a)** Hold incomplete leads for brief customers only. Existing customers keep receiving them as today.
- **(b)** Hold them for everyone until enriched.

Also **STOP for Zac** on: **is "District only" sellable?** Report how many leads in the last 90 days would be District only, so he can see the supply cost of holding them.

Do not build either option before Zac answers.

## Phase 0 — Audit only

Report the following, with file paths and line numbers.

1. **How many leads are incomplete.** For Management leads in the last 90 days, give the count and share missing:
   - postcode
   - an outcode that parses
   - readable bedrooms
   - `gross_annual_income`
   - any of the three

   Split these by source (Google or Facebook) if a source field exists (see additions A12, check 6). Also give the count per **Property data** label for leads where it is set.
2. **Where the gaps come from.** Which ingest paths produce the incomplete leads: the n8n webhook, Monday pull-sync, the Facebook lead form, or customer-added leads.
3. **Whether gaps can be filled automatically.** Can missing revenue be filled by the STR analyser (intelligence.stayful.co.uk) or by existing enrichment code? How long does that take?
4. **What happens to a held lead's value.** How long can a lead be held before it goes stale? Report the existing lead-retirement rules.
5. **Reading the label.** Show where `color_mm7z8pt0` would need to be read:
   - the n8n webhook payload into `POST /api/webhook/n8n`. Is the column in the payload today? Which n8n workflow sends it?
   - the Monday pull-sync (`src/lib/monday.ts` `fetchMondayLeads`)

   Also show how a held lead would be re-checked when its label changes on Monday. Ingest is idempotent on `monday_item_id`, so a lead already ingested won't be re-read today. Propose the least invasive way to refresh held leads (e.g. the daily pull-sync re-reading held leads only).

**STOP.** Zac chooses (a) or (b), and whether District only is sellable.

## Phase 1 — Hold and enrich (after Zac's choice)

- Add `leads.property_data text` (nullable). Store the Monday label on ingest and refresh it for held leads.
- Add `leads.held_reason text` (nullable). Set it on ingest when a required field is missing **or** the label is a hold label. Use the label text as the reason when present (e.g. `Check bedrooms`).
- Held leads are excluded from routing in the scope Zac chose. Use the least invasive predicate that Phase 0 proposes.
- **Do not change the body of `assign_lead_to_customer`.**
- Use automatic enrichment wherever Phase 0 found it possible. A lead re-enters routing as soon as it is complete, or its label moves to a sellable one.
- Add an admin queue of held leads with their missing fields, label and age, so Zac can complete them by hand.

**Verify:**
- An incomplete test lead is held.
- A lead labelled Check bedrooms is held. Changing its label to Full address releases it into routing.
- Completing it releases it into routing.
- Out-of-scope customers are unaffected.

**STOP.**

## Phase 2 — Docs

Add a CLAUDE.md section for this rule, including the label column IDs and the hold/sell mapping Zac chose. **STOP** for preview review before merging.

## Revision safety

Read every file before modifying it. Touch only the files named in an approved phase. If anything conflicts with existing code or CLAUDE.md, stop and describe it.
