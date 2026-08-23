/**
 * Formatting shared by the logged-in filter panel and the public estimator.
 *
 * These lived privately inside LeadFilteringPanel and were then re-typed, with
 * small differences, into the marketing estimator — which is how the two
 * surfaces started quoting the same money two ways. One home, one behaviour.
 */

/** Miles to kilometres. The geo helpers work in km; every UI works in miles. */
export const MILES_TO_KM = 1.60934;

/**
 * A price per lead — ALWAYS two decimals.
 *
 * These appear in columns and in sentences beside each other ("£50.00 instead
 * of £21.43"), so a figure that sometimes drops its pence does not line up and
 * reads as a different kind of number. It is also the half of the quote a
 * customer is agreeing to, where exactness is the point.
 */
export function formatPence(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

/**
 * A headline monthly plan price — drops a trailing `.00`.
 *
 * Deliberately NOT the same function. "£150 a month" is the register a plan is
 * sold in; "£150.00 a month" reads like an invoice. The distinction is between
 * a price someone is quoted per lead and a price on a pricing card, and
 * collapsing the two would make one of them wrong.
 */
export function formatPlanPrice(pence: number): string {
  const pounds = pence / 100;
  return `£${pounds % 1 === 0 ? pounds.toFixed(0) : pounds.toFixed(2)}`;
}

/** "Any bedroom size" / "Exactly 3 bedrooms" / "2–4 bedrooms" / "3+ bedrooms". */
export function summariseBedrooms(
  min: number | null,
  max: number | null
): string {
  if (min == null && max == null) return "Any bedroom size";
  if (min != null && max != null) {
    return min === max
      ? `Exactly ${min} bedroom${min === 1 ? "" : "s"}`
      : `${min}–${max} bedrooms`;
  }
  if (min != null) return `${min}+ bedrooms`;
  return `Up to ${max} bedrooms`;
}

/**
 * A bedroom text input to the number the prediction wants.
 *
 * Distinct from `parseBedrooms` in filterPrediction.ts, which reads a LEAD's
 * free-text bedroom field ("3 bed", "2-3"). This reads a controlled numeric
 * input where empty means "no bound".
 */
export function bedroomInputValue(raw: string): number | null {
  if (raw === "") return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}
