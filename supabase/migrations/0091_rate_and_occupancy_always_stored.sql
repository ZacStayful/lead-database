-- ============================================================================
-- 0091 — Store the nightly rate and occupancy the report states, always.
--
-- 0090 stored them only when `rate x 365 x occupancy` reproduced
-- gross_annual_income within 2%, on the reasoning that a pair contradicting
-- the money printed above it is worse than no pair at all.
--
-- That was the right instinct attached to the wrong lever. The test was sound —
-- on live data 137 reports land between 0.00% and 1.82% drift and the next one
-- up is 4.3%, so it detects something real about the document. But it was being
-- used to decide whether to STORE a fact, when the fact is true either way: the
-- report states these numbers. What varies is whether they can be described as
-- what the gross was built from.
--
-- The report captions its nightly rate "ADR across comp set" — it is the
-- comparable set's average. Usually the analyser prices the property at that
-- rate and the arithmetic closes. Sometimes the property is unusual against its
-- comps and it does not, and on those 12 leads an operator saw the money with
-- nothing behind it.
--
-- So the identity moved to render time, where it picks the WORDING and never
-- suppresses anything (`incomeBasis()` in src/lib/incomeProjection.ts):
--
--     reconciles      "Based on £157 a night at 63% occupancy."
--     does not        "Comparable properties average £116 a night at 54% occupancy."
--
-- NO SCHEMA CHANGE. This migration exists to correct the column comments, which
-- documented the old rule and are read by anyone inspecting the database rather
-- than the repo. A comment that describes behaviour the code no longer has is
-- worse than no comment.
--
-- The identity was never the primary defence against reading the WRONG pair,
-- which is the objection this invites. The "Comparable Properties" page prints
-- `Avg Nightly Rate` and `Avg Occupancy`; the parser anchors on `ADR across`
-- and `Market average`, which appear only in the headline block.
-- ============================================================================

comment on column public.leads.avg_nightly_rate is
  'Average nightly rate for this property from the Stayful property-analysis '
  'PDF, whole pounds, as stated. The report captions it "ADR across comp set". '
  'Stored whenever the report states it and an occupancy alongside it — see '
  '0091. Whether rate x 365 x occupancy reproduces gross_annual_income decides '
  'how it is WORDED on screen, never whether it is stored.';

comment on column public.leads.occupancy_rate is
  'The property''s projected occupancy from the same report, as the percentage '
  'printed (63, not 0.63). Stored with avg_nightly_rate, both or neither. This '
  'is the PROPERTY''S own figure, not the market average the report prints '
  'beside it — which is 0% on reports with no comparable listings nearby, and '
  'is why a zero here is rejected as a mis-read rather than stored.';
