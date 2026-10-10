# Batch 06 — Phase 0 report (approved 10 Oct 2026)

Zac answered the batch's open questions on 10 Oct 2026, and the decisions are recorded below as D1–D4. This is the repo copy, so later sessions can read the decisions behind 06. **The decision register is not in the repo**: it lives in the Claude project as `claude/decision-register.md`. Copy D1–D4 there too.

The audit ran on `main` @ `5c34966` (10 Oct). Line numbers below are for that commit.

The figures come from production (`znlfwbnvhlacwzgfalcf`), Monday and n8n, all read-only, on 9–10 Oct. **No landlord names or addresses appear here**: a lead is named by its id prefix, and a Monday item by its item id.

## Orientation

- **This session:** batch 06, Phase 0 (audit only, then STOP). Wave 2.
- **Merged:**
  - Lead Brief Phases 0–5B: migrations 0161–0164, with `lead_brief_enabled` off.
  - Batch 02, complete (0165, CLAUDE.md §75).
  - Batch 03 Part A, Phases 1–2 (0166, §76).
- **Not yet merged:**
  - Batch 04: Phase 0 approved, Phase 1 not started.
  - Batch 05: Phase 0 not yet reviewed.
- **Depends on 06:** nothing downstream. The 06 build (Phase 1) waits on **batch 04 merging**. 04 and 06 must never build together, because both change which leads a customer can receive.
- **Docs read:**
  - `00-index.md`;
  - `lead-brief-build-prompt.md` (locked decisions 1–9);
  - `01-lead-brief-additions.md` (A12, and "Unchanged and re-confirmed");
  - `02-phase0-report.md` through `05-phase0-report.md`;
  - this batch's prompt, `06-lead-data-completeness.md`.
- **Next free migration:** 0167 (04 may take it first; renumber per the merge rule).

## Decisions (10 Oct)

| | Decision |
|---|---|
| **D1** | **Scope (a): hold incomplete leads from brief customers only.** Existing customers keep receiving them as today. This keeps Lead Brief locked decision 1 ("Every customer active before this ships keeps their current filter, routing and UI exactly as today … Nothing they receive changes") with no change to the register. Phase 1 still sets `held_reason` on every Management lead and refreshes held leads from Monday. The routing predicate goes **only** in `get_brief_candidates_for_lead` (0163). |
| **D2** | **District only is held**, until the full postcode is collected. **Hold labels:** District only, Area data thin, Check bedrooms, No location. **Sellable labels:** Full address, Postcode only. **Blank label:** check the three fields directly. |
| **D3** | **The label must move to release a label-held lead.** The app reads the label and never recomputes it, as the batch says. A lead is released when its label is sellable **and** the three fields are complete. A sellable label over blank fields (F1) stays held until the refresh fills them. **This needs work outside the repo:** n8n must recompute the label when Address, Bedrooms or the report change (F5). Until then, a hand-fixed lead needs a hand relabel on Monday. |
| **D4** | **Repair F1's nine blank leads now**, independent of batch 06 and not on this batch's branch. **Done 10 Oct**, directly on production; see F1. |

---

## 1. How many leads are incomplete

These are Management leads created in the last 90 days (11 Jul – 9 Oct). "Readable bedrooms" uses the routing rule, `substring(bedrooms from '\d+')` (0163:59 and :276).

**Marketplace leads (sold through routing): 288**

| Missing | Leads | Share |
|---|---|---|
| Postcode | 17 | 5.9% |
| An outcode that parses (`leads.outcode`, 0161) | 17 | 5.9% |
| Readable bedrooms | 12 | 4.2% |
| `gross_annual_income` | 23 | 8.0% |
| **Any of the three** | **43** | **14.9%** |

Notes on the rows:
- **Outcode** is generated from every well-formed postcode (0161), so it is missing exactly when the postcode is. Separately, 0161's header measured 2 outcodes absent from the centroid list.
- **Bedrooms:** 9 are blank. 3 hold junk: "E bedrooms", "various flats bedrooms", and a sentence typed into the cell.
- **Revenue:** all 23 have `income_report_status = 'no_report'`, meaning no analysis PDF was ever attached to the Monday item.

| How the gaps combine | Leads |
|---|---|
| Revenue only | 23 |
| Postcode and bedrooms | 9 |
| Postcode only | 8 |
| Bedrooms only | 3 |

By month: Jul 6 of 60, Aug 11 of 95, Sep 14 of 95, **Oct 1–9 12 of 38**. Nine of October's twelve come from one fault, F1.

**Customer-owned leads: 11.**
- All 11 lack revenue, because no analysis was bought. 3 lack a postcode and 2 lack bedrooms.
- They are never sold unless analysed and resale-qualified (§32).
- `qualify_owned_lead_for_resale` (0108:330) requires gross and `postcode_area`, but **not readable bedrooms**.
- `analysability()` reads "Studio" as 0 bedrooms (`leadAnalysis.ts:88-103`) where routing reads it as null.
- Both are noted for Phase 1 and not changed here.

**Source split (Google vs Facebook): not possible from the database.**
- `leads` has no source, utm or fb column. The only provenance field is `owner_source` (import, manual or webhook), and only customer-owned leads have it. This is the same answer A12 check 6 got.
- Monday carries one: `text_mm7wy4pv` "Lead Source" on 18420117742 (`text_mm7ew9e0` on 5891626711). n8n writes "Facebook" there. Nothing writes "Google": a blank means a Google or calculator lead.
- The app does not read that column.

**Property data label** (`color_mm7z8pt0`, on 18420117742): set on 24 items, all created or labelled since 6 Oct.

| Label | Items |
|---|---|
| Full address | 13 |
| Postcode only | 9 |
| District only | 1 |
| Area data thin | 1 |
| Check bedrooms | 0 |
| No location | 0 |
| (blank) | the other ~316 items on the board |

**District only** (the second STOP).
- One item carries the label today: lead `9d9183a0`, outcode NG8. It has no postcode and a district-level gross, and it is unsold. It is routable today to unfiltered customers. It is not routable to filtered or brief customers: there is no `postcode_area`, no `outcode`, and 0163:321 needs one.
- Before the label existed, the proxy is an address carrying an outcode but no full postcode: **4 leads in 90 days (1.4%)**, all with a gross.
- So holding District only costs about **1–2 leads a month**. Held, per D2.

## 2. Where the gaps come from

Only two code paths insert into `leads`: `ingestLead` (`src/lib/ingest.ts:246`, insert at :411) and `create_customer_leads` (0135).

| Path | What it does for these leads |
|---|---|
| **Monday pull-sync** | **Every incomplete marketplace lead came this way.** It covers the five-minute poll (`src/lib/leadSync.ts`, `/api/cron/monday-lead-sync`) and the 09:00 walk (`fetchMondayLeads`, `src/lib/monday.ts:1429`). The address comes only from `text6`: there is no postcode column, and `withPostcode` (`ingest.ts:108`) parses the postcode from the address. Bedrooms are the raw `text5`. A gap is stored as `""` (`buildManagementInsert`, `ingest.ts:118`) |
| **n8n webhook** `POST /api/webhook/n8n` | **Delivers nothing for Management.** Its one Management caller is n8n "Lead for Sale: Push to Lead Database App" (`aHTViy23NrnKeoN4`). That fires on a Monday `create_item` on 18420117742, but items reach that board by being **moved** there by Monday automation 7920216105 ("Qualify leads for sale" on 5891626711). So the workflow has never run (0 executions). It also posts to the `…vercel.app` deployment URL, which sits behind Deployment Protection (see F4) |
| **Facebook lead form** | Never writes `leads`. Facebook landlord leads enter 5891626711 through n8n (`JTfIRLtMvdU8bnba`), are moved to the for-sale board and are pulled in by the sync. Facebook *operator* enquiries go to `customers` instead (§57) |
| **Customer-added** (`create_customer_leads`, 0135:166-211) | The 11 owned leads above. Never sold unless resale-qualified |

### F1 — ⚠️ Nine leads were frozen blank at ingest, and four were sold that way

**Which leads:** nine items created 6–9 Oct:

| Lead | Monday item |
|---|---|
| `fd5c350e` | 13223068666 |
| `595a5ef1` | 13230605784 |
| `fa0ef439` | 13234069220 |
| `7626cbd4` | 13236224059 |
| `a6610c12` | 13236568013 |
| `8c2861e5` | 13236679502 |
| `82eb1e58` | 13238150557 |
| `080f01d0` | 13240394520 |
| `deb68198` | 13244951560 |

Each is stored with an empty address, no postcode and no bedrooms. Monday now holds the address and bedrooms for all nine, labelled Full address (7) or Postcode only (2).

**How it happened**, from Monday's activity log and n8n's executions for item 13236224059:
1. The item was created on 5891626711 at 08:40 UTC on 8 Oct, with no address.
2. A report PDF landed at 08:42.
3. n8n `BKoHh3lheV8WWSX4` set the status to "Lead for sale".
4. Automation 7920216105 moved the item. The move does copy `text6`/`text5`, but both were empty.
5. The poll ingested it 3 minutes later.
6. About **22 hours** later (06:36 UTC on 9 Oct), the one-off Facebook-sheet resync (`JTfIRLtMvdU8bnba`, "sale" mode) wrote the address and bedrooms onto 18420117742.
7. The label was set by hand at 07:56.

**Why it stayed blank:** ingest never re-reads an item it already has (`leadSync.ts:27-28`), and the two-minute settle cannot cover a 22-hour gap.

**The cost:** **four were sold**: `595a5ef1`, `fa0ef439`, `7626cbd4` and `a6610c12`, **8 assignments** in all. Those customers hold a lead with no address and no bedrooms on screen. Items labelled after 9 Oct 07:56 arrived complete.

**D4: repaired on production on 10 Oct**, after this report merged. Done the way CLAUDE.md §49.5 records for the phone backfill, not through a new route:
- The address and bedrooms were read from each Monday item, and the postcode and area were worked out by the shipped `extractPostcode` / `postcodeArea`. Those are the four columns `withPostcode` writes at ingest (`ingest.ts:108`). `outcode` is generated, so it was not written.
- The old rows (all blank) were saved first.
- The update was guarded on the lead id **and** its Monday item, on a Management marketplace lead, and on the address, bedrooms and postcode still being blank. So a row changed in the meantime would have been skipped, not overwritten. All nine matched.
- `leads` has no triggers. A fingerprint of every other lead, every assignment and every customer's balances and counters was identical before and after.
- Effect: the four sold leads now show their address and bedrooms to the customers holding them. All nine now have an outcode and a postcode area, so filtered customers can receive the ones with free slots from the next sync or release.
- The nine were exactly the "postcode and bedrooms" group in §1. On the same 288 leads, "any of the three" falls from 43 to 34 (11.8%). The other figures in this report are as measured before the repair.

### F2 — An "Area data thin" lead shows a figure anyway

Lead `7d345ff7` (E3) is labelled Area data thin, which means no trustworthy revenue estimate. The app nevertheless parsed a gross from the PDF on the item, and the lead is sold to 3 customers.

Under D1 that stays as it is for existing customers. Under D2 the label holds the lead from brief customers, because the label wins.

### F3 — A comment, and §36.5, claim a self-heal that does not happen

`ingest.ts:266-271` says: "a number corrected on the board clears itself on the next sync". CLAUDE.md §36.5 says the same.

It does not happen:
- `refreshLeadQuality(supabase, existingLead)` (`ingest.ts:272`) re-judges the **stored** row.
- The existing-row branch (`ingest.ts:256-306`) ignores the fresh payload it was handed.
- Nothing copies board edits onto a lead that already exists.

The Phase 1 refresh (§5) fixes this for held leads. Correct the comment and §36.5 when it lands.

### F4 — The n8n "push" workflows are dead (outside this repo)

Both "Push to Lead Database App" workflows (`aHTViy23NrnKeoN4` for Management, `Z5Tfpx6PEYYRILlF` for GR) post to the protected `…vercel.app` deployment URL. The GR one has failed **all 88 retained runs since 11 Sep** with a 401 "Protected deployment". GR leads still arrive through the daily GR sync and the poll.

The fix is n8n-side: point them at `leads.stayful.co.uk`, or retire them. **Do not build Phase 1 on the webhook.**

### F5 — ⚠️ Conflict with this batch's prompt: nothing recomputes the label after a fix

**Checked:** "Upstream signal" in `06-lead-data-completeness.md`: "Held leads get worked upstream: someone collects the missing detail from the landlord, n8n re-runs the report, and the label updates on Monday."

**What n8n actually does** (read 10 Oct):
- Only "Facebook Lead Sheet → Monday + Report" (`JTfIRLtMvdU8bnba`, node `Update Or Create`) works the label out. It does so for a **new** Facebook sheet row, from the sheet data, in the same Monday write as `text6`/`text5`, before the report runs.
- **Area data thin** is written only by its node `Build Note`, to `color_mm7zanzk` on 5891626711, after the calculator returns a `gated_reason`.
- `BKoHh3lheV8WWSX4` and `IoCOvZySfO71CNtE` **copy** the label to `color_mm7z8pt0` 45 s after a move. They do so only on a run that writes "Lead for sale".
- **Things that leave the old label in place:** a hand edit of Address or Bedrooms, a report re-run (`8VV9UZERO2l49VXk`), or a re-uploaded PDF.

JTf's rules, for reference:

| Label | Rule |
|---|---|
| Full address | a full postcode plus at least 3 other letters |
| Postcode only | a full postcode and nothing else |
| District only | text ending in a postcode district |
| No location | anything else |
| Check bedrooms | replaces the first three when bedrooms is not a whole number 0–10 |

**Resolved by D3:** the label must move. The n8n recompute is needed outside this repo. Until it exists, a fixed lead is released by a hand relabel.

## 3. Whether gaps can be filled automatically

**Revenue: it is filled upstream. Don't build analysis into the app.**

**What already runs in the app:**
- `/api/cron/parse-income-reports` (daily 12:00) re-checks `no_report` leads for 30 days (`route.ts:38`, `:140-147`), reading the PDF off the Monday item. So a report attached upstream lands within a day.
- It does not re-route the lead. The next 07:30 weekday release (`src/lib/releaseLeads.ts`) or the 09:00 sync offers it.

**What an app-side fill would need:**
- **Code that exists:** `analyserClient.ts` and `processAnalysisRow` (`src/lib/leadAnalysisRun.ts`) can analyse any lead id.
- **Why no current path can use it:** every route in is customer-paid. A job needs a `customer_id` (0104:60) and a charge, and `qualify_owned_lead_for_resale` is owned-only (0108:330).
- **What it would cost:** a system path would be new code. Each call buys an external report (§31.8) and takes 20–70 s (`ANALYSIS_ROW_TIMEOUT_MS` 45 s, worst case about 70 s).

**What n8n runs today:**
- "Management Leads: Auto Report For Stray Leads" (`8VV9UZERO2l49VXk`) runs at 09:00 and 15:00. It covers items **on 5891626711 from the last 7 days** with no report, at most 10 a run, once per lead.
- JTf runs the report for new Facebook sheet rows.
- **Nothing runs it for an item already on 18420117742**, which is where all 23 revenue-only leads sit.

**Recommendation:** widen the stray-report run to cover held items on 18420117742. That is n8n work, outside this repo. The app's sweep and the Phase 1 refresh then pick the figure up with no app change. All 23 revenue-only leads have a postcode and bedrooms, so the analyser can take them.

**Postcode and bedrooms: nothing in the app can fill them.**
- 0027 and 0097 were one-off backfills.
- `areaFromAddress` (`postcode.ts:65-67`) has no callers.
- The PDF parser reads no address or bedrooms.
- The only automatic route is upstream completion plus the app re-reading Monday (§5). For F1, that alone fixes all nine.

## 4. What happens to a held lead's value

| Rule | Applies to | Clock |
|---|---|---|
| Ordinary routing | every lead | **No age limit.** `releaseLeads` offers oldest first, with no cap |
| Pool entry, `unassigned` basis | never-assigned leads | `lead_last_activity_at` = `created_at` + 25 days (`pool_entry_days`, 0073:73). The lead stays routable (0155:187-188) |
| Pool expiry | pooled leads | `pool_first_entered_at` + 90 days (`pool_life_days`, 0073:77), so about `created_at` + 115 days. The lead is then retired |
| Escalation (§18) | assigned leads only | 10 and 20 days from `assigned_at`, with an age gate of 25 |
| `release_fresh_hours` (0154) | — | measured from `created_at`. Seeded 0, which means off |

**The pool, for scope (a) as chosen:**
- Brief customers have no pool ("No pool", 01 "Unchanged and re-confirmed").
- Existing customers are unaffected by D1.
- So **no pool bar is needed**.

**The pool, under scope (b), which was not chosen:**
- A held lead would have needed a `lead_pool_barred` clause (0155:210).
- Otherwise a never-sold held lead pools at day 25, and `customer_can_see_pool_lead` makes it claimable free. That is §36.5's trap.

**Staleness:**
- The business case for speed is §42 (contact on day 0) and §54.
- Apart from pool expiry, nothing in the code ends a lead's sellability by age.
- **The docs don't say when a held lead should be given up**, because they assume it is completed upstream. Phase 1's admin queue shows each held lead's age from `created_at`. A cut-off is a later decision.

## 5. Reading the label, and refreshing held leads

**Is `color_mm7z8pt0` in the n8n webhook payload today? No, and nothing sends that payload.**
- `aHTViy23NrnKeoN4` maps:
  - `text6`, `text5`;
  - `phone_mm1hp0a8`, `text_mkygb5xx`, `text_mm1x8cgy`;
  - `date`;
  - the item id and name;
  - `text_mm2eawgk`.
- It never runs (§2, F4).
- In the app, `N8nLeadPayload` takes extra keys (`types.ts:1105-1122`), but `buildManagementInsert` copies only `LEAD_FIELDS` (`ingest.ts:45-54`).
- **Read the label through the pull-sync only.**

**Pull-sync:**
- Both readers request exactly `Object.values(COLUMN_MAP)` (`monday.ts:14-22`): the 09:00 walk (`fetchMondayLeads`, column list at :1437) and the poll (`fetchRecentManagementLeads`, :1610).
- Adding `property_data: "color_mm7z8pt0"` there makes both read it, with no query change and no extra request.
- `mapManagementItem` (:1503) carries it into the payload.

**Re-checking a held lead today: never.**
- The poll drops every known id with one `in(...)` read.
- The 09:00 walk hands the fresh payload to `ingestLead`'s existing-row branch (`ingest.ts:256-306`), which ignores it (F3).

**Proposed refresh: held, unsold leads only, and never a worked lead.**
1. **The 09:00 walk (daily backstop).** In the existing-row branch, when the stored row has `held_reason` set:
   - re-apply the payload's `address`, through `withPostcode`, so `postcode`, `postcode_area` and the generated `outcode` follow;
   - re-apply `bedrooms` and `property_data`;
   - if `gross_annual_income` is still null and the payload carries a report URL, run `attachIncomeProjection` (`ingest.ts:469`);
   - recompute `held_reason`.

   The `autoAssignLead` call already there then routes the lead once it is complete.
2. **The five-minute poll (latency).** The poll's page is already sorted by `__last_updated__` descending, so an item whose label just changed rises to the top. Today it is dropped as known.
   - Change: among the page's **known** ids, select those whose lead is held (one extra read, `held_reason is not null`), and pass them through the same refresh.
   - Capped within the existing tick budget (`LEAD_POLL_BUDGET_MS`, `leadSync.ts:50`).
   - A label moved on Monday then reaches the app within about five minutes.

## 6. Impact of the scope choice (as measured for the decision)

**Live today:**
- One customer is flagged `lead_brief_required`; none has completed a brief.
- `lead_brief_enabled` is off.
- 14 Management customers are live: 8 filtered, 5 unfiltered, 1 `pending_lift`. They hold 68 unspent credits against 190 a month of allocation.
- Stock: 125 marketplace leads have a free slot. 22 of them are incomplete: 9 revenue-only, and 13 missing a postcode or bedrooms.

**Option (a), chosen (D1):**
- **Costs nothing today.**
- It is one predicate, `l.held_reason is null`, in `get_brief_candidates_for_lead` (0163:247), which has no live caller while the switch is off.
- The brief pool already needs an outcode (0163:321). It already reads a null figure as failing an essential (0163:336-337). So (a) adds bedrooms, revenue and the label for briefs that set none of those essentials.
- No change to `assign_lead_to_customer`, the legacy pools or the pool.

**Option (b), not chosen:** it would have held 43 of 288 leads (14.9%), which made **69 of 545 assignments (12.7%)**.

| Leads that would have been held | Assignments | Who had them | Cost |
|---|---|---|---|
| Missing postcode or bedrooms | 29 | Mostly unfiltered customers. Filtered customers can't receive them anyway (0163:86-87) | Not measurable against 103 complete leads in stock |
| Revenue only | 40 | 17 went to 9 **filtered** customers without a revenue floor, about 6 a month | **The real cost:** §69 found 6 of 8 filtered customers already under plan |

(b) would also have amended Lead Brief locked decision 1.

## 7. Conflicts, each quoting the doc section checked

| Doc | Says | Finding |
|---|---|---|
| 06, "Upstream signal" | "n8n re-runs the report, and the label updates on Monday" | No workflow recomputes the label after a fix (F5). Resolved by D3 |
| 06, Phase 0 point 5 | "the n8n webhook payload into `POST /api/webhook/n8n` … Which n8n workflow sends it?" | None does. The Management push never fires, and the GR push fails with a 401 (F4) |
| 06, Phase 1 | "Use automatic enrichment wherever Phase 0 found it possible" | Only upstream enrichment is possible. Revenue for for-sale items needs the n8n stray-report run widened (§3). Postcode and bedrooms come only from Monday, via the refresh |
| Lead Brief prompt, locked decision 1 | "Nothing they receive changes" | Option (b) would have amended it. D1 keeps it |
| User's session note | "the decision register (docs/build/decision-register.md)" | Not in the repo. `00-index.md` lines 3–5 place it in the Claude project |

## Phase plan

Each phase ends with STOP, a status-row update in `00-index.md`, a draft PR, and a merge on approval.

- **Phase 1: hold and enrich.** Starts after batch 04 merges. Run the function-overlap check against 04's migrations first.
  - **Migration 0167 or later.** Adds `leads.property_data text` and `leads.held_reason text`. Re-creates `get_brief_candidates_for_lead` with one added line, `and l.held_reason is null`, and its grants re-asserted (§11). Backfills `held_reason`. No other function changes.
  - **`src/lib/leadCompleteness.ts`** (pure, import-free): `heldReasonFor(fields, label)`, using D2's mapping and D3's rule with the routing bedroom rule. Its tests use the leads in this report as fixtures.
  - **Reading the label:** `property_data: "color_mm7z8pt0"` in `COLUMN_MAP`, passed through `mapManagementItem` and stored at insert, with `held_reason` stamped there.
  - **The refresh** (§5): the existing-row branch, held rows only, plus the poll's known held ids.
  - **Admin queue** `/admin/leads/held`: missing fields, label, age and the Monday link, with a "Re-read from Monday" action.
  - **Verify:**
    - an incomplete lead is held from the brief pool;
    - a Check bedrooms lead is held, and Full address with complete fields releases it;
    - both legacy candidate functions are fingerprinted on production before and after, and are identical;
    - `assign_lead_to_customer` is unchanged.
- **Phase 2: docs.** A CLAUDE.md section with the column ids, D1–D4, the mapping and F3's correction.

**Outside the repo, for Zac:**
- n8n: recompute the label on Address, Bedrooms or report change (D3).
- n8n: widen the stray-report run to cover held items on 18420117742 (§3).
- F4: point the push workflows at `leads.stayful.co.uk`, or retire them.

## Verification (this phase)

- Every figure was measured read-only on production on 9–10 Oct. The label counts come from Monday (`color_mm7z8pt0` is_not_empty on 18420117742). F1 was checked against item 13236224059's activity log and n8n executions 44888, 44892 and 45375.
- Docs only, in `docs/build/`: no migration, no code.
