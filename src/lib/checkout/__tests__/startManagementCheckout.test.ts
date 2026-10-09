import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above every const, so the spy is hoisted with it.
const { sendPossibleDuplicateCustomerEmail } = vi.hoisted(() => ({
  sendPossibleDuplicateCustomerEmail: vi.fn(async () => ({ id: "em_1", error: null })),
}));
vi.mock("@/lib/emails", () => ({ sendPossibleDuplicateCustomerEmail }));

import { startManagementCheckout, type StartCheckoutInput } from "@/lib/checkout/startManagementCheckout";
import { fakeDb, fakeStripe } from "./fakes";

/**
 * The ONE door for a Management payment (02 Phase 4), run end to end against
 * in-memory Supabase and Stripe. The doc's Phase 4 checks, in its words:
 *   - an existing active customer gets already_customer and no checkout;
 *   - an invited-unpaid customer gets their existing checkout reused;
 *   - two tabs end with one payable session;
 *   - the post-call discount is applied.
 */

const NOW = new Date("2026-10-09T12:00:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);

function customer(over: Record<string, unknown> = {}) {
  return {
    id: "c1",
    email: "jo@example.com",
    contact_name: "Jo Bloggs",
    business_name: "Bloggs Lettings",
    phone: "+447700900123",
    stripe_customer_id: null,
    user_id: null,
    is_active: true,
    account_status: "waitlisted",
    subscription_status: "inactive",
    gr_subscription_status: "inactive",
    monthly_allocation: 20,
    ...over,
  };
}

const input = (over: Partial<StartCheckoutInput> = {}): StartCheckoutInput => ({
  email: "Jo@Example.com",
  phone: "07700 900123",
  name: "Jo Bloggs",
  plan: 10,
  source: "funnel",
  funnelSessionId: "fs_1",
  successUrl: "https://app/ok",
  cancelUrl: "https://app/back",
  ...over,
});

beforeEach(() => {
  vi.stubEnv("STRIPE_PRICE_ID_10", "price_10");
  vi.stubEnv("STRIPE_PRICE_ID_20", "price_20");
  vi.stubEnv("STRIPE_MONTHLY_PRICE_ID", "");
  sendPossibleDuplicateCustomerEmail.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("check 1: already a customer", () => {
  it("an active Management customer gets the login link and Stripe is never called", async () => {
    const db = fakeDb({ customers: [customer({ account_status: "active", stripe_customer_id: "cus_1" })] });
    const s = fakeStripe();
    const r = await startManagementCheckout(db.admin, input(), { stripe: s.stripe, now: () => NOW });
    expect(r.status).toBe("already_customer");
    expect(r.status === "already_customer" && r.loginUrl).toMatch(/\/login\?notice=already_set_up$/);
    expect(s.calls).toEqual([]);
    expect(db.writes).toEqual([]);
  });

  it("a Management customer on the same phone AND name is the same person", async () => {
    const db = fakeDb({
      customers: [customer({ id: "c9", email: "office@example.com", account_status: "active" })],
    });
    const s = fakeStripe();
    const r = await startManagementCheckout(db.admin, input(), { stripe: s.stripe, now: () => NOW });
    expect(r.status).toBe("already_customer");
    expect(s.calls).toEqual([]);
  });

  it("the same phone under another name goes ahead, and Zac is told once", async () => {
    const db = fakeDb({
      customers: [customer({ id: "c9", email: "office@example.com", account_status: "active", contact_name: "Pat Smith", business_name: "Smith Co" })],
    });
    const s = fakeStripe();
    const r = await startManagementCheckout(db.admin, input(), { stripe: s.stripe, now: () => NOW });
    expect(r.status).toBe("checkout");
    expect(sendPossibleDuplicateCustomerEmail).toHaveBeenCalledTimes(1);
    // A second tab reuses the session, and does not email again.
    await startManagementCheckout(db.admin, input(), { stripe: s.stripe, now: () => NOW });
    expect(sendPossibleDuplicateCustomerEmail).toHaveBeenCalledTimes(1);
  });
});

describe("checks 2 and 4: one Stripe customer per email, then a session", () => {
  it("an enquirer: a new Stripe customer and session, the plan sized on the row, and the row NOT linked", async () => {
    const db = fakeDb({ customers: [customer()] });
    const s = fakeStripe();
    const r = await startManagementCheckout(db.admin, input(), { stripe: s.stripe, now: () => NOW });
    expect(r.status).toBe("checkout");
    if (r.status !== "checkout") return;
    expect(r.reused).toBe(false);
    expect(r.customerId).toBe("c1");

    const create = s.calls.find((c) => c.name === "customers.create");
    expect(create?.key).toMatch(/^mgmt-customer:[0-9a-f]{64}$/);
    expect(create?.args).toMatchObject({ email: "jo@example.com" });

    // §17: the plan is on the row before checkout opens...
    expect(db.tables.customers[0].monthly_allocation).toBe(10);
    // ...but the Stripe id is NOT, so invoice.paid provisions the login.
    expect(db.tables.customers[0].stripe_customer_id).toBeNull();
    expect(db.writes.every((w) => !("stripe_customer_id" in w.values))).toBe(true);

    const session = s.state.sessions[0];
    expect(session.params?.line_items).toEqual([{ price: "price_10", quantity: 1 }]);
    expect(session.params?.subscription_data?.metadata).toMatchObject({ source: "funnel", funnel_session_id: "fs_1" });
  });

  it("reuses a Stripe customer that already has this email", async () => {
    const db = fakeDb({ customers: [] });
    const s = fakeStripe({ customers: [{ id: "cus_old", email: "jo@example.com" }] });
    const r = await startManagementCheckout(db.admin, input(), { stripe: s.stripe, now: () => NOW });
    expect(r.status === "checkout" && r.stripeCustomerId).toBe("cus_old");
    expect(s.calls.some((c) => c.name === "customers.create")).toBe(false);
  });

  it("uses the row's own Stripe customer before searching", async () => {
    const db = fakeDb({ customers: [customer({ stripe_customer_id: "cus_row", account_status: "invited" })] });
    const s = fakeStripe({ customers: [{ id: "cus_other", email: "jo@example.com" }] });
    const r = await startManagementCheckout(db.admin, input(), { stripe: s.stripe, now: () => NOW });
    expect(r.status === "checkout" && r.stripeCustomerId).toBe("cus_row");
    expect(s.calls.some((c) => c.name === "customers.list")).toBe(false);
  });
});

describe("check 3: one open checkout at a time", () => {
  const invited = () => customer({ stripe_customer_id: "cus_1", account_status: "invited", user_id: "u1" });
  const openInvite = {
    id: "cs_invite",
    customer: "cus_1",
    status: "open" as const,
    url: "https://checkout.stripe.com/c/cs_invite",
    priceId: "price_10",
    metadata: {},
    expires_at: NOW_S + 3600,
  };

  it("an invited customer gets their existing checkout reused", async () => {
    const db = fakeDb({ customers: [invited()] });
    const s = fakeStripe({ sessions: [openInvite] });
    const r = await startManagementCheckout(db.admin, input({ source: "call", discountOfferId: null }), {
      stripe: s.stripe,
      now: () => NOW,
    });
    expect(r).toMatchObject({ status: "checkout", checkoutSessionId: "cs_invite", reused: true });
    expect(s.calls.some((c) => c.name === "checkout.sessions.create")).toBe(false);
  });

  it("two tabs on the same plan get the same session", async () => {
    const db = fakeDb({ customers: [customer()] });
    const s = fakeStripe();
    const a = await startManagementCheckout(db.admin, input(), { stripe: s.stripe, now: () => NOW });
    const b = await startManagementCheckout(db.admin, input(), { stripe: s.stripe, now: () => NOW });
    expect(a.status === "checkout" && b.status === "checkout" && a.checkoutSessionId === b.checkoutSessionId).toBe(true);
    expect(s.state.sessions.filter((x) => x.status === "open")).toHaveLength(1);
  });

  it("switching plan expires the first session, so only one can ever be paid", async () => {
    const db = fakeDb({ customers: [invited()] });
    const s = fakeStripe({ sessions: [openInvite] });
    const r = await startManagementCheckout(db.admin, input({ plan: 20, discountOfferId: null }), {
      stripe: s.stripe,
      now: () => NOW,
    });
    expect(r.status === "checkout" && r.reused).toBe(false);
    expect(s.state.sessions.find((x) => x.id === "cs_invite")?.status).toBe("expired");
    expect(s.state.sessions.filter((x) => x.status === "open")).toHaveLength(1);
  });

  it("leaves a non-Management session alone", async () => {
    const db = fakeDb({ customers: [invited()] });
    const s = fakeStripe({ sessions: [{ ...openInvite, id: "cs_topup", priceId: "price_topup" }] });
    await startManagementCheckout(db.admin, input({ discountOfferId: null }), { stripe: s.stripe, now: () => NOW });
    expect(s.state.sessions.find((x) => x.id === "cs_topup")?.status).toBe("open");
  });
});

describe("the discount", () => {
  const offer = {
    id: "o1",
    prospect_email: "jo@example.com",
    stripe_promo_code_id: "promo_1",
    promo_code_string: "FOUNDING10-ABCD",
    expires_at: "2026-10-10T10:00:00Z",
    redeemed_at: null,
  };

  it("finds and applies this person's own live code when none is named", async () => {
    const db = fakeDb({ customers: [customer()], post_call_offers: [offer] });
    const s = fakeStripe();
    const r = await startManagementCheckout(db.admin, input(), { stripe: s.stripe, now: () => NOW });
    expect(r.status === "checkout" && r.discountApplied).toBe(true);
    expect(s.state.sessions[0].params?.discounts).toEqual([{ promotion_code: "promo_1" }]);
  });

  it("applies the named offer on the post-call link", async () => {
    const db = fakeDb({ customers: [customer()], post_call_offers: [offer] });
    const s = fakeStripe();
    await startManagementCheckout(db.admin, input({ source: "call", discountOfferId: "o1" }), {
      stripe: s.stripe,
      now: () => NOW,
    });
    expect(s.state.sessions[0].params?.metadata).toMatchObject({ offer_id: "o1", promo_code_id: "promo_1" });
  });

  it("an expired code just means full price, with a code box", async () => {
    const db = fakeDb({ customers: [customer()], post_call_offers: [{ ...offer, expires_at: "2026-10-09T11:00:00Z" }] });
    const s = fakeStripe();
    const r = await startManagementCheckout(db.admin, input({ discountOfferId: "o1" }), { stripe: s.stripe, now: () => NOW });
    expect(r.status === "checkout" && r.discountApplied).toBe(false);
    expect(s.state.sessions[0].params?.discounts).toBeUndefined();
    expect(s.state.sessions[0].params?.allow_promotion_codes).toBe(true);
  });

  it("null means no discount, even when one exists", async () => {
    const db = fakeDb({ customers: [customer()], post_call_offers: [offer] });
    const s = fakeStripe();
    const r = await startManagementCheckout(db.admin, input({ discountOfferId: null }), { stripe: s.stripe, now: () => NOW });
    expect(r.status === "checkout" && r.discountApplied).toBe(false);
  });
});

describe("never throws", () => {
  it("a bad email, a failed lookup, a missing price and a Stripe failure are each a result", async () => {
    const s = fakeStripe();
    expect(await startManagementCheckout(fakeDb({}).admin, input({ email: "nope" }), { stripe: s.stripe })).toEqual({
      status: "unavailable",
      reason: "invalid_email",
    });

    const broken = fakeDb({ customers: [] }, { failSelect: { customers: { message: "down" } } });
    expect(await startManagementCheckout(broken.admin, input(), { stripe: s.stripe })).toEqual({
      status: "unavailable",
      reason: "lookup_failed",
    });

    vi.stubEnv("STRIPE_PRICE_ID_10", "");
    expect(await startManagementCheckout(fakeDb({ customers: [] }).admin, input(), { stripe: s.stripe })).toEqual({
      status: "unavailable",
      reason: "price_not_configured",
    });
    vi.stubEnv("STRIPE_PRICE_ID_10", "price_10");

    const failing = fakeStripe({}, { fail: { "checkout.sessions.create": new Error("card network down") } });
    expect(await startManagementCheckout(fakeDb({ customers: [] }).admin, input(), { stripe: failing.stripe, now: () => NOW })).toEqual({
      status: "unavailable",
      reason: "stripe_failed",
    });
  });
});
