/**
 * What a customer PAYS for, beside what their FILTER can actually deliver.
 *
 * Those are two numbers the product has always held and never once compared.
 * The allocation is billed, the forecast is computed and stored, the unspent
 * credit accrues in between, and each lives on a different screen.
 *
 * ⚠️ `filter_forecast_plan_price_pence` — the plan price the forecast was quoted
 * against — is written by THREE code paths and read by NONE. That one fact is
 * this module in miniature: the comparison was computed, stored, and never
 * shown to anybody.
 *
 * Measured on production 2026-09-24, over the eight live filtered customers:
 * six are forecast BELOW their own plan, they hold 94 unspent credits between
 * them (£1,410), and the monthly shortfall is 57 leads. The decisive contrast
 * is the other half of the book — ten live customers with NO filter hold TWO
 * credits between them, because ordinary routing drains a balance as fast as it
 * is granted. The filter is the mechanism that banks the credit.
 *
 * ⚠️ IMPORT-FREE, and it must stay that way — the `featureRequest.ts` (§21.8),
 * `deadLeadCopy.ts` (§51.6) and `releaseCopy.ts` (§54.8) rule. Both consumers
 * are or sit inside `"use client"` components, and `vitest.config.mts` is PURE
 * UNITS ONLY with no React, so a rule living inside a component is a rule no
 * test can reach. §66.2 is the standing proof of what that costs: a correct
 * pure function whose caller never read it shipped, reached production, and
 * misled every Northern Ireland visitor for two weeks.
 */

/**
 * Months of banked credit above which the balance is worth naming.
 *
 * It is what stops the sentence firing on a healthy account. On today's book:
 * James holds 6 credits against a forecast of 9 a month — 0.7 months, silent —
 * while Allan holds 32 against a forecast of 1, and is not.
 */
export const BANKED_MONTHS = 3;

export interface PlanVsFilterInput {
  /** What they pay for each month. */
  allocation: number;
  /**
   * What the filter is forecast to deliver — the STORED figure where there is
   * one, else the live fallback §58.3 already computes. Null means we have no
   * figure we can stand behind, and saying nothing beats inventing one.
   */
  expected: number | null;
  /** Unspent credit. */
  balance: number;
  costPerLeadPence: number | null;
  /**
   * Did THEY tick to say they had read this figure, or did the §58.3 admin
   * backfill write it?
   *
   * ⚠️ Two of the eight live filtered customers carry a figure they never
   * acknowledged. `forecastBackfill.ts` is explicit that the column means "the
   * customer ticked to say they had read this figure, and they did not", so no
   * copy reading this verdict may tell them what they agreed to.
   */
  acknowledged: boolean;
}

export interface PlanVsFilterUnder {
  kind: "under_plan";
  allocation: number;
  expected: number;
  /** allocation − expected, always > 0 in this branch. */
  shortfall: number;
  balance: number;
  /** balance / expected. Null when expected is 0 — never a division by zero. */
  monthsBanked: number | null;
  banked: boolean;
  costPerLeadPence: number | null;
  acknowledged: boolean;
}

export type PlanVsFilter =
  | { kind: "no_figure" }
  | { kind: "covered" }
  | PlanVsFilterUnder;

/**
 * The verdict. Three outcomes, never two — §18.3's rule, and here the third is
 * load-bearing: "we cannot put a number on this filter" and "this filter covers
 * your plan" are opposite facts, and collapsing them would reassure exactly the
 * customer we cannot reassure.
 */
export function planVsFilter(input: PlanVsFilterInput): PlanVsFilter {
  const { allocation, expected, balance } = input;
  if (expected == null || !Number.isFinite(expected)) return { kind: "no_figure" };
  if (!Number.isFinite(allocation) || allocation <= 0) return { kind: "no_figure" };
  if (expected >= allocation) return { kind: "covered" };

  const monthsBanked = expected > 0 ? balance / expected : null;
  return {
    kind: "under_plan",
    allocation,
    expected,
    shortfall: allocation - expected,
    balance,
    monthsBanked,
    banked: monthsBanked != null && monthsBanked >= BANKED_MONTHS,
    costPerLeadPence: input.costPerLeadPence,
    acknowledged: input.acknowledged,
  };
}

/** "20 leads" / "1 lead". */
function leads(n: number): string {
  return `${n} lead${n === 1 ? "" : "s"}`;
}

/**
 * The gap, stated as two figures rather than a judgement.
 *
 * ⚠️ ALWAYS "at least", never a bare number. The figure is a lower bound at
 * FORECAST_CONFIDENCE (0.83) and is missed about one month in six BY
 * CONSTRUCTION (§28.0). Every other surface says "at least"; this must not be
 * the one that drops it.
 */
export function planGapSentence(v: PlanVsFilterUnder): string {
  return (
    `Your plan is ${leads(v.allocation)} a month and this filter is forecast to ` +
    `deliver at least ${v.expected} — a gap of ${leads(v.shortfall)} a month.`
  );
}

/**
 * The banked credit, named only when there is enough of it to matter.
 *
 * ⚠️ IT MUST NEVER OFFER OR IMPLY A REFUND. `types.ts` says it outright of
 * these very columns — "nothing settles a shortfall against it, and no copy
 * reading these may offer to" — and §28.0 records that the guarantee was
 * withdrawn precisely because a figure missed one month in six is not one to
 * pay out against. State the position and the action; never suggest money
 * comes back.
 *
 * ⚠️ "at this filter's forecast rate ... worth" is a COMPARISON, not a promise
 * about the wait, and the direction is deliberate: `expected` is a lower bound,
 * so the real time to drain the balance is at MOST this figure. Phrasing it as
 * a delivery estimate would be a promise we have not made; phrasing it as a
 * floor would be arithmetically backwards.
 */
export function bankedCreditSentence(v: PlanVsFilterUnder): string | null {
  if (!v.banked || v.monthsBanked == null) return null;
  const months = Math.max(1, Math.round(v.monthsBanked));
  return (
    `You have ${leads(v.balance)} of credit unspent. At this filter's forecast ` +
    `rate that is about ${months} month${months === 1 ? "" : "s"}' worth — ` +
    `widening your filter is the quickest way to receive them.`
  );
}

/**
 * ⚠️ A RECOMMENDED DOWNGRADE CAN STILL BE TERRIBLE, AND THE CARD MUST SAY SO.
 *
 * `recommendedDowngrade` returns the cheapest plan whose `leads >= expected`.
 * For a customer forecast at 1 lead a month on a £300/20 plan that is the
 * £150/10 plan — which is £150 A LEAD. Cheaper, and not a fix. §28.3 calls that
 * advice "the only thing between them and paying twice the going rate
 * indefinitely", so it must keep being offered; what it must not do is read as
 * a solution when the cost per lead is still absurd.
 *
 * The threshold is a PARAMETER rather than a copy of HIGH_COST_PER_LEAD_PENCE,
 * so this module stays import-free without duplicating a constant that would
 * then need its own equality test to stop it drifting.
 */
export function downgradeRelief(
  downgradeCostPerLeadPence: number,
  highCostPerLeadPence: number
): "fix" | "cheaper_but_still_poor" {
  return downgradeCostPerLeadPence > highCostPerLeadPence
    ? "cheaper_but_still_poor"
    : "fix";
}
