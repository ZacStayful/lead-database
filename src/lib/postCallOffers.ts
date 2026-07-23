/**
 * Post-call discount offers — shared types and helpers.
 *
 * A post_call_offer is a single-use, 24-hour, 15%-off (first month only) Stripe
 * Promotion Code generated per prospect after a web meeting. The same code works
 * on BOTH Management Payment Links (10-lead / 20-lead) because the underlying
 * coupon is percentage-based and not price-restricted — the plan is chosen by
 * whoever sends the link, not at generation time.
 *
 * This module touches nothing in the allocation / pacing / GR domain.
 */

export const OFFER_TTL_MS = 24 * 60 * 60 * 1000;

export interface PostCallOffer {
  id: string;
  prospect_email: string;
  prospect_phone: string | null;
  prospect_name: string | null;
  stripe_promo_code_id: string;
  promo_code_string: string;
  offer_created_at: string;
  expires_at: string;
  redeemed_at: string | null;
  redeemed_plan: "10" | "20" | null;
  source: "manual" | "auto_monday";
  reminder_12h_sent_at: string | null;
  reminder_4h_sent_at: string | null;
  reminder_1h_sent_at: string | null;
  created_by: string | null;
  matched_customer_id: string | null;
  created_at: string;
}

export interface CheckoutUrls {
  checkout_url_10: string;
  checkout_url_20: string;
}

/**
 * Compute both plan checkout URLs for a promo code. The link base URLs come from
 * env; if either is unset we throw so the caller surfaces a clear config error
 * rather than handing out a broken half-URL.
 */
export function computeCheckoutUrls(code: string): CheckoutUrls {
  const base10 = process.env.STRIPE_MANAGEMENT_10_PAYMENT_LINK_URL;
  const base20 = process.env.STRIPE_MANAGEMENT_20_PAYMENT_LINK_URL;
  if (!base10 || !base20) {
    throw new Error(
      "Missing STRIPE_MANAGEMENT_10_PAYMENT_LINK_URL and/or " +
        "STRIPE_MANAGEMENT_20_PAYMENT_LINK_URL environment variables."
    );
  }
  const q = `?prefilled_promo_code=${encodeURIComponent(code)}`;
  return {
    checkout_url_10: `${base10}${q}`,
    checkout_url_20: `${base20}${q}`,
  };
}

export type OfferState =
  | { kind: "none" }
  | { kind: "active"; expiresAt: string }
  | { kind: "expired_unused" }
  | { kind: "redeemed"; plan: "10" | "20" | null };

/** Derive the display state of a prospect's most relevant offer row. */
export function offerState(
  offer: Pick<PostCallOffer, "redeemed_at" | "redeemed_plan" | "expires_at"> | null,
  now: number = Date.now()
): OfferState {
  if (!offer) return { kind: "none" };
  if (offer.redeemed_at) {
    return { kind: "redeemed", plan: offer.redeemed_plan ?? null };
  }
  if (new Date(offer.expires_at).getTime() > now) {
    return { kind: "active", expiresAt: offer.expires_at };
  }
  return { kind: "expired_unused" };
}

/**
 * Human, timezone-agnostic "time remaining" string from now until `expiresAt`
 * (e.g. "23 hours 12 minutes", "45 minutes"). Returns "0 minutes" once passed.
 */
export function formatRemaining(
  expiresAt: string,
  now: number = Date.now()
): string {
  let ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return "0 minutes";
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  return parts.join(" ");
}
