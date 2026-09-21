import { describe, expect, it } from "vitest";
import {
  MAX_DEPTH,
  MAX_QUESTIONS,
  answersComplete,
  canSimplify,
  collectAnswers,
  maxSimplify,
  normaliseQuestions,
  normaliseSimplified,
  simplifySpent,
  terminalQuestion,
  type Question,
} from "../schemas";
import { MAX_DEPTH as FEEDBACK_MAX_DEPTH } from "@/lib/feedback/schemas";
import { AD_MAX_DEPTH } from "../copy";
import { fallbackQuestionnaire, fallbackTemplate } from "../fallback";
import { resolveSlots } from "../resolveSlots";
import { templateById } from "../templates";
import type { Customer } from "@/lib/types";

const T8 = templateById("years-properties-review")!;
const T3 = templateById("never-see-the-messages")!;

const q = (over: Partial<Question> = {}): Question => ({
  id: "q1", question: "x", options: [], allowOther: true, depth: 0, calls: 0, ...over,
});

function customer(over: Record<string, unknown> = {}): Customer {
  return {
    id: "c1", business_name: "Adco Ltd", email: "z@x.com", ad_profile: {},
    filter_status: "off", gr_filter_status: "off", filter_areas: null, gr_filter_areas: null,
    ...over,
  } as unknown as Customer;
}

describe("⚠️ the depth constant is stated in three places and must agree", () => {
  it("matches §50's, which ClarifyStep.tsx already restates unpinned", () => {
    expect(AD_MAX_DEPTH).toBe(FEEDBACK_MAX_DEPTH);
    expect(MAX_DEPTH).toBe(AD_MAX_DEPTH);
  });
});

describe("⚠️ the simplify budget scales, where §50's is flat", () => {
  it("grows with the question count", () => {
    // A template can ask eight slot questions where a ticket asks three, and a
    // flat six is exhausted by the first four rewordings.
    expect(maxSimplify(4)).toBe(4);
    expect(maxSimplify(10)).toBe(10);
    expect(maxSimplify(1)).toBe(2);
    expect(maxSimplify(0)).toBe(2);
  });

  it("⚠️ charges MODEL CALLS, not depth — a free drop to terminal costs nothing", () => {
    // §50 sums depth, which bills two units for zero model calls every time a
    // question drops straight to terminal because there was no key.
    const free = normaliseSimplified(null, q(), false);
    expect(free.depth).toBe(MAX_DEPTH);
    expect(free.calls).toBe(0);
    expect(simplifySpent([free])).toBe(0);

    const paid = normaliseSimplified({ question: "simpler?", options: ["a", "b"], allow_other: false }, q(), true);
    expect(paid.calls).toBe(1);
    expect(simplifySpent([paid])).toBe(1);
  });

  it("stops once the budget is gone, and only then", () => {
    const four = [q({ id: "q1" }), q({ id: "q2" }), q({ id: "q3" }), q({ id: "q4" })];
    expect(canSimplify(four)).toBe(true);
    expect(canSimplify(four.map((x) => ({ ...x, calls: 1 })))).toBe(false); // 4 spent of 4
    expect(canSimplify([q({ calls: 99 })])).toBe(false);
  });

  it("ignores a corrupted call count rather than going negative", () => {
    expect(simplifySpent([q({ calls: -5 }), q({ calls: Number.NaN })])).toBe(0);
  });
});

describe("⚠️ terminality is enforced, never requested", () => {
  it("a second simplify always lands on a plain text box", () => {
    const once = normaliseSimplified({ question: "a", options: ["x", "y"], allow_other: false }, q(), true);
    expect(once.depth).toBe(1);
    const twice = normaliseSimplified({ question: "b", options: ["p", "q", "r", "s"], allow_other: false }, once, true);
    // A model returning another four-way choice at the bottom would strand a
    // customer in front of a compulsory question with no skip.
    expect(twice.depth).toBe(MAX_DEPTH);
    expect(twice.options).toEqual([]);
    expect(twice.allowOther).toBe(true);
    expect(twice.question).toContain("In your own words");
  });

  it("keeps the question id through the whole ladder", () => {
    const start = q({ id: "q3", question: "original" });
    const next = normaliseSimplified({ question: "simpler", options: ["a", "b"], allow_other: false }, start, true);
    expect(next.id).toBe("q3");
    expect(terminalQuestion("q3", "original", 2).id).toBe("q3");
  });

  it("falls to terminal on anything unusable", () => {
    for (const bad of [null, "text", {}, { question: "   " }, []]) {
      expect(normaliseSimplified(bad, q(), true).depth).toBe(MAX_DEPTH);
    }
  });
});

describe("normalising a question set", () => {
  const set = (over: Record<string, unknown> = {}) => ({
    template_id: "years-properties-review",
    reason: "They have the numbers to do it.",
    questions: [
      { question: "How many years?", options: ["1-3", "4-9", "10+"], allow_other: true, slot: "years_trading" },
      { question: "How many properties?", options: [], allow_other: true, slot: "properties_managed" },
    ],
    ...over,
  });

  it("keeps a recognised template and drops an invented one", () => {
    expect(normaliseQuestions(set())?.templateId).toBe("years-properties-review");
    expect(normaliseQuestions(set({ template_id: "your-worst-case" }))?.templateId).toBeNull();
  });

  it("gives stable ids and starts every question at depth 0 with 0 calls", () => {
    const out = normaliseQuestions(set())!;
    expect(out.questions.map((x) => x.id)).toEqual(["q1", "q2"]);
    expect(out.questions.every((x) => x.depth === 0 && x.calls === 0)).toBe(true);
  });

  it("turns a one-option question into a typed answer rather than dropping it", () => {
    const out = normaliseQuestions(set({ questions: [{ question: "Which?", options: ["only"], allow_other: false }] }))!;
    expect(out.questions[0].options).toEqual([]);
    expect(out.questions[0].allowOther).toBe(true);
  });

  it("drops a repeat and caps the count", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ question: `Q${i}`, options: [], allow_other: true }));
    expect(normaliseQuestions(set({ questions: many }))!.questions).toHaveLength(MAX_QUESTIONS);
    const dupes = [{ question: "Same", options: [], allow_other: true }, { question: "same", options: [], allow_other: true }];
    expect(normaliseQuestions(set({ questions: dupes }))!.questions).toHaveLength(1);
  });

  it("returns null when there is nothing renderable", () => {
    expect(normaliseQuestions(null)).toBeNull();
    expect(normaliseQuestions(set({ questions: [] }))).toBeNull();
    expect(normaliseQuestions(set({ questions: "nope" }))).toBeNull();
  });
});

describe("answers", () => {
  const qs = [q({ id: "q1" }), q({ id: "q2" })];
  it("is complete only when every question has one", () => {
    expect(answersComplete(qs, [{ id: "q1", question: "x", answer: "a", depth: 0 }])).toBe(false);
    expect(answersComplete(qs, [
      { id: "q1", question: "x", answer: "a", depth: 0 },
      { id: "q2", question: "x", answer: "b", depth: 0 },
    ])).toBe(true);
    expect(answersComplete([], [])).toBe(false);
  });

  it("drops anything unrecognised, blank or repeated", () => {
    expect(collectAnswers(qs, [
      { id: "q9", answer: "ghost" },
      { id: "q1", answer: "  " },
      { id: "q2", answer: "real" },
      { id: "q2", answer: "again" },
    ])).toEqual([{ id: "q2", question: "x", answer: "real", depth: 0 }]);
  });
});

describe("⚠️ the fallback questionnaire — an empty list is a FAILURE here", () => {
  it("asks about targeting first, then every missing slot", () => {
    const r = resolveSlots(customer(), T8);
    const qs = fallbackQuestionnaire(T8, r);
    expect(qs.length).toBeGreaterThan(3);
    expect(qs[0].question).toContain("town or city");
    const text = qs.map((x) => x.question).join(" ");
    expect(text).toContain("years");
    expect(text).toContain("properties");
    expect(text).toContain("reviews");
  });

  it("⚠️ SHRINKS as the profile fills — the whole promise of setup slots", () => {
    const empty = fallbackQuestionnaire(T8, resolveSlots(customer(), T8)).length;
    const filled = fallbackQuestionnaire(
      T8,
      resolveSlots(
        customer({
          filter_status: "active",
          filter_areas: ["LS"],
          ad_profile: {
            city: "Leeds", areas: "LS", years_trading: 8, properties_managed: 140,
            review_score: 4.9, review_count: 63, landing_url: "https://a.com",
          },
        }),
        T8
      )
    );
    expect(filled).toHaveLength(0);
    expect(empty).toBeGreaterThan(0);
  });

  it("asks the multi-select from the template's own vocabulary", () => {
    const qs = fallbackQuestionnaire(T3, resolveSlots(customer(), T3));
    const multi = qs.find((x) => x.question.includes("Only what you tick"));
    expect(multi).toBeDefined();
    expect(multi!.options).toEqual(["guest messaging", "cleaning", "linen", "pricing", "check-ins"]);
    expect(multi!.allowOther).toBe(false);
  });

  it("gives every question a stable id, depth 0 and no spend", () => {
    const qs = fallbackQuestionnaire(T8, resolveSlots(customer(), T8));
    expect(qs.map((x) => x.id)).toEqual(qs.map((_, i) => `q${i + 1}`));
    expect(qs.every((x) => x.depth === 0 && x.calls === 0)).toBe(true);
  });

  it("falls back to T7 with a reason a customer can read", () => {
    const { template, reason } = fallbackTemplate();
    expect(template.id).toBe("what-would-it-earn");
    expect(reason.length).toBeGreaterThan(20);
    expect(reason).not.toContain("{");
  });
});
