/**
 * The Resend receiver: the signature, the payload, and the containment rule.
 *
 * ⚠️ WHY THIS FILE EXISTS AT ALL. `POST /api/customer/messaging/email-domain`
 * registered a webhook at `/api/webhook/resend/<token>` and the route was never
 * written, so every event 404'd until Resend disabled the endpoint. The pieces
 * either side were fine; the seam between them had nothing pointed at it. That
 * is the third time in this feature (§23.10, §25's `items(ids:)`, §27.8's
 * `!inner`), so the cases below deliberately cover the JOINS — is this event
 * about a message we hold, is this thread this customer's — and not only the
 * arithmetic.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";

import { verifySvixSignature } from "../svixSignature";
import {
  addressOnly,
  advanceStatus,
  bodyFrom,
  emailIdFrom,
  failureDetailFrom,
  recipientsFrom,
  senderFrom,
  statusRuleFor,
  subjectFrom,
  type ResendWebhookPayload,
} from "../resendEvents";

const stopRuns = vi.fn();
vi.mock("../sequences", () => ({
  stopRunsForAssignment: (...args: unknown[]) => stopRuns(...args),
}));

// verifyThreadToken needs this to mint and check the MAC.
process.env.MESSAGING_TOKEN_SECRET = "test-token-secret";

import { ingestResendEvent } from "../ingestResendEvent";
import { handleFor, mintThreadToken } from "../threadAddress";

// ---------------------------------------------------------------------------
// 1 — The signature.
// ---------------------------------------------------------------------------
const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const BODY = '{"type":"email.delivered","data":{"email_id":"abc"}}';
const ID = "msg_2c8Vd7Wk";

/**
 * An INDEPENDENT implementation of the signing rule, written straight from the
 * Svix spec rather than by calling the module under test. Signing with the
 * function we are verifying with would pass however wrong both halves were —
 * the same reason §27.2 duplicates the exposed-field list in its assertions
 * instead of deriving it from the source.
 */
function signIndependently(id: string, tsSeconds: number, body: string, secret: string) {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const mac = createHmac("sha256", key)
    .update(`${id}.${tsSeconds}.${body}`, "utf8")
    .digest("base64");
  return `v1,${mac}`;
}

describe("svix signature", () => {
  const now = Date.UTC(2026, 8, 3, 12, 0, 0);
  const ts = Math.floor(now / 1000);

  it("accepts a correctly signed request", () => {
    const v = verifySvixSignature({
      id: ID,
      timestamp: String(ts),
      signature: signIndependently(ID, ts, BODY, SECRET),
      body: BODY,
      secret: SECRET,
      nowMs: now,
    });
    expect(v.ok).toBe(true);
  });

  it("accepts a secret stored without the whsec_ prefix", () => {
    const v = verifySvixSignature({
      id: ID,
      timestamp: String(ts),
      signature: signIndependently(ID, ts, BODY, SECRET),
      body: BODY,
      secret: SECRET.replace("whsec_", ""),
      nowMs: now,
    });
    expect(v.ok).toBe(true);
  });

  it("REJECTS a body altered by a single byte", () => {
    const v = verifySvixSignature({
      id: ID,
      timestamp: String(ts),
      signature: signIndependently(ID, ts, BODY, SECRET),
      body: BODY.replace('"abc"', '"abd"'),
      secret: SECRET,
      nowMs: now,
    });
    expect(v).toEqual({ ok: false, reason: "no_match" });
  });

  it("REJECTS a signature made with another customer's secret", () => {
    const other = "whsec_" + Buffer.from("a-completely-different-key").toString("base64");
    const v = verifySvixSignature({
      id: ID,
      timestamp: String(ts),
      signature: signIndependently(ID, ts, BODY, other),
      body: BODY,
      secret: SECRET,
      nowMs: now,
    });
    expect(v).toEqual({ ok: false, reason: "no_match" });
  });

  it("REJECTS a signature bound to a different svix id", () => {
    const v = verifySvixSignature({
      id: ID,
      timestamp: String(ts),
      signature: signIndependently("msg_somethingelse", ts, BODY, SECRET),
      body: BODY,
      secret: SECRET,
      nowMs: now,
    });
    expect(v).toEqual({ ok: false, reason: "no_match" });
  });

  it("accepts when one of several offered signatures matches", () => {
    const good = signIndependently(ID, ts, BODY, SECRET);
    const v = verifySvixSignature({
      id: ID,
      timestamp: String(ts),
      signature: `v1,bm90LXRoZS1yaWdodC1vbmU= ${good}`,
      body: BODY,
      secret: SECRET,
      nowMs: now,
    });
    expect(v.ok).toBe(true);
  });

  it("IGNORES a non-v1 version rather than accepting it under v1 rules", () => {
    const mac = signIndependently(ID, ts, BODY, SECRET).slice("v1,".length);
    const v = verifySvixSignature({
      id: ID,
      timestamp: String(ts),
      signature: `v2,${mac}`,
      body: BODY,
      secret: SECRET,
      nowMs: now,
    });
    expect(v).toEqual({ ok: false, reason: "no_match" });
  });

  it("reports missing headers distinctly from a bad signature", () => {
    expect(
      verifySvixSignature({ id: null, timestamp: String(ts), signature: "v1,x", body: BODY, secret: SECRET })
    ).toEqual({ ok: false, reason: "missing_headers" });
  });

  it("reports a non-numeric timestamp distinctly", () => {
    expect(
      verifySvixSignature({
        id: ID,
        timestamp: "not-a-number",
        signature: signIndependently(ID, ts, BODY, SECRET),
        body: BODY,
        secret: SECRET,
        nowMs: now,
      })
    ).toEqual({ ok: false, reason: "bad_timestamp" });
  });

  /**
   * ⚠️ THE CASE THAT WOULD PUT US BACK WHERE WE STARTED.
   *
   * Svix retries a failed delivery for up to ten hours and re-sends the
   * ORIGINAL signed payload with its ORIGINAL timestamp. The five-minute
   * tolerance the Svix libraries ship with would reject every one of those, and
   * reject them as forgeries — so a transient blip would turn into the endpoint
   * being disabled all over again, which is the exact bug this whole change is
   * fixing. The window has to outlive the retry schedule.
   */
  it("still accepts a retry sent SIX HOURS after the original", () => {
    const v = verifySvixSignature({
      id: ID,
      timestamp: String(ts),
      signature: signIndependently(ID, ts, BODY, SECRET),
      body: BODY,
      secret: SECRET,
      nowMs: now + 6 * 60 * 60 * 1000,
    });
    expect(v.ok).toBe(true);
  });

  it("rejects one replayed days later, and says so distinctly", () => {
    const v = verifySvixSignature({
      id: ID,
      timestamp: String(ts),
      signature: signIndependently(ID, ts, BODY, SECRET),
      body: BODY,
      secret: SECRET,
      nowMs: now + 5 * 24 * 60 * 60 * 1000,
    });
    expect(v).toEqual({ ok: false, reason: "stale" });
  });
});

// ---------------------------------------------------------------------------
// 2 — Reading the payload.
// ---------------------------------------------------------------------------
describe("payload accessors", () => {
  it("takes the email id from email_id, falling back to id", () => {
    expect(emailIdFrom({ data: { email_id: "e1" } })).toBe("e1");
    expect(emailIdFrom({ data: { id: "e2" } })).toBe("e2");
    expect(emailIdFrom({ data: {} })).toBeNull();
    expect(emailIdFrom({})).toBeNull();
  });

  it("normalises `to` whether it is a string or an array", () => {
    expect(recipientsFrom({ data: { to: "A@B.com" } })).toEqual(["a@b.com"]);
    expect(recipientsFrom({ data: { to: ["x@y.com", "Z@Y.com"] } })).toEqual([
      "x@y.com",
      "z@y.com",
    ]);
    expect(recipientsFrom({ data: { to: null } })).toEqual([]);
    expect(recipientsFrom({})).toEqual([]);
  });

  it("pulls the address out of a display-name header and drops a non-address", () => {
    expect(addressOnly("Jane Smith <Jane@Example.COM>")).toBe("jane@example.com");
    expect(addressOnly("  bare@example.com ")).toBe("bare@example.com");
    expect(addressOnly("no address here")).toBeNull();
    expect(addressOnly("")).toBeNull();
    expect(senderFrom({ data: { from: "Landlord <l@example.com>" } })).toBe("l@example.com");
  });

  it("treats an empty body as absent, which is what sets body_fetch_pending", () => {
    expect(bodyFrom({ data: { text: "hello" } })).toEqual({ text: "hello", html: null });
    expect(bodyFrom({ data: { text: "" } })).toEqual({ text: null, html: null });
    expect(bodyFrom({ data: {} })).toEqual({ text: null, html: null });
  });

  it("keeps the bounce reason, which is the only useful thing about a bounce", () => {
    expect(
      failureDetailFrom({
        data: { bounce: { message: "The recipient's mailbox is full.", type: "Transient" } },
      })
    ).toBe("The recipient's mailbox is full.");
    expect(failureDetailFrom({ data: { bounce: { type: "Permanent", subType: "NoEmail" } } })).toBe(
      "Permanent/NoEmail"
    );
    expect(failureDetailFrom({ data: {} })).toBeNull();
  });

  it("truncates a subject rather than failing the insert", () => {
    expect(subjectFrom({ data: { subject: "x".repeat(400) } })).toHaveLength(200);
    expect(subjectFrom({ data: {} })).toBeNull();
  });
});

describe("status rules", () => {
  it("maps each subscribed event to its own event_type", () => {
    for (const [type, event] of [
      ["email.sent", "sent"],
      ["email.delivered", "delivered"],
      ["email.delivery_delayed", "delivery_delayed"],
      ["email.opened", "opened"],
      ["email.clicked", "clicked"],
      ["email.bounced", "bounced"],
      ["email.complained", "complained"],
      ["email.failed", "failed"],
    ] as const) {
      expect(statusRuleFor(type)?.event).toBe(event);
    }
  });

  it("returns nothing for an event we do not handle", () => {
    expect(statusRuleFor("email.received")).toBeNull();
    expect(statusRuleFor("domain.updated")).toBeNull();
    expect(statusRuleFor(undefined)).toBeNull();
  });

  /**
   * ⚠️ 0116: an open is never a fact — Apple Mail Privacy Protection loads the
   * pixel unconditionally, so a prefetch and a human are indistinguishable.
   * Moving the message's status on that would put a claim on the operator's
   * screen the evidence does not support.
   */
  it("does NOT move the status on an open or a click", () => {
    expect(statusRuleFor("email.opened")?.status).toBeNull();
    expect(statusRuleFor("email.clicked")?.status).toBeNull();
    expect(statusRuleFor("email.opened")?.stamp).toBe("first_opened_at");
    expect(statusRuleFor("email.clicked")?.stamp).toBe("first_clicked_at");
  });

  it("does not move the status on a delay — the message is still in flight", () => {
    expect(statusRuleFor("email.delivery_delayed")?.status).toBeNull();
  });
});

describe("advanceStatus", () => {
  it("moves forwards", () => {
    expect(advanceStatus("queued", "sent")).toBe("sent");
    expect(advanceStatus("sent", "delivered")).toBe("delivered");
  });

  it("NEVER moves backwards, however the events are ordered", () => {
    expect(advanceStatus("delivered", "sent")).toBeNull();
    expect(advanceStatus("delivered", "delivered")).toBeNull();
    expect(advanceStatus("bounced", "delivered")).toBeNull();
  });

  /** An async bounce after a delivery notice is real, and it is the fact that matters. */
  it("lets a late bounce overwrite a delivery", () => {
    expect(advanceStatus("delivered", "bounced")).toBe("bounced");
    expect(advanceStatus("sent", "complained")).toBe("complained");
  });

  it("leaves an unranked status alone rather than rewriting it", () => {
    // `received` is an inbound message, not a send in progress.
    expect(advanceStatus("received", "delivered")).toBeNull();
    expect(advanceStatus("skipped", "sent")).toBeNull();
  });

  it("is a no-op for an event that carries no status", () => {
    expect(advanceStatus("sent", null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3 — The ingest, at the joins.
// ---------------------------------------------------------------------------
const CUSTOMER = "cus-1";
const DOMAIN = { domain: "leads.example.co.uk", reply_local_prefix: "reply" };

interface Tables {
  lead_messages?: Record<string, unknown>[];
  lead_message_threads?: Record<string, unknown>[];
}

interface Writes {
  inserts: { table: string; row: Record<string, unknown> }[];
  updates: { table: string; patch: Record<string, unknown> }[];
}

/**
 * Answers only the queries this code actually makes, and matches on EVERY
 * filter it was given — which is the point. A fake that ignored `customer_id`
 * would pass the containment cases below while the real thing leaked one
 * customer's events into another's messages.
 */
function fakeAdmin(tables: Tables) {
  const writes: Writes = { inserts: [], updates: [] };

  class Q {
    filters: Record<string, unknown> = {};
    op: "select" | "insert" | "update" = "select";
    row: Record<string, unknown> = {};
    patch: Record<string, unknown> = {};
    constructor(public table: string) {}

    select() {
      return this;
    }
    eq(k: string, v: unknown) {
      this.filters[k] = v;
      return this;
    }
    insert(row: Record<string, unknown>) {
      this.op = "insert";
      this.row = row;
      return this;
    }
    update(patch: Record<string, unknown>) {
      this.op = "update";
      this.patch = patch;
      return this;
    }
    maybeSingle() {
      return this.run();
    }
    then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
      return this.run().then(res, rej);
    }

    async run() {
      if (this.op === "insert") {
        writes.inserts.push({ table: this.table, row: this.row });
        return { data: null, error: null };
      }
      if (this.op === "update") {
        writes.updates.push({ table: this.table, patch: this.patch });
        return { data: null, error: null };
      }
      const rows = (tables[this.table as keyof Tables] ?? []) as Record<string, unknown>[];
      const hit = rows.find((r) =>
        Object.entries(this.filters).every(([k, v]) => r[k] === v)
      );
      return { data: hit ?? null, error: null };
    }
  }

  return {
    admin: { from: (table: string) => new Q(table) } as never,
    writes,
  };
}

beforeEach(() => stopRuns.mockClear());

describe("status events", () => {
  const delivered = (emailId: string): ResendWebhookPayload => ({
    type: "email.delivered",
    created_at: "2026-09-03T10:00:00Z",
    data: { email_id: emailId, created_at: "2026-09-03T10:00:00Z" },
  });

  it("advances a message we hold, and records the event", async () => {
    const { admin, writes } = fakeAdmin({
      lead_messages: [
        {
          id: "m1",
          customer_id: CUSTOMER,
          provider: "resend",
          provider_message_id: "e1",
          status: "sent",
          delivered_at: null,
        },
      ],
    });

    const r = await ingestResendEvent(admin, {
      customerId: CUSTOMER,
      domain: DOMAIN,
      payload: delivered("e1"),
      claimId: "resend:svix-1",
    });

    expect(r).toEqual({ outcome: "stored", kind: "status" });
    expect(writes.inserts[0].table).toBe("lead_message_events");
    expect(writes.inserts[0].row).toMatchObject({
      message_id: "m1",
      event_type: "delivered",
      provider_event_id: "resend:svix-1",
    });
    expect(writes.updates[0].patch).toMatchObject({
      status: "delivered",
      delivered_at: "2026-09-03T10:00:00Z",
    });
  });

  /**
   * ⚠️ THE CONTAINMENT CASE. The email id is the one identifier that arrives
   * from outside, so an unscoped lookup on it is exactly how customer A's
   * webhook would mark customer B's message delivered.
   */
  it("REFUSES an event for a message belonging to another customer", async () => {
    const { admin, writes } = fakeAdmin({
      lead_messages: [
        {
          id: "m1",
          customer_id: "someone-else",
          provider: "resend",
          provider_message_id: "e1",
          status: "sent",
        },
      ],
    });

    const r = await ingestResendEvent(admin, {
      customerId: CUSTOMER,
      domain: DOMAIN,
      payload: delivered("e1"),
      claimId: "resend:svix-2",
    });

    expect(r).toEqual({ outcome: "dropped", reason: "no_matching_message" });
    expect(writes.inserts).toHaveLength(0);
    expect(writes.updates).toHaveLength(0);
  });

  it("drops an event about mail sent outside this system", async () => {
    const { admin } = fakeAdmin({ lead_messages: [] });
    const r = await ingestResendEvent(admin, {
      customerId: CUSTOMER,
      domain: DOMAIN,
      payload: delivered("unknown"),
      claimId: "resend:svix-3",
    });
    expect(r).toEqual({ outcome: "dropped", reason: "no_matching_message" });
  });

  it("records a late `sent` without walking the message back from delivered", async () => {
    const { admin, writes } = fakeAdmin({
      lead_messages: [
        {
          id: "m1",
          customer_id: CUSTOMER,
          provider: "resend",
          provider_message_id: "e1",
          status: "delivered",
          sent_at: "2026-09-03T09:00:00Z",
        },
      ],
    });

    await ingestResendEvent(admin, {
      customerId: CUSTOMER,
      domain: DOMAIN,
      payload: { type: "email.sent", data: { email_id: "e1" } },
      claimId: "resend:svix-4",
    });

    // The event row is still written — it happened — but nothing on the message
    // moves: the status would regress and the stamp is already set.
    expect(writes.inserts[0].row).toMatchObject({ event_type: "sent" });
    expect(writes.updates).toHaveLength(0);
  });

  it("stamps a first open once and never re-stamps it", async () => {
    const already = fakeAdmin({
      lead_messages: [
        {
          id: "m1",
          customer_id: CUSTOMER,
          provider: "resend",
          provider_message_id: "e1",
          status: "delivered",
          first_opened_at: "2026-09-03T08:00:00Z",
        },
      ],
    });
    await ingestResendEvent(already.admin, {
      customerId: CUSTOMER,
      domain: DOMAIN,
      payload: { type: "email.opened", data: { email_id: "e1", created_at: "2026-09-03T11:00:00Z" } },
      claimId: "resend:svix-5",
    });
    // The repeat open is recorded as its own row and the first-open stamp stands.
    expect(already.writes.inserts[0].row).toMatchObject({ event_type: "opened" });
    expect(already.writes.updates).toHaveLength(0);
  });

  it("keeps the bounce reason on the message", async () => {
    const { admin, writes } = fakeAdmin({
      lead_messages: [
        {
          id: "m1",
          customer_id: CUSTOMER,
          provider: "resend",
          provider_message_id: "e1",
          status: "sent",
        },
      ],
    });

    await ingestResendEvent(admin, {
      customerId: CUSTOMER,
      domain: DOMAIN,
      payload: {
        type: "email.bounced",
        data: { email_id: "e1", bounce: { message: "Mailbox does not exist", type: "Permanent" } },
      },
      claimId: "resend:svix-6",
    });

    expect(writes.updates[0].patch).toMatchObject({
      status: "bounced",
      error_code: "bounced",
      error_detail: "Mailbox does not exist",
    });
  });

  it("acknowledges an event type we never subscribed to", async () => {
    const { admin, writes } = fakeAdmin({});
    const r = await ingestResendEvent(admin, {
      customerId: CUSTOMER,
      domain: DOMAIN,
      payload: { type: "domain.updated", data: {} },
      claimId: "resend:svix-7",
    });
    expect(r).toEqual({ outcome: "dropped", reason: "unhandled_type:domain.updated" });
    expect(writes.inserts).toHaveLength(0);
  });
});

describe("email.received", () => {
  const THREAD = "11111111-2222-3333-4444-555555555555";
  const token = mintThreadToken(THREAD) as string;

  const thread = (over: Record<string, unknown> = {}) => ({
    id: THREAD,
    customer_id: CUSTOMER,
    channel: "email",
    thread_token: token,
    assignment_id: "a1",
    lead_id: "l1",
    counterparty_email: "landlord@example.com",
    unread_inbound_count: 0,
    ...over,
  });

  const reply = (to: string | string[]): ResendWebhookPayload => ({
    type: "email.received",
    data: {
      email_id: "in-1",
      from: "Landlord <landlord@example.com>",
      to,
      subject: "Re: your enquiry",
      text: "Yes, please call me tomorrow.",
      created_at: "2026-09-03T12:00:00Z",
    },
  });

  it("files a reply into the thread named by its reply-address token", async () => {
    const { admin, writes } = fakeAdmin({ lead_message_threads: [thread()] });

    const r = await ingestResendEvent(admin, {
      customerId: CUSTOMER,
      domain: DOMAIN,
      payload: reply(`reply-${token}@leads.example.co.uk`),
      claimId: "resend:svix-8",
    });

    expect(r).toEqual({ outcome: "stored", kind: "inbound" });
    expect(writes.inserts[0].row).toMatchObject({
      thread_id: THREAD,
      customer_id: CUSTOMER,
      assignment_id: "a1",
      channel: "email",
      direction: "inbound",
      status: "received",
      // 0116: on an inbound row these columns hold the COUNTERPARTY, not us.
      to_address: "landlord@example.com",
      body_text: "Yes, please call me tomorrow.",
      body_fetch_pending: false,
    });
    expect(writes.updates[0].patch).toMatchObject({ unread_inbound_count: 1 });
  });

  it("matches the token whatever case the mail server hands it back in", async () => {
    const { admin } = fakeAdmin({ lead_message_threads: [thread()] });
    const r = await ingestResendEvent(admin, {
      customerId: CUSTOMER,
      domain: DOMAIN,
      payload: reply(`REPLY-${token.toUpperCase()}@LEADS.EXAMPLE.CO.UK`),
      claimId: "resend:svix-9",
    });
    expect(r).toEqual({ outcome: "stored", kind: "inbound" });
  });

  /** ⚠️ THE LANDLORD ANSWERED. STOP TALKING (§40.13). */
  it("stops any running follow-up sequence", async () => {
    const { admin } = fakeAdmin({ lead_message_threads: [thread()] });
    await ingestResendEvent(admin, {
      customerId: CUSTOMER,
      domain: DOMAIN,
      payload: reply(`reply-${token}@leads.example.co.uk`),
      claimId: "resend:svix-10",
    });
    expect(stopRuns).toHaveBeenCalledWith(expect.anything(), "a1", "replied");
  });

  it("flags a reply whose body did not arrive, and still stores it", async () => {
    const { admin, writes } = fakeAdmin({ lead_message_threads: [thread()] });
    const bodyless = reply(`reply-${token}@leads.example.co.uk`);
    delete bodyless.data!.text;

    const r = await ingestResendEvent(admin, {
      customerId: CUSTOMER,
      domain: DOMAIN,
      payload: bodyless,
      claimId: "resend:svix-11",
    });

    expect(r).toEqual({ outcome: "stored", kind: "inbound" });
    expect(writes.inserts[0].row).toMatchObject({ body_fetch_pending: true });
    // Losing the text must not lose the fact that they replied.
    expect(stopRuns).toHaveBeenCalled();
  });

  /**
   * ⚠️ CONTAINMENT AGAIN. A token is unguessable, but the receiver must not
   * rely on that alone: the thread lookup is scoped to the customer who owns
   * the RECEIVING DOMAIN, exactly as threadAddress.ts requires.
   */
  it("REFUSES a token belonging to another customer's thread", async () => {
    const { admin, writes } = fakeAdmin({
      lead_message_threads: [thread({ customer_id: "someone-else" })],
    });

    const r = await ingestResendEvent(admin, {
      customerId: CUSTOMER,
      domain: DOMAIN,
      payload: reply(`reply-${token}@leads.example.co.uk`),
      claimId: "resend:svix-12",
    });

    expect(r).toEqual({ outcome: "dropped", reason: "no_matching_thread" });
    expect(writes.inserts).toHaveLength(0);
    expect(stopRuns).not.toHaveBeenCalled();
  });

  /**
   * Right shape, right handle, WRONG MAC — and planted in the column, so the
   * row lookup succeeds and only `verifyThreadToken` can catch it.
   *
   * ⚠️ THE SENDER HAS TO BE A STRANGER FOR THIS TO TEST ANYTHING. Written with
   * the usual landlord address it PASSED, because the sender fallback found
   * their existing thread and stored the reply anyway — correctly, but with the
   * MAC check contributing nothing to the outcome. An unknown sender is what
   * leaves the token as the only route in.
   */
  it("REFUSES a forged token whose MAC does not check out", async () => {
    const forged = `${handleFor(THREAD)}z${"0".repeat(12)}`;
    const { admin, writes } = fakeAdmin({
      lead_message_threads: [thread({ thread_token: forged })],
    });

    const payload = reply(`reply-${forged}@leads.example.co.uk`);
    payload.data!.from = "stranger@elsewhere.com";

    const r = await ingestResendEvent(admin, {
      customerId: CUSTOMER,
      domain: DOMAIN,
      payload,
      claimId: "resend:svix-13",
    });

    expect(r).toEqual({ outcome: "dropped", reason: "no_matching_thread" });
    expect(writes.inserts).toHaveLength(0);
  });

  /**
   * The other half of the case above: with a VALID token that same stranger's
   * mail is filed, because the token is the operator's own cryptographic
   * assertion about which conversation this is — it survives the landlord
   * replying from a different address, which is the whole reason
   * threadAddress.ts makes it the primary route rather than the headers.
   */
  it("accepts a valid token even when the sender is not the address we wrote to", async () => {
    const { admin } = fakeAdmin({ lead_message_threads: [thread()] });

    const payload = reply(`reply-${token}@leads.example.co.uk`);
    payload.data!.from = "landlords-other-account@gmail.com";

    const r = await ingestResendEvent(admin, {
      customerId: CUSTOMER,
      domain: DOMAIN,
      payload,
      claimId: "resend:svix-13b",
    });

    expect(r).toEqual({ outcome: "stored", kind: "inbound" });
  });

  it("falls back to an EXISTING thread when the landlord replied to the plain address", async () => {
    const { admin, writes } = fakeAdmin({ lead_message_threads: [thread()] });

    const r = await ingestResendEvent(admin, {
      customerId: CUSTOMER,
      domain: DOMAIN,
      payload: reply("hello@leads.example.co.uk"),
      claimId: "resend:svix-14",
    });

    expect(r).toEqual({ outcome: "stored", kind: "inbound" });
    expect(writes.inserts[0].row).toMatchObject({ thread_id: THREAD });
  });

  /**
   * ⚠️ THE FALLBACK MAY FIND, NEVER CREATE. A `From` header is trivially
   * forged, so a stranger emailing the operator's domain must not be able to
   * bring a thread — or a lead binding — into existence.
   */
  it("drops mail from someone this customer has no conversation with", async () => {
    const { admin, writes } = fakeAdmin({ lead_message_threads: [thread()] });

    const stranger = reply("hello@leads.example.co.uk");
    stranger.data!.from = "spammer@elsewhere.com";

    const r = await ingestResendEvent(admin, {
      customerId: CUSTOMER,
      domain: DOMAIN,
      payload: stranger,
      claimId: "resend:svix-15",
    });

    expect(r).toEqual({ outcome: "dropped", reason: "no_matching_thread" });
    expect(writes.inserts).toHaveLength(0);
  });
});
