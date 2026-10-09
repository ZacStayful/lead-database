import type Stripe from "stripe";
import { normaliseName } from "@/lib/monday";
import { holdsProduct, type ProductCustomerFields } from "@/lib/products";

/**
 * The guarded checkout's rules (batch 02 Phase 4). Pure: no reads, no writes,
 * no Stripe calls, so every decision that keeps somebody from being charged
 * twice is a unit under vitest.config.mts's "PURE UNITS ONLY" rule.
 * startManagementCheckout.ts and duplicateSubscription.ts do the I/O.
 */

export type CheckoutPlan = 10 | 20;
export type CheckoutSource = "funnel" | "call";

export function isCheckoutPlan(v: unknown): v is CheckoutPlan {
  return v === 10 || v === 20;
}

/** `?plan=10` from a URL, or null. */
export function checkoutPlanFromParam(raw: string | string[] | undefined | null): CheckoutPlan | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === "10") return 10;
  if (v === "20") return 20;
  return null;
}

/* ------------------------------------------------------------------ *
 * 1. Who is already a customer (C5)
 * ------------------------------------------------------------------ */

export interface CustomerCandidate extends ProductCustomerFields {
  id: string;
  email: string;
  contact_name: string | null;
  business_name: string | null;
  phone: string | null;
  stripe_customer_id: string | null;
  user_id: string | null;
  is_active: boolean | null;
}

export const CUSTOMER_CANDIDATE_COLUMNS =
  "id, email, contact_name, business_name, phone, stripe_customer_id, user_id, is_active, account_status, subscription_status, gr_subscription_status";

export type ExistingVerdict =
  | { kind: "already_customer"; customerId: string; matchedBy: "email" | "phone_and_name" }
  | {
      kind: "proceed";
      /** The row this payment will land on, when one exists (an enquiry, an invite, a cancellation). */
      reuse: CustomerCandidate | null;
      /** Management customers sharing the phone but not the name: proceed, and tell Zac. */
      possibleDuplicates: CustomerCandidate[];
    };

function namesMatch(name: string, row: CustomerCandidate): boolean {
  const want = normaliseName(name);
  if (!want) return false;
  return want === normaliseName(row.contact_name) || want === normaliseName(row.business_name);
}

/**
 * Whether this person already holds Management (02 Phase 4, check 1), and
 * which row to reuse if not.
 *
 * ⚠️ EMAIL DECIDES. PHONE ALONE NEVER MERGES TWO PEOPLE (C5, §57.3): two
 * colleagues on one office number are plausible here, and refusing the second
 * would lose a sale with nothing to show why. So a Management customer on the
 * same phone blocks the checkout only when the name agrees as well; otherwise
 * the checkout goes ahead and the match is reported to Zac.
 *
 * "Holds Management" is holdsProduct, never account_status alone (invariant
 * 6): an active or past-due subscriber is set up, a waitlisted enquirer and
 * somebody who cancelled are not.
 */
export function existingCustomerVerdict(args: {
  byEmail: CustomerCandidate[];
  byPhone: CustomerCandidate[];
  name: string;
}): ExistingVerdict {
  const setUp = args.byEmail.find((c) => holdsProduct(c, "management"));
  if (setUp) return { kind: "already_customer", customerId: setUp.id, matchedBy: "email" };

  const emailIds = new Set(args.byEmail.map((c) => c.id));
  const possibleDuplicates: CustomerCandidate[] = [];
  for (const row of args.byPhone) {
    if (emailIds.has(row.id) || !holdsProduct(row, "management")) continue;
    if (namesMatch(args.name, row)) {
      return { kind: "already_customer", customerId: row.id, matchedBy: "phone_and_name" };
    }
    possibleDuplicates.push(row);
  }

  // Email is unique on customers, so this is at most one row in practice. An
  // archived row is a last resort (§18D): it is still the person's history.
  const reuse = args.byEmail.find((c) => c.is_active !== false) ?? args.byEmail[0] ?? null;
  return { kind: "proceed", reuse, possibleDuplicates };
}

/* ------------------------------------------------------------------ *
 * 2. The discount
 * ------------------------------------------------------------------ */

export interface OfferRow {
  id: string;
  prospect_email: string;
  stripe_promo_code_id: string;
  promo_code_string: string;
  expires_at: string;
  redeemed_at: string | null;
}

export const OFFER_COLUMNS = "id, prospect_email, stripe_promo_code_id, promo_code_string, expires_at, redeemed_at";

/**
 * The promotion code to apply, or null. One live code per person across both
 * routes (02 locked decision 3; uq_post_call_offers_unredeemed_email, 0037), so
 * an offer is used only for the email it was made for, and only while it can
 * still be redeemed. Applying a dead code would make Stripe refuse the session.
 */
export function usableOffer(
  offer: OfferRow | null | undefined,
  email: string,
  now: Date
): { offerId: string; promoCodeId: string; code: string } | null {
  if (!offer || offer.redeemed_at) return null;
  if (offer.prospect_email.trim().toLowerCase() !== email.trim().toLowerCase()) return null;
  const expires = new Date(offer.expires_at).getTime();
  if (!Number.isFinite(expires) || expires <= now.getTime()) return null;
  if (!offer.stripe_promo_code_id) return null;
  return { offerId: offer.id, promoCodeId: offer.stripe_promo_code_id, code: offer.promo_code_string };
}

/* ------------------------------------------------------------------ *
 * 3. One open checkout at a time
 * ------------------------------------------------------------------ */

export interface OpenSessionView {
  id: string;
  url: string | null;
  priceIds: string[];
  /** Our own metadata; "" when the session carries no discount or was not ours. */
  promoCodeId: string;
  /** Unix seconds. */
  expiresAt: number | null;
}

/** A session this close to expiring is not worth handing to somebody about to type a card number. */
export const OPEN_SESSION_MIN_REMAINING_SECONDS = 10 * 60;

export function openSessionView(s: Stripe.Checkout.Session): OpenSessionView {
  const items = (s.line_items?.data ?? []) as { price?: { id?: string } | null }[];
  return {
    id: s.id,
    url: s.url ?? null,
    priceIds: items.map((i) => i.price?.id ?? "").filter(Boolean),
    promoCodeId: s.metadata?.promo_code_id ?? "",
    expiresAt: typeof s.expires_at === "number" ? s.expires_at : null,
  };
}

/**
 * Which open Management Checkout Session to hand back, and which to expire.
 *
 * ⚠️ THIS IS WHAT STOPS TWO TABS PAYING TWICE. Every route asks for the open
 * session on this Stripe customer before making one, so a second tab on the
 * same plan gets the SAME session, and Stripe completes a session only once.
 * A session for a different plan or discount is expired rather than left
 * open, so only one can ever be paid. Sessions that are not Management
 * (top-ups, analysis, Guaranteed Rent) are never touched.
 *
 * An invite's session (§18) counts too: the doc's "an invited customer gets
 * their existing checkout reused".
 */
export function chooseOpenSession(
  sessions: OpenSessionView[],
  want: { priceId: string; promoCodeId: string | null; managementPriceIds: string[]; nowSeconds: number }
): { reuse: OpenSessionView | null; expire: string[] } {
  const management = sessions.filter((s) => s.priceIds.some((p) => want.managementPriceIds.includes(p)));
  let reuse: OpenSessionView | null = null;
  const expire: string[] = [];
  for (const s of management) {
    const fits =
      reuse === null &&
      Boolean(s.url) &&
      s.priceIds.length === 1 &&
      s.priceIds[0] === want.priceId &&
      s.promoCodeId === (want.promoCodeId ?? "") &&
      (s.expiresAt === null || s.expiresAt > want.nowSeconds + OPEN_SESSION_MIN_REMAINING_SECONDS);
    if (fits) reuse = s;
    else expire.push(s.id);
  }
  return { reuse, expire };
}

/* ------------------------------------------------------------------ *
 * 4. The session itself
 * ------------------------------------------------------------------ */

export function buildCheckoutSessionParams(args: {
  stripeCustomerId: string;
  priceId: string;
  plan: CheckoutPlan;
  source: CheckoutSource;
  promoCodeId: string | null;
  offerId: string | null;
  funnelSessionId: string | null;
  customerId: string | null;
  successUrl: string;
  cancelUrl: string;
}): Stripe.Checkout.SessionCreateParams {
  // The same keys on the session and on the subscription it creates: the
  // webhook reads the subscription (Phase 5), the admin reads either.
  const tags: Record<string, string> = { source: args.source, plan: String(args.plan) };
  if (args.funnelSessionId) tags.funnel_session_id = args.funnelSessionId;
  if (args.offerId) tags.offer_id = args.offerId;
  if (args.customerId) tags.supabase_customer_id = args.customerId;

  return {
    mode: "subscription",
    customer: args.stripeCustomerId,
    line_items: [{ price: args.priceId, quantity: 1 }],
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
    ...(args.funnelSessionId ? { client_reference_id: args.funnelSessionId } : {}),
    // Stripe refuses both at once. With our code already applied there is
    // nothing to type; without one, a code given out by hand still works.
    ...(args.promoCodeId
      ? { discounts: [{ promotion_code: args.promoCodeId }] }
      : { allow_promotion_codes: true }),
    metadata: { ...tags, guarded_checkout: "1", promo_code_id: args.promoCodeId ?? "" },
    subscription_data: { metadata: tags },
  };
}

/* ------------------------------------------------------------------ *
 * 5. The webhook backstop (C3)
 * ------------------------------------------------------------------ */

/** A subscription in one of these is somebody being billed for Management. */
export const LIVE_SUBSCRIPTION_STATUSES: readonly string[] = ["active", "trialing", "past_due"];

export interface SubscriptionView {
  id: string;
  /** Unix seconds. */
  created: number;
  status: string;
  cancelAtPeriodEnd: boolean;
  isManagement: boolean;
}

function olderThan(a: { id: string; created: number }, b: { id: string; created: number }): boolean {
  return a.created < b.created || (a.created === b.created && a.id < b.id);
}

/**
 * Whether `self` is a second Management subscription for the same person, and
 * which one is kept.
 *
 * ⚠️ THE NEWER ONE GOES (02 Phase 4). Both subscriptions' events reach the
 * webhook, so the rule must give the same answer from either side: the oldest
 * live subscription is kept, with the id breaking a same-second tie, and only
 * a subscription that is not the oldest is ever a duplicate.
 *
 * Not counted as "live", each for a reason:
 *   - one already recorded as a duplicate: it is being cancelled, and counting
 *     it would let it outrank the real subscription;
 *   - one scheduled to cancel at period end: that customer is leaving, so a
 *     new subscription is a genuine return, not a second charge;
 *   - Guaranteed Rent: a customer may hold both products.
 */
export function duplicateVerdict(
  self: { id: string; created: number },
  others: SubscriptionView[],
  recorded: ReadonlySet<string>
): { duplicate: false } | { duplicate: true; keptId: string } {
  const live = others.filter(
    (s) =>
      s.id !== self.id &&
      s.isManagement &&
      LIVE_SUBSCRIPTION_STATUSES.includes(s.status) &&
      !s.cancelAtPeriodEnd &&
      !recorded.has(s.id)
  );
  let oldest: SubscriptionView | null = null;
  for (const s of live) if (!oldest || olderThan(s, oldest)) oldest = s;
  if (oldest && olderThan(oldest, self)) return { duplicate: true, keptId: oldest.id };
  return { duplicate: false };
}

/** Events for a subscription created this recently are checked for being a duplicate. */
export const DUPLICATE_CHECK_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * Which subscription events get the (Stripe-calling) duplicate check.
 * `created` always. `updated` only while the subscription is new, because
 * Stripe does not promise order: an `updated` can arrive before the
 * `created`, and handled as an ordinary event it would write the duplicate's
 * id onto the real customer's row. Everything older is left alone, so a
 * renewal costs no extra Stripe call.
 */
export function shouldCheckForDuplicate(
  eventType: string,
  subscriptionCreated: number,
  nowSeconds: number
): boolean {
  if (eventType === "customer.subscription.created") return true;
  if (eventType !== "customer.subscription.updated") return false;
  return nowSeconds - subscriptionCreated <= DUPLICATE_CHECK_WINDOW_SECONDS;
}
