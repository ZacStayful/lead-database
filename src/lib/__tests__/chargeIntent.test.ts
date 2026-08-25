import { describe, it, expect, vi } from "vitest";
import type Stripe from "stripe";
import { chargeClaimedIntent, isIndeterminate } from "../chargeIntent";

/**
 * These cover the branches that used to live inside chargeClaimedTopup. The
 * extraction was meant to be behaviour-preserving, and this is what says so —
 * particularly the two that decide whether somebody's money is taken and
 * nothing given back.
 */

function spy() {
  return { calls: [] as string[] };
}

function spec(log: { calls: string[] }, over: Record<string, unknown> = {}) {
  return {
    stripeCustomerId: "cus_1",
    amountPence: 55_200,
    description: "Lead analysis — 184 leads",
    metadata: { kind: "lead_analysis", token_id: "tok_1" },
    idempotencyKey: "lead_analysis_tok_1",
    successUrl: "https://app.test/done",
    cancelUrl: "https://app.test/back",
    onSuccess: async (id: string) => { log.calls.push(`success:${id}`); },
    onFailed: async (id: string | null) => { log.calls.push(`failed:${id}`); },
    onRelease: async () => { log.calls.push("release"); },
    ...over,
  };
}

function stripeWith(over: Record<string, unknown>): Stripe {
  return {
    customers: { retrieve: async () => ({ invoice_settings: { default_payment_method: "pm_1" } }) },
    paymentMethods: { list: async () => ({ data: [] }) },
    paymentIntents: { create: async () => ({ id: "pi_1", status: "succeeded" }) },
    checkout: { sessions: { create: async () => ({ url: "https://checkout.test/s" }) } },
    ...over,
  } as unknown as Stripe;
}

function stripeError(type: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(type), { type, ...extra });
}

describe("isIndeterminate", () => {
  it("knows which errors prove the charge did not happen", () => {
    expect(isIndeterminate({ type: "StripeCardError" } as Stripe.errors.StripeError)).toBe(false);
    expect(isIndeterminate({ type: "StripeInvalidRequestError" } as Stripe.errors.StripeError)).toBe(false);
  });

  it("treats everything else as unknown, which is the safe direction", () => {
    for (const type of ["StripeConnectionError", "StripeAPIError", "StripeRateLimitError", "weird"]) {
      expect(isIndeterminate({ type } as Stripe.errors.StripeError)).toBe(true);
    }
  });
});

describe("chargeClaimedIntent", () => {
  it("charges the saved card off-session and finalises on success", async () => {
    const log = spy();
    let seen: unknown;
    const stripe = stripeWith({
      paymentIntents: {
        create: async (args: unknown, opts: unknown) => {
          seen = { args, opts };
          return { id: "pi_ok", status: "succeeded" };
        },
      },
    });
    const out = await chargeClaimedIntent(stripe, spec(log));
    expect(out).toEqual({ kind: "success", paymentIntentId: "pi_ok" });
    expect(log.calls).toEqual(["success:pi_ok"]);

    const { args, opts } = seen as { args: Record<string, unknown>; opts: Record<string, unknown> };
    expect(args.amount).toBe(55_200);
    expect(args.currency).toBe("gbp");
    expect(args.off_session).toBe(true);
    expect(args.confirm).toBe(true);
    // The idempotency key is what makes a retry return the ORIGINAL intent
    // rather than charging a second time.
    expect(opts.idempotencyKey).toBe("lead_analysis_tok_1");
  });

  it("fails definitively with no billing account, without touching Stripe", async () => {
    const log = spy();
    const stripe = stripeWith({
      customers: { retrieve: async () => { throw new Error("should not be called"); } },
    });
    const out = await chargeClaimedIntent(stripe, spec(log, { stripeCustomerId: null }));
    expect(out.kind).toBe("failed");
    expect(log.calls).toEqual(["failed:null"]);
  });

  it("sends the customer to a hosted page when there is no reusable card", async () => {
    const log = spy();
    let created: Record<string, unknown> | null = null;
    const stripe = stripeWith({
      customers: { retrieve: async () => ({ invoice_settings: {} }) },
      paymentMethods: { list: async () => ({ data: [] }) },
      checkout: {
        sessions: {
          create: async (args: Record<string, unknown>) => {
            created = args;
            return { url: "https://checkout.test/s" };
          },
        },
      },
    });
    const out = await chargeClaimedIntent(stripe, spec(log));
    expect(out).toEqual({ kind: "redirect", url: "https://checkout.test/s" });
    // Nothing is finalised: the customer has not paid yet.
    expect(log.calls).toEqual([]);
    expect(created!.mode).toBe("payment");
    // Card only, so the charge completes synchronously — a delayed method would
    // finish via async_payment_succeeded, which is pay-now-deliver-later.
    expect(created!.payment_method_types).toEqual(["card"]);
    expect((created!.payment_intent_data as Record<string, unknown>).setup_future_usage).toBe("off_session");
  });

  // ── The two branches the whole module exists for ──────────────────

  it("RELEASES rather than failing when Stripe's answer is indeterminate", async () => {
    // A connection error can be thrown AFTER the money was taken. Finalising
    // here would keep it and give nothing back.
    for (const type of ["StripeConnectionError", "StripeAPIError", "StripeRateLimitError"]) {
      const log = spy();
      const stripe = stripeWith({
        paymentIntents: { create: async () => { throw stripeError(type); } },
      });
      const out = await chargeClaimedIntent(stripe, spec(log));
      expect(out.kind).toBe("pending");
      expect(log.calls).toEqual(["release"]);
      expect(log.calls).not.toContain("failed:null");
    }
  });

  it("finalises as failed ONLY when the decline is definitive", async () => {
    const log = spy();
    const stripe = stripeWith({
      paymentIntents: {
        create: async () => { throw stripeError("StripeCardError", { payment_intent: { id: "pi_dead" } }); },
      },
    });
    const out = await chargeClaimedIntent(stripe, spec(log));
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") expect(out.message).toMatch(/declined/i);
    expect(log.calls).toEqual(["failed:pi_dead"]);
  });

  it("releases a payment that is still settling, and never finalises it", async () => {
    const log = spy();
    const stripe = stripeWith({
      paymentIntents: { create: async () => ({ id: "pi_slow", status: "processing" }) },
    });
    const out = await chargeClaimedIntent(stripe, spec(log));
    expect(out.kind).toBe("pending");
    expect(log.calls).toEqual(["release"]);
  });

  it("finalises a card that needs the cardholder present", async () => {
    for (const status of ["requires_action", "requires_payment_method"]) {
      const log = spy();
      const stripe = stripeWith({
        paymentIntents: { create: async () => ({ id: "pi_3ds", status }) },
      });
      const out = await chargeClaimedIntent(stripe, spec(log));
      expect(out.kind).toBe("failed");
      expect(log.calls).toEqual(["failed:pi_3ds"]);
    }
  });

  it("releases when the card cannot even be looked up", async () => {
    const log = spy();
    const stripe = stripeWith({
      customers: { retrieve: async () => { throw new Error("network"); } },
    });
    const out = await chargeClaimedIntent(stripe, spec(log));
    expect(out.kind).toBe("pending");
    expect(log.calls).toEqual(["release"]);
  });

  it("releases when the hosted page cannot be created — no money can have moved", async () => {
    const log = spy();
    const stripe = stripeWith({
      customers: { retrieve: async () => ({ invoice_settings: {} }) },
      paymentMethods: { list: async () => ({ data: [] }) },
      checkout: { sessions: { create: async () => { throw new Error("nope"); } } },
    });
    const out = await chargeClaimedIntent(stripe, spec(log));
    expect(out.kind).toBe("pending");
    expect(log.calls).toEqual(["release"]);
  });

  it("falls back to any attached card when there is no default", async () => {
    const log = spy();
    let usedPm: string | undefined;
    const stripe = stripeWith({
      customers: { retrieve: async () => ({ invoice_settings: {} }) },
      paymentMethods: { list: async () => ({ data: [{ id: "pm_attached" }] }) },
      paymentIntents: {
        create: async (a: Record<string, unknown>) => {
          usedPm = a.payment_method as string;
          return { id: "pi_ok", status: "succeeded" };
        },
      },
    });
    const out = await chargeClaimedIntent(stripe, spec(log));
    expect(out.kind).toBe("success");
    expect(usedPm).toBe("pm_attached");
  });
});

describe("forceHosted", () => {
  it("skips the saved card entirely and goes to the hosted page", async () => {
    // A £600 off-session charge nobody is present for is exactly what issuers
    // decline. This turns a silent decline into a prompt the cardholder can
    // answer — so the saved card must not even be looked up.
    const log = spy();
    let cardLookedUp = false;
    let created: Record<string, unknown> | null = null;
    const stripe = stripeWith({
      customers: {
        retrieve: async () => {
          cardLookedUp = true;
          return { invoice_settings: { default_payment_method: "pm_1" } };
        },
      },
      paymentIntents: { create: async () => { throw new Error("must not charge off-session"); } },
      checkout: {
        sessions: {
          create: async (args: Record<string, unknown>) => {
            created = args;
            return { url: "https://checkout.test/big" };
          },
        },
      },
    });
    const out = await chargeClaimedIntent(stripe, spec(log, { forceHosted: true, amountPence: 60_000 }));
    expect(out).toEqual({ kind: "redirect", url: "https://checkout.test/big" });
    expect(cardLookedUp).toBe(false);
    expect(log.calls).toEqual([]);
    expect((created!.line_items as Array<Record<string, never>>)[0]).toMatchObject({
      price_data: { unit_amount: 60_000 },
    });
  });

  it("leaves the ordinary path alone when it is off", async () => {
    const log = spy();
    const out = await chargeClaimedIntent(stripeWith({}), spec(log, { forceHosted: false }));
    expect(out.kind).toBe("success");
  });
});
