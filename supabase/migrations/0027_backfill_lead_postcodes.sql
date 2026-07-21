-- ============================================================================
-- Backfill postcode / postcode_area on existing leads.
--
-- 0021 added the postcode columns, but extraction only runs at ingest, so every
-- lead created before this feature has NULL postcode_area. That leaves the
-- lead-filtering area picker empty (it is populated from distinct postcode_area
-- values present in leads). This backfills both columns from each lead's stored
-- address, mirroring the extraction in lib/postcode.ts:
--   * find the LAST UK-postcode-shaped token in the address (postcodes sit at
--     the end; run-together words do not affect a standalone postcode)
--   * normalise to uppercase with a single space before the inward code
--   * postcode_area = the letters before the first digit
-- Only rows that still have a NULL postcode_area and yield a match are touched;
-- unparseable addresses stay NULL (invisible to filtered routing, as intended).
-- Idempotent: safe to re-run.
-- ============================================================================
update public.leads t
set postcode = x.pc,
    postcode_area = substring(x.pc from '^[A-Z]{1,2}')
from (
  select id, pc
  from (
    select
      l.id,
      upper(m.match[1]) || ' ' || upper(m.match[2]) as pc,
      row_number() over (partition by l.id order by m.ord desc) as rn
    from public.leads l
    cross join lateral regexp_matches(
      coalesce(l.address, ''),
      '([A-Za-z]{1,2}[0-9][A-Za-z0-9]?)\s*([0-9][A-Za-z]{2})',
      'g'
    ) with ordinality as m(match, ord)
  ) ranked
  where rn = 1
) x
where t.id = x.id
  and t.postcode_area is null;
