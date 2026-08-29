/**
 * The seven silent rules, pinned at the seam a second caller will use.
 *
 * `sendOneMessage` was lifted out of the send route so that a scheduled
 * sequence step walks the identical path. Everything it enforces — the daily
 * cap, the minimum interval, quiet hours, the cross-operator cooldown, and the
 * order they are applied in — used to live inside a route handler and had no
 * test at all: the route needed a session, a real database and a live
 * TimelinesAI workspace to reach.
 *
 * These cases stop BEFORE the thread and the provider. That is on purpose. A
 * fake elaborate enough to fake an insert, a thread and an HTTP send would be
 * testing the fake — the seam draft.test.ts already warns about — while the
 * decisions worth pinning are all made above it.
 *
 * ⚠️ The one that matters most is `quiet_hours` carrying `quietOpensAt`. The
 * manual path refuses because it has nowhere to defer to; a sequence step has a
 * schedule and moves its due time. One rule, two remedies — and the remedy is
 * only possible because the verdict carries the reopening time rather than
 * acting on it. Drop that field and sequences silently start refusing overnight
 * steps instead of rescheduling them.
 */
import { describe, it, expect, vi } from "vitest";

/**
 * The single sentinel for "every guard passed". Thread creation is stubbed to
 * fail, so a send that gets all the way through the limits reports
 * `thread_failed` and nothing reaches TimelinesAI. Asserting `not.toBe(...)` on
 * a specific refusal would pass just as well if the code fell over somewhere
 * else entirely; asserting the sentinel says which line it got to.
 */
vi.mock("../threads", () => ({ findOrCreateWhatsappThread: async () => null }));

import { sendOneMessage, type SendableAssignment } from "../sendOneMessage";

/** Mid-afternoon London, inside the default 09:00–20:00 window. */
const DAYTIME = new Date("2026-09-02T14:00:00Z");
/** 22:30 London. Outside it. */
const NIGHT = new Date("2026-09-02T21:30:00Z");

interface FakeState {
  whatsappStatus?: string | null;
  dailyCap?: number;
  minInterval?: number;
  /** Rows in system_settings; omit a key to exercise its fallback. */
  settings?: Record<string, string>;
  /** Outbound WhatsApps in the last 24h for this customer. */
  sentToday?: number;
  /** ISO of the last outbound send, or null for none. */
  lastSentAt?: string | null;
  /** Threads on this number belonging to OTHER customers. */
  foreignThreadIds?: string[];
  /** Outbound messages on those threads inside the cooldown window. */
  foreignRecentCount?: number;
}

/**
 * Answers exactly the queries made above the thread block, and throws on
 * anything past it — so a test that accidentally reaches the provider fails
 * loudly rather than passing on a stub.
 */
function fakeAdmin(state: FakeState) {
  function builder(table: string) {
    let head = false;
    const filters: Record<string, unknown> = {};
    const self: Record<string, unknown> = {};

    const chain = () => self;
    Object.assign(self, {
      select: (_cols: string, opts?: { head?: boolean }) => {
        if (opts?.head) head = true;
        return self;
      },
      eq: (c: string, v: unknown) => ((filters[c] = v), self),
      neq: chain,
      not: chain,
      gte: chain,
      order: chain,
      limit: chain,
      in: (c: string, v: unknown[]) => ((filters[c] = v), self),
      insert: () => {
        throw new Error(`unexpected insert into ${table}`);
      },
      update: () => {
        throw new Error(`unexpected update of ${table}`);
      },
      maybeSingle: async () => {
        if (table === "customer_whatsapp_connections") {
          if (!state.whatsappStatus) return { data: null, error: null };
          return {
            data: {
              id: "conn-1",
              status: state.whatsappStatus,
              token_ciphertext: "x",
              whatsapp_account_phone: "+447957516879",
              daily_send_cap: state.dailyCap ?? 40,
              min_send_interval_secs: state.minInterval ?? 45,
            },
            error: null,
          };
        }
        if (table === "lead_messages") {
          return { data: { sent_at: state.lastSentAt ?? null }, error: null };
        }
        if (table === "lead_message_threads") return { data: null, error: null };
        throw new Error(`unexpected maybeSingle on ${table}`);
      },
      then: (resolve: (v: unknown) => unknown) => {
        if (table === "system_settings") {
          const rows = Object.entries(state.settings ?? {}).map(([key, value]) => ({
            key,
            value,
          }));
          return Promise.resolve({ data: rows, error: null }).then(resolve);
        }
        if (table === "lead_messages") {
          // Two head counts share this table: the daily cap (filtered by
          // customer_id) and the cooldown (filtered by thread_id).
          const count = filters.thread_id
            ? (state.foreignRecentCount ?? 0)
            : (state.sentToday ?? 0);
          return Promise.resolve({ data: null, count, error: null }).then(resolve);
        }
        if (table === "lead_message_threads") {
          return Promise.resolve({
            data: (state.foreignThreadIds ?? []).map((id) => ({ id })),
            error: null,
          }).then(resolve);
        }
        if (head) return Promise.resolve({ count: 0, error: null }).then(resolve);
        return Promise.resolve({ data: [], error: null }).then(resolve);
      },
    });
    return self;
  }
  return { from: (t: string) => builder(t) } as never;
}

const ASSIGNMENT: SendableAssignment = {
  id: "assign-1",
  status: "new",
  closed_at: null,
  closed_reason: null,
  lead_id: "lead-1",
  leads: { lead_name: "Priya", email: null, phone: "07700900123" },
};

function send(state: FakeState, over: Partial<Parameters<typeof sendOneMessage>[1]> = {}) {
  return sendOneMessage(fakeAdmin(state), {
    customerId: "cust-1",
    assignment: ASSIGNMENT,
    channel: "whatsapp",
    text: "Hi Priya, quick question about the flat.",
    idempotencyKey: "tok-1",
    sentByUserId: "user-1",
    now: DAYTIME,
    ...over,
  });
}

const CONNECTED: FakeState = { whatsappStatus: "connected" };

/** What a send that cleared every guard reports, given the stubbed thread. */
const PASSED_GUARDS = "thread_failed";

describe("sendOneMessage — eligibility, before anything else", () => {
  it("refuses a rejected assignment with the assignmentSendable reason", async () => {
    const r = await send(CONNECTED, {
      assignment: { ...ASSIGNMENT, status: "rejected" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("not_sendable");
    expect(r.status).toBe(409);
  });

  it("refuses a closed assignment", async () => {
    const r = await send(CONNECTED, {
      assignment: { ...ASSIGNMENT, closed_at: "2026-08-01T00:00:00Z" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not_sendable");
  });

  it("refuses a lead with no phone number", async () => {
    const r = await send(CONNECTED, {
      assignment: { ...ASSIGNMENT, leads: { lead_name: "Priya", phone: null, email: null } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("no_recipient");
  });

  it("refuses when the connection is not connected", async () => {
    const r = await send({ whatsappStatus: "pending" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not_connected");
  });

  it("refuses a phone the identity rule cannot key on", async () => {
    const r = await send(CONNECTED, {
      assignment: { ...ASSIGNMENT, leads: { lead_name: "Priya", phone: "+0", email: null } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("bad_phone");
  });
});

describe("sendOneMessage — the limits the setup panel promises", () => {
  it("refuses at the daily cap", async () => {
    const r = await send({ ...CONNECTED, dailyCap: 40, sentToday: 40 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("daily_cap_reached");
      expect(r.status).toBe(429);
    }
  });

  it("allows one below the cap", async () => {
    const r = await send({ ...CONNECTED, dailyCap: 40, sentToday: 39 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(PASSED_GUARDS);
  });

  it("refuses inside the minimum interval, and says how long is left", async () => {
    const r = await send({
      ...CONNECTED,
      minInterval: 45,
      lastSentAt: new Date(DAYTIME.getTime() - 10_000).toISOString(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("too_soon");
      expect(r.retryAfterSeconds).toBe(35);
    }
  });

  it("does not fire the interval once it has elapsed", async () => {
    const r = await send({
      ...CONNECTED,
      minInterval: 45,
      lastSentAt: new Date(DAYTIME.getTime() - 60_000).toISOString(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(PASSED_GUARDS);
  });
});

describe("sendOneMessage — quiet hours", () => {
  it("refuses at night AND carries the time the window reopens", async () => {
    const r = await send(CONNECTED, { now: NIGHT });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("quiet_hours");
    expect(r.status).toBe(429);
    // This is what lets a sequence step reschedule rather than be refused.
    expect(r.quietOpensAt).toBeInstanceOf(Date);
    expect(r.quietOpensAt!.getTime()).toBeGreaterThan(NIGHT.getTime());
  });

  it("uses the settings rows when they are present", async () => {
    // A window that has already closed by 14:00 London.
    const r = await send({
      ...CONNECTED,
      settings: { messaging_quiet_start_hour: "9", messaging_quiet_end_hour: "12" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("quiet_hours");
  });

  it("falls back to the DEFAULT WINDOW when the settings rows are missing", async () => {
    // Not fail-open and not fail-closed: 14:00 is inside 09:00–20:00, so this
    // must get past quiet hours on no settings at all.
    const r = await send(CONNECTED);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(PASSED_GUARDS);
  });
});

describe("sendOneMessage — the cross-operator cooldown", () => {
  it("refuses when another operator messaged this landlord recently", async () => {
    const r = await send({
      ...CONNECTED,
      foreignThreadIds: ["thread-other"],
      foreignRecentCount: 1,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("lead_cooldown");
    // §19.7 reached by subtraction: the copy may name no time at all.
    expect(r.error).not.toMatch(/\d/);
  });

  it("does not fire when no other operator holds a thread on the number", async () => {
    const r = await send({ ...CONNECTED, foreignThreadIds: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(PASSED_GUARDS);
  });

  it("is disabled by a cooldown of zero hours", async () => {
    const r = await send({
      ...CONNECTED,
      settings: { messaging_lead_cooldown_hours: "0" },
      foreignThreadIds: ["thread-other"],
      foreignRecentCount: 5,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(PASSED_GUARDS);
  });
});

describe("sendOneMessage — the order of the guards", () => {
  it("checks eligibility before the connection", async () => {
    // A rejected assignment on an account with no WhatsApp connection at all
    // must report the settled outcome, not "connect WhatsApp" — the operator
    // would otherwise go and fix the wrong thing.
    const r = await send({}, { assignment: { ...ASSIGNMENT, status: "rejected" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not_sendable");
  });

  it("checks the daily cap before quiet hours", async () => {
    // At 22:30 and over the cap, the cap is the honest answer: coming back at
    // 9am will not help.
    const r = await send({ ...CONNECTED, dailyCap: 1, sentToday: 5 }, { now: NIGHT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("daily_cap_reached");
  });
});
