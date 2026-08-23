-- ============================================================================
-- Backfill postcode / postcode_area for leads ingested before the parser.
--
-- 137 leads carry a NULL postcode_area. A lead with no area is invisible to
-- EVERY filtered customer (0026) and is excluded from every volume prediction
-- (src/lib/filterPrediction.ts), so the gap understates matchable supply by
-- ~26% on management and ~55% on Guaranteed Rent. That matters now in a way it
-- did not before: the filter volume guarantee prices a commitment off those
-- predictions, and a rate that is low by half is a guarantee sold too cheap.
--
-- THIS IS NOT AN INGEST BUG — DO NOT "FIX" THE PARSER
-- ---------------------------------------------------------------------------
-- `extractPostcode` (src/lib/postcode.ts) already handles every format in the
-- data: it is case-insensitive, tolerates a missing or collapsed space, and
-- takes the LAST match. Both insert builders call `withPostcode`
-- (src/lib/ingest.ts). The gap is purely historical — the parser shipped with
-- lead filtering on 2026-07-21 (#29) and every recoverable row predates it.
-- From the week of 2026-07-27 onward the recoverable gap is zero. So this is a
-- one-time data repair, and no code changes with it.
--
-- WHY THE REGEX IS WRITTEN THE WAY IT IS
-- ---------------------------------------------------------------------------
-- It mirrors POSTCODE_RE = /([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})/gi, matched
-- against upper(address), taking the last match — verified row by row against
-- the real parser before this was written.
--
-- The obvious Postgres spelling of "last match" is a greedy `.*` prefix, and it
-- is WRONG: `.*` eats as much as it can, so `[A-Z]{1,2}` is left matching one
-- letter and every two-letter area loses its first character. "BS14 0GG" comes
-- out as "S14 0GG" — Bristol filed under Sheffield. Enumerating all matches
-- with the 'g' flag and taking the highest ordinality is what actually mirrors
-- the JS while-loop, and is what is used below.
--
-- TWO PASSES, AND WHY THE SECOND ONE WRITES NO POSTCODE
-- ---------------------------------------------------------------------------
-- Pass 1 recovers a full postcode (118 rows) and sets both columns. Pass 2
-- handles addresses carrying only an outward code — "Wisewood place sheffield
-- S6", "High Court Lane Leeds ls2" — and sets ONLY postcode_area (11 rows).
-- Routing and prediction read nothing but the area, so those rows become
-- useful; inventing an inward code to fill `postcode` would be fabricating
-- data, so `postcode` stays NULL and stays honest.
--
-- 6 addresses yield nothing ("n/a n/a", "80 Clark Road Wolverhampton") and 2
-- leads have no address at all. Those 8 are left alone.
--
-- Idempotent: both passes are guarded on `postcode_area is null`, so a re-run
-- is a no-op. Additive: no column is added, dropped or renamed.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 — Full postcode recovered from the address (118 rows).
-- ---------------------------------------------------------------------------
update public.leads l
set postcode      = e.pc,
    postcode_area = substring(e.pc from '^[A-Z]{1,2}')
from (
  select l2.id,
         (select m[1] || ' ' || m[2]
            from regexp_matches(
                   upper(l2.address),
                   '([A-Z]{1,2}[0-9][A-Z0-9]?)[[:space:]]*([0-9][A-Z]{2})',
                   'g'
                 ) with ordinality as t(m, ord)
           order by ord desc
           limit 1) as pc
  from public.leads l2
  where l2.postcode_area is null
    and l2.address is not null
    and l2.address <> ''
) e
where l.id = e.id
  and e.pc is not null
  and l.postcode_area is null;

-- ---------------------------------------------------------------------------
-- 2 — Outward code only: area recovered, postcode deliberately left NULL
--     (11 rows).
-- ---------------------------------------------------------------------------
update public.leads l
set postcode_area = substring(e.outward from '^[A-Z]{1,2}')
from (
  select l2.id,
         (select m[1]
            from regexp_matches(
                   upper(l2.address),
                   '\m([A-Z]{1,2}[0-9][A-Z0-9]?)',
                   'g'
                 ) with ordinality as t(m, ord)
           order by ord desc
           limit 1) as outward
  from public.leads l2
  where l2.postcode_area is null
    and l2.address is not null
    and l2.address <> ''
) e
where l.id = e.id
  and e.outward is not null
  and l.postcode_area is null;

-- ---------------------------------------------------------------------------
-- 3 — The case/trim invariant, now that money depends on it.
--
-- The JS prediction uppercases and trims both sides when matching areas
-- (buildLeadVolumeAggregate, predictMonthlyVolume); the SQL router compares RAW
-- (`l.area = any (c.filter_areas)` in get_filtered_candidates_for_lead). They
-- agree today — every populated area is already uppercase and untrimmed-clean —
-- but nothing enforced it, and filterPrediction.ts's header requires the two to
-- mirror each other exactly. A lowercase area would be silently invisible to
-- the router while still counting towards the guarantee.
--
-- Normalise first (a no-op today) so the constraint cannot fail on apply.
-- ---------------------------------------------------------------------------
update public.leads
set postcode_area = upper(btrim(postcode_area))
where postcode_area is not null
  and postcode_area <> upper(btrim(postcode_area));

alter table public.leads
  drop constraint if exists leads_postcode_area_normalised_check;
alter table public.leads
  add constraint leads_postcode_area_normalised_check
  check (postcode_area is null or postcode_area = upper(btrim(postcode_area)));
