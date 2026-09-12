import Stripe from "stripe";

let _stripe: Stripe | null = null;

/** Lazily-constructed server-side Stripe client. */
export function getStripe(): Stripe {
  if (!_stripe) {
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      typescript: true,
    });
  }
  return _stripe;
}

/**
 * End of the subscription's current billing period, as a unix timestamp, or null.
 *
 * `current_period_end` moved from the subscription onto its items in the newer
 * API version, and getStripe() pins no apiVersion, so the ACCOUNT DEFAULT decides
 * which shape arrives. Read both — the same belt-and-braces the webhook uses for
 * current_period_start.
 *
 * Shared rather than inlined because two callers need the same answer: the admin
 * billing-health panel, and the Monday status sync deciding what date to write as
 * a cancelling customer's real end of service. Two readings of "when does this
 * subscription actually end" would eventually disagree.
 */
export function subscriptionPeriodEnd(sub: Stripe.Subscription): number | null {
  return (
    (sub as unknown as { current_period_end?: number }).current_period_end ??
    (sub.items?.data?.[0] as unknown as { current_period_end?: number })
      ?.current_period_end ??
    null
  );
}

/**
 * Start of the billing period a PAID invoice actually covers, as a unix
 * timestamp, or null when the invoice carries no ordinary subscription line.
 *
 * ⚠️ DO NOT READ `invoice.period_start` FOR THIS. On a subscription RENEWAL
 * invoice that field is the start of the PREVIOUS period — Stripe documents it
 * as "the usage period during which invoice items were added", which looks back
 * one period. Anchoring on it put eight customers' `billing_cycle_anchor` a month
 * behind their last payment (found 2026-09-12): they read as day 30+ of a cycle,
 * so pacing reported a maximal deficit, routing ranked them ahead of everyone,
 * and the admin supply banner named them. `customer.subscription.updated` writes
 * the correct date from `current_period_start`, but whichever event lands LAST
 * wins the column, and on a renewal `invoice.paid` usually arrives about an hour
 * after the subscription event.
 *
 * The subscription LINE carries the period the invoice is for, on every API
 * version. Proration lines are skipped: their period starts at the moment of the
 * change, not at the cycle boundary, and a mid-cycle upgrade must not move the
 * anchor. A pure-proration invoice therefore returns null, and a null means
 * "leave the anchor alone" — never fall back to `period_start` or `created`.
 */
export function subscriptionPeriodStartFromInvoice(
  invoice: Stripe.Invoice
): number | null {
  let latest: number | null = null;
  for (const raw of invoice.lines?.data ?? []) {
    const line = raw as unknown as {
      type?: string;
      proration?: boolean;
      subscription?: string | { id?: string } | null;
      parent?: { subscription_item_details?: unknown } | null;
      period?: { start?: number | null } | null;
    };
    if (line.proration) continue;
    const isSubscriptionLine =
      line.type === "subscription" ||
      Boolean(line.subscription) ||
      Boolean(line.parent?.subscription_item_details);
    if (!isSubscriptionLine) continue;
    const start = line.period?.start;
    if (typeof start !== "number" || !Number.isFinite(start) || start <= 0) continue;
    if (latest === null || start > latest) latest = start;
  }
  return latest;
}
