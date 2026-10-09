import { beforeEach, describe, expect, it, vi } from "vitest";

const { briefRoutingEnabled, startManagementCheckout } = vi.hoisted(() => ({
  briefRoutingEnabled: vi.fn(async () => true),
  startManagementCheckout: vi.fn(async (_a: unknown, _i: Record<string, unknown>) => ({
    status: "checkout",
    url: "https://checkout.stripe.test/s1",
    checkoutSessionId: "cs_1",
    reused: false,
    stripeCustomerId: "cus_1",
    customerId: "c1",
    discountApplied: true,
  }) as Record<string, unknown>),
}));
vi.mock("@/lib/leadBrief/routing", () => ({ briefRoutingEnabled }));
vi.mock("@/lib/checkout/startManagementCheckout", () => ({ startManagementCheckout }));

import { startFunnelCheckout } from "@/lib/funnel/checkout";
import type { FunnelSessionRow } from "@/lib/funnel/server";
import { fakeDb } from "@/lib/checkout/__tests__/fakes";

/** The funnel's payment, shared by its route and a funnel offer's /pay link (02 Phases 4 and 5). */

function session(over: Partial<FunnelSessionRow> = {}): FunnelSessionRow & Record<string, unknown> {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    name: "Jo Bloggs",
    email: "jo@example.com",
    phone: "+447700900123",
    monday_item_id: null,
    answers: {},
    base_postcode_locked: "YO10 5DD",
    preview_snapshot: { plans: [] },
    plan_selected: null,
    step: "previewed",
    customer_id: null,
    discount_offer_id: "o1",
    paid_at: null,
    ...over,
  };
}

beforeEach(() => {
  briefRoutingEnabled.mockClear();
  briefRoutingEnabled.mockImplementation(async () => true);
  startManagementCheckout.mockClear();
});

describe("startFunnelCheckout", () => {
  it("pays as the funnel, for the person on the session, with their code, and records checkout_started", async () => {
    const db = fakeDb({ funnel_sessions: [session()] });
    const r = await startFunnelCheckout(db.admin, session(), 20, "https://x/cancel");
    expect(r).toEqual({ status: "checkout", url: "https://checkout.stripe.test/s1" });
    expect(startManagementCheckout.mock.calls[0][1]).toMatchObject({
      email: "jo@example.com",
      phone: "+447700900123",
      name: "Jo Bloggs",
      plan: 20,
      source: "funnel",
      funnelSessionId: "11111111-2222-4333-8444-555555555555",
      discountOfferId: "o1",
      cancelUrl: "https://x/cancel",
    });
    expect(db.tables.funnel_sessions[0]).toMatchObject({ step: "checkout_started", checkout_session_id: "cs_1", plan_selected: 20, customer_id: "c1" });
  });

  it("refuses before a preview, and while brief routing is off, without opening a checkout", async () => {
    const db = fakeDb({ funnel_sessions: [session()] });
    expect(await startFunnelCheckout(db.admin, session({ preview_snapshot: null }), 10, "")).toEqual({ status: "refused", code: "preview_required" });
    briefRoutingEnabled.mockImplementation(async () => false);
    expect(await startFunnelCheckout(db.admin, session(), 10, "")).toEqual({ status: "refused", code: "payment_not_open" });
    expect(startManagementCheckout).not.toHaveBeenCalled();
    expect(db.writes).toHaveLength(0);
  });

  it("never moves a paid session back", async () => {
    const db = fakeDb({ funnel_sessions: [session({ step: "paid", paid_at: "2026-10-09T12:00:00Z" })] });
    await startFunnelCheckout(db.admin, session(), 10, "");
    expect(db.tables.funnel_sessions[0].step).toBe("paid");
  });

  it("an existing customer is sent to log in, and nothing is recorded", async () => {
    startManagementCheckout.mockImplementationOnce(async () => ({ status: "already_customer", loginUrl: "https://x/login" }));
    const db = fakeDb({ funnel_sessions: [session()] });
    expect(await startFunnelCheckout(db.admin, session(), 10, "")).toEqual({ status: "already_customer", loginUrl: "https://x/login" });
    expect(db.writes).toHaveLength(0);
  });

  it("a session with no code of its own lets the door find the person's live one", async () => {
    const db = fakeDb({ funnel_sessions: [session()] });
    await startFunnelCheckout(db.admin, session({ discount_offer_id: null }), 10, "");
    expect(startManagementCheckout.mock.calls[0][1].discountOfferId).toBeUndefined();
  });
});
