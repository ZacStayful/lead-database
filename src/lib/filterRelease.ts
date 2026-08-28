/**
 * How many held leads a filter apply gives back, and why.
 *
 * Applying a lead filter is already instant for FUTURE leads (0026). What is
 * not instant is supply: `(gr_)lead_balance` is the allocation gate, and a
 * customer who has spent this cycle's credits receives nothing — filtered or
 * not — until `invoice.paid` tops them up. Their untouched, non-matching held
 * leads are the missing credits, and 0114 lets them be returned to the pool.
 *
 * This module is the arithmetic only: which mode applies, and how many leads
 * that mode gives back. The predicate for WHICH leads are releasable lives in
 * `releasable_filter_assignments` (0114) — in SQL, because it has to agree
 * with the router about what "matches this filter" means.
 *
 * ⚠️ This is NOT a lead-for-lead swap. Nothing here promises a replacement for
 * a lead returned; the customer is consenting to trade unused stock for the
 * chance of leads on their filter as those arrive. Do not add a "we'll replace
 * N of these" figure without modelling it — the volume forecast (§28) is the
 * one expectation this product sets.
 */

/** What the customer chose when told they hold leads the new filter excludes. */
export type ReleaseChoice = "keep" | "discard";

/** Audit label stored on `filter_lead_releases.mode`. */
export type ReleaseMode = "discard" | "quota_refill";

export interface ReleaseInputs {
  choice: ReleaseChoice;
  /** Untouched held leads that fail the filter being applied. */
  releasableCount: number;
  /**
   * `(gr_)lead_balance` AFTER the fresh-enable clamp — credits they can still
   * spend. The clamp itself is applied under the row lock in
   * `release_unmatched_assignments`; this is the same number, computed here to
   * size the release.
   */
  balance: number;
  /**
   * `forecast.expected` — leads a month the filter is forecast to deliver, at
   * FORECAST_CONFIDENCE. Null when no forecast could be offered.
   */
  forecastExpected: number | null;
  /** False when too little history exists to forecast this selection at all. */
  forecastOfferable: boolean;
  /** True when the account cannot spend a refunded credit (see `canSpendRefund`). */
  blocked: boolean;
}

export interface ReleasePlan {
  count: number;
  mode: ReleaseMode;
}

/**
 * Whether refunding this customer a credit could ever deliver them a lead.
 *
 * A paused customer receives no management leads (§21); an archived one is out
 * of allocation entirely (§18D); one who has scheduled a cancellation will stop
 * receiving leads at the period end (§29). Crediting any of them for leads they
 * hand back would take real leads away and give nothing back, so the apply
 * skips the question and releases nothing.
 *
 * `paused_at` and `account_status` are MANAGEMENT-ONLY columns (invariant 6) —
 * they must never gate GR behaviour, which is why the pause test is behind the
 * product check rather than applied to both.
 */
export function canSpendRefund(
  customer: {
    is_active?: boolean | null;
    paused_at?: string | null;
    cancel_effective_at?: string | null;
    gr_cancel_effective_at?: string | null;
  },
  product: "management" | "guaranteed_rent"
): boolean {
  if (customer.is_active === false) return false;
  if (product === "guaranteed_rent") {
    return !customer.gr_cancel_effective_at;
  }
  return !customer.paused_at && !customer.cancel_effective_at;
}

/**
 * How many leads this apply gives back.
 *
 * - `discard` returns everything releasable — the customer said put them back.
 * - `keep` returns only what the filter needs to become deliverable this cycle:
 *   the forecast, less the credits they already have. A customer with headroom
 *   gives back nothing, because nothing is in the way of the filter delivering.
 *
 * Never negative, never more than `releasableCount`.
 */
export function releaseCount(input: ReleaseInputs): ReleasePlan {
  const mode: ReleaseMode = input.choice === "discard" ? "discard" : "quota_refill";
  const releasable = Math.max(0, Math.trunc(input.releasableCount || 0));

  if (input.blocked || releasable === 0) return { count: 0, mode };

  if (input.choice === "discard") return { count: releasable, mode };

  // Keep, at quota. Sizing this needs a forecast, and there is not always one:
  // when too few leads have come through the selection, `filter_expected_leads`
  // is written as null and there is no number to take from their allocation.
  // Release nothing rather than guessing — the filter is live either way, and
  // starts delivering at renewal.
  if (!input.forecastOfferable || input.forecastExpected == null) {
    return { count: 0, mode };
  }

  const balance = Math.max(0, Math.trunc(input.balance || 0));
  const needed = Math.max(0, Math.trunc(input.forecastExpected) - balance);
  return { count: Math.min(needed, releasable), mode };
}
