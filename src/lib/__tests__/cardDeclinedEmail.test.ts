import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send };
  },
}));

import { sendCardDeclinedEmail } from "@/lib/emails";

/**
 * The rendered email. Pure — Resend is mocked, so nothing leaves the process.
 *
 * These assert the two things that are invisible in a code review and only show
 * up in an inbox: that no merchant-facing string escapes into the markup, and
 * that the prose never points at a button that is not there.
 */
const render = async (over: Partial<Parameters<typeof sendCardDeclinedEmail>[0]> = {}) => {
  send.mockClear();
  send.mockResolvedValue({ data: { id: "resend_1" }, error: null });
  await sendCardDeclinedEmail({
    to: "ann@example.com",
    contactName: "Emily Kitts",
    productName: "Management leads",
    reasonKey: "insufficient_funds",
    amountDuePence: 15000,
    currency: "gbp",
    cardBrand: "Visa",
    cardLast4: "4242",
    hostedInvoiceUrl: "https://pay.stripe.com/i/abc",
    nextAttemptIso: "2026-09-12T00:00:00Z",
    ...over,
  });
  return send.mock.calls[0][0] as { subject: string; html: string; to: string };
};

beforeEach(() => {
  process.env.RESEND_API_KEY = "re_test";
});

describe("sendCardDeclinedEmail", () => {
  it("leads with the reason and names the product and card", async () => {
    const { html } = await render();
    expect(html).toContain("There weren&#39;t enough funds on the card".replace("&#39;", "'"));
    expect(html).toContain("Management leads");
    expect(html).toContain("Visa ending");
    expect(html).toContain("4242");
    expect(html).toContain("£150");
  });

  /**
   * ⚠️ past_due DOES stop delivery — all three candidate functions require
   * subscription_status = 'active'. The copy must say leads are paused, and
   * must not claim anything has been taken away.
   */
  it("states the lead consequence accurately", async () => {
    const { html } = await render();
    expect(html).toContain("New leads are paused");
    expect(html).toContain("Nothing has been taken away");
    expect(html).toMatch(/credits you have left are kept/i);
  });

  it("promotes the settings link when there is no invoice to pay", async () => {
    const withLink = await render();
    const without = await render({ hostedInvoiceUrl: null });
    expect(withLink.html).toContain("Pay this invoice");
    // Never a dead button.
    expect(without.html).not.toContain("Pay this invoice");
    expect(without.html).not.toContain('href="null"');
    expect(without.html).toContain("Update your card");
  });

  /** The prose must agree with the buttons actually rendered. */
  it("does not offer to pay now when there is nothing to pay on", async () => {
    const { html } = await render({ hostedInvoiceUrl: null });
    expect(html).not.toMatch(/Paying now is faster/i);
    expect(html).toMatch(/Updating the card now is faster/i);
  });

  it("says plainly when it was the last automatic attempt", async () => {
    const more = await render();
    const last = await render({ nextAttemptIso: null });
    expect(more.subject).toBe("Your Stayful payment didn't go through");
    expect(more.html).toContain("12 September 2026");
    expect(last.subject).toBe("Action needed: your Stayful payment has failed");
    expect(last.html).toContain("last automatic attempt");
  });

  it("omits the card phrase rather than rendering half of it", async () => {
    const { html } = await render({ cardLast4: null });
    expect(html).not.toContain("ending");
    expect(html).not.toContain("null");
    expect(html).not.toContain("undefined");
  });

  it("omits the amount for a non-GBP invoice rather than quoting a wrong one", async () => {
    // formatGbp hard-codes the pound sign.
    const { html } = await render({ currency: "usd" });
    expect(html).not.toContain("£150");
    expect(html).toContain("was declined");
  });

  /** The suppression, all the way through to the markup. */
  it("says nothing about why on a suppressed reason", async () => {
    const { html } = await render({ reasonKey: "bank_declined" });
    // Precise about what a leak actually is. A bare "lost" is not one — the
    // credits bullet says "nothing is lost" and no reader takes that as being
    // about their card. What must never appear is a raw code, Stripe's
    // merchant-facing wording, or an accusation about the card itself.
    expect(html).not.toMatch(
      /lost_card|stolen_card|pickup_card|merchant_blacklist|revocation_of_authorization|security_violation|seller_message|decline_code/i
    );
    expect(html).not.toMatch(/reported (lost|stolen)|stolen|fraudulent/i);
    expect(html).toContain("hasn&#39;t told us why".replace("&#39;", "'"));
  });

  it("escapes a hostile contact name", async () => {
    const { html } = await render({ contactName: "<script>alert(1)</script>" });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("never throws when Resend does", async () => {
    send.mockReset();
    send.mockRejectedValue(new Error("resend exploded"));
    const result = await sendCardDeclinedEmail({
      to: "ann@example.com",
      contactName: "Ann",
      productName: "Management leads",
      reasonKey: "unknown",
      amountDuePence: null,
      currency: null,
      cardBrand: null,
      cardLast4: null,
      hostedInvoiceUrl: null,
      nextAttemptIso: null,
    });
    expect(result.id).toBeNull();
    expect(result.error).toBeInstanceOf(Error);
  });
});
