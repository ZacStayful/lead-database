import { describe, expect, it } from "vitest";
import {
  QUESTIONS_INSTRUCTIONS,
  SIMPLIFY_INSTRUCTIONS,
  SYNTHESIS_INSTRUCTIONS,
  questionsUser,
  simplifyUser,
  synthesisUser,
  systemFor,
} from "../prompts";
import { accountState } from "../accountState";
import type { Customer } from "@/lib/types";

const base = {
  id: "c1",
  business_name: "The Hosting Edit",
  subscription_status: "inactive",
  gr_subscription_status: "inactive",
  monthly_allocation: 20,
  gr_monthly_allocation: 10,
  lead_balance: 0,
  gr_lead_balance: 0,
  leads_received_this_month: 0,
  gr_leads_received_this_month: 0,
} as unknown as Customer;

const management = { ...base, subscription_status: "active", lead_balance: 7 } as Customer;
const grOnly = { ...base, gr_subscription_status: "active", gr_lead_balance: 0 } as Customer;

describe("the system block", () => {
  const blocks = systemFor(QUESTIONS_INSTRUCTIONS);

  it("puts the cache breakpoint after the pack and nowhere else", () => {
    // ⚠️ The pack is ~3k tokens and identical on every call of all three kinds.
    // A breakpoint in the wrong place, or a second one, means paying full price
    // for it on every single request.
    expect(blocks).toHaveLength(2);
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[1]).not.toHaveProperty("cache_control");
  });

  it("shares a byte-identical prefix across all three call types", () => {
    // This is the only reason the pack can afford to be large.
    const a = systemFor(QUESTIONS_INSTRUCTIONS)[0].text;
    const b = systemFor(SIMPLIFY_INSTRUCTIONS)[0].text;
    const c = systemFor(SYNTHESIS_INSTRUCTIONS)[0].text;
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});

describe("the questions instructions", () => {
  it("forbids the questions that make people feel stupid", () => {
    for (const banned of ["browser version", "console error", "reproduce it on demand"]) {
      expect(QUESTIONS_INSTRUCTIONS).toContain(banned);
    }
  });

  it("asks for the answer that becomes the acceptance criteria", () => {
    expect(QUESTIONS_INSTRUCTIONS).toContain("what 'working' would look like");
  });

  it("tells it to read the invariants before calling anything broken", () => {
    expect(QUESTIONS_INSTRUCTIONS).toContain("invariants");
    expect(QUESTIONS_INSTRUCTIONS).toContain("deliberate behaviour");
  });
});

describe("the simplify instructions", () => {
  it("rules out the lazy simplification", () => {
    expect(SIMPLIFY_INSTRUCTIONS).toContain("Do NOT rephrase with synonyms");
  });

  it("states plainly that the customer cannot escape the question", () => {
    expect(SIMPLIFY_INSTRUCTIONS).toContain("no skip control");
  });
});

describe("the synthesis instructions", () => {
  it("forbids inventing a file path", () => {
    expect(SYNTHESIS_INSTRUCTIONS).toContain("Never invent a path");
    expect(SYNTHESIS_INSTRUCTIONS).toContain("An empty list is better than a wrong one");
  });

  it("demands honesty about what is still unknown", () => {
    expect(SYNTHESIS_INSTRUCTIONS).toContain("could_not_determine");
    expect(SYNTHESIS_INSTRUCTIONS).toContain("An empty list should be rare");
  });
});

describe("what varies goes in the user turn", () => {
  it("carries the account state, which is what makes a question specific", () => {
    const user = questionsUser({
      kind: "bug",
      summary: "no leads",
      body: "nothing since Friday",
      page: "Priority",
      account: accountState(grOnly),
    });
    expect(user).toContain("Guaranteed Rent");
    expect(user).toContain("Priority");
    expect(user).toContain("nothing since Friday");
  });

  it("never leaks a customer into the cached half", () => {
    const pack = systemFor(QUESTIONS_INSTRUCTIONS)[0].text;
    expect(pack).not.toContain("The Hosting Edit");
  });

  it("hands the ticket history to synthesis, not to the questions", () => {
    const s = synthesisUser({
      kind: "feature",
      summary: "s",
      body: "b",
      page: null,
      account: accountState(management),
      answers: [{ id: "q1", question: "Where?", answer: "The list", depth: 1 }],
      history: "STF-0009 shipped in 0112",
    });
    expect(s).toContain("STF-0009 shipped in 0112");
    expect(s).toContain("simplified 1 time");
  });

  it("tells simplify which attempt this is", () => {
    const s = simplifyUser({
      question: { id: "q1", question: "Which?", options: ["a", "b"], allowOther: false, depth: 1 },
      summary: "s",
      body: "b",
      account: accountState(management),
    });
    expect(s).toContain("attempt 2 of 2");
  });
});

describe("accountState", () => {
  it("spells out an empty balance rather than leaving it to be inferred", () => {
    // The single most valuable line in the whole prompt: it is what turns
    // "leads have stopped" from a bug hunt into a billing answer.
    expect(accountState(grOnly)).toContain("Guaranteed Rent credits are at zero");
    expect(accountState(grOnly)).toContain("not a fault");
  });

  it("says which screens the customer cannot see", () => {
    expect(accountState(grOnly)).toContain("do NOT hold Management");
    expect(accountState(management)).toContain("do NOT hold Guaranteed Rent");
  });

  it("does not warn about a balance for a product they do not hold", () => {
    const state = accountState(management);
    expect(state).not.toContain("Guaranteed Rent credits are at zero");
  });

  it("carries no personal data", () => {
    const withPii = {
      ...management,
      contact_name: "Jane Doe",
      email: "jane@example.com",
      phone: "07700900123",
    } as Customer;
    const state = accountState(withPii);
    expect(state).not.toContain("Jane Doe");
    expect(state).not.toContain("jane@example.com");
    expect(state).not.toContain("07700900123");
  });

  it("tells the model to ask nothing account-specific when signed out", () => {
    expect(accountState(null)).toContain("NOT SIGNED IN");
  });
});
