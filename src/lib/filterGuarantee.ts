import {
  WEEKS_PER_MONTH,
  type VolumePrediction,
} from "@/lib/filterPrediction";
import { planForProductAllocation, plansFor, type Plan } from "@/lib/plans";
import type { LeadType } from "@/lib/types";

/**
 * Turning a lead-filter volume ESTIMATE into a volume GUARANTEE, and into the
 * cost per lead that guarantee implies.
 *
 * Applying a filter used to void the volume guarantee outright: the customer
 * narrowed their leads, got nothing back, and paid the same. This module prices
 * that trade instead. It answers three questions from one distribution —
 *
 *   how many leads a month can we commit to?      -> `guaranteed`
 *   what does that make each one cost?            -> `costPerLeadPence`
 *   how likely are we to actually deliver it?     -> `likelihoodPct`
 *
 * — and the customer accepts all three together before the filter applies.
 *
 * Pure by design: no Supabase, no React, so the customer panel, the server
 * route that re-derives the number, and both admin surfaces all run the same
 * code. `filterPrediction.ts` observes the same rule for the same reason.
 */

/**
 * The confidence every guarantee is struck at, and the one risk dial in here.
 *
 * WHY A FIXED CONFIDENCE AND NOT A FIXED MARGIN
 * An earlier design guaranteed `round(estimate - sqrt(estimate))` — a one-sigma
 * haircut. The maths was sound (per-filter monthly variance really does track
 * 1/sqrt(lambda)) but it made the DISPLAYED likelihood sawtooth and, worse, move
 * against filter quality: an estimate of 3 showed 92% while an estimate of 6
 * showed 80%, because a small promise is proportionally easier to keep. A
 * customer comparing two filters by that percentage would reliably pick the
 * worse one — fewer leads, higher price, better-looking number.
 *
 * Fixing the confidence and letting the guarantee move instead inverts that.
 * Both figures the customer actually decides on are then monotone in filter
 * breadth: widening a filter can only ever raise `guaranteed` and lower
 * `costPerLeadPence`. That property is asserted in the tests, and it is the
 * reason not to "simplify" this back to a fixed margin.
 *
 * 0.83 is calibrated so a filter estimated at 5/month guarantees 3 — the worked
 * example the pricing was agreed on. Raising it lowers every guarantee and
 * raises every cost per lead.
 */
export const GUARANTEE_CONFIDENCE = 0.83;

/**
 * Above this cost per lead the offer is poor enough to be worth a second look
 * before the customer accepts it — not a refusal, a pause. The panel pairs it
 * with `expansionSuggestions()` so the answer on offer is "widen your filter",
 * which is the only thing that actually helps.
 */
export const GUARANTEE_CONFIRM_CEILING_PENCE = 5000; // £50 a lead

/** Why no guarantee could be offered. */
export type GuaranteeUnavailable =
  | "unreliable"
  | "zero_volume"
  | "no_plan";

export interface GuaranteeQuote {
  /** The estimate the guarantee was struck against — prediction.displayRate. */
  estimate: number;
  /** Leads a month we commit to. 0 when none can be offered. */
  guaranteed: number;
  /**
   * floor(100 * P(X >= guaranteed)). Always >= 83 when offerable, by
   * construction; reaches ~99 once the guarantee caps at the plan. Null when
   * there is no guarantee to be confident about.
   */
  likelihoodPct: number | null;
  /** The plan allocation the guarantee is capped at. */
  allocation: number;
  /** Headline plan price in pence — the LIST price, see `quoteGuarantee`. */
  planPricePence: number;
  /** ceil(planPricePence / guaranteed). Null when guaranteed is 0. */
  costPerLeadPence: number | null;
  /** guaranteed < allocation — the customer must accept explicitly. */
  reducesGuarantee: boolean;
  /** A poor enough offer to warrant a second confirmation. */
  requiresExtraConfirm: boolean;
  /** False when no guarantee can be offered at all. */
  offerable: boolean;
  /** Set only when !offerable. */
  reason: GuaranteeUnavailable | null;
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
 * p -> 1, the distribution converges to Poisson, and guarantees rise on their
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
 * The largest guarantee we can meet with at least `GUARANTEE_CONFIDENCE`
 * confidence, capped at what the plan actually sells.
 *
 * THE CAP IS NOT COSMETIC. A filter estimated at 44/month on a 10-lead plan
 * would otherwise "guarantee" 38 leads we never promised to deliver and are not
 * paid for. Capping also has to happen BEFORE the likelihood is read, or the
 * customer is shown the confidence of a promise nobody is making: that same
 * filter reads "38 leads, 79%" uncapped and "10 leads, 99%" capped.
 */
export function guaranteeFor(
  matchingLeads: number,
  weeksElapsed: number,
  allocation: number
): { guaranteed: number; likelihood: number } {
  if (allocation <= 0) return { guaranteed: 0, likelihood: 1 };

  const w = Math.max(weeksElapsed, 1);
  const r = Math.max(matchingLeads, 0) + 0.5;
  const p = w / (w + WEEKS_PER_MONTH);

  const s = survivalCurve(r, p, allocation);
  for (let g = allocation; g >= 1; g--) {
    if (s[g] >= GUARANTEE_CONFIDENCE) {
      return { guaranteed: g, likelihood: s[g] };
    }
  }
  return { guaranteed: 0, likelihood: 1 };
}

/**
 * Quote a filter: what we guarantee, what it costs a lead, how likely we are to
 * meet it.
 *
 * Driven off `prediction.displayRate` for the estimate it reports, never
 * `monthlyRate` — the same discipline `belowAllocation()` documents, so the
 * "~N" the customer reads can never contradict the guarantee beside it. The
 * guarantee itself comes from the raw (matchingLeads, weeksElapsed) pair, which
 * is what the distribution is actually parameterised by.
 *
 * `planPricePence` is the LIST price for the allocation, not what this customer
 * is billed. Discounts exist (post-call offers, promotion codes, a stored
 * stripe_price_id) and every other price derivation in the app goes through
 * `planForAllocation`; the copy says "based on your plan price" for that reason.
 */
export function quoteGuarantee(
  prediction: VolumePrediction,
  allocation: number,
  leadType: LeadType
): GuaranteeQuote {
  const plan = planForProductAllocation(leadType, allocation);
  const planPricePence = Math.round(plan.priceGbp * 100);
  const estimate = prediction.displayRate;

  const base = {
    estimate,
    allocation,
    planPricePence,
    reducesGuarantee: false,
    requiresExtraConfirm: false,
  };

  if (allocation <= 0) {
    return {
      ...base,
      guaranteed: 0,
      likelihoodPct: null,
      costPerLeadPence: null,
      offerable: false,
      reason: "no_plan",
    };
  }

  // Too thin to predict is too thin to promise. This is the one branch that
  // keeps today's behaviour — the guarantee stays lifted and the copy still
  // says so — rather than guessing a number with money attached.
  if (!prediction.reliable) {
    return {
      ...base,
      guaranteed: 0,
      likelihoodPct: null,
      costPerLeadPence: null,
      offerable: false,
      reason: "unreliable",
    };
  }

  const { guaranteed, likelihood } = guaranteeFor(
    prediction.matchingLeads,
    prediction.weeksElapsed,
    allocation
  );

  if (guaranteed <= 0) {
    return {
      ...base,
      guaranteed: 0,
      likelihoodPct: null,
      costPerLeadPence: null,
      offerable: false,
      reason: "zero_volume",
    };
  }

  // Ceil, not round: guaranteed * costPerLead must never come out below the
  // plan price, or a customer can arithmetic their way to "you promised me
  // £149.94 of leads for £150".
  const costPerLeadPence = Math.ceil(planPricePence / guaranteed);

  return {
    ...base,
    guaranteed,
    likelihoodPct: Math.floor(100 * likelihood),
    costPerLeadPence,
    reducesGuarantee: guaranteed < allocation,
    requiresExtraConfirm: costPerLeadPence > GUARANTEE_CONFIRM_CEILING_PENCE,
    offerable: true,
    reason: null,
  };
}

/**
 * The cheapest plan that still delivers `guaranteed` leads, or null when the
 * customer is already on it.
 *
 * Because the guarantee is capped at the allocation, a customer whose filter
 * guarantees fewer leads than the SMALLER plan delivers is paying for
 * allocation they can never receive — £300 a month for five leads, when £150
 * buys the same five. Recommending the downgrade costs revenue; not
 * recommending it costs the customer, who works it out eventually and churns
 * rather than downgrades.
 *
 * The `guaranteed <= plan.leads` test is what makes this safe to surface
 * automatically: the recommended plan still covers the whole guarantee, so
 * taking the advice can never cost the customer a lead. Only the price moves.
 */
export function recommendedDowngrade(
  guaranteed: number,
  currentAllocation: number,
  leadType: LeadType
): Plan | null {
  if (guaranteed <= 0) return null;

  const current = planForProductAllocation(leadType, currentAllocation);
  const cheapest = Object.values(plansFor(leadType))
    .filter((plan) => plan.leads >= guaranteed)
    .sort((a, b) => a.priceGbp - b.priceGbp)[0];

  if (!cheapest) return null;
  return cheapest.priceGbp < current.priceGbp ? cheapest : null;
}
