import { createHash } from "node:crypto";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getStripe } from "@/lib/stripe";
import { normaliseEmail } from "@/lib/emailAddress";
import { ukMobileE164 } from "@/lib/leadQuality";
import { configuredManagementPriceIds, stripePriceIdFor } from "@/lib/plans";
import { holdsProduct } from "@/lib/products";
import { sendPossibleDuplicateCustomerEmail } from "@/lib/emails";
import { alreadySetUpLoginUrl } from "@/lib/funnel/token";
import {
  CUSTOMER_CANDIDATE_COLUMNS,
  OFFER_COLUMNS,
  buildCheckoutSessionParams,
  chooseOpenSession,
  existingCustomerVerdict,
  openSessionView,
  usableOffer,
  type CheckoutPlan,
  type CheckoutSource,
  type CustomerCandidate,
  type OfferRow,
} from "@/lib/checkout/rules";

/**
 * THE ONE DOOR for a Management payment (batch 02 Phase 4). The funnel
 * (`POST /api/funnel/[token]/checkout`) and the post-call link
 * (`GET /pay/[offerToken]`) both come through here, so the same checks stand
 * in front of every route:
 *
 *   1. Already a customer? An active or past-due Management customer, by email
 *      (or by phone with the same name, C5), gets the login link and NO
 *      checkout.
 *   2. One Stripe customer per email: the row's own id, else the first Stripe
 *      customer with this email, else a new one.
 *   3. One open checkout at a time: an open Management session that fits is
 *      handed back, and any that does not fit is expired (rules.ts says why).
 *   4. Otherwise a new session, with this person's live discount applied.
 *
 * What gets past all four (a raw Payment Link still in somebody's inbox, two
 * requests in the same instant) is caught by the webhook backstop,
 * duplicateSubscription.ts.
 *
 * ⚠️ NOTHING HERE GRANTS ANYTHING. Payment is what activates a customer: the
 * Stripe webhook's invoice.paid credits the leads and promotes the row, as it
 * always has. An abandoned checkout leaves everything as it was.
 *
 * ⚠️ IT DOES NOT LINK A STRIPE CUSTOMER TO A ROW THAT HAS NONE. An enquirer's
 * row (waitlisted, no login) must reach invoice.paid as an unknown Stripe
 * customer, because that is the path that links the row by email, creates the
 * login and emails the set-password link (provisionPaidSubscriber). Writing
 * the id here would send them down the known-customer path instead: credited,
 * promoted, and left with no way to sign in.
 *
 * Never throws. Every failure is a result the route can turn into a sentence.
 */

export interface StartCheckoutInput {
  email: string;
  phone: string | null;
  name: string;
  plan: CheckoutPlan;
  source: CheckoutSource;
  /**
   * The post_call_offers row to apply. Omitted: this person's own live offer,
   * if they have one, is found by email (one code per person across both
   * routes). Null: apply none.
   */
  discountOfferId?: string | null;
  funnelSessionId?: string | null;
  successUrl: string;
  cancelUrl: string;
}

export type StartCheckoutResult =
  | {
      status: "checkout";
      url: string;
      checkoutSessionId: string;
      reused: boolean;
      stripeCustomerId: string;
      customerId: string | null;
      discountApplied: boolean;
    }
  | { status: "already_customer"; loginUrl: string }
  | {
      status: "unavailable";
      reason: "invalid_email" | "lookup_failed" | "price_not_configured" | "stripe_failed";
    };

export interface CheckoutDeps {
  stripe?: Stripe;
  now?: () => Date;
}

function unavailable(reason: Extract<StartCheckoutResult, { status: "unavailable" }>["reason"]): StartCheckoutResult {
  return { status: "unavailable", reason };
}

async function findCustomers(
  admin: SupabaseClient,
  email: string,
  phone: string | null
): Promise<{ ok: true; byEmail: CustomerCandidate[]; byPhone: CustomerCandidate[] } | { ok: false }> {
  // `.eq`, never `.ilike` (§43.1). Email is unique on customers; the limit is
  // defensive, as in funnel/server.ts.
  const byEmail = await admin.from("customers").select(CUSTOMER_CANDIDATE_COLUMNS).eq("email", email).limit(5);
  if (byEmail.error) {
    console.error("[checkout] customer lookup by email failed", byEmail.error.message);
    return { ok: false };
  }
  let byPhone: CustomerCandidate[] = [];
  const e164 = phone ? ukMobileE164(phone) : null;
  if (e164?.ok) {
    // customers.phone is stored as +44 E.164 (§49), so one exact match covers it.
    const res = await admin.from("customers").select(CUSTOMER_CANDIDATE_COLUMNS).eq("phone", e164.value).limit(10);
    if (res.error) {
      console.error("[checkout] customer lookup by phone failed", res.error.message);
      return { ok: false };
    }
    byPhone = (res.data ?? []) as unknown as CustomerCandidate[];
  }
  return { ok: true, byEmail: (byEmail.data ?? []) as unknown as CustomerCandidate[], byPhone };
}

async function findOffer(
  admin: SupabaseClient,
  email: string,
  offerId: string | null | undefined,
  now: Date
): Promise<ReturnType<typeof usableOffer>> {
  if (offerId === null) return null;
  const query = admin.from("post_call_offers").select(OFFER_COLUMNS);
  // Absent: this person's own unredeemed offer, if any. The unique index
  // (0037) means there is at most one.
  const { data, error } = offerId
    ? await query.eq("id", offerId).maybeSingle()
    : await query.eq("prospect_email", email).is("redeemed_at", null).maybeSingle();
  if (error) {
    // A missing discount is recoverable; a refused payment is not. Go on without it.
    console.error("[checkout] offer lookup failed, continuing without a discount", error.message);
    return null;
  }
  return usableOffer(data as OfferRow | null, email, now);
}

/**
 * One Stripe customer per email. The row's own id wins; then the first live
 * Stripe customer already carrying this email; then a new one.
 *
 * ⚠️ The create carries an idempotency key built from what it sends, so two
 * tabs asking in the same instant get the same customer back rather than two.
 * Stripe's email filter is case-sensitive and we always write lower case, so a
 * legacy mixed-case customer can be missed here; the webhook backstop matches
 * on email in our own table too.
 */
async function resolveStripeCustomer(
  stripe: Stripe,
  args: { existingId: string | null; email: string; name: string; phone: string | null; source: CheckoutSource }
): Promise<string> {
  if (args.existingId) return args.existingId;
  const found = await stripe.customers.list({ email: args.email, limit: 10 });
  const live = found.data.find((c) => !(c as unknown as { deleted?: boolean }).deleted);
  if (live) return live.id;

  const params: Stripe.CustomerCreateParams = {
    email: args.email,
    name: args.name,
    ...(args.phone ? { phone: args.phone } : {}),
    metadata: { created_by: "guarded_checkout", source: args.source },
  };
  const key = createHash("sha256")
    .update(JSON.stringify([args.email, args.name, args.phone ?? "", args.source]))
    .digest("hex");
  try {
    const created = await stripe.customers.create(params, { idempotencyKey: `mgmt-customer:${key}` });
    return created.id;
  } catch (err) {
    // Lost a race to a concurrent create with different details: the other
    // request's customer is the one to use.
    const again = await stripe.customers.list({ email: args.email, limit: 10 });
    const winner = again.data.find((c) => !(c as unknown as { deleted?: boolean }).deleted);
    if (winner) return winner.id;
    throw err;
  }
}

export async function startManagementCheckout(
  admin: SupabaseClient,
  input: StartCheckoutInput,
  deps: CheckoutDeps = {}
): Promise<StartCheckoutResult> {
  const now = deps.now?.() ?? new Date();
  const email = normaliseEmail(input.email);
  if (!email) return unavailable("invalid_email");
  const name = input.name.trim() || email;

  // 1. Already a customer?
  const found = await findCustomers(admin, email, input.phone);
  if (!found.ok) return unavailable("lookup_failed");
  const verdict = existingCustomerVerdict({ byEmail: found.byEmail, byPhone: found.byPhone, name });
  if (verdict.kind === "already_customer") return { status: "already_customer", loginUrl: alreadySetUpLoginUrl() };
  const row = verdict.reuse;

  let priceId: string;
  try {
    priceId = stripePriceIdFor(input.plan);
  } catch (err) {
    console.error("[checkout] price not configured", err instanceof Error ? err.message : err);
    return unavailable("price_not_configured");
  }

  const offer = await findOffer(admin, email, input.discountOfferId, now);

  let stripe: Stripe;
  try {
    stripe = deps.stripe ?? getStripe();
  } catch (err) {
    console.error("[checkout] stripe unavailable", err);
    return unavailable("stripe_failed");
  }

  try {
    // 2. One Stripe customer per email.
    const stripeCustomerId = await resolveStripeCustomer(stripe, {
      existingId: row?.stripe_customer_id ?? null,
      email,
      name,
      phone: input.phone,
      source: input.source,
    });

    // §17's trap: invoice.paid credits the allocation on the row, so the row
    // carries the plan being bought BEFORE the checkout opens, exactly as
    // /api/customer/subscribe does. Inert for somebody who never pays: the
    // column gates nothing for a customer who does not hold Management.
    if (row && !holdsProduct(row, "management")) {
      const { error } = await admin.from("customers").update({ monthly_allocation: input.plan }).eq("id", row.id);
      if (error) console.error("[checkout] could not size the plan on the row", error.message);
    }

    // 3. One open checkout at a time.
    const open = await stripe.checkout.sessions.list({
      customer: stripeCustomerId,
      status: "open",
      limit: 20,
      expand: ["data.line_items"],
    });
    const choice = chooseOpenSession(open.data.map(openSessionView), {
      priceId,
      promoCodeId: offer?.promoCodeId ?? null,
      managementPriceIds: configuredManagementPriceIds(),
      nowSeconds: Math.floor(now.getTime() / 1000),
    });
    for (const id of choice.expire) {
      try {
        await stripe.checkout.sessions.expire(id);
      } catch (err) {
        // Already completed or expired between the list and here. If it was
        // paid, the webhook backstop has the second subscription.
        console.error("[checkout] could not expire an open session", id, err instanceof Error ? err.message : err);
      }
    }
    if (choice.reuse?.url) {
      return {
        status: "checkout",
        url: choice.reuse.url,
        checkoutSessionId: choice.reuse.id,
        reused: true,
        stripeCustomerId,
        customerId: row?.id ?? null,
        discountApplied: Boolean(offer),
      };
    }

    // 4. A new session.
    const session = await stripe.checkout.sessions.create(
      buildCheckoutSessionParams({
        stripeCustomerId,
        priceId,
        plan: input.plan,
        source: input.source,
        promoCodeId: offer?.promoCodeId ?? null,
        offerId: offer?.offerId ?? null,
        funnelSessionId: input.funnelSessionId ?? null,
        customerId: row?.id ?? null,
        successUrl: input.successUrl,
        cancelUrl: input.cancelUrl,
      })
    );
    if (!session.url) {
      console.error("[checkout] Stripe returned a session with no url", session.id);
      return unavailable("stripe_failed");
    }

    // C5: a phone shared with a Management customer under another name. The
    // checkout goes ahead; Zac is told once per new session.
    if (verdict.possibleDuplicates.length > 0) {
      const sent = await sendPossibleDuplicateCustomerEmail({
        name,
        email,
        phone: input.phone,
        source: input.source,
        matches: verdict.possibleDuplicates.map((m) => ({
          id: m.id,
          email: m.email,
          name: m.contact_name ?? m.business_name,
        })),
      });
      if (sent.error) console.error("[checkout] possible-duplicate email failed", sent.error);
    }

    return {
      status: "checkout",
      url: session.url,
      checkoutSessionId: session.id,
      reused: false,
      stripeCustomerId,
      customerId: row?.id ?? null,
      discountApplied: Boolean(offer),
    };
  } catch (err) {
    console.error("[checkout] Stripe call failed", err instanceof Error ? err.message : err);
    return unavailable("stripe_failed");
  }
}
