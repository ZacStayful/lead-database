/**
 * Guards on the REAL files the guarded checkout touches (batch 02 Phase 4).
 *
 * vitest.config.mts is PURE UNITS ONLY, so neither the Stripe webhook nor a
 * route handler is run here. These read the files themselves (§42.8), with
 * comments stripped, because every file explains its own rules and a naive
 * substring check would pass on the explanation.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1")
    .replace(/\{\s*\}/g, "{}");
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "__tests__" ? [] : filesUnder(p);
    return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}

const WEBHOOK = source("src/app/api/webhook/stripe/route.ts");
const CHECKOUT = source("src/lib/checkout/startManagementCheckout.ts");
const BACKSTOP = source("src/lib/checkout/duplicateSubscription.ts");
const FUNNEL_ROUTE = source("src/app/api/funnel/[token]/checkout/route.ts");
const PAY = source("src/app/pay/[offerToken]/page.tsx");
const OFFERS = source("src/lib/postCallOffers.ts");
const PAY_TOKEN = source("src/lib/checkout/payToken.ts");
const OFFER_ROUTE = source("src/app/api/admin/post-call-offer/route.ts");
const REMINDERS = source("src/app/api/cron/post-call-offer-reminders/route.ts");
const LOGIN = source("src/app/login/page.tsx");

describe("the webhook backstop's two additive calls (C3)", () => {
  it("customer.subscription.*: after the product is known, before the customer row is read, and it stops the event", () => {
    const branch = WEBHOOK.slice(WEBHOOK.indexOf('case "customer.subscription.created"'), WEBHOOK.indexOf('case "invoice.paid"'));
    const product = branch.indexOf("const isGuaranteedRent = isGuaranteedRentPriceId(subPriceIds);");
    const call = branch.indexOf("await skipDuplicateSubscriptionEvent(admin, stripe, {");
    const firstRead = branch.indexOf('.from("customers")');
    expect(product).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(product);
    expect(call).toBeLessThan(firstRead);
    expect(branch.slice(call, firstRead)).toMatch(/\)\s*\{\s*break;\s*\}/);
    expect(branch.slice(call, firstRead)).toContain("eventType: event.type");
    expect(branch.slice(call, firstRead)).toContain("isGuaranteedRent,");
  });

  it("invoice.paid: at the top of the Management half, before the customer read and before any credit", () => {
    const branch = WEBHOOK.slice(WEBHOOK.indexOf('case "invoice.paid"'), WEBHOOK.indexOf('case "invoice.payment_failed"'));
    const grEnd = branch.indexOf('await pushMetaPurchase(admin, customer.id, invoice, "guaranteed_rent");');
    const call = branch.indexOf("if (await skipDuplicateInvoice(admin, stripe, { invoice, subscriptionId })) break;");
    const mgmtRead = branch.indexOf('.eq("stripe_customer_id", customerId)');
    const credits = Array.from(branch.matchAll(/admin\.rpc\("credit_invoice"/g), (m) => m.index ?? -1);
    expect(grEnd).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(grEnd);
    expect(call).toBeLessThan(mgmtRead);
    expect(credits).toHaveLength(2);
    expect(call).toBeLessThan(credits[1]);
  });

  it("is exactly those two calls", () => {
    expect(WEBHOOK.match(/skipDuplicateSubscriptionEvent\(/g)).toHaveLength(1);
    expect(WEBHOOK.match(/skipDuplicateInvoice\(/g)).toHaveLength(1);
  });

  it("records before it cancels, and keys every Stripe write", () => {
    const settle = BACKSTOP.slice(BACKSTOP.indexOf("async function settleDuplicate"), BACKSTOP.indexOf("export async function skipDuplicateSubscriptionEvent"));
    expect(settle.indexOf('.from("duplicate_subscriptions")\n    .insert(')).toBeGreaterThan(-1);
    expect(settle.indexOf(".insert(")).toBeLessThan(settle.indexOf("stripe.subscriptions.cancel("));
    expect(settle).toContain("idempotencyKey: `dup-cancel:${args.subscriptionId}`");
    expect(settle).toContain("idempotencyKey: `dup-refund:${invoice.id}`");
    // A failed insert (other than the 23505 that means "already recorded")
    // stops before any Stripe write. The read-back below is a second stop.
    expect(settle).toMatch(/if \(inserted\.error && inserted\.error\.code !== "23505"\) \{[^}]*return;\s*\}/);
    // The email is claimed by write, conditionally, before it is sent.
    const claim = settle.indexOf('.is("emailed_at", null)');
    expect(claim).toBeGreaterThan(-1);
    expect(claim).toBeLessThan(settle.indexOf("sendDuplicateSubscriptionEmail("));
  });

  it("never throws out of either touch point", () => {
    for (const fn of ["skipDuplicateSubscriptionEvent", "skipDuplicateInvoice"]) {
      const start = BACKSTOP.indexOf(`export async function ${fn}`);
      const body = BACKSTOP.slice(start, BACKSTOP.indexOf("\n}\n", start));
      expect(body.trimEnd()).toMatch(/\} catch \(err\) \{[\s\S]*return false;\s*\}$/);
    }
  });
});

describe("the one door", () => {
  it("never links a Stripe customer to a row that has none (provisioning does that at payment)", () => {
    expect(CHECKOUT).not.toMatch(/\.update\(\{[^}]*stripe_customer_id/);
    expect(CHECKOUT).toContain(".update({ monthly_allocation: input.plan })");
  });

  it("checks for an existing customer before touching Stripe", () => {
    expect(CHECKOUT.indexOf('if (verdict.kind === "already_customer")')).toBeLessThan(CHECKOUT.indexOf("resolveStripeCustomer(stripe,"));
  });

  it("asks for an open session before creating one", () => {
    expect(CHECKOUT.indexOf("stripe.checkout.sessions.list(")).toBeLessThan(CHECKOUT.indexOf("stripe.checkout.sessions.create("));
  });

  it("no app code reads the raw Payment Link variables any more", () => {
    const readers = filesUnder("src").filter((f) => /PAYMENT_LINK_URL/.test(source(f)));
    expect(readers).toEqual([]);
  });

  it("postCallOffers.ts stays client-safe: a client component imports it", () => {
    // PostCallOfferPanel ("use client") imports offerState from it, so a
    // runtime import reaching node:crypto fails the production build.
    expect(source("src/components/admin/PostCallOfferPanel.tsx")).toContain('from "@/lib/postCallOffers"');
    expect(OFFERS).not.toMatch(/^import (?!type )/m);
  });

  it("post-call links are built from the offer id, never the code", () => {
    expect(PAY_TOKEN).not.toContain("prefilled_promo_code");
    expect(PAY_TOKEN).toContain("export function computeCheckoutUrls(offerId: string)");
    expect(OFFER_ROUTE).toContain("computeCheckoutUrls(existing.id)");
    expect(OFFER_ROUTE).toContain("computeCheckoutUrls(winner.id)");
    expect(OFFER_ROUTE).toContain("computeCheckoutUrls(offerId)");
    expect(OFFER_ROUTE).not.toMatch(/computeCheckoutUrls\([^)]*promo/);
    expect(REMINDERS).toContain("computeCheckoutUrls(offer.id)");
  });
});

describe("POST /api/funnel/[token]/checkout", () => {
  it("runs the funnel gate first, then refuses without a preview or with brief routing off", () => {
    const gate = FUNNEL_ROUTE.indexOf('funnelGate(admin, params.token, "checkout")');
    const json = FUNNEL_ROUTE.indexOf("await request.json()");
    const preview = FUNNEL_ROUTE.indexOf("if (!session.preview_snapshot)");
    const brief = FUNNEL_ROUTE.indexOf("if (!(await briefRoutingEnabled(admin)))");
    const door = FUNNEL_ROUTE.indexOf("await startManagementCheckout(admin, {");
    for (const at of [gate, json, preview, brief, door]) expect(at).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(json);
    expect(preview).toBeLessThan(door);
    expect(brief).toBeLessThan(door);
    expect(FUNNEL_ROUTE).toContain('{ code: "preview_required" }, { status: 409');
    expect(FUNNEL_ROUTE).toContain('{ code: "payment_not_open" }, { status: 409');
  });

  it("takes who is paying from the session, never the body, as source 'funnel'", () => {
    const call = FUNNEL_ROUTE.slice(FUNNEL_ROUTE.indexOf("await startManagementCheckout(admin, {"));
    expect(call).toContain("email: session.email,");
    expect(call).toContain("phone: session.phone,");
    expect(call).toContain("name: session.name,");
    expect(call).toContain('source: "funnel",');
    expect(call).toContain("funnelSessionId: session.id,");
  });

  it("records checkout_started without ever moving a paid session", () => {
    expect(FUNNEL_ROUTE).toContain('step: advanceStep(session.step, "checkout_started")');
    expect(FUNNEL_ROUTE).toContain('.neq("step", "paid")');
  });
});

describe("GET /pay/[offerToken]", () => {
  it("opens only a token we signed, and sends no referrer", () => {
    expect(PAY).toContain("verifyPayToken(params.offerToken, payTokenSecret())");
    expect(PAY).toContain("if (!offerId) notFound();");
    expect(PAY).toContain('referrer: "no-referrer"');
    expect(PAY).toContain("robots: { index: false, follow: false }");
  });

  it("pays for the person on the offer, as source 'call', with that offer's code", () => {
    const call = PAY.slice(PAY.indexOf("await startManagementCheckout(admin, {"));
    expect(call).toContain("email: offer.prospect_email,");
    expect(call).toContain('source: "call",');
    expect(call).toContain("discountOfferId: offer.id,");
  });

  it("never prefetches a link that starts a checkout", () => {
    expect(PAY).not.toMatch(/from "next\/link"/);
    expect(PAY).toContain("href={payPath(props.token, plan)}");
  });

  it("redirects outside any try, so Next's redirect is not swallowed", () => {
    expect(PAY).not.toMatch(/\btry\s*\{/);
  });
});

describe("where a payer lands", () => {
  it("the login page says the payment was received", () => {
    expect(LOGIN).toContain('params.get("notice") === "payment_received"');
    expect(LOGIN).toContain("FUNNEL_COPY.paymentReceived");
  });
});
