import type Stripe from "stripe";

/**
 * How a Stripe subscription's billing state becomes ours, and how a past-due
 * EPISODE is tracked across the many events one failed card produces.
 *
 * Lives here rather than in the webhook route for the reason planChanges.ts
 * does: these are rules with subtle semantics that want driving directly, and a
 * Next route file can only export its HTTP handlers. The webhook is still the
 * only caller.
 */

/**
 * Maintain the past-due episode stamps for one product (0094).
 *
 * COALESCE SEMANTICS ON THE START, and that is the whole point: Stripe retries a
 * failed card several times over the following weeks, and each retry arrives here
 * with status still `past_due`. Re-stamping on every one would hold the three-day
 * clock permanently at zero, so the lapse could never fire — the exact failure the
 * clock exists to prevent. First failure of an episode wins; the stamp only moves
 * once the episode has genuinely ended.
 *
 * Any status other than past_due CLEARS both columns. That is what makes recovery
 * free: a customer who pays comes back with no episode and no write-off, so the
 * label rule returns them to Management Customer with no special handling. It also
 * means a fresh episode starts a fresh clock rather than inheriting an old one.
 *
 * Mutates the caller's update object rather than returning a patch, so the columns
 * ride along in the single UPDATE the branch already performs and can never be
 * half-applied against it.
 */
export function applyPastDueEpisode(
  update: Record<string, unknown>,
  status: string,
  currentSince: string | null | undefined,
  isGuaranteedRent: boolean,
  nowIso: string
): void {
  const sinceColumn = isGuaranteedRent ? "gr_past_due_since" : "past_due_since";
  const lapsedColumn = isGuaranteedRent ? "gr_lapsed_at" : "lapsed_at";

  if (status === "past_due") {
    if (!currentSince) update[sinceColumn] = nowIso;
    return;
  }

  update[sinceColumn] = null;
  update[lapsedColumn] = null;
}

/**
 * Map a Stripe subscription status onto our customers.subscription_status.
 *
 * `unpaid` IS A CANCELLATION, NOT A DECLINE (0094). It used to return 'past_due'
 * alongside `past_due` itself, which made the end of the dunning cycle — every
 * retry exhausted, Stripe has given up — indistinguishable from the first failed
 * charge. Nothing downstream could tell them apart, so a dead subscription read
 * as "Wants to pay card declined" for ever and kept its capacity slot.
 *
 * Mapping it to 'canceled' needs no new branch anywhere: the management branch
 * below already sets account_status = 'cancelled' and stamps cancelled_at on that
 * value, the Monday label rule already returns Cancelled for it, and capacity
 * already releases the slot. Recovery is unaffected — an `unpaid` subscription
 * that is finally paid produces invoice.paid, which promotes account_status back
 * out of 'cancelled' (§23.9) and writes subscription_status = 'active'.
 *
 * What this deliberately gives up: subscription_status can no longer distinguish
 * "unpaid but still alive in Stripe" from "cancelled outright". Nothing reads that
 * distinction, and Stripe remains the source of truth for it.
 *
 * `unpaid` is only the CLEAN end of dunning. A subscription Stripe leaves sitting
 * at past_due indefinitely never reaches this branch at all, which is what
 * /api/cron/lapse-past-due exists for.
 */
export function mapStripeSubscriptionStatus(status: Stripe.Subscription.Status): string {
  switch (status) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
      return "past_due";
    case "unpaid":
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    default:
      return "inactive";
  }
}

