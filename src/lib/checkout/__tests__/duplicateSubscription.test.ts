import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

const { sendDuplicateSubscriptionEmail } = vi.hoisted(() => ({
  sendDuplicateSubscriptionEmail: vi.fn(async (_args: Record<string, unknown>) => ({ id: "em_1" as string | null, error: null as unknown })),
}));
vi.mock("@/lib/emails", () => ({ sendDuplicateSubscriptionEmail }));

import { skipDuplicateInvoice, skipDuplicateSubscriptionEvent } from "@/lib/checkout/duplicateSubscription";
import { fakeDb, fakeStripe, type FakeStripeState } from "./fakes";

/**
 * The webhook backstop (02 Phase 4, C3), against in-memory Supabase and
 * Stripe. The doc's check: "two tabs paying at once end with exactly one
 * active subscription, one refund and an email to Zac".
 */

const NOW_S = 1_800_000_000;
const PK = { primaryKeys: { duplicate_subscriptions: "subscription_id" } };

function twoSubs(over: Partial<FakeStripeState> = {}): Partial<FakeStripeState> {
  return {
    customers: [{ id: "cus_1", email: "Jo@Example.com" }],
    subscriptions: [
      { id: "sub_old", customer: "cus_1", created: NOW_S - 600, status: "active", priceId: "price_10", latest_invoice: "in_old" },
      { id: "sub_new", customer: "cus_1", created: NOW_S - 60, status: "active", priceId: "price_10", latest_invoice: "in_new" },
    ],
    invoices: [
      { id: "in_old", status: "paid", amount_paid: 15000, payment_intent: "pi_old" },
      { id: "in_new", status: "paid", amount_paid: 15000, payment_intent: "pi_new" },
    ],
    ...over,
  };
}

async function subOf(s: ReturnType<typeof fakeStripe>, id: string): Promise<Stripe.Subscription> {
  return (await s.stripe.subscriptions.retrieve(id)) as unknown as Stripe.Subscription;
}

function created(s: ReturnType<typeof fakeStripe>, db: ReturnType<typeof fakeDb>, sub: Stripe.Subscription, eventType = "customer.subscription.created") {
  return skipDuplicateSubscriptionEvent(db.admin, s.stripe, {
    eventType,
    subscription: sub,
    isGuaranteedRent: false,
    nowSeconds: NOW_S,
  });
}

beforeEach(() => {
  vi.stubEnv("STRIPE_GR_MONTHLY_PRICE_ID", "price_gr_10");
  vi.stubEnv("STRIPE_GR_PRICE_ID_20", "price_gr_20");
  sendDuplicateSubscriptionEmail.mockClear();
  sendDuplicateSubscriptionEmail.mockImplementation(async () => ({ id: "em_1", error: null }));
});
afterEach(() => vi.unstubAllEnvs());

describe("two Management subscriptions on one Stripe customer", () => {
  it("the newer is recorded FIRST, then cancelled, refunded once and reported once", async () => {
    const order: string[] = [];
    const db = fakeDb({ duplicate_subscriptions: [], customers: [] }, {
      ...PK,
      onWrite: (t, op) => order.push(`db:${t}:${op}`),
    });
    const s = fakeStripe(twoSubs(), { onCall: (n) => order.push(`stripe:${n}`) });
    const sub = await subOf(s, "sub_new");

    expect(await created(s, db, sub)).toBe(true);

    const row = db.tables.duplicate_subscriptions[0];
    expect(row).toMatchObject({
      subscription_id: "sub_new",
      kept_subscription_id: "sub_old",
      stripe_customer_id: "cus_1",
      detected_from: "subscription_created",
      invoice_id: "in_new",
      refund_id: "re_dup-refund:in_new",
    });
    expect(row.cancelled_at).toBeTruthy();
    expect(row.emailed_at).toBeTruthy();

    // ⚠️ The record before the cancellation: without it, the deleted event
    // would reach the real customer.
    expect(order.indexOf("db:duplicate_subscriptions:insert")).toBeLessThan(order.indexOf("stripe:subscriptions.cancel"));

    const cancel = s.calls.find((c) => c.name === "subscriptions.cancel");
    expect(cancel).toMatchObject({ args: "sub_new", key: "dup-cancel:sub_new" });
    const refund = s.calls.find((c) => c.name === "refunds.create");
    expect(refund).toMatchObject({ args: { payment_intent: "pi_new" }, key: "dup-refund:in_new" });

    expect(s.state.subscriptions.filter((x) => x.status === "active").map((x) => x.id)).toEqual(["sub_old"]);
    expect(sendDuplicateSubscriptionEmail).toHaveBeenCalledTimes(1);
    expect(sendDuplicateSubscriptionEmail.mock.calls[0][0]).toMatchObject({
      duplicateSubscriptionId: "sub_new",
      keptSubscriptionId: "sub_old",
      email: "Jo@Example.com",
    });
  });

  it("the older one's own events go through untouched", async () => {
    const db = fakeDb({ duplicate_subscriptions: [], customers: [] }, PK);
    const s = fakeStripe(twoSubs());
    expect(await created(s, db, await subOf(s, "sub_old"))).toBe(false);
    expect(db.tables.duplicate_subscriptions).toEqual([]);
    expect(s.calls.some((c) => c.name === "subscriptions.cancel")).toBe(false);
  });

  it("a redelivery neither refunds nor emails twice, and the deleted event is skipped", async () => {
    const db = fakeDb({ duplicate_subscriptions: [], customers: [] }, PK);
    const s = fakeStripe(twoSubs());
    await created(s, db, await subOf(s, "sub_new"));
    await created(s, db, await subOf(s, "sub_new"), "customer.subscription.updated");
    expect(s.calls.filter((c) => c.name === "refunds.create")).toHaveLength(1);
    expect(s.calls.filter((c) => c.name === "subscriptions.cancel")).toHaveLength(1);
    expect(sendDuplicateSubscriptionEmail).toHaveBeenCalledTimes(1);

    // The cancellation's own deleted event: skipped, so the real customer is
    // never marked cancelled, and nothing is called.
    const before = s.calls.length;
    expect(await created(s, db, await subOf(s, "sub_new"), "customer.subscription.deleted")).toBe(true);
    expect(s.calls.slice(before + 1)).toEqual([]);
  });
});

describe("who counts as the same person", () => {
  it("another Stripe customer with the same email, found through our own table", async () => {
    const db = fakeDb({ duplicate_subscriptions: [], customers: [{ email: "jo@example.com", stripe_customer_id: "cus_shared" }] }, PK);
    const s = fakeStripe({
      customers: [
        { id: "cus_link", email: "JO@example.com" },
        { id: "cus_shared", email: "jo@example.com" },
      ],
      subscriptions: [
        { id: "sub_real", customer: "cus_shared", created: NOW_S - 10_000, status: "active", priceId: "price_20" },
        { id: "sub_link", customer: "cus_link", created: NOW_S - 30, status: "active", priceId: "price_10", latest_invoice: "in_link" },
      ],
      invoices: [{ id: "in_link", status: "paid", amount_paid: 13500, payment_intent: "pi_link" }],
    });
    expect(await created(s, db, await subOf(s, "sub_link"))).toBe(true);
    expect(db.tables.duplicate_subscriptions[0]).toMatchObject({ subscription_id: "sub_link", kept_subscription_id: "sub_real" });
  });

  it("a customer leaving at period end may start again: not a duplicate", async () => {
    const db = fakeDb({ duplicate_subscriptions: [], customers: [] }, PK);
    const base = twoSubs();
    base.subscriptions![0].cancel_at_period_end = true;
    const s = fakeStripe(base);
    expect(await created(s, db, await subOf(s, "sub_new"))).toBe(false);
  });

  it("Guaranteed Rent is never checked, and costs no Stripe call", async () => {
    const db = fakeDb({ duplicate_subscriptions: [], customers: [] }, PK);
    const s = fakeStripe(twoSubs());
    const sub = await subOf(s, "sub_new");
    const before = s.calls.length;
    expect(
      await skipDuplicateSubscriptionEvent(db.admin, s.stripe, {
        eventType: "customer.subscription.created",
        subscription: sub,
        isGuaranteedRent: true,
        nowSeconds: NOW_S,
      })
    ).toBe(false);
    expect(s.calls.length).toBe(before);
  });

  it("a GR subscription on the same customer does not make a Management one a duplicate", async () => {
    const db = fakeDb({ duplicate_subscriptions: [], customers: [] }, PK);
    const base = twoSubs();
    base.subscriptions![0].priceId = "price_gr_10";
    const s = fakeStripe(base);
    expect(await created(s, db, await subOf(s, "sub_new"))).toBe(false);
  });
});

describe("the invoice touch point, before any credit", () => {
  it("a duplicate's first invoice arriving first is caught, credits nothing, and that invoice is refunded", async () => {
    const db = fakeDb({ duplicate_subscriptions: [], customers: [] }, PK);
    const s = fakeStripe(twoSubs());
    const invoice = { id: "in_new", billing_reason: "subscription_create" } as Stripe.Invoice;
    expect(await skipDuplicateInvoice(db.admin, s.stripe, { invoice, subscriptionId: "sub_new" })).toBe(true);
    expect(db.tables.duplicate_subscriptions[0]).toMatchObject({ detected_from: "invoice_paid", refund_id: "re_dup-refund:in_new" });
  });

  it("a renewal costs no Stripe call, and a non-duplicate's first invoice goes through", async () => {
    const db = fakeDb({ duplicate_subscriptions: [], customers: [] }, PK);
    const s = fakeStripe(twoSubs());
    const renewal = { id: "in_x", billing_reason: "subscription_cycle" } as Stripe.Invoice;
    expect(await skipDuplicateInvoice(db.admin, s.stripe, { invoice: renewal, subscriptionId: "sub_new" })).toBe(false);
    expect(s.calls).toEqual([]);

    const first = { id: "in_old", billing_reason: "subscription_create" } as Stripe.Invoice;
    expect(await skipDuplicateInvoice(db.admin, s.stripe, { invoice: first, subscriptionId: "sub_old" })).toBe(false);
  });

  it("a refund left pending (unpaid at detection) is issued when the invoice is paid", async () => {
    const db = fakeDb({ duplicate_subscriptions: [], customers: [] }, PK);
    const base = twoSubs();
    base.invoices![1] = { id: "in_new", status: "open", amount_paid: 0, payment_intent: "pi_new" };
    const s = fakeStripe(base);
    await created(s, db, await subOf(s, "sub_new"));
    expect(db.tables.duplicate_subscriptions[0].refund_id ?? null).toBeNull();
    expect(sendDuplicateSubscriptionEmail.mock.calls[0][0]).toMatchObject({ refund: expect.stringMatching(/^Pending/) });

    s.state.invoices[1] = { id: "in_new", status: "paid", amount_paid: 15000, payment_intent: "pi_new" };
    const invoice = { id: "in_new", billing_reason: "subscription_create" } as Stripe.Invoice;
    expect(await skipDuplicateInvoice(db.admin, s.stripe, { invoice, subscriptionId: "sub_new" })).toBe(true);
    expect(db.tables.duplicate_subscriptions[0].refund_id).toBe("re_dup-refund:in_new");
  });
});

describe("never throws, and never cancels without the record", () => {
  it("a record that cannot be written means nothing is cancelled", async () => {
    const db = fakeDb(
      { duplicate_subscriptions: [], customers: [] },
      { ...PK, failInsert: { duplicate_subscriptions: { code: "XX000", message: "down" } } }
    );
    const s = fakeStripe(twoSubs());
    await created(s, db, await subOf(s, "sub_new"));
    expect(s.calls.some((c) => c.name === "subscriptions.cancel")).toBe(false);
    expect(s.calls.some((c) => c.name === "refunds.create")).toBe(false);
  });

  it("a Stripe failure while checking processes the event as normal", async () => {
    const db = fakeDb({ duplicate_subscriptions: [], customers: [] }, PK);
    const s = fakeStripe(twoSubs(), { fail: { "subscriptions.list": new Error("rate limited") } });
    expect(await created(s, db, (await fakeStripe(twoSubs()).stripe.subscriptions.retrieve("sub_new")) as unknown as Stripe.Subscription)).toBe(false);
  });

  it("an unreadable record table processes the event as normal", async () => {
    const db = fakeDb({ duplicate_subscriptions: [] }, { failSelect: { duplicate_subscriptions: { message: "down" } } });
    const s = fakeStripe(twoSubs());
    expect(await created(s, db, await subOf(s, "sub_new"))).toBe(false);
  });

  it("a failed cancel and refund are recorded and named in the email", async () => {
    const db = fakeDb({ duplicate_subscriptions: [], customers: [] }, PK);
    const s = fakeStripe(twoSubs(), {
      fail: { "subscriptions.cancel": new Error("nope"), "refunds.create": new Error("charge disputed") },
    });
    expect(await created(s, db, await subOf(s, "sub_new"))).toBe(true);
    const row = db.tables.duplicate_subscriptions[0];
    expect(row.cancelled_at ?? null).toBeNull();
    expect(String(row.error)).toMatch(/cancel failed.*refund failed/);
    expect(sendDuplicateSubscriptionEmail.mock.calls[0][0]).toMatchObject({ cancelled: "Not cancelled", error: expect.stringMatching(/charge disputed/) });
  });

  it("the email claim is conditional: a delivery that loses the race sends nothing", async () => {
    // Two deliveries both read the record with emailed_at still null; the
    // other one claims the email while this one is talking to Stripe.
    const db = fakeDb({ duplicate_subscriptions: [], customers: [] }, PK);
    const s = fakeStripe(twoSubs(), {
      onCall: (n) => {
        if (n === "refunds.create") db.tables.duplicate_subscriptions[0].emailed_at = "2026-10-09T10:00:00Z";
      },
    });
    expect(await created(s, db, await subOf(s, "sub_new"))).toBe(true);
    expect(sendDuplicateSubscriptionEmail).not.toHaveBeenCalled();
    expect(db.tables.duplicate_subscriptions[0].emailed_at).toBe("2026-10-09T10:00:00Z");
  });

  it("a failed email releases its claim, so a later event sends it", async () => {
    const db = fakeDb({ duplicate_subscriptions: [], customers: [] }, PK);
    const s = fakeStripe(twoSubs());
    sendDuplicateSubscriptionEmail.mockImplementationOnce(async () => ({ id: null, error: new Error("resend down") }));
    await created(s, db, await subOf(s, "sub_new"));
    expect(db.tables.duplicate_subscriptions[0].emailed_at).toBeNull();
    await created(s, db, await subOf(s, "sub_new"), "customer.subscription.updated");
    expect(sendDuplicateSubscriptionEmail).toHaveBeenCalledTimes(2);
    expect(db.tables.duplicate_subscriptions[0].emailed_at).toBeTruthy();
  });
});
