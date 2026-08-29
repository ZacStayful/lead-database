import { describe, expect, it } from "vitest";
import {
  DEFAULT_LEAD_COOLDOWN_HOURS,
  LEAD_COOLDOWN_MESSAGE,
  otherOperatorMessagedRecently,
} from "@/lib/messaging/contactLimits";

/**
 * The cross-operator cooldown (§40.12).
 *
 * 136 of 441 leads are held by two or more operators, 28 by three or more, one
 * by five — and none of them can see each other. Every other limit in this
 * feature is per customer and cannot ask this question.
 *
 * Half of what is tested here is the DISCLOSURE boundary rather than the
 * arithmetic: this is the only customer-agnostic read in the feature, and the
 * thing it must never do is tell operator A anything about operator B.
 */

const US = "customer-us";
const THEM = "customer-them";
const KEY = "700900123";

interface FakeRow {
  threadCustomer: string;
  /** Hours before "now" the message went out. */
  agoHours: number;
  status?: string;
  direction?: string;
}

/**
 * The smallest client that answers the two queries the module makes: a thread
 * lookup that is awaited, and a head-count over lead_messages. Built in the
 * shape service.test.ts uses — one chainable object with a `then` — and
 * extended with the operators this module actually needs (`in`, `neq`, `gte`,
 * and `{ count: "exact", head: true }`), which that file's fake does not carry.
 */
function fakeAdmin(rows: FakeRow[], opts: { failOn?: string } = {}) {
  const now = Date.now();
  function builder(table: string) {
    const eqs: Record<string, unknown> = {};
    const neqs: Record<string, unknown> = {};
    let gteAt: string | null = null;
    let inIds: string[] = [];
    let counting = false;

    const self = {
      select: (_cols: string, o?: { count?: string; head?: boolean }) => {
        counting = Boolean(o?.count);
        return self;
      },
      eq: (c: string, v: unknown) => { eqs[c] = v; return self; },
      neq: (c: string, v: unknown) => { neqs[c] = v; return self; },
      in: (_c: string, v: string[]) => { inIds = v; return self; },
      gte: (_c: string, v: string) => { gteAt = v; return self; },
      then: (resolve: (v: unknown) => unknown) => {
        if (opts.failOn === table) {
          return Promise.resolve({
            data: null, count: null, error: { message: "boom" },
          }).then(resolve);
        }
        if (table === "lead_message_threads") {
          const data = rows
            .map((r, i) => ({ row: r, id: `t${i}` }))
            .filter(({ row }) => row.threadCustomer !== neqs.customer_id)
            .map(({ id }) => ({ id }));
          return Promise.resolve({ data, error: null }).then(resolve);
        }
        // lead_messages head count
        const since = gteAt ? new Date(gteAt).getTime() : 0;
        const count = rows.filter((r, i) => {
          if (!inIds.includes(`t${i}`)) return false;
          if ((r.direction ?? "outbound") !== eqs.direction) return false;
          if ((r.status ?? "sent") === neqs.status) return false;
          return now - r.agoHours * 3600_000 >= since;
        }).length;
        return Promise.resolve({ count: counting ? count : null, error: null }).then(
          resolve
        );
      },
    };
    return self;
  }
  return { from: (t: string) => builder(t) } as never;
}

const run = (rows: FakeRow[], opts?: { failOn?: string }) =>
  otherOperatorMessagedRecently(fakeAdmin(rows, opts), {
    phoneKey: KEY,
    customerId: US,
    cooldownHours: DEFAULT_LEAD_COOLDOWN_HOURS,
  });

describe("the cooldown itself", () => {
  it("does not block when nobody else has this landlord", async () => {
    expect((await run([])).blocked).toBe(false);
  });

  it("blocks when another operator messaged inside the window", async () => {
    expect((await run([{ threadCustomer: THEM, agoHours: 2 }])).blocked).toBe(true);
  });

  it("does not block on the operator's OWN earlier message", async () => {
    // Otherwise a second follow-up to your own landlord blocks itself, which is
    // the per-customer limits' job and not this one's.
    expect((await run([{ threadCustomer: US, agoHours: 2 }])).blocked).toBe(false);
  });

  it("does not block once the window has passed", async () => {
    expect((await run([{ threadCustomer: THEM, agoHours: 30 }])).blocked).toBe(false);
  });

  it("ignores a FAILED send — it reached nobody", async () => {
    // Mirrors the existing daily cap, which excludes failures for the same
    // reason: a message that never arrived must not block anybody.
    expect(
      (await run([{ threadCustomer: THEM, agoHours: 1, status: "failed" }])).blocked
    ).toBe(false);
  });

  it("ignores an inbound message — a landlord replying is not us contacting", async () => {
    expect(
      (await run([{ threadCustomer: THEM, agoHours: 1, direction: "inbound" }])).blocked
    ).toBe(false);
  });

  it("does not block when the cooldown is switched off", async () => {
    const r = await otherOperatorMessagedRecently(
      fakeAdmin([{ threadCustomer: THEM, agoHours: 1 }]),
      { phoneKey: KEY, customerId: US, cooldownHours: 0 }
    );
    expect(r.blocked).toBe(false);
  });

  it("does not block a lead with no usable phone key", async () => {
    const r = await otherOperatorMessagedRecently(fakeAdmin([]), {
      phoneKey: "",
      customerId: US,
      cooldownHours: 24,
    });
    expect(r.blocked).toBe(false);
  });
});

describe("failure behaviour", () => {
  /**
   * FAILS OPEN, deliberately, and the opposite way to the send route's other
   * guards. Those protect the operator's own number; this one protects a
   * landlord from a second message. Refusing every send because one read failed
   * would take a paid feature down to prevent a duplicate.
   */
  it("does not block when the thread lookup errors", async () => {
    expect(
      (await run([{ threadCustomer: THEM, agoHours: 1 }], { failOn: "lead_message_threads" }))
        .blocked
    ).toBe(false);
  });

  it("does not block when the message count errors", async () => {
    expect(
      (await run([{ threadCustomer: THEM, agoHours: 1 }], { failOn: "lead_messages" }))
        .blocked
    ).toBe(false);
  });
});

/**
 * §19.7 removed previous-holder information from the pool row set entirely "so
 * no later UI change can reach for it", and 0075's header repeats it in SQL.
 * These two cases are that rule, pinned — so a future, well-meaning "tell them
 * when they can retry" fails the build instead of shipping a leak.
 */
describe("§19.7 — the block must disclose nothing about the other operator", () => {
  it("returns a verdict with exactly one key, and it is a boolean", async () => {
    const verdict = await run([{ threadCustomer: THEM, agoHours: 2 }]);
    expect(Object.keys(verdict)).toEqual(["blocked"]);
    expect(typeof verdict.blocked).toBe("boolean");
  });

  it("carries no digit anywhere in the message", () => {
    // "You can message them again after 4pm tomorrow", minus a cooldown anyone
    // can measure by experiment, IS the other operator's send time.
    expect(LEAD_COOLDOWN_MESSAGE).not.toMatch(/\d/);
  });

  it("names no time expression and no other operator", () => {
    expect(LEAD_COOLDOWN_MESSAGE).not.toMatch(
      /\b(hour|hours|minute|minutes|day|days|tomorrow|today|am|pm|later|soon|recent|recently|already)\b/i
    );
    expect(LEAD_COOLDOWN_MESSAGE).not.toMatch(/\b(operator|someone|somebody|another|else)\b/i);
  });

  it("still tells the operator what they CAN do", () => {
    // A refusal with no alternative reads as the product being broken.
    expect(LEAD_COOLDOWN_MESSAGE).toMatch(/call/i);
  });
});
