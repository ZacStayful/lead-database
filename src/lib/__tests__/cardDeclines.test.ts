import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";

// vi.mock is hoisted above every const, so the spy has to be hoisted with it.
const { sendCardDeclinedEmail } = vi.hoisted(() => ({
  sendCardDeclinedEmail: vi.fn(),
}));
vi.mock("@/lib/emails", () => ({ sendCardDeclinedEmail }));

import { notifyCardDeclined, resolveCardDeclines } from "@/lib/cardDeclines";

/**
 * The SEAM between the version-tolerant reader, the copy table, the claim and
 * the send.
 *
 * This repo keeps recording that its bugs live in seams whose two sides were
 * each well tested — items(ids:) pagination, the missing !inner, the whole
 * failure-path cluster in the Monday work. declineDetail and declineReason are
 * covered hard on their own; nothing else exercises them together with the
 * claim-then-send ordering, which is where a duplicate email would come from.
 *
 * Stays a pure unit: the Supabase client and Stripe are stubs, and the email
 * module is mocked, so there is no network and no database.
 */

/** Minimal stub of the supabase-js chain shapes this module actually uses. */
function stubAdmin(opts: { insertError?: { code?: string; message: string } } = {}) {
  const calls = {
    inserted: [] as Record<string, unknown>[],
    updates: [] as Record<string, unknown>[],
    resolvedFilters: [] as Record<string, unknown>[],
  };
  const admin = {
    from(table: string) {
      if (table !== "card_decline_events") throw new Error(`unexpected table ${table}`);
      return {
        insert(row: Record<string, unknown>) {
          calls.inserted.push(row);
          return {
            select: () => ({
              single: async () =>
                opts.insertError
                  ? { data: null, error: opts.insertError }
                  : { data: { id: "row_1" }, error: null },
            }),
          };
        },
        update(patch: Record<string, unknown>) {
          calls.updates.push(patch);
          // The stamp path awaits `.eq(...)` directly; resolveCardDeclines
          // chains `.eq().eq().is()`. One object satisfying both is enough.
          const chain: Record<string, unknown> = {};
          chain.eq = () => chain;
          chain.is = async () => ({ error: null });
          chain.then = (resolve: (v: { error: null }) => unknown) =>
            resolve({ error: null });
          return chain;
        },
      };
    },
  } as unknown as SupabaseClient;
  return { admin, calls };
}

/** A basil-shaped invoice — the shape this account actually emits. */
const invoice = (over: Record<string, unknown> = {}) =>
  ({
    id: "in_1",
    attempt_count: 2,
    next_payment_attempt: 1789000000,
    hosted_invoice_url: "https://pay.stripe.com/invoice/abc",
    amount_due: 15000,
    currency: "gbp",
    payments: { data: [{ payment: { payment_intent: "pi_1" } }] },
    ...over,
  }) as unknown as Stripe.Invoice;

const stubStripe = (pi: unknown, shouldThrow = false) =>
  ({
    paymentIntents: {
      retrieve: vi.fn(async () => {
        if (shouldThrow) throw new Error("stripe is down");
        return pi;
      }),
    },
  }) as unknown as Stripe;

const customer = {
  id: "cus_row",
  email: "ann@example.com",
  contact_name: "Ann Example",
};

const declinedPi = {
  id: "pi_1",
  last_payment_error: { code: "card_declined", decline_code: "insufficient_funds" },
  latest_charge: {
    id: "ch_1",
    outcome: {
      seller_message: "The bank returned the decline code insufficient_funds.",
      network_status: "declined_by_network",
      type: "issuer_declined",
      risk_level: "normal",
    },
    payment_method_details: { card: { brand: "visa", last4: "4242" } },
  },
};

beforeEach(() => {
  sendCardDeclinedEmail.mockReset();
  sendCardDeclinedEmail.mockResolvedValue({ id: "resend_1", error: null });
});

describe("notifyCardDeclined — the happy path", () => {
  it("resolves the reason, claims a row and sends", async () => {
    const { admin, calls } = stubAdmin();
    const result = await notifyCardDeclined(admin, stubStripe(declinedPi), {
      invoice: invoice(),
      customer,
      leadType: "management",
      subscriptionId: "sub_1",
    });

    expect(result).toEqual({ sent: true, reasonKey: "insufficient_funds" });
    expect(sendCardDeclinedEmail).toHaveBeenCalledOnce();
    expect(calls.inserted).toHaveLength(1);
  });

  it("claims BEFORE it sends", async () => {
    // The ordering the whole dedupe rests on: a crash between send and insert
    // would lose the guard, so the insert has to come first.
    const order: string[] = [];
    const { admin } = stubAdmin();
    const spied = new Proxy(admin, {
      get(target, prop) {
        if (prop === "from") {
          return (t: string) => {
            order.push("claim");
            return (target as unknown as { from: (t: string) => unknown }).from(t);
          };
        }
        return Reflect.get(target, prop);
      },
    }) as SupabaseClient;
    sendCardDeclinedEmail.mockImplementation(async () => {
      order.push("send");
      return { id: "resend_1", error: null };
    });

    await notifyCardDeclined(spied, stubStripe(declinedPi), {
      invoice: invoice(),
      customer,
      leadType: "management",
      subscriptionId: "sub_1",
    });
    expect(order[0]).toBe("claim");
    expect(order).toContain("send");
  });

  it("stores the raw merchant-only detail on the audit row", async () => {
    const { admin, calls } = stubAdmin();
    await notifyCardDeclined(admin, stubStripe(declinedPi), {
      invoice: invoice(),
      customer,
      leadType: "management",
      subscriptionId: "sub_1",
    });
    const row = calls.inserted[0];
    expect(row.decline_code).toBe("insufficient_funds");
    expect(row.outcome_seller_message).toContain("The bank returned");
    expect(row.stripe_payment_intent_id).toBe("pi_1");
    expect(row.stripe_charge_id).toBe("ch_1");
    expect(row.attempt_count).toBe(2);
    expect(row.lead_type).toBe("management");
    expect(row.emailed_to).toBe("ann@example.com");
    expect(row.reason_suppressed).toBe(false);
  });

  /** The split this feature exists for: store the truth, say something safe. */
  it("stores a fraud code but never passes it to the email", async () => {
    const { admin, calls } = stubAdmin();
    await notifyCardDeclined(
      admin,
      stubStripe({
        id: "pi_1",
        last_payment_error: { decline_code: "stolen_card" },
        latest_charge: {
          outcome: { seller_message: "The bank returned the decline code stolen_card." },
        },
      }),
      { invoice: invoice(), customer, leadType: "management", subscriptionId: "sub_1" }
    );

    expect(calls.inserted[0].decline_code).toBe("stolen_card");
    expect(calls.inserted[0].reason_suppressed).toBe(true);

    const emailArgs = sendCardDeclinedEmail.mock.calls[0][0];
    expect(emailArgs.reasonKey).toBe("bank_declined");
    expect(JSON.stringify(emailArgs)).not.toMatch(/stolen|seller|decline_code/i);
  });
});

describe("notifyCardDeclined — refusals and failures", () => {
  it("treats a 23505 as already handled and sends nothing", async () => {
    const { admin } = stubAdmin({
      insertError: { code: "23505", message: "duplicate key" },
    });
    const result = await notifyCardDeclined(admin, stubStripe(declinedPi), {
      invoice: invoice(),
      customer,
      leadType: "management",
      subscriptionId: "sub_1",
    });
    expect(result).toEqual({ sent: false, skipped: "already_sent" });
    expect(sendCardDeclinedEmail).not.toHaveBeenCalled();
  });

  it("does NOT send when the claim fails for any other reason", async () => {
    // An unrecorded email cannot be deduped, and more attempts are coming.
    const { admin } = stubAdmin({ insertError: { code: "42P01", message: "no table" } });
    const result = await notifyCardDeclined(admin, stubStripe(declinedPi), {
      invoice: invoice(),
      customer,
      leadType: "management",
      subscriptionId: "sub_1",
    });
    expect(result.skipped).toBe("claim_failed");
    expect(sendCardDeclinedEmail).not.toHaveBeenCalled();
  });

  it("skips a customer with no email BEFORE claiming", async () => {
    const { admin, calls } = stubAdmin();
    const result = await notifyCardDeclined(admin, stubStripe(declinedPi), {
      invoice: invoice(),
      customer: { ...customer, email: null },
      leadType: "management",
      subscriptionId: "sub_1",
    });
    expect(result.skipped).toBe("no_email");
    // Not claimed — so a later backfill can still reach them.
    expect(calls.inserted).toHaveLength(0);
  });

  /**
   * A Stripe outage must not cost the customer the notice: they still need to
   * fix the card whether or not Stripe would tell us why.
   */
  it("still emails, with generic copy, when the Stripe lookup fails", async () => {
    const { admin, calls } = stubAdmin();
    const result = await notifyCardDeclined(admin, stubStripe(null, true), {
      invoice: invoice(),
      customer,
      leadType: "management",
      subscriptionId: "sub_1",
    });
    expect(result.sent).toBe(true);
    expect(result.reasonKey).toBe("unknown");
    expect(calls.inserted[0].pi_resolved).toBe(false);
    expect(calls.inserted[0].stripe_lookup_error).toBe("stripe is down");
    expect(sendCardDeclinedEmail).toHaveBeenCalledOnce();
  });

  it("still emails when no payment intent can be found at all", async () => {
    const { admin, calls } = stubAdmin();
    const result = await notifyCardDeclined(admin, stubStripe(declinedPi), {
      invoice: invoice({ payments: { data: [] } }),
      customer,
      leadType: "management",
      subscriptionId: "sub_1",
    });
    expect(result.sent).toBe(true);
    expect(calls.inserted[0].stripe_lookup_error).toBe(
      "no_payment_intent_on_invoice"
    );
  });

  it("records an email failure on the row instead of throwing", async () => {
    sendCardDeclinedEmail.mockResolvedValue({ id: null, error: new Error("resend 500") });
    const { admin, calls } = stubAdmin();
    const result = await notifyCardDeclined(admin, stubStripe(declinedPi), {
      invoice: invoice(),
      customer,
      leadType: "management",
      subscriptionId: "sub_1",
    });
    expect(result.sent).toBe(false);
    expect(result.error).toBe("resend 500");
    expect(calls.updates.some((u) => "email_error" in u)).toBe(true);
  });

  /**
   * THE CONTRACT. The webhook deletes its stripe_events claim on any throw, so
   * an exception escaping here would have Stripe redeliver an event that has
   * already written past_due, a payments row and a Monday label.
   */
  it("never throws, whatever the database does", async () => {
    const exploding = {
      from() {
        throw new Error("supabase exploded");
      },
    } as unknown as SupabaseClient;
    const result = await notifyCardDeclined(exploding, stubStripe(declinedPi), {
      invoice: invoice(),
      customer,
      leadType: "management",
      subscriptionId: "sub_1",
    });
    expect(result.sent).toBe(false);
    expect(result.error).toBe("supabase exploded");
  });

  it("resolveCardDeclines never throws either", async () => {
    const exploding = {
      from() {
        throw new Error("nope");
      },
    } as unknown as SupabaseClient;
    await expect(
      resolveCardDeclines(exploding, "cus_row", "management", "test")
    ).resolves.toBeUndefined();
  });
});
