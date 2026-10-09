import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";

const { sendFunnelWelcomeEmail } = vi.hoisted(() => ({
  sendFunnelWelcomeEmail: vi.fn(async (_args: Record<string, unknown>) => ({ id: "em_1" as string | null, error: null as unknown })),
}));
vi.mock("@/lib/emails", () => ({ sendFunnelWelcomeEmail }));
vi.mock("@/lib/monday", () => ({ enquiryBoardId: () => "18420649520" }));

import {
  completeFunnelPayment,
  funnelSessionIdFrom,
  funnelSignInUrl,
  invoiceSubscriptionMetadata,
} from "@/lib/funnel/payment";
import { fakeDb } from "@/lib/checkout/__tests__/fakes";

/**
 * A funnel payer's account (02 Phase 5), run against in-memory Supabase with
 * the auth admin calls stubbed. The doc's checks, in its words: an active
 * customer with no invite, the sign-in email through Resend, the first login
 * landing on the brief, Monday updated.
 */

const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const PK = { primaryKeys: { customers: "email" } };

function session(over: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    name: "Jo Bloggs",
    email: "jo@example.com",
    phone: "+447700900123",
    monday_item_id: "9876543210",
    plan_selected: 10,
    step: "checkout_started",
    customer_id: null,
    paid_at: null,
    ...over,
  };
}

function invoice(over: Record<string, unknown> = {}, metadata: Record<string, string> | null = { source: "funnel", funnel_session_id: SESSION_ID }): Stripe.Invoice {
  return {
    id: "in_1",
    billing_reason: "subscription_create",
    parent: metadata ? { subscription_details: { metadata } } : null,
    ...over,
  } as unknown as Stripe.Invoice;
}

function harness(
  tables: Record<string, Record<string, unknown>[]>,
  opts: { existingAuthUser?: string; onCreateUser?: () => void; failSelect?: Record<string, { message: string }> } = {}
) {
  const db = fakeDb(tables, { ...PK, failSelect: opts.failSelect });
  const createUser = vi.fn(async (_p: Record<string, unknown>) => {
    opts.onCreateUser?.();
    if (opts.existingAuthUser) return { data: { user: null }, error: { message: "already registered" } };
    return { data: { user: { id: "user_new" } }, error: null };
  });
  const generateLink = vi.fn(async (_p: { type: string; email: string }) => ({
    data: { user: { id: opts.existingAuthUser ?? "user_new" }, properties: { hashed_token: "hash_abc" } },
    error: null,
  }));
  const admin = { from: db.admin.from, auth: { admin: { createUser, generateLink } } } as unknown as SupabaseClient;
  const retrieve = vi.fn(async (_id: string) => ({ metadata: { source: "funnel", funnel_session_id: SESSION_ID } }));
  const stripe = { subscriptions: { retrieve } } as unknown as Stripe;
  return { db, admin, stripe, createUser, generateLink, retrieve };
}

function moneyWrites(db: ReturnType<typeof fakeDb>) {
  return db.writes.filter((w) =>
    ["stripe_customer_id", "stripe_subscription_id", "subscription_status", "lead_balance", "leads_received_this_month"].some(
      (k) => k in w.values
    ) || (w.table === "customers" && w.values.account_status !== undefined && w.values.account_status !== "waitlisted")
  );
}

beforeEach(() => {
  sendFunnelWelcomeEmail.mockClear();
  sendFunnelWelcomeEmail.mockImplementation(async () => ({ id: "em_1", error: null }));
});

describe("which invoices it looks at", () => {
  it("a renewal costs nothing: no read, no write, no Stripe call", async () => {
    const h = harness({ funnel_sessions: [session()] });
    expect(await completeFunnelPayment(h.admin, h.stripe, { invoice: invoice({ billing_reason: "subscription_cycle" }), subscriptionId: "sub_1" })).toBe("not_first_invoice");
    expect(h.db.writes).toHaveLength(0);
    expect(h.retrieve).not.toHaveBeenCalled();
  });

  it("a call-route subscription is left alone", async () => {
    const h = harness({ funnel_sessions: [session()] });
    expect(await completeFunnelPayment(h.admin, h.stripe, { invoice: invoice({}, { source: "call", offer_id: "x" }), subscriptionId: "sub_1" })).toBe("not_funnel");
    expect(h.db.writes).toHaveLength(0);
    expect(h.retrieve).not.toHaveBeenCalled();
  });

  it("an empty tag set on the invoice is not the funnel, and costs no Stripe call", async () => {
    const h = harness({ funnel_sessions: [session()] });
    expect(await completeFunnelPayment(h.admin, h.stripe, { invoice: invoice({}, {}), subscriptionId: "sub_1" })).toBe("not_funnel");
    expect(h.retrieve).not.toHaveBeenCalled();
  });

  it("reads the subscription's own tags when the invoice carries none", async () => {
    const h = harness({ funnel_sessions: [session()], customers: [] });
    expect(await completeFunnelPayment(h.admin, h.stripe, { invoice: invoice({}, null), subscriptionId: "sub_1" })).toBe("provisioned");
    expect(h.retrieve).toHaveBeenCalledWith("sub_1");
  });

  it("names a session only for source 'funnel' and a uuid", () => {
    expect(funnelSessionIdFrom({ source: "funnel", funnel_session_id: SESSION_ID })).toBe(SESSION_ID);
    expect(funnelSessionIdFrom({ source: "call", funnel_session_id: SESSION_ID })).toBeNull();
    expect(funnelSessionIdFrom({ source: "funnel", funnel_session_id: "not-a-uuid" })).toBeNull();
    expect(funnelSessionIdFrom(null)).toBeNull();
  });

  it("finds the tags under either API shape", () => {
    const tags = { source: "funnel" };
    expect(invoiceSubscriptionMetadata({ parent: { subscription_details: { metadata: tags } } } as unknown as Stripe.Invoice)).toEqual(tags);
    expect(invoiceSubscriptionMetadata({ subscription_details: { metadata: tags } } as unknown as Stripe.Invoice)).toEqual(tags);
  });
});

describe("an enquirer who paid through the funnel", () => {
  it("gets a login, the brief flag, the Monday item, a paid session and ONE sign-in email, with no money column touched", async () => {
    const row = { id: "c1", email: "jo@example.com", user_id: null, monday_item_id: null, account_status: "waitlisted", lead_brief_required: false, signup_source: "call" };
    const h = harness({ funnel_sessions: [session()], customers: [row] });

    expect(await completeFunnelPayment(h.admin, h.stripe, { invoice: invoice(), subscriptionId: "sub_1" })).toBe("provisioned");

    const c = h.db.tables.customers[0];
    expect(c.user_id).toBe("user_new");
    expect(c.lead_brief_required).toBe(true);
    expect(c.signup_source).toBe("funnel");
    expect(c.monday_item_id).toBe("9876543210");
    expect(c.monday_board_id).toBe("18420649520");
    expect(h.db.tables.funnel_sessions[0]).toMatchObject({ step: "paid", customer_id: "c1" });
    expect(h.db.tables.funnel_sessions[0].paid_at).toBeTruthy();

    // C2: the login has no password the payer knows, and the link is a magic link to the brief.
    expect(h.createUser.mock.calls[0][0]).toMatchObject({ email: "jo@example.com", email_confirm: true });
    expect(h.generateLink).toHaveBeenCalledWith({ type: "magiclink", email: "jo@example.com" });
    expect(sendFunnelWelcomeEmail).toHaveBeenCalledTimes(1);
    const url = new URL(String(sendFunnelWelcomeEmail.mock.calls[0][0].signInUrl));
    expect(url.pathname).toBe("/auth/confirm");
    expect(url.searchParams.get("type")).toBe("magiclink");
    expect(url.searchParams.get("next")).toBe("/onboarding/brief");
    expect(url.searchParams.get("token_hash")).toBe("hash_abc");

    // Linking, crediting and activating stay the webhook's own work.
    expect(moneyWrites(h.db)).toEqual([]);
  });

  it("a stranger gets a new waitlisted row sized to the plan they chose", async () => {
    const h = harness({ funnel_sessions: [session({ plan_selected: 10 })], customers: [] });
    expect(await completeFunnelPayment(h.admin, h.stripe, { invoice: invoice(), subscriptionId: "sub_1" })).toBe("provisioned");
    expect(h.db.tables.customers).toHaveLength(1);
    expect(h.db.tables.customers[0]).toMatchObject({
      email: "jo@example.com",
      contact_name: "Jo Bloggs",
      account_status: "waitlisted",
      signup_source: "funnel",
      lead_brief_required: true,
      monthly_allocation: 10,
      user_id: "user_new",
    });
    expect(moneyWrites(h.db)).toEqual([]);
  });

  it("a redelivered invoice neither makes a second login nor sends a second email", async () => {
    const h = harness({ funnel_sessions: [session()], customers: [] });
    await completeFunnelPayment(h.admin, h.stripe, { invoice: invoice(), subscriptionId: "sub_1" });
    expect(await completeFunnelPayment(h.admin, h.stripe, { invoice: invoice(), subscriptionId: "sub_1" })).toBe("already_paid");
    expect(h.createUser).toHaveBeenCalledTimes(1);
    expect(sendFunnelWelcomeEmail).toHaveBeenCalledTimes(1);
  });

  it("a delivery that loses the race to mark the session paid sends nothing", async () => {
    const tables = { funnel_sessions: [session()], customers: [] as Record<string, unknown>[] };
    const h = harness(tables, {
      // Another delivery marks it paid while this one is making the login.
      onCreateUser: () => Object.assign(h.db.tables.funnel_sessions[0], { step: "paid", paid_at: "2026-10-09T12:00:00Z" }),
    });
    expect(await completeFunnelPayment(h.admin, h.stripe, { invoice: invoice(), subscriptionId: "sub_1" })).toBe("already_paid");
    expect(sendFunnelWelcomeEmail).not.toHaveBeenCalled();
  });
});

describe("somebody who already has a login", () => {
  it("keeps it: no new login, signup_source left alone, still flagged for the brief and emailed", async () => {
    const row = { id: "c1", email: "jo@example.com", user_id: "user_old", monday_item_id: "111", signup_source: "call", lead_brief_required: false };
    const h = harness({ funnel_sessions: [session()], customers: [row] });
    expect(await completeFunnelPayment(h.admin, h.stripe, { invoice: invoice(), subscriptionId: "sub_1" })).toBe("provisioned");
    expect(h.createUser).not.toHaveBeenCalled();
    const c = h.db.tables.customers[0];
    expect(c.signup_source).toBe("call");
    expect(c.lead_brief_required).toBe(true);
    // An item already on the row is never replaced.
    expect(c.monday_item_id).toBe("111");
    expect(sendFunnelWelcomeEmail).toHaveBeenCalledTimes(1);
  });

  it("an auth user that already exists is found and linked, and is not called a funnel sign-up", async () => {
    const row = { id: "c1", email: "jo@example.com", user_id: null, monday_item_id: null, signup_source: "call" };
    const h = harness({ funnel_sessions: [session()], customers: [row] }, { existingAuthUser: "user_orphan" });
    expect(await completeFunnelPayment(h.admin, h.stripe, { invoice: invoice(), subscriptionId: "sub_1" })).toBe("provisioned");
    const c = h.db.tables.customers[0];
    expect(c.user_id).toBe("user_orphan");
    expect(c.signup_source).toBe("call");
    // One link, used both to find the user and in the email.
    expect(h.generateLink).toHaveBeenCalledTimes(1);
    expect(sendFunnelWelcomeEmail).toHaveBeenCalledTimes(1);
  });
});

describe("never throws, and never stands in the way of the invoice", () => {
  it("a missing session is logged and nothing is written", async () => {
    const h = harness({ funnel_sessions: [], customers: [] });
    expect(await completeFunnelPayment(h.admin, h.stripe, { invoice: invoice(), subscriptionId: "sub_1" })).toBe("session_missing");
    expect(h.db.writes).toHaveLength(0);
  });

  it("a failed email leaves the session paid (the login page's reset is the way in)", async () => {
    sendFunnelWelcomeEmail.mockImplementationOnce(async () => ({ id: null, error: new Error("resend down") }));
    const h = harness({ funnel_sessions: [session()], customers: [] });
    expect(await completeFunnelPayment(h.admin, h.stripe, { invoice: invoice(), subscriptionId: "sub_1" })).toBe("provisioned_email_failed");
    expect(h.db.tables.funnel_sessions[0].step).toBe("paid");
  });

  it("an unreadable customers table stops before any login is made", async () => {
    const h = harness({ funnel_sessions: [session()], customers: [] }, { failSelect: { customers: { message: "down" } } });
    expect(await completeFunnelPayment(h.admin, h.stripe, { invoice: invoice(), subscriptionId: "sub_1" })).toBe("error");
    expect(h.createUser).not.toHaveBeenCalled();
    expect(h.db.tables.funnel_sessions[0].step).toBe("checkout_started");
  });

  it("an exception becomes an outcome, not a throw", async () => {
    const h = harness({ funnel_sessions: [session()] });
    const exploding = { ...h.admin, from: () => { throw new Error("boom"); } } as unknown as SupabaseClient;
    await expect(completeFunnelPayment(exploding, h.stripe, { invoice: invoice(), subscriptionId: "sub_1" })).resolves.toBe("error");
  });
});

describe("the sign-in link", () => {
  it("is a token-hash magic link to the brief, on /auth/confirm", () => {
    const url = new URL(funnelSignInUrl("abc+/="));
    expect(url.pathname).toBe("/auth/confirm");
    expect(url.searchParams.get("token_hash")).toBe("abc+/=");
    expect(url.searchParams.get("type")).toBe("magiclink");
    expect(url.searchParams.get("next")).toBe("/onboarding/brief");
  });
});
