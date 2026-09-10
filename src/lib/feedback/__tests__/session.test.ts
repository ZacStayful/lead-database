import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_DEPTH, MAX_SIMPLIFY_PER_TICKET } from "../schemas";
import { canSimplify, simplifySpent, toStored, type StoredQuestion } from "../session";

const q = (over: Partial<StoredQuestion> = {}): StoredQuestion => ({
  id: "q1",
  question: "Which did you use?",
  options: ["Reject", "Discard"],
  allowOther: false,
  depth: 0,
  answer: null,
  ...over,
});

/**
 * The route's code, with comments AND the import block removed.
 *
 * Comments go because these files explain their own guards and a substring
 * check would otherwise pass on the explanation — the §46 boundary test learned
 * that one. Imports go because several assertions below compare the ORDER of
 * two calls, and an import names both of them at the top of the file, which
 * would make every ordering check trivially true.
 */
function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^import[\s\S]*?from\s+"[^"]+";$/gm, "");
}

describe("the simplification budget", () => {
  it("is counted from the stored depths, not from a counter", () => {
    // A separate counter column could desynchronise, and — worse — could be
    // advanced by a request. The only way to raise this is to have actually
    // been simplified.
    expect(simplifySpent([q({ depth: 2 }), q({ id: "q2", depth: 1 })])).toBe(3);
    expect(simplifySpent([])).toBe(0);
  });

  it("stops one question going below the floor", () => {
    expect(canSimplify([], q({ depth: MAX_DEPTH }))).toBe(false);
    expect(canSimplify([], q({ depth: MAX_DEPTH - 1 }))).toBe(true);
  });

  it("stops a ticket spending the whole budget on a ladder", () => {
    const spent = Array.from({ length: MAX_SIMPLIFY_PER_TICKET }, (_, i) =>
      q({ id: `q${i}`, depth: 1 })
    );
    expect(canSimplify(spent, q({ id: "fresh", depth: 0 }))).toBe(false);
  });

  it("marks fresh questions unanswered", () => {
    const stored = toStored([
      { id: "q1", question: "A?", options: ["a", "b"], allowOther: false, depth: 0 },
    ]);
    expect(stored[0].answer).toBeNull();
  });
});

/**
 * ⚠️ THE ROUTES ARE PINNED AGAINST THEIR OWN SOURCE, §42.8-style.
 *
 * Each assertion below is a property that removing the skip button depends on.
 * None of them can be checked by calling the handler without a database, and
 * all of them are one careless edit away from being untrue.
 */
describe("the simplify route can never dead-end a customer", () => {
  const ROUTE = source("src/app/api/feedback/clarify/simplify/route.ts");

  it("falls back to the terminal question when the budget is gone", () => {
    // Without this, a customer who has spent the budget taps "not sure" on a
    // compulsory question and gets nothing back.
    expect(ROUTE).toContain("terminalQuestion");
    expect(ROUTE).toContain("canSimplify");
  });

  it("reads the depth from storage, never from the request body", () => {
    // A client-supplied depth would let a crafted request loop the ladder and
    // bill the account for it.
    expect(ROUTE).not.toMatch(/body\.depth|depth:\s*body\./);
    expect(ROUTE).toContain("ticket.clarifications");
  });
});

describe("the answers route", () => {
  const ROUTE = source("src/app/api/feedback/[id]/answers/route.ts");

  it("enforces completeness server-side, not just with a disabled button", () => {
    expect(ROUTE).toContain("answersComplete");
  });

  it("is idempotent, so a double tap cannot send twice or synthesise twice", () => {
    expect(ROUTE).toContain('ticket.ai_status !== "awaiting_answers"');
  });

  it("sends the email even when synthesis failed", () => {
    // A model outage may cost the brief. It may never cost the request.
    //
    // The property is not "send comes after finalise" — an early return between
    // them satisfies that and still swallows the request. It is that NOTHING
    // returns between the two.
    const finalise = ROUTE.indexOf("finaliseTicket(");
    const send = ROUTE.indexOf("sendFeedbackEmail(");
    expect(finalise).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(finalise);
    expect(
      ROUTE.slice(finalise, send),
      "a return between finalising and sending means a failed synthesis eats the request"
    ).not.toContain("return");
  });
});

describe("the sweeper", () => {
  const ROUTE = source("src/app/api/cron/ticket-synthesis/route.ts");

  it("claims the row before sending, so two runs cannot double-email", () => {
    // The property is that the UPDATE which marks 'abandoned' is itself
    // conditional on the row still being 'awaiting_answers'. Measuring the
    // first occurrence of that guard would find the SCAN query instead, which
    // is always present and proves nothing.
    const mark = ROUTE.indexOf('ai_status: "abandoned"');
    const send = ROUTE.indexOf("sendFeedbackEmail(");
    expect(mark).toBeGreaterThan(-1);
    expect(mark).toBeLessThan(send);
    expect(
      ROUTE.slice(mark, send),
      "the claim must be conditional on the row still awaiting answers, or two runs both send"
    ).toContain('.eq("ai_status", "awaiting_answers")');
  });

  it("fails closed when CRON_SECRET is unset", () => {
    expect(ROUTE).toContain("Boolean(cronSecret)");
  });

  it("bounds one run, so a backlog cannot become an unbounded mail-out", () => {
    expect(ROUTE).toMatch(/limit\(BATCH\)/);
  });
});

describe("the public feedback route", () => {
  const ROUTE = source("src/app/api/feedback/route.ts");

  it("still logs the ticket before anything else can go wrong", () => {
    // §46's guarantee. §50 defers the SEND; it must never defer the INSERT.
    const insert = ROUTE.indexOf("logSupportTicket");
    const clarifyReturn = ROUTE.indexOf("clarify: true");
    expect(insert).toBeGreaterThan(-1);
    expect(clarifyReturn).toBeGreaterThan(insert);
  });

  it("only clarifies for a signed-in customer with a key configured", () => {
    expect(ROUTE).toContain("Boolean(context) && isClarifyConfigured()");
  });

  it("sends immediately when the insert failed, rather than waiting for questions", () => {
    expect(ROUTE).toContain("willClarify && ticket");
  });
});
