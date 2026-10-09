/**
 * Guards on the REAL files for a funnel payer's account (batch 02 Phase 5).
 *
 * vitest.config.mts is PURE UNITS ONLY, so the Stripe webhook is never run
 * here. These read the files themselves (§42.8), comments stripped, because
 * each file explains its own rules and a naive check would pass on the
 * explanation.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const WEBHOOK = source("src/app/api/webhook/stripe/route.ts");
const PAYMENT = source("src/lib/funnel/payment.ts");

describe("the one additive call in invoice.paid (approved 9 Oct)", () => {
  const branch = WEBHOOK.slice(WEBHOOK.indexOf('case "invoice.paid"'), WEBHOOK.indexOf('case "invoice.payment_failed"'));
  const call = branch.indexOf("await completeFunnelPayment(admin, stripe, { invoice, subscriptionId });");

  it("is exactly one call", () => {
    expect(WEBHOOK.match(/completeFunnelPayment\(/g)).toHaveLength(1);
    expect(call).toBeGreaterThan(-1);
  });

  it("runs after the duplicate check and BEFORE the Management customer read and its provisioning", () => {
    const duplicate = branch.indexOf("if (await skipDuplicateInvoice(admin, stripe, { invoice, subscriptionId })) break;");
    const read = branch.indexOf('.eq("stripe_customer_id", customerId)', duplicate);
    const provisionCalls = Array.from(branch.matchAll(/provisionPaidSubscriber\(/g), (m) => m.index ?? -1);
    const readyEmails = Array.from(branch.matchAll(/sendAccountReadyEmail\(/g), (m) => m.index ?? -1);
    expect(duplicate).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(duplicate);
    expect(read).toBeGreaterThan(call);
    // The second of each is the Management half's (the first is GR's).
    expect(provisionCalls).toHaveLength(2);
    expect(readyEmails).toHaveLength(2);
    expect(call).toBeLessThan(provisionCalls[1]);
    expect(call).toBeLessThan(readyEmails[1]);
  });

  it("does not stop the invoice: nothing reads its result", () => {
    expect(branch).not.toMatch(/=\s*await completeFunnelPayment/);
    expect(branch).not.toMatch(/if \(await completeFunnelPayment/);
  });
});

describe("what it may write", () => {
  it("no money column, no Stripe link, no credit: those stay the webhook's", () => {
    for (const banned of ["stripe_customer_id", "stripe_subscription_id", "credit_invoice", "lead_balance", "subscription_status", 'account_status: "active"']) {
      expect(PAYMENT).not.toContain(banned);
    }
  });

  it("C2: a magic link through Resend, never the set-password email", () => {
    expect(PAYMENT).toContain('generateLink({ type: "magiclink", email })');
    expect(PAYMENT).not.toContain('type: "recovery"');
    expect(PAYMENT).not.toContain("sendAccountReadyEmail");
    expect(PAYMENT).toContain("sendFunnelWelcomeEmail(");
  });

  it("marks the session paid by a conditional write before it sends", () => {
    const claim = PAYMENT.indexOf('.neq("step", "paid")');
    expect(claim).toBeGreaterThan(-1);
    expect(claim).toBeLessThan(PAYMENT.indexOf("sendFunnelWelcomeEmail("));
  });

  it("never throws: the whole body is one try whose catch returns", () => {
    const start = PAYMENT.indexOf("export async function completeFunnelPayment");
    const body = PAYMENT.slice(start, PAYMENT.indexOf("\n}\n", start));
    expect(body.trimEnd()).toMatch(/\} catch \(err\) \{[\s\S]*return "error";\s*\}$/);
  });
});
