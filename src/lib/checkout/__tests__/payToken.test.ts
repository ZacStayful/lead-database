import { afterEach, describe, expect, it, vi } from "vitest";
import { computeCheckoutUrls, derivePayToken, payPath, verifyPayToken } from "@/lib/checkout/payToken";
import { deriveFunnelSummaryToken } from "@/lib/funnel/token";

const SECRET = "test-secret";
const OFFER = "11111111-2222-4333-8444-555555555555";

describe("the /pay token (02 Phase 4)", () => {
  it("round-trips to the offer it was made for", () => {
    const token = derivePayToken(OFFER, SECRET)!;
    expect(token.startsWith(`${OFFER}.`)).toBe(true);
    expect(verifyPayToken(token, SECRET)).toBe(OFFER);
  });

  it("refuses a tampered token, another secret, and no secret at all", () => {
    const token = derivePayToken(OFFER, SECRET)!;
    const other = "99999999-2222-4333-8444-555555555555";
    expect(verifyPayToken(`${other}${token.slice(OFFER.length)}`, SECRET)).toBeNull();
    expect(verifyPayToken(`${token.slice(0, -1)}A`, SECRET)).toBeNull();
    expect(verifyPayToken(token, "another-secret")).toBeNull();
    expect(verifyPayToken(token, null)).toBeNull();
    expect(derivePayToken(OFFER, null)).toBeNull();
    expect(derivePayToken("not-a-uuid", SECRET)).toBeNull();
  });

  it("cannot be swapped with the funnel's partner token (different domains)", () => {
    const summary = deriveFunnelSummaryToken(OFFER, SECRET)!;
    expect(verifyPayToken(summary, SECRET)).toBeNull();
  });

  it("carries the plan in the query string", () => {
    expect(payPath("t", 10)).toBe("/pay/t?plan=10");
    expect(payPath("t")).toBe("/pay/t");
  });
});

describe("computeCheckoutUrls: post-call links go through /pay now", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns both plans' /pay links, with no Stripe Payment Link and no prefilled code", () => {
    vi.stubEnv("MESSAGING_TOKEN_SECRET", SECRET);
    vi.stubEnv("STRIPE_MANAGEMENT_10_PAYMENT_LINK_URL", "https://buy.stripe.com/ten");
    vi.stubEnv("STRIPE_MANAGEMENT_20_PAYMENT_LINK_URL", "https://buy.stripe.com/twenty");
    const urls = computeCheckoutUrls(OFFER);
    const token = derivePayToken(OFFER, SECRET)!;
    expect(urls.checkout_url_10.endsWith(`/pay/${token}?plan=10`)).toBe(true);
    expect(urls.checkout_url_20.endsWith(`/pay/${token}?plan=20`)).toBe(true);
    for (const u of Object.values(urls)) {
      expect(u).not.toContain("buy.stripe.com");
      expect(u).not.toContain("prefilled_promo_code");
    }
  });

  it("throws without the secret, so no unusable link is ever handed out", () => {
    vi.stubEnv("MESSAGING_TOKEN_SECRET", "");
    expect(() => computeCheckoutUrls(OFFER)).toThrow(/MESSAGING_TOKEN_SECRET/);
  });
});
