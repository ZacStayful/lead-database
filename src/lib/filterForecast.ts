import {
  WEEKS_PER_MONTH,
  type VolumePrediction,
} from "@/lib/filterPrediction";
import { planForProductAllocation, plansFor, type Plan } from "@/lib/plans";
import type { LeadType } from "@/lib/types";

/**
 * Turning a lead-filter volume estimate into a FORECAST — what a filter is
 * expected to deliver, how confident we are, and what that makes a lead cost.
 *
 * It answers three questions from one distribution:
 *
 *   how many leads a month can this filter be relied on for? -> `expected`
 *   how sure are we of that?                                 -> `likelihoodPct`
 *   what does it make each lead cost?                        -> `costPerLeadPence`
 *
 * ⚠️ THIS IS A FORECAST AND NOT A GUARANTEE, AND THE DIFFERENCE IS LOAD-BEARING.
 * An earlier version of this module called `expected` a guarantee and the app
 * credited any shortfall back to the customer's balance. That was withdrawn:
 * `expected` is the largest N with P(X >= N) >= FORECAST_CONFIDENCE, so it
 * carries a designed-in miss rate of roughly one month in six. Promising a
 * number you have already calculated you will miss is not a guarantee, it is a
 * guarantee you have decided to break. Nothing here creates a liability, no
 * shortfall is settled anywhere, and no copy built on these values may offer
 * to make one good.
 *
 * ⚠️ `expected` IS A LOWER BOUND, NOT A MEAN. Read it as "at least N", which is
 * how the UI is required to word it. Calling a P83 figure "expected" without
 * that qualifier invites the reader to treat it as the middle of the range when
 * it is deliberately the pessimistic end.
 *
 * Pure by design: no Supabase, no React, so the customer panel, the server
 * route that re-derives the number, and both admin surfaces all run the same
 * code. `filterPrediction.ts` observes the same rule for the same reason.
 */

/**
 * The confidence every forecast is struck at, and the one risk dial in here.
 *
 * WHY A FIXED CONFIDENCE AND NOT A FIXED MARGIN
 * An earlier design used `round(estimate - sqrt(estimate))` — a one-sigma
 * haircut. The maths was sound (per-filter monthly variance really does track
 * 1/sqrt(lambda)) but it made the DISPLAYED likelihood sawtooth and, worse, move
 * against filter quality: an estimate of 3 showed 92% while an estimate of 6
 * showed 80%, because a smaller number is proportionally easier to hit. A
 * customer comparing two filters by that percentage would reliably pick the
 * worse one — fewer leads, higher price, better-looking number.
 *
 * Fixing the confidence and letting the number move instead inverts that. Both
 * figures the customer actually decides on are then monotone in filter breadth:
 * widening a filter can only ever raise `expected` and lower
 * `costPerLeadPence`. That property is asserted in the tests, and it is the
 * reason not to "simplify" this back to a fixed margin.
 *
 * ⚠️ DO NOT LOWER THIS TO 0.5 TO MAKE THE WORD "EXPECTED" LITERALLY TRUE.
 * A central estimate is wrong half the time, which would make the cost-per-lead
 * figure beside it worthless. The conservative reading is what makes the whole
 * quote trustworthy; the UI carries the honesty by saying "at least N".
 *
 * 0.83 is calibrated so a filter estimated at 5/month forecasts 3 — the worked
 * example the pricing was agreed on. Raising it lowers every forecast and
 * raises every cost per lead.
 */
export const FORECAST_CONFIDENCE = 0.83;

/**
 * Above this cost per lead the filter is poor enough value to be worth flagging
 * before the customer applies it — not a refusal, a pause. Every surface pairs
 * it with `expansionSuggestions()` so the answer on offer is "widen your
 * filter", which is the only thing that actually helps.
 */
export const HIGH_COST_PER_LEAD_PENCE = 5000; // £50 a lead

/** Why no forecast could be offered. */
export type ForecastUnavailable =
  | "unreliable"
  | "zero_volume"
  | "no_plan";

export interface VolumeForecast {
  /** The estimate the forecast was struck against — prediction.displayRate. */
  estimate: number;
  /**
   * Leads a month this filter can be relied on for — a LOWER BOUND at
   * FORECAST_CONFIDENCE, not a mean and not a commitment. 0 when none can be
   * offered. Word it "at least N" wherever it is shown.
   */
  expected: number;
  /**
   * floor(100 * P(X >= expected)). Always >= 83 when offerable, by
   * construction; reaches ~99 once `expected` caps at the plan. Null when there
   * is no figure to be confident about.
   */
  likelihoodPct: number | null;
  /** The plan allocation `expected` is capped at. */
  allocation: number;
  /** Headline plan price in pence — the LIST price, see `forecastVolume`. */
  planPricePence: number;
  /** ceil(planPricePence / expected). Null when expected is 0. */
  costPerLeadPence: number | null;
  /**
   * expected < allocation — the filter is forecast to deliver less than the
   * plan sells, so the customer must acknowledge it before applying.
   *
   * ⚠️ NOT the same test as `belowAllocation()` in filterPrediction.ts, and they
   * deliberately disagree: a filter estimated at exactly 20 on a 20-lead plan is
   * not "below allocation" but does forecast 16. Both are asserted in the tests.
   * Do not merge them.
   */
  reducesVolume: boolean;
  /** Poor enough value per lead to warrant flagging. */
  requiresExtraConfirm: boolean;
  /** False when no forecast can be offered at all. */
  offerable: boolean;
  /** Set only when !offerable. */
  reason: ForecastUnavailable | null;
}

/**
 * P(X >= G) for G in 0..upTo, where X is next month's lead count.
 *
 * X is NEGATIVE BINOMIAL, not Poisson, and the difference is the whole point.
 * Poisson would answer "how often would we hit this if the estimate were
 * exactly right" — but the estimate is inferred from a few weeks of history and
 * carries real error, and a percentage shown to a customer is close to a
 * contractual claim. Placing a Gamma (Jeffreys) prior on the weekly arrival
 * rate and observing `m` leads over `w` weeks makes next month's count
 *
 *     X ~ NegBinomial(r = m + 0.5, p = w / (w + WEEKS_PER_MONTH))
 *
 * whose variance is inflated over Poisson's by (w + WEEKS_PER_MONTH) / w. At a
 * few weeks of history that is a substantial widening; as history accumulates
 * p -> 1, the distribution converges to Poisson, and forecasts rise on their
 * own. There is no haircut anyone has to remember to remove later.
 *
 * Evaluated by the recurrence P(0) = p^r, P(k) = P(k-1) * (k+r-1)/k * (1-p),
 * which needs no log-gamma and does not overflow at large r.
 */
function survivalCurve(r: number, p: number, upTo: number): number[] {
  const s: number[] = [1];
  let cumulative = 0;
  let pk = Math.pow(p, r); // P(0)
  for (let g = 1; g <= upTo; g++) {
    cumulative += pk;
    // Clamp: floating-point drift can push the tail a hair below zero.
    s.push(Math.min(1, Math.max(0, 1 - cumulative)));
    pk *= ((g + r - 1) / g) * (1 - p);
  }
  return s;
}

/**
 * The largest number we can deliver with at least `FORECAST_CONFIDENCE`
 * confidence, capped at what the plan actually sells.
 *
 * THE CAP IS NOT COSMETIC. A filter estimated at 44/month on a 10-lead plan
 * would otherwise forecast 38 leads the customer has not bought and we do not
 * owe. Capping also has to happen BEFORE the likelihood is read, or the customer
 * is shown the confidence of a figure nobody is quoting: that same filter reads
 * "38 leads, 79%" uncapped and "10 leads, 99%" capped.
 */
export function deliverableAtConfidence(
  matchingLeads: number,
  weeksElapsed: number,
  allocation: number
): { expected: number; likelihood: number } {
  if (allocation <= 0) return { expected: 0, likelihood: 1 };

  const w = Math.max(weeksElapsed, 1);
  const r = Math.max(matchingLeads, 0) + 0.5;
  const p = w / (w + WEEKS_PER_MONTH);

  const s = survivalCurve(r, p, allocation);
  for (let g = allocation; g >= 1; g--) {
    if (s[g] >= FORECAST_CONFIDENCE) {
      return { expected: g, likelihood: s[g] };
    }
  }
  return { expected: 0, likelihood: 1 };
}

/**
 * Forecast a filter: what it can be relied on for, how confident we are, and
 * what that makes a lead cost.
 *
 * Driven off `prediction.displayRate` for the estimate it reports, never
 * `monthlyRate` — the same discipline `belowAllocation()` documents, so the
 * "~N" the customer reads can never contradict the figure beside it. The
 * forecast itself comes from the raw (matchingLeads, weeksElapsed) pair, which
 * is what the distribution is actually parameterised by.
 *
 * `planPricePence` is the LIST price for the allocation, not what this customer
 * is billed. Discounts exist (post-call offers, promotion codes, a stored
 * stripe_price_id) and every other price derivation in the app goes through
 * `planForAllocation`; the copy says "based on your plan price" for that reason.
 */
export function forecastVolume(
  prediction: VolumePrediction,
  allocation: number,
  leadType: LeadType
): VolumeForecast {
  const plan = planForProductAllocation(leadType, allocation);
  const planPricePence = Math.round(plan.priceGbp * 100);
  const estimate = prediction.displayRate;

  const base = {
    estimate,
    allocation,
    planPricePence,
    reducesVolume: false,
    requiresExtraConfirm: false,
  };

  if (allocation <= 0) {
    return {
      ...base,
      expected: 0,
      likelihoodPct: null,
      costPerLeadPence: null,
      offerable: false,
      reason: "no_plan",
    };
  }

  // Too thin to predict is too thin to quote. This branch keeps the original
  // behaviour — no number, and copy that says so — rather than inventing one
  // the customer would price a decision on.
  if (!prediction.reliable) {
    return {
      ...base,
      expected: 0,
      likelihoodPct: null,
      costPerLeadPence: null,
      offerable: false,
      reason: "unreliable",
    };
  }

  const { expected, likelihood } = deliverableAtConfidence(
    prediction.matchingLeads,
    prediction.weeksElapsed,
    allocation
  );

  if (expected <= 0) {
    return {
      ...base,
      expected: 0,
      likelihoodPct: null,
      costPerLeadPence: null,
      offerable: false,
      reason: "zero_volume",
    };
  }

  // Ceil, not round: expected * costPerLead must never come out below the plan
  // price, or a customer can arithmetic their way to "you quoted me £149.94 of
  // leads for £150".
  const costPerLeadPence = Math.ceil(planPricePence / expected);

  return {
    ...base,
    expected,
    likelihoodPct: Math.floor(100 * likelihood),
    costPerLeadPence,
    reducesVolume: expected < allocation,
    requiresExtraConfirm: costPerLeadPence > HIGH_COST_PER_LEAD_PENCE,
    offerable: true,
    reason: null,
  };
}

/**
 * The cheapest plan that still covers `expected` leads, or null when the
 * customer is already on it.
 *
 * Because `expected` is capped at the allocation, a customer whose filter is
 * forecast to deliver fewer leads than the SMALLER plan sells is paying for
 * allocation they will never receive — £300 a month for five leads, when £150
 * buys the same five. Recommending the downgrade costs revenue; not
 * recommending it costs the customer, who works it out eventually and churns
 * rather than downgrades.
 *
 * ⚠️ THIS MATTERS MORE NOW THAN IT DID, not less. When a shortfall was credited
 * back, an over-plan customer at least got the difference in leads. Nothing is
 * credited any more, so this advice is the only thing standing between them and
 * paying twice the going rate indefinitely. Never make it harder to find.
 *
 * The `expected <= plan.leads` test is what makes this safe to surface
 * automatically: the recommended plan still covers the whole forecast, so taking
 * the advice can never cost the customer a lead. Only the price moves.
 */
export function recommendedDowngrade(
  expected: number,
  currentAllocation: number,
  leadType: LeadType
): Plan | null {
  if (expected <= 0) return null;

  const current = planForProductAllocation(leadType, currentAllocation);
  const cheapest = Object.values(plansFor(leadType))
    .filter((plan) => plan.leads >= expected)
    .sort((a, b) => a.priceGbp - b.priceGbp)[0];

  if (!cheapest) return null;
  return cheapest.priceGbp < current.priceGbp ? cheapest : null;
}
