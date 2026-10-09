import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import {
  OPEN_SESSION_MIN_REMAINING_SECONDS,
  buildCheckoutSessionParams,
  checkoutPlanFromParam,
  chooseOpenSession,
  duplicateVerdict,
  existingCustomerVerdict,
  isCheckoutPlan,
  openSessionView,
  shouldCheckForDuplicate,
  usableOffer,
  type CustomerCandidate,
  type OfferRow,
  type OpenSessionView,
  type SubscriptionView,
} from "@/lib/checkout/rules";

/**
 * The guarded checkout's decisions (batch 02 Phase 4): who is already a
 * customer, which discount applies, which open checkout is handed back, and
 * which of two subscriptions the webhook cancels. Each is a way somebody could
 * be charged twice, so each branch is pinned here.
 */

function row(over: Partial<CustomerCandidate> = {}): CustomerCandidate {
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
    ...over,
  };
}

describe("plans", () => {
  it("accepts 10 and 20 only", () => {
    expect(isCheckoutPlan(10)).toBe(true);
    expect(isCheckoutPlan(20)).toBe(true);
    expect(isCheckoutPlan(15)).toBe(false);
    expect(isCheckoutPlan("10")).toBe(false);
    expect(checkoutPlanFromParam("20")).toBe(20);
    expect(checkoutPlanFromParam(["10", "20"])).toBe(10);
    expect(checkoutPlanFromParam("30")).toBeNull();
    expect(checkoutPlanFromParam(undefined)).toBeNull();
  });
});

describe("existingCustomerVerdict (C5)", () => {
  it("an active Management customer by email gets the login link", () => {
    const v = existingCustomerVerdict({ byEmail: [row({ account_status: "active" })], byPhone: [], name: "Jo" });
    expect(v).toEqual({ kind: "already_customer", customerId: "c1", matchedBy: "email" });
  });

  it("a past-due one does too: they have a card to fix, not a plan to buy", () => {
    const v = existingCustomerVerdict({
      byEmail: [row({ account_status: "active", subscription_status: "past_due" })],
      byPhone: [],
      name: "Jo",
    });
    expect(v.kind).toBe("already_customer");
  });

  it("a live subscription counts even when account_status lags behind it (holdsProduct, never account_status alone)", () => {
    // A row left at 'cancelled' or 'waitlisted' while Stripe says active or
    // past due (§23.9): still paying, so a second checkout would bill twice.
    for (const over of [
      { account_status: "cancelled", subscription_status: "active" },
      { account_status: "waitlisted", subscription_status: "past_due" },
    ]) {
      const v = existingCustomerVerdict({ byEmail: [row(over)], byPhone: [], name: "Jo" });
      expect(v.kind).toBe("already_customer");
    }
  });

  it("a waitlisted enquirer, a cancelled customer and a GR-only customer may pay, on their own row", () => {
    for (const over of [
      { account_status: "waitlisted" },
      { account_status: "cancelled", subscription_status: "canceled" },
      { account_status: "waitlisted", gr_subscription_status: "active" },
    ]) {
      const v = existingCustomerVerdict({ byEmail: [row(over)], byPhone: [], name: "Jo" });
      expect(v.kind).toBe("proceed");
      if (v.kind === "proceed") expect(v.reuse?.id).toBe("c1");
    }
  });

  it("a stranger has no row to reuse", () => {
    const v = existingCustomerVerdict({ byEmail: [], byPhone: [], name: "Sam" });
    expect(v).toEqual({ kind: "proceed", reuse: null, possibleDuplicates: [] });
  });

  it("a phone match blocks only when the name agrees too", () => {
    const holder = row({ id: "other", email: "boss@example.com", account_status: "active", contact_name: "Jo Bloggs" });
    const same = existingCustomerVerdict({ byEmail: [], byPhone: [holder], name: "  jo   BLOGGS " });
    expect(same).toEqual({ kind: "already_customer", customerId: "other", matchedBy: "phone_and_name" });

    // Matching on the business name counts as the same person as well.
    const byBusiness = existingCustomerVerdict({ byEmail: [], byPhone: [holder], name: "Bloggs Lettings" });
    expect(byBusiness.kind).toBe("already_customer");
  });

  it("a phone match under another name proceeds, and is reported (never merged)", () => {
    const holder = row({ id: "other", email: "boss@example.com", account_status: "active", contact_name: "Pat Smith", business_name: "Smith Co" });
    const v = existingCustomerVerdict({ byEmail: [], byPhone: [holder], name: "Jo Bloggs" });
    expect(v.kind).toBe("proceed");
    if (v.kind === "proceed") expect(v.possibleDuplicates.map((d) => d.id)).toEqual(["other"]);
  });

  it("a phone match that does not hold Management is ignored entirely", () => {
    const enquirer = row({ id: "other", email: "x@example.com", contact_name: "Jo Bloggs" });
    const v = existingCustomerVerdict({ byEmail: [], byPhone: [enquirer], name: "Jo Bloggs" });
    expect(v).toEqual({ kind: "proceed", reuse: null, possibleDuplicates: [] });
  });

  it("the person's own row matched by phone is not a second person", () => {
    const own = row({ account_status: "waitlisted" });
    const v = existingCustomerVerdict({ byEmail: [own], byPhone: [own], name: "Someone Else" });
    expect(v).toEqual({ kind: "proceed", reuse: own, possibleDuplicates: [] });
  });

  it("prefers a live row to an archived one", () => {
    const archived = row({ id: "old", is_active: false });
    const live = row({ id: "new" });
    const v = existingCustomerVerdict({ byEmail: [archived, live], byPhone: [], name: "Jo" });
    expect(v.kind === "proceed" && v.reuse?.id).toBe("new");
  });
});

describe("usableOffer", () => {
  const now = new Date("2026-10-09T12:00:00Z");
  const offer: OfferRow = {
    id: "o1",
    prospect_email: "jo@example.com",
    stripe_promo_code_id: "promo_1",
    promo_code_string: "FOUNDING10-ABCD",
    expires_at: "2026-10-10T10:00:00Z",
    redeemed_at: null,
  };

  it("applies a live code made for this email", () => {
    expect(usableOffer(offer, "JO@example.com ", now)).toEqual({
      offerId: "o1",
      promoCodeId: "promo_1",
      code: "FOUNDING10-ABCD",
    });
  });

  it("never applies a redeemed, expired or somebody else's code", () => {
    expect(usableOffer({ ...offer, redeemed_at: "2026-10-09T11:00:00Z" }, "jo@example.com", now)).toBeNull();
    expect(usableOffer({ ...offer, expires_at: "2026-10-09T12:00:00Z" }, "jo@example.com", now)).toBeNull();
    expect(usableOffer(offer, "sam@example.com", now)).toBeNull();
    expect(usableOffer({ ...offer, stripe_promo_code_id: "" }, "jo@example.com", now)).toBeNull();
    expect(usableOffer(null, "jo@example.com", now)).toBeNull();
  });
});

describe("chooseOpenSession: one open checkout at a time", () => {
  const nowSeconds = 1_800_000_000;
  const mgmt = ["price_10", "price_20"];
  const s = (over: Partial<OpenSessionView>): OpenSessionView => ({
    id: "cs_1",
    url: "https://checkout.stripe.com/c/cs_1",
    priceIds: ["price_10"],
    promoCodeId: "",
    expiresAt: nowSeconds + 3600,
    ...over,
  });

  it("hands back the open session that fits, so a second tab gets the same one", () => {
    const want = { priceId: "price_10", promoCodeId: null, managementPriceIds: mgmt, nowSeconds };
    expect(chooseOpenSession([s({})], want)).toEqual({ reuse: s({}), expire: [] });
  });

  it("expires a session for the other plan or another discount, so only one can be paid", () => {
    const want = { priceId: "price_20", promoCodeId: "promo_1", managementPriceIds: mgmt, nowSeconds };
    const other = s({ id: "cs_10" });
    const noCode = s({ id: "cs_20_nocode", priceIds: ["price_20"] });
    expect(chooseOpenSession([other, noCode], want)).toEqual({ reuse: null, expire: ["cs_10", "cs_20_nocode"] });
  });

  it("matches the discount it was created with", () => {
    const want = { priceId: "price_20", promoCodeId: "promo_1", managementPriceIds: mgmt, nowSeconds };
    const fits = s({ id: "cs_ok", priceIds: ["price_20"], promoCodeId: "promo_1" });
    expect(chooseOpenSession([fits], want).reuse?.id).toBe("cs_ok");
  });

  it("never touches a session that is not Management", () => {
    const want = { priceId: "price_10", promoCodeId: null, managementPriceIds: mgmt, nowSeconds };
    const topup = s({ id: "cs_topup", priceIds: [] });
    const gr = s({ id: "cs_gr", priceIds: ["price_gr_10"] });
    expect(chooseOpenSession([topup, gr], want)).toEqual({ reuse: null, expire: [] });
  });

  it("does not hand over a session about to expire, nor one with no url, and keeps only one", () => {
    const want = { priceId: "price_10", promoCodeId: null, managementPriceIds: mgmt, nowSeconds };
    const late = s({ id: "cs_late", expiresAt: nowSeconds + OPEN_SESSION_MIN_REMAINING_SECONDS - 1 });
    const blank = s({ id: "cs_blank", url: null });
    const first = s({ id: "cs_first" });
    const second = s({ id: "cs_second" });
    expect(chooseOpenSession([late, blank, first, second], want)).toEqual({
      reuse: first,
      expire: ["cs_late", "cs_blank", "cs_second"],
    });
  });

  it("reads Stripe's session shape", () => {
    const view = openSessionView({
      id: "cs_x",
      url: "https://checkout.stripe.com/c/cs_x",
      expires_at: 123,
      metadata: { promo_code_id: "promo_9" },
      line_items: { data: [{ price: { id: "price_20" } }] },
    } as unknown as Stripe.Checkout.Session);
    expect(view).toEqual({
      id: "cs_x",
      url: "https://checkout.stripe.com/c/cs_x",
      priceIds: ["price_20"],
      promoCodeId: "promo_9",
      expiresAt: 123,
    });
  });
});

describe("buildCheckoutSessionParams", () => {
  const base = {
    stripeCustomerId: "cus_1",
    priceId: "price_10",
    plan: 10 as const,
    source: "funnel" as const,
    promoCodeId: null,
    offerId: null,
    funnelSessionId: "fs_1",
    customerId: "c1",
    successUrl: "https://x/ok",
    cancelUrl: "https://x/back",
  };

  it("is a Management subscription for this customer, tagged with where it came from", () => {
    const p = buildCheckoutSessionParams(base);
    expect(p.mode).toBe("subscription");
    expect(p.customer).toBe("cus_1");
    expect(p.line_items).toEqual([{ price: "price_10", quantity: 1 }]);
    expect(p.client_reference_id).toBe("fs_1");
    expect(p.subscription_data?.metadata).toEqual({
      source: "funnel",
      plan: "10",
      funnel_session_id: "fs_1",
      supabase_customer_id: "c1",
    });
    expect(p.metadata).toMatchObject({ source: "funnel", guarded_checkout: "1", promo_code_id: "" });
  });

  it("applies the code, or lets one be typed, never both", () => {
    const withCode = buildCheckoutSessionParams({ ...base, source: "call", promoCodeId: "promo_1", offerId: "o1", funnelSessionId: null });
    expect(withCode.discounts).toEqual([{ promotion_code: "promo_1" }]);
    expect(withCode.allow_promotion_codes).toBeUndefined();
    expect(withCode.metadata).toMatchObject({ promo_code_id: "promo_1", offer_id: "o1" });
    expect(withCode.client_reference_id).toBeUndefined();

    const without = buildCheckoutSessionParams(base);
    expect(without.discounts).toBeUndefined();
    expect(without.allow_promotion_codes).toBe(true);
  });
});

describe("duplicateVerdict (C3): the newer subscription goes", () => {
  const sub = (over: Partial<SubscriptionView>): SubscriptionView => ({
    id: "sub_a",
    created: 1000,
    status: "active",
    cancelAtPeriodEnd: false,
    isManagement: true,
    ...over,
  });
  const none = new Set<string>();

  it("the newer one is the duplicate, the older is kept", () => {
    const older = sub({ id: "sub_old", created: 1000 });
    expect(duplicateVerdict({ id: "sub_new", created: 2000 }, [older], none)).toEqual({ duplicate: true, keptId: "sub_old" });
  });

  it("gives the same answer from the older one's side", () => {
    const newer = sub({ id: "sub_new", created: 2000 });
    expect(duplicateVerdict({ id: "sub_old", created: 1000 }, [newer], none)).toEqual({ duplicate: false });
  });

  it("breaks a same-second tie by id, consistently from both sides", () => {
    expect(duplicateVerdict({ id: "sub_b", created: 1000 }, [sub({ id: "sub_a" })], none)).toEqual({ duplicate: true, keptId: "sub_a" });
    expect(duplicateVerdict({ id: "sub_a", created: 1000 }, [sub({ id: "sub_b" })], none)).toEqual({ duplicate: false });
  });

  it("keeps the OLDEST when there are several", () => {
    const v = duplicateVerdict(
      { id: "sub_new", created: 3000 },
      [sub({ id: "sub_mid", created: 2000 }), sub({ id: "sub_old", created: 1000 })],
      none
    );
    expect(v).toEqual({ duplicate: true, keptId: "sub_old" });
  });

  it("past-due still counts: that customer is being billed for Management", () => {
    expect(duplicateVerdict({ id: "sub_new", created: 2000 }, [sub({ status: "past_due" })], none).duplicate).toBe(true);
  });

  it("ignores Guaranteed Rent, a leaving customer, a dead subscription and a recorded duplicate", () => {
    const self = { id: "sub_new", created: 2000 };
    expect(duplicateVerdict(self, [sub({ isManagement: false })], none).duplicate).toBe(false);
    expect(duplicateVerdict(self, [sub({ cancelAtPeriodEnd: true })], none).duplicate).toBe(false);
    for (const status of ["canceled", "incomplete", "incomplete_expired", "unpaid", "paused"]) {
      expect(duplicateVerdict(self, [sub({ status })], none).duplicate).toBe(false);
    }
    expect(duplicateVerdict(self, [sub({ id: "sub_dup" })], new Set(["sub_dup"])).duplicate).toBe(false);
  });

  it("never calls a subscription a duplicate of itself", () => {
    expect(duplicateVerdict({ id: "sub_a", created: 2000 }, [sub({ id: "sub_a", created: 1000 })], none).duplicate).toBe(false);
  });
});

describe("shouldCheckForDuplicate", () => {
  const now = 1_800_000_000;
  it("checks every created event, and an updated one only while the subscription is new", () => {
    expect(shouldCheckForDuplicate("customer.subscription.created", now - 999_999, now)).toBe(true);
    expect(shouldCheckForDuplicate("customer.subscription.updated", now - 3600, now)).toBe(true);
    expect(shouldCheckForDuplicate("customer.subscription.updated", now - 25 * 3600, now)).toBe(false);
    expect(shouldCheckForDuplicate("customer.subscription.deleted", now, now)).toBe(false);
  });
});
