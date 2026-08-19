/**
 * What a lead's property is projected to earn — and what that is worth to a
 * management operator.
 *
 * ONE STORED FIGURE, EVERYTHING ELSE DERIVED. `leads.gross_annual_income` is
 * the only number in the database (0089); the four ranges below are computed
 * here, every time, so they cannot drift apart. If the band or the fee ever
 * changes, it changes in one place and every surface moves together.
 *
 * NOT `lead_assignments.income_estimate`. That is the OPERATOR'S own figure —
 * self-entered, per customer, and what the analytics income totals count. This
 * is ours: one figure per lead, the same for every holder, present the moment
 * the lead is delivered. The two are shown side by side on the lead detail page
 * and must never be merged or used as a fallback for one another.
 */

import type { Lead } from "@/lib/types";

/** The band shown either side of the estimate. */
export const INCOME_RANGE_PCT = 0.1;

/**
 * Gross ÷ 6.667 is a 15% management fee. Kept as the divisor the business
 * states rather than a 0.15 multiplier, so the code reads the way the rule is
 * spoken — and because it is what the analyser PDF itself uses: its own
 * "Management Fees (15%)" line agrees with gross / 6.667 to within £1 on every
 * report checked.
 */
export const MANAGEMENT_FEE_DIVISOR = 6.667;

/** The single wording for the assumption. Shown wherever the fee figure is. */
export const MANAGEMENT_FEE_LABEL = "15% management fee";

export interface IncomeProjection {
  /** Projected gross revenue for the property, ±10%. */
  grossAnnualLow: number;
  grossAnnualHigh: number;
  grossMonthlyLow: number;
  grossMonthlyHigh: number;
  /** What a management operator earns on that gross at a 15% fee, ±10%. */
  feeAnnualLow: number;
  feeAnnualHigh: number;
  feeMonthlyLow: number;
  feeMonthlyHigh: number;
}

type LeadIncomeFields = Pick<Lead, "gross_annual_income">;

/**
 * Null when there is no trustworthy figure — callers render nothing rather
 * than a zero or an em dash. A lead with no parsed analysis should look like a
 * lead that simply does not carry the feature, not like one worth £0.
 *
 * Monthly is annual / 12. The PDF prints its own monthly line, but it is only
 * round(annual / 12), so storing it would buy a second source of truth for
 * nothing.
 */
export function buildIncomeProjection(
  lead: LeadIncomeFields | null | undefined
): IncomeProjection | null {
  const gross = lead?.gross_annual_income;
  if (gross == null) return null;

  const annual = Number(gross);
  // Guard the whole family of nonsense at once: NaN from a bad numeric cast, a
  // zero left by some future backfill, and anything negative.
  if (!Number.isFinite(annual) || annual <= 0) return null;

  const low = annual * (1 - INCOME_RANGE_PCT);
  const high = annual * (1 + INCOME_RANGE_PCT);

  return {
    grossAnnualLow: Math.round(low),
    grossAnnualHigh: Math.round(high),
    grossMonthlyLow: Math.round(low / 12),
    grossMonthlyHigh: Math.round(high / 12),
    feeAnnualLow: Math.round(low / MANAGEMENT_FEE_DIVISOR),
    feeAnnualHigh: Math.round(high / MANAGEMENT_FEE_DIVISOR),
    feeMonthlyLow: Math.round(low / MANAGEMENT_FEE_DIVISOR / 12),
    feeMonthlyHigh: Math.round(high / MANAGEMENT_FEE_DIVISOR / 12),
  };
}
