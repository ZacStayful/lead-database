-- ============================================================================
-- A revenue floor on a lead filter, and a version on the public volume cache.
--
-- Every management lead carries a projected GROSS ANNUAL REVENUE, parsed from
-- its Stayful property analysis (§25, leads.gross_annual_income). It is shown
-- on the lead and nothing filters on it, so a customer who only wants
-- properties worth £50k+ has to open every lead to find out. This is the
-- column that lets them say so, priced and forecast by the same §28 machinery
-- under the same rules.
--
-- ⚠️ POUNDS, NOT PENCE, unlike every other money column in this schema
-- (price_paid, filter_forecast_plan_price_pence, costPerLeadPence). It is
-- compared directly against leads.gross_annual_income, which is numeric in
-- pounds. A floor stored in pence matches nothing, quotes zero, and reads to
-- the customer as "your filter is too narrow" rather than as a bug.
--
-- ⚠️ MANAGEMENT ONLY — THERE IS DELIBERATELY NO gr_ MIRROR, and that is not an
-- oversight of invariant 6. That invariant governs balance, counter, pacing
-- and eligibility branches; this is none of those. Measured on production
-- 2026-09-24: ZERO of 291 guaranteed-rent leads carry a gross figure, because
-- §25's analysis is management-only by design — so a gr_ column could never
-- hold a value that meant anything, and a column that can never be set is a
-- column that lies about what the product does. The GR branch of every filter
-- function is therefore structurally unable to read a floor, which satisfies
-- invariant 6 by construction rather than by a clause somebody must remember.
--
-- ⚠️ THE ALLOWED VALUES ARE A FIXED LIST, AND IT MUST MATCH GROSS_THRESHOLDS
-- IN src/lib/filterPrediction.ts CHARACTER FOR CHARACTER. That is what makes
-- the prediction's banding exact rather than approximate: because the only
-- floors are these, ">= £40k" is EXACTLY the union of the aggregate's bands
-- from 40k up, agreeing with this predicate cell for cell. If the two ever
-- diverge, every floored quote is computed at the wrong edge and half the
-- directions OVERSTATE. grossBands.test.ts asserts the equality mechanically,
-- the cancelOptions.ts arrangement (§29).
--
-- ⚠️ £100k was measured and DROPPED rather than shipped. Only 7 management
-- leads in the whole book clear it, so no area-restricted filter could ever
-- reach MIN_RELIABLE_MATCHES — and an unofferable forecast does not merely
-- decline to quote, it writes NULL into all five forecast columns and skips
-- §39.8's give-back question (§58.3 records five customers already in that
-- state). Adding it back is one entry in each list, if the book grows into it.
--
-- ⚠️ execute_filter_lift MUST null this column alongside the areas and the
-- bedroom bounds. 0094 deliberately declined to touch that function for the
-- radius METADATA — a create-or-replace of a privileged function for a
-- nicety. A revenue floor is not metadata, it is a live predicate input, so
-- the opposite applies: forgetting it strands a floor behind a lifted filter
-- and NOTHING ERRORS. That change ships with the four filter functions, not
-- here, because this migration is inert and that one is not.
--
-- Additive, nullable, and INERT: no function reads either column until the
-- code that does ships, and every existing row keeps behaving exactly as it
-- does today.
-- ============================================================================

-- ---------------------------------------------------------------- the floor
alter table public.customers
  add column if not exists filter_min_gross integer;

alter table public.customers
  drop constraint if exists customers_filter_min_gross_check;
alter table public.customers
  add constraint customers_filter_min_gross_check
  check (
    filter_min_gross is null
    or filter_min_gross in (25000, 30000, 40000, 50000, 75000)
  );

comment on column public.customers.filter_min_gross is
  'Minimum projected gross annual revenue, in POUNDS (not pence), from GROSS_THRESHOLDS in src/lib/filterPrediction.ts. NULL = no revenue floor. Management only — guaranteed rent has no lead carrying a gross figure, so there is deliberately no gr_ mirror.';

-- ------------------------------------------------- the public cache version
--
-- ⚠️ WITHOUT THIS, SHIPPING A NEW PAYLOAD SHAPE QUOTES ZERO ON A MARKETING
-- PAGE FOR UP TO SIX HOURS. toProductVolume reads `p.areaBedCounts ?? {}`,
-- and that default is deliberate — the row genuinely ships as '{}' (0099) and
-- a landing page can render against an un-primed cache. Which means an
-- OLD-SHAPE payload is indistinguishable from an un-primed one: every
-- revenue-floored estimate would read zero until the next rebuild, which is
-- §58.2's failure self-inflicted, and it would recur on every future shape
-- change.
--
-- ⚠️ A PLAIN INTEGER COLUMN, NOT A payload->>'schemaVersion' JSON PATH inside
-- the staleness filter string. §65.6 records that shape as "easy to reason
-- about wrongly, and impossible to test without PostgREST running", and chose
-- an RPC over it. A column is inspectable in SQL and testable.
--
-- NULL means "written before versioning", which the reader treats as
-- unusable rather than as version 0 — the same three-outcomes rule (§18.3).
alter table public.public_filter_volume
  add column if not exists schema_version integer;

comment on column public.public_filter_volume.schema_version is
  'Shape version of payload. Folded into the atomic staleness claim so a deploy that changes the shape forces ONE rebuild rather than serving an old shape for PUBLIC_VOLUME_STALE_AFTER_MS. NULL = predates versioning.';
