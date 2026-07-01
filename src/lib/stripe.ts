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
