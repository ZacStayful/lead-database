import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { fakeDb } from "@/lib/checkout/__tests__/fakes";
import {
  FUNNEL_DISCOUNT_AFTER_MS,
  FUNNEL_DISCOUNT_WINDOW_MS,
  funnelDiscountDue,
  issueFunnelDiscounts,
  type DiscountCandidate,
} from "@/lib/funnel/discount";
import { issuePostCallOffer } from "@/lib/postCallOfferIssue";

/**
 * The funnel's discount (02 Phase 5): the doc's check is "only one discount
 * code exists per person", across both routes.
 */

const NOW = new Date("2026-10-09T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const at = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();

function session(over: Partial<DiscountCandidate> = {}): DiscountCandidate & Record<string, unknown> {
  return {
    id: "s1",
    name: "Jo Bloggs",
    email: "jo@example.com",
    phone: "+447700900123",
    step: "previewed",
    updated_at: at(2 * HOUR),
    paid_at: null,
    discount_offer_id: null,
    ...over,
  };
}

function offer(over: Record<string, unknown> = {}) {
  return {
    id: "o1",
    prospect_email: "jo@example.com",
    prospect_name: "Jo",
    prospect_phone: null,
    stripe_promo_code_id: "promo_old",
    promo_code_string: "FOUNDING10-OLD1",
    expires_at: at(-10 * HOUR),
    redeemed_at: null,
    source: "auto_monday",
    reminder_12h_sent_at: "2026-10-08T00:00:00Z",
    reminder_4h_sent_at: null,
    reminder_1h_sent_at: null,
    ...over,
  };
}

function stripeStub(opts: { fail?: Error; onCreate?: () => void } = {}) {
  let n = 0;
  const create = vi.fn(async (p: { code: string }) => {
    opts.onCreate?.();
    if (opts.fail) throw opts.fail;
    n += 1;
    return { id: `promo_new${n}`, code: p.code };
  });
  return { stripe: { promotionCodes: { create } } as unknown as Stripe, create };
}

beforeEach(() => vi.stubEnv("STRIPE_POST_CALL_COUPON_ID", "coupon_1"));
afterEach(() => vi.unstubAllEnvs());

describe("who is due a code", () => {
  it("previewed or at checkout, unpaid, uncoded, quiet between an hour and a week", () => {
    expect(funnelDiscountDue(session(), NOW)).toBe(true);
    expect(funnelDiscountDue(session({ step: "checkout_started" }), NOW)).toBe(true);
    expect(funnelDiscountDue(session({ updated_at: at(FUNNEL_DISCOUNT_AFTER_MS) }), NOW)).toBe(true);
    expect(funnelDiscountDue(session({ updated_at: at(FUNNEL_DISCOUNT_AFTER_MS - 1) }), NOW)).toBe(false);
    expect(funnelDiscountDue(session({ updated_at: at(FUNNEL_DISCOUNT_WINDOW_MS + 1) }), NOW)).toBe(false);
    expect(funnelDiscountDue(session({ step: "questions_done" }), NOW)).toBe(false);
    expect(funnelDiscountDue(session({ step: "paid", paid_at: at(HOUR) }), NOW)).toBe(false);
    expect(funnelDiscountDue(session({ discount_offer_id: "o9" }), NOW)).toBe(false);
  });
});

describe("issuing", () => {
  it("a quiet previewer gets a funnel code, linked to their session", async () => {
    const db = fakeDb({ funnel_sessions: [session()], post_call_offers: [], customers: [] });
    const s = stripeStub();
    const run = await issueFunnelDiscounts(db.admin, { now: NOW, stripe: s.stripe });
    expect(run).toMatchObject({ ok: true, checked: 1, issued: 1, linkedExisting: 0 });
    expect(db.tables.post_call_offers).toHaveLength(1);
    expect(db.tables.post_call_offers[0]).toMatchObject({ prospect_email: "jo@example.com", source: "funnel", stripe_promo_code_id: "promo_new1" });
    expect(String(db.tables.post_call_offers[0].promo_code_string)).toMatch(/^FOUNDING10-[A-Z2-9]{4}$/);
    expect(s.create.mock.calls[0][0]).toMatchObject({ coupon: "coupon_1", max_redemptions: 1 });
    expect(db.tables.funnel_sessions[0].discount_offer_id).toBe(db.tables.post_call_offers[0].id ?? null);
  });

  it("nobody quiet for under an hour, gone for over a week, paid or already coded is touched", async () => {
    const db = fakeDb({
      funnel_sessions: [
        session({ id: "fresh", updated_at: at(30 * 60 * 1000) }),
        session({ id: "stale", updated_at: at(8 * 24 * HOUR) }),
        session({ id: "paid", step: "paid", paid_at: at(HOUR) }),
        session({ id: "coded", discount_offer_id: "o9" }),
      ],
      post_call_offers: [],
      customers: [],
    });
    const s = stripeStub();
    const run = await issueFunnelDiscounts(db.admin, { now: NOW, stripe: s.stripe });
    expect(run.checked).toBe(0);
    expect(s.create).not.toHaveBeenCalled();
    expect(db.writes).toHaveLength(0);
  });

  // The code expires 10 hours after NOW and the real clock is long past that,
  // so this only passes when the pass hands its clock to issuePostCallOffer.
  it("ONE CODE PER PERSON: a live call-route code is linked, never doubled", async () => {
    const db = fakeDb({ funnel_sessions: [session()], post_call_offers: [offer()], customers: [] });
    const s = stripeStub();
    const run = await issueFunnelDiscounts(db.admin, { now: NOW, stripe: s.stripe });
    expect(run).toMatchObject({ issued: 0, linkedExisting: 1 });
    expect(s.create).not.toHaveBeenCalled();
    expect(db.tables.post_call_offers).toHaveLength(1);
    expect(db.tables.post_call_offers[0].source).toBe("auto_monday");
    expect(db.tables.funnel_sessions[0].discount_offer_id).toBe("o1");
  });

  it("an expired, unused code is replaced in place, so there is still one row", async () => {
    const db = fakeDb({ funnel_sessions: [session()], post_call_offers: [offer({ expires_at: at(HOUR) })], customers: [] });
    const s = stripeStub();
    const run = await issueFunnelDiscounts(db.admin, { now: NOW, stripe: s.stripe });
    expect(run.issued).toBe(1);
    expect(db.tables.post_call_offers).toHaveLength(1);
    expect(db.tables.post_call_offers[0]).toMatchObject({ id: "o1", source: "funnel", stripe_promo_code_id: "promo_new1", reminder_12h_sent_at: null });
    expect(db.tables.funnel_sessions[0].discount_offer_id).toBe("o1");
  });

  it("somebody already set up on Management is never offered one", async () => {
    const db = fakeDb({
      funnel_sessions: [session()],
      post_call_offers: [],
      customers: [{ id: "c1", email: "jo@example.com", account_status: "active", subscription_status: "active", gr_subscription_status: null }],
    });
    const s = stripeStub();
    const run = await issueFunnelDiscounts(db.admin, { now: NOW, stripe: s.stripe });
    expect(run.skippedCustomers).toBe(1);
    expect(s.create).not.toHaveBeenCalled();
    expect(db.tables.funnel_sessions[0].discount_offer_id).toBeNull();
  });

  it("a session that paid while its code was being made keeps no code", async () => {
    const db = fakeDb({ funnel_sessions: [session()], post_call_offers: [], customers: [] });
    const s = stripeStub({
      onCreate: () => Object.assign(db.tables.funnel_sessions[0], { step: "paid", paid_at: NOW.toISOString() }),
    });
    await issueFunnelDiscounts(db.admin, { now: NOW, stripe: s.stripe });
    expect(db.tables.funnel_sessions[0].discount_offer_id).toBeNull();
  });

  it("a Stripe failure links nothing, and the run carries on", async () => {
    const db = fakeDb({ funnel_sessions: [session()], post_call_offers: [], customers: [] });
    const s = stripeStub({ fail: new Error("rate limited") });
    const run = await issueFunnelDiscounts(db.admin, { now: NOW, stripe: s.stripe });
    expect(run).toMatchObject({ ok: true, failed: 1, issued: 0 });
    expect(db.tables.funnel_sessions[0].discount_offer_id).toBeNull();
  });

  it("a dry run lists who would get one and writes nothing", async () => {
    const db = fakeDb({ funnel_sessions: [session()], post_call_offers: [], customers: [] });
    const s = stripeStub();
    const run = await issueFunnelDiscounts(db.admin, { now: NOW, stripe: s.stripe, dryRun: true });
    expect(run.wouldIssue).toEqual(["s1"]);
    expect(s.create).not.toHaveBeenCalled();
    expect(db.writes).toHaveLength(0);
  });

  it("an unreadable session table is a failed run, not an empty one", async () => {
    const db = fakeDb({ funnel_sessions: [session()] }, { failSelect: { funnel_sessions: { message: "down" } } });
    const run = await issueFunnelDiscounts(db.admin, { now: NOW, stripe: stripeStub().stripe });
    expect(run).toMatchObject({ ok: false, error: "sessions_unreadable" });
  });
});

describe("the shared issuer (postCallOfferIssue.ts)", () => {
  const input = { email: "jo@example.com", name: "Jo", phone: null, source: "manual" as const, createdBy: "admin_1" };

  it("returns a live code unchanged", async () => {
    const db = fakeDb({ post_call_offers: [offer()] });
    const s = stripeStub();
    expect(await issuePostCallOffer(db.admin, input, { stripe: s.stripe, now: () => NOW.getTime() })).toEqual({
      ok: true,
      status: "existing",
      offerId: "o1",
      promoCode: "FOUNDING10-OLD1",
    });
    expect(s.create).not.toHaveBeenCalled();
  });

  it("a lost race returns the winner, not an error", async () => {
    const db = fakeDb({ post_call_offers: [] }, { primaryKeys: { post_call_offers: "prospect_email" } });
    const s = stripeStub({
      // Another request inserts the live code between the check and the insert.
      onCreate: () => db.tables.post_call_offers.push(offer({ id: "o_winner", promo_code_string: "FOUNDING10-WIN1" })),
    });
    expect(await issuePostCallOffer(db.admin, input, { stripe: s.stripe, now: () => NOW.getTime() })).toMatchObject({
      ok: true,
      status: "existing",
      offerId: "o_winner",
    });
    expect(db.tables.post_call_offers).toHaveLength(1);
  });

  it("a Stripe failure writes nothing", async () => {
    const db = fakeDb({ post_call_offers: [] });
    const r = await issuePostCallOffer(db.admin, input, { stripe: stripeStub({ fail: new Error("nope") }).stripe });
    expect(r).toMatchObject({ ok: false, reason: "stripe_failed", message: "nope" });
    expect(db.writes).toHaveLength(0);
  });

  it("a failed write names the orphaned Stripe code", async () => {
    const db = fakeDb({ post_call_offers: [] }, { failInsert: { post_call_offers: { code: "XX000", message: "down" } } });
    const r = await issuePostCallOffer(db.admin, input, { stripe: stripeStub().stripe });
    expect(r).toMatchObject({ ok: false, reason: "db_failed", orphanedPromoCodeId: "promo_new1" });
  });
});
