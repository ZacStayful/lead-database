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
