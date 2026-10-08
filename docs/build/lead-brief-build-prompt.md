# Claude Code prompt — Lead Brief (new customers only)

Repo: `ZacStayful/lead-database`, branch from `main` (last checked at merge of PR #138, migrations up to `0160`).
Product: **Management only.** Guaranteed Rent is out of scope and must not change.

---

## What we are building, in one paragraph

New Management customers complete a mandatory **Lead Brief** after payment and before their first lead. The brief records how they operate, what they want in a lead (ranked priorities, up to two essentials) and where (priority areas, plus suggested similar and low-competition areas). From that, the system computes a **service area** (the smallest radius that delivers their plan allocation from live supply) and **first-pick areas** (nearby outcodes no customer covers, where this customer is the closest operator). Brief customers are routed by **match score, not hard exclusion**: every lead inside their service area is eligible, and the best matches reach them first. Every lead they receive carries a **label** (Top match / Strong match / First pick / Nearby opportunity) and an expandable **"Why you got this lead"** checklist. An admin **Lead Reach** page shows what share of leads are within reach of a customer and where they are not. **Existing customers are not touched in any way.**

---

## Locked decisions (do not re-ask, do not change)

1. **New customers only.** Every customer active before this ships keeps their current filter, routing and UI exactly as today. They are exempt from the brief. Nothing they receive changes.
2. **Count guaranteed, mix expected.** The brief promises the plan allocation every cycle (already true via credit carry-forward). The Top / Strong / First pick / Nearby split is shown as **expected**, never guaranteed. Respect CLAUDE.md §28.0 and §69 copy rules.
3. **Widen, never block.** If a new customer's area has no spare capacity, their service area widens. Capacity never blocks a sale (CLAUDE.md §16).
4. **Outcode-level matching.** Service areas, first-pick areas and distance are computed per outcode (YO1, YO10…), not per postcode area.
5. **Up to 3 operators per lead** (already the code default via `0055`). Do not change `max_assignments` behaviour.
6. **Filters rank, they never exclude** — for brief customers only. Essentials are the only hard exclusions, plus the service-area boundary.
7. **"First pick" never claims exclusivity.** It means the customer is the closest operator and received the lead first, not that no one else will.
8. **Competition is shown as High / Medium / Low competition from management companies.** Never phrased in relation to "our network" or other subscribers.
9. **Never reveal** other holders of a lead, how many operators hold it, any customer's deficit, or area lead volumes (§19.7, §53.7, §40.12).

---

## Standing invariants (CLAUDE.md §9 and others — all must still hold)

- §9 invariants 1–12 unchanged. In particular: balance is the allocation gate (1); a lead reaches at most `max_assignments` through ordinary routing (3); every delivered lead is chargeable except the existing refund exceptions (4); Management and GR stay fully parallel and GR never reads management-only columns (6); only the four named `SECURITY DEFINER` functions are callable by `authenticated` (7); retired leads are never re-allocated and retirement stays a hard exclusion (11); no code path asks Supabase to send email (10).
- `assign_lead_to_customer` is the most sensitive function in the system. **Do not change its body.** If brief routing needs it to accept a lower-ranked delivery, pass the existing `p_allow_filter_mismatch` argument rather than editing the lock-level filter check — and only for brief customers.
- `customer_release_allows` (daily release curve, entitlement, hold) applies to brief customers exactly as to everyone else.
- `vercel.json` is authoritative for crons. Any new cron must be registered there.
- Schema changes = new numbered migrations starting at **`0161`**. Mirror any pacing maths into `pacing.ts`. Update CLAUDE.md with a new numbered section.

## Prohibited — do not modify

- `supabase/migrations/0001`–`0160` (add new migrations only).
- The body of `assign_lead_to_customer` (live in `0142`) and of `lead_matches_customer_filter` / `get_filtered_candidates_for_lead` (live in `0159`) and `get_unfiltered_candidates_for_lead` (live in `0154`) — **except** a single, additive predicate to hold delivery for a customer whose brief is required but not yet completed, if Phase 0 shows that is the least invasive gate.
- `src/app/api/webhook/stripe/route.ts` credit, invoice and provisioning logic (read only; you may add one call to recompute a brief at renewal if Phase 0 approves).
- `src/app/api/customer/filter/route.ts` and `src/components/dashboard/LeadFilteringPanel.tsx` behaviour for existing customers.
- All Guaranteed Rent code paths, columns and UI.
- Pool claim logic (`pool.ts`, `0073`–`0076` and successors), §64 owed replacements, swaps, escalation.
- Monday sync, Resend templates other than the new-lead email additions in Phase 5.

---

## Phase 0 — Audit only. Write no code.

Read and report. Stop at the end and wait for approval.

1. Confirm the live definitions and file/line of: `get_filtered_candidates_for_lead`, `get_unfiltered_candidates_for_lead`, `customer_release_allows`, `lead_matches_customer_filter`, `assign_lead_to_customer`; `autoAssignLead`, `selectCombinedCandidates` and `completeAssignment` in `src/lib/ingest.ts`; the morning release in `src/lib/releaseLeads.ts`.
2. Propose **how brief customers enter routing without changing existing customers' outcomes**: a third candidate set (e.g. `get_brief_candidates_for_lead`) whose rows are scored in TypeScript, and the exact merge rule with the filtered and unfiltered pools inside `selectCombinedCandidates`. Show that an existing customer's eligibility and ordering are unchanged.
3. Propose the **least invasive gate** that stops delivery to a new customer until their brief is complete (candidate-function predicate vs a routing hold set at provisioning vs other). Show how existing customers are exempted (backfill).
4. Confirm the reuse points and their exact signatures: `resolveRadius` / `wideningStepsFrom` (`src/components/filtering/radiusSearch.ts`), `predictMonthlyVolume` / `contentionShare` / `expansionSuggestions` / `fetchAreaContention` (`src/lib/filterPrediction.ts`), `forecastVolume` / `deliverableAtConfidence` (`src/lib/filterForecast.ts`), `outcodes.ts` (2,856 centroids, `parseOutcode`), `areaCentroids.ts` (`haversineKm`), `geoRadius.ts`. State which run client-side only and what must move server-side.
5. Check outcode coverage: what share of Management leads since `2026-07-01` parse to an outcode present in `outcodes.ts`. List unmatched examples.
6. Check data completeness for labels: share of Management leads with `postcode`, readable `bedrooms`, `gross_annual_income`, `avg_nightly_rate`, `occupancy_rate`, `net_annual_income` and `long_let_annual_income`.
7. Find every customer-facing surface that renders a lead (expected: `LeadCard.tsx`, `ContactPanel.tsx`, `NewLeadCard.tsx`, `sendNewLeadEmail` in `emails.ts`, `sendNewLeadSms` in `sms.ts`, the notification insert in `completeAssignment`) and confirm where a label and collapsible panel go.
8. Confirm the existing reject flow (`src/app/api/leads/[id]/reject`, `outcomeReasons.ts`, `leadOutcomes.ts`, `lead_outcome_reasons` from `0138`) and where "Not for me" can sit without being adjacent to "report a dead lead" (§51.6, §51.10).
9. Report any conflict between this prompt and the codebase or CLAUDE.md. **Do not resolve conflicts silently.**

**Phase 0 output:** a written report with file paths and line numbers, the proposed routing merge rule, the proposed delivery gate, and a list of files Phases 1–7 will create or touch. **STOP. Wait for approval.**

---

## Phase 1 — Data (migrations `0161`+)

- `leads.outcode text` with backfill from `postcode` via the same parsing as `parseOutcode`, set on ingest for new leads. Index it.
- `customer_lead_briefs` (one row per customer, Management only, versioned like `filter_forecast_acknowledgements`): `customer_id`, `version`, `base_postcode`, `base_outcode`, `operating_mode` (`local` | `growing` | `anywhere`), `travel_limit_miles`, `priorities` jsonb (ranked list of `location`, `revenue`, `bedrooms`, `occupancy` with thresholds), `essentials` text[] (max 2), `priority_outcodes` text[], `service_radius_miles`, `service_outcodes` text[], `first_pick_outcodes` text[], `expected_mix` jsonb, `locked_until` date (end of current billing cycle), `confirmed_at`, `created_at`.
- `customers.lead_brief_required boolean default false` and `customers.lead_brief_completed_at timestamptz`. Backfill: every existing customer stays `false`. New customers get `true` at invite or provisioning (Phase 0 decides where).
- `lead_assignments.match_label text`, `match_score numeric`, `match_reasons jsonb`. Null for every non-brief assignment.
- `area_competition` (`outcode` or `postcode_area`, `tier` high/medium/low, `source` (`contention` | `admin`), `updated_at`) — admin can override any tier.
- RLS: customers read only their own brief. All writes through server routes on the service role. Nothing new granted to `authenticated` beyond reading own rows.

**Verify:** migrations apply cleanly on a branch; the backfill leaves every existing customer `lead_brief_required = false`; `leads.outcode` populated for the share reported in Phase 0; no change to any existing function. **STOP.**

---

## Phase 2 — The brief engine (server-side TypeScript)

Create `src/lib/leadBrief/` (pure modules where possible, tests beside them):

- **Service area:** from `base_outcode` and priority outcodes, widen in steps until forecast deliverable volume (existing `forecastVolume`, contention-aware) reaches the plan allocation × a 1.3 buffer, capped at `travel_limit_miles`. Reuse `resolveRadius` / `wideningStepsFrom` logic moved server-side. Output `service_radius_miles` and `service_outcodes`. If the cap is reached before the target, widen anyway up to the cap and record that the mix will lean to Nearby (widen, never block).
- **First-pick areas:** outcodes within `travel_limit_miles` of the customer that are inside no active customer's filter and no other brief customer's `service_outcodes`, assigned to the nearest brief customer. Recompute at each renewal and lock per billing cycle (`locked_until`).
- **Similar areas:** per-area economics aggregated from lead columns (average `gross_annual_income`, `avg_nightly_rate`, `occupancy_rate`, landlord gain = `net_annual_income − long_let_annual_income`), **only where an area has at least 5 leads**. Rank candidates by similarity to the customer's priority areas, filtered to the travel limit, then sort low competition first. Return the matched figures so the UI can say exactly why each is similar.
- **Competition tier:** from `fetchAreaContention` plus the `area_competition` admin override. Admin override wins.
- **Expected mix:** forecast counts of Top / Strong / First pick / Nearby for the allocation. Copy says "expected".
- **Biggest bottleneck:** for the match preview, compute which single priority, if relaxed one step (e.g. `£50k → £40k`), most reduces `service_radius_miles`, and by how many miles. One suggestion only.

**Verify:** unit tests for each module, including a York base on the 20-lead plan, a base with no nearby supply (widens to the cap), and an essentials combination that cannot be met (clear message, no crash). **STOP.**

---

## Phase 3 — The questionnaire (new customers only)

- Route `/onboarding/brief`. On dashboard load, a customer with `lead_brief_required = true` and no `lead_brief_completed_at` is redirected there (hook near `markFirstLoginAndNotify` in `src/app/dashboard/layout.tsx`).
- Screens, matching the approved canvas design:
  0. **How your leads work** — you set priorities; your full allocation every cycle, best matches first; every lead tells you why; defines the four labels.
  1. **How you operate** — business postcode, local / growing / anywhere, furthest travel distance.
  2. **What matters most** — rank location, revenue, bedrooms, occupancy; set thresholds; pick up to 2 essentials.
  3. **Where** — priority areas, each showing its competition tier; "Similar to [area], less competition" list with the matched figures and the top suggestion **pre-ticked as "Recommended for your brief"** (untick allowed); optional bonus rule.
  4. **Your match preview** — allocation, expected mix, service area in miles, first-pick areas described as "Low competition areas where you're the closest operator, so leads here reach you first" (only label an area "low competition" if its tier is low), and one side-by-side comparison of the brief as entered vs with the recommended change.
- On confirm: write the brief, set `lead_brief_completed_at`, release the delivery gate.
- Brand: existing Tailwind / shadcn tokens, `#5D8156` / `#3B6D11` / `#EAF3DE`, sentence case, no exclamation marks.
- Never show lead volumes per area. Show radius, figures and tiers only.

**Verify:** on a Vercel preview, a test new customer is gated until the brief is confirmed and an existing customer is never redirected. **STOP.**

---

## Phase 4 — Routing for brief customers

- Add the brief candidate set and merge rule exactly as approved in Phase 0.
- Eligibility: all existing gates (active, balance, pause, release curve, retirement), lead `outcode` in `service_outcodes` or `first_pick_outcodes`, all essentials met. Nothing else excludes.
- Score (TypeScript, pure, tested): weighted by the customer's priority ranking; distance from nearest priority outcode; essentials already guaranteed. Highest score first; deficit breaks ties.
- **First sale first:** in the morning release (`releaseLeads.ts`), when filling a brief customer, prefer reachable leads with `assignment_count = 0` before a lead's second or third sale. Do not change ordering for existing customers.
- Write `match_label`, `match_score` and `match_reasons` in `completeAssignment` for brief customers only.
- Label rules: **Top match** (meets all priorities); **Strong match** (meets most, states the one gap and how close); **First pick** (lead outcode in the customer's `first_pick_outcodes`; shown as the primary label unless the lead is also a Top match, in which case Top match plus a "First pick" tag); **Nearby opportunity** (inside the service area, below priorities).

**Verify:** a replay of the last 90 days of Management leads with existing customers unchanged and two or three synthetic brief customers. Report: every existing customer's assignments identical to production; brief customers filled to allocation; share of leads sold at least once before and after. Manually test any path that reaches `assign_lead_to_customer`. **STOP.**

---

## Phase 5 — Labels and "why" on every lead

- Copy lives in a pure module with no imports (pattern: `src/lib/leadRetirement.ts`), with a test that every label and reason key has copy.
- `LeadCard.tsx`: label badge in the badge row; collapsible **"Why you got this lead"** in the expanded section: a checklist (✓ met / – missed, with the actual figure and how close), a one-line reason, and for Nearby a tip naming the one change that would turn similar leads into strong matches.
- `ContactPanel.tsx`: the same label and panel in the header.
- `sendNewLeadEmail`: label plus the one-line reason. `sendNewLeadSms`: label only.
- Reason copy by label:
  - Top match: "Sent to you first because it matches your brief exactly."
  - Strong match: names the one missed priority and the gap.
  - First pick: "You're the first operator to receive this lead. You're the closest operator to this property, in a low competition area, which puts you in a strong position to sign this landlord." (drop "in a low competition area" if the tier is not low).
  - Nearby opportunity: "No lead matching all your priorities came in this week. This was the strongest lead in your service area, sent to keep your [N] leads on track. You're on [x] of [N], with [d] days left in your cycle."
- "Not for me" on Strong and Nearby leads only, mapped to the existing reject reasons (`wrong_area`, `wrong_property`, `poor_numbers`); follows existing reject rules (chargeable, `cold` stage only). Never placed beside "report a dead lead".
- A "Your brief" summary bar above the lead list with an Edit link (editing creates a new brief version; changes to the service area apply at the next renewal).
- Dashboard line: "This month: x top · y strong · z first pick · w nearby".
- **Never** mention other operators, shared leads, deficits or volumes. **Never** use "guarantee" about a match.

**Verify:** screenshots of each label state on the preview; copy test passes; existing customers' cards unchanged. **STOP.**

---

## Phase 6 — Admin: Lead Reach (reporting only)

New page `/admin/reach` under the Insights nav group:

- % of Management leads within reach of at least one customer (this month, 12-week trend).
- Unreached leads by area, ranked, with weeks since a customer was in reach.
- Leads sold once / twice / three times (from `assignment_count`, clamped with `greatest(…,0)`, excluding withdrawn).
- First-pick areas and their customer.
- Capacity by area: leads × 3 against committed allocation.
- Competition tier editor for `area_competition` overrides.
- Weekly alert to Zac via Resend (not Supabase email): forecast supply against committed allocation for the next 4 weeks, and any area with steady leads and no customer in reach for 3+ weeks. Register the cron in `vercel.json`.
- Reporting only. Nothing here blocks a sale (§16).

**Verify:** figures reconcile with a direct SQL count for the last 30 days. **STOP.**

---

## Phase 7 — Copy and docs

- `src/app/guaranteed-rent/page.tsx` ~line 108: "Maximum 2 operators per lead" → three. *(This is copy only; no GR logic changes.)*
- `src/components/dashboard/ConversionFunnel.tsx` ~lines 99–100: "racing one other operator" → wording consistent with up to three.
- Leave `src/app/api/admin/leads/[id]/route.ts` ~line 69 as is (correct for customer-added leads).
- Add a CLAUDE.md section "Lead Brief (new customers only)" covering the tables, routing merge rule, label rules, copy rules and the exemption of existing customers.

**Verify:** grep confirms no remaining customer-facing "two operators" claims on Management surfaces. **STOP** for Vercel preview review before merge to `main`.

---

## Revision safety

Read every file before modifying it. Touch only files named in an approved phase. If a task instruction conflicts with the existing code or CLAUDE.md, stop and describe it — do not resolve it silently.
