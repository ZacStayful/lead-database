import { createHmac, timingSafeEqual } from "node:crypto";
import { APP_URL } from "@/lib/env";
import type { CheckoutUrls } from "@/lib/postCallOffers";

/**
 * The `/pay/[offerToken]` link (batch 02 Phase 4): the post-call payment link
 * that replaces the raw Stripe Payment Links.
 *
 * Shape `<post_call_offers id>.<HMAC of "post-call-pay:<id>">`, under
 * MESSAGING_TOKEN_SECRET (the funnel's secret, domain-separated): the id says
 * which offer, the HMAC proves we issued it, and no column is needed to look
 * it up. The funnel summary token (funnel/token.ts) uses the same shape under
 * its own domain, so neither can be turned into the other.
 *
 * ⚠️ It opens ONE thing: a checkout for the person the offer was made for,
 * with their name, email and phone read from the offer row. The visitor
 * supplies nothing but the plan, so a forwarded link can only ever start a
 * payment for that prospect.
 *
 * Null when no secret is configured, which fails closed: no link can be minted
 * or opened without it.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function payTokenSecret(): string | null {
  return process.env.MESSAGING_TOKEN_SECRET || null;
}

export function derivePayToken(offerId: string, secret: string | null | undefined): string | null {
  if (!secret || !UUID.test(offerId)) return null;
  const mac = createHmac("sha256", secret).update(`post-call-pay:${offerId}`).digest("base64url");
  return `${offerId}.${mac}`;
}

/** The offer id a pay token opens, or null. Compared in constant time. */
export function verifyPayToken(raw: string, secret: string | null | undefined): string | null {
  if (!secret || typeof raw !== "string") return null;
  const dot = raw.indexOf(".");
  if (dot < 0) return null;
  const id = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  if (!UUID.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(mac)) return null;
  const expected = derivePayToken(id, secret);
  if (!expected) return null;
  const a = Buffer.from(raw);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? id : null;
}

export function payPath(token: string, plan?: 10 | 20): string {
  return plan ? `/pay/${token}?plan=${plan}` : `/pay/${token}`;
}

export function payUrl(token: string, plan?: 10 | 20): string {
  return `${APP_URL}${payPath(token, plan)}`;
}

/**
 * Both plans' payment links for an offer: `/pay/[offerToken]?plan=10|20`
 * (batch 02 Phase 4), the guarded checkout, under the field names the admin
 * panel, the reminder email and the reminder text already read.
 *
 * ⚠️ NOT THE RAW STRIPE PAYMENT LINKS ANY MORE. Those let a prospect who was
 * already a customer pay a second time, and let two tabs pay twice; /pay goes
 * through startManagementCheckout, which stops both. The code is applied there,
 * server-side, so the link carries no `prefilled_promo_code`.
 * STRIPE_MANAGEMENT_{10,20}_PAYMENT_LINK_URL stay set in Vercel and are read
 * by nothing in the app.
 *
 * Throws without MESSAGING_TOKEN_SECRET, so the caller surfaces a clear config
 * error rather than handing out a link that cannot be opened.
 */
export function computeCheckoutUrls(offerId: string): CheckoutUrls {
  const token = derivePayToken(offerId, payTokenSecret());
  if (!token) {
    throw new Error(
      "Cannot build the payment link: MESSAGING_TOKEN_SECRET is not set, or the offer id is not a uuid."
    );
  }
  return {
    checkout_url_10: payUrl(token, 10),
    checkout_url_20: payUrl(token, 20),
  };
}
