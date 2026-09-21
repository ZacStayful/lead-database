import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above every const, so the spy is hoisted with it.
const parse = vi.hoisted(() => vi.fn());
const ctor = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { parse };
    constructor(opts: unknown) {
      ctor(opts);
    }
  },
}));
vi.mock("@anthropic-ai/sdk/helpers/zod", () => ({ zodOutputFormat: () => ({ type: "json_schema" }) }));

import { defaultCopyFor, generateCopy, generateQuestions, simplifyQuestion } from "../generate";
import { validateAdCopy, type ValidationContext } from "../validateAdCopy";
import { AD_TEMPLATES, templateById } from "../templates";
import type { Question } from "../schemas";

const t7 = templateById("what-would-it-earn")!;
const t8 = templateById("years-properties-review")!;

const ctx = (over: Partial<ValidationContext> = {}): ValidationContext => ({
  template: t7,
  slots: { company_name: "Acme Lets", landing_url: "https://acme.example/quote", city: "Leeds" },
  profile: {},
  targeting: { kind: "areas", areas: ["LS"] },
  fixed: { headline: "H", sub: "S" },
  ...over,
});

const goodCopy = {
  message:
    "Landlords with a property let out: this is short let management. We look after it and " +
    "send you the statement. Send the postcode and we will work it out.",
  headline: "What would your property earn?",
  description: "Get your estimate",
};

const fallbackQuestions = (): Question[] => [
  { id: "q1", question: "Which town?", options: [], allowOther: true, slot: "city", depth: 0, calls: 0 },
];

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  parse.mockReset();
  ctor.mockReset();
});
afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

/**
 * ⚠️ THE SDK RETRIES TWICE BY DEFAULT, which turns one "60-second" call into
 * three plus backoff and walks through the function ceiling — leaving the
 * draft in `generating` with nobody to clear it. Asserted on every construction
 * rather than on one, because a single call site that forgets is the whole bug.
 */
describe("the client", () => {
  it("never lets the SDK retry, on any call", async () => {
    parse.mockResolvedValue({ model: "m", usage: {}, parsed_output: { question: "q", options: [], allow_other: true } });
    await simplifyQuestion({ question: fallbackQuestions()[0], account: "a" });
    parse.mockResolvedValue({ model: "m", usage: {}, parsed_output: goodCopy });
    await generateCopy({ ctx: ctx(), account: "a", answers: [], cta: "c", figures: [] });
    parse.mockResolvedValue({
      model: "m",
      usage: {},
      parsed_output: { template_id: t7.id, reason: "r", questions: [{ question: "Q?", options: ["a", "b"], allow_other: false, slot: "" }] },
    });
    await generateQuestions({ prompt: "p", account: "a", fallback: fallbackQuestions });

    expect(ctor).toHaveBeenCalled();
    for (const [opts] of ctor.mock.calls) {
      expect((opts as { maxRetries: number }).maxRetries).toBe(0);
      expect((opts as { timeout: number }).timeout).toBeGreaterThan(0);
    }
  });

  it("sets an explicit max_tokens every time", async () => {
    parse.mockResolvedValue({ model: "m", usage: {}, parsed_output: goodCopy });
    await generateCopy({ ctx: ctx(), account: "a", answers: [], cta: "c", figures: [] });
    for (const [req] of parse.mock.calls) {
      expect((req as { max_tokens?: number }).max_tokens).toBeGreaterThan(0);
    }
  });
});

describe("effort", () => {
  it("is low for questions and simplify, and default for the copy", async () => {
    parse.mockResolvedValue({
      model: "m",
      usage: {},
      parsed_output: { template_id: t7.id, reason: "r", questions: [{ question: "Q?", options: ["a", "b"], allow_other: false, slot: "" }] },
    });
    await generateQuestions({ prompt: "p", account: "a", fallback: fallbackQuestions });
    expect(parse.mock.calls[0][0].output_config.effort).toBe("low");

    parse.mockReset();
    parse.mockResolvedValue({ model: "m", usage: {}, parsed_output: { question: "q", options: [], allow_other: true } });
    await simplifyQuestion({ question: fallbackQuestions()[0], account: "a" });
    expect(parse.mock.calls[0][0].output_config.effort).toBe("low");

    parse.mockReset();
    parse.mockResolvedValue({ model: "m", usage: {}, parsed_output: goodCopy });
    await generateCopy({ ctx: ctx(), account: "a", answers: [], cta: "c", figures: [] });
    // ⚠️ The deliverable, after the operator has committed. The one call where
    // thinking earns its cost.
    expect(parse.mock.calls[0][0].output_config.effort).toBeUndefined();
  });
});

describe("the ledger entries a call earns", () => {
  it("takes model_id from the response, never from our constant", async () => {
    parse.mockResolvedValue({ model: "claude-something-else", usage: {}, parsed_output: goodCopy });
    const r = await generateCopy({ ctx: ctx(), account: "a", answers: [], cta: "c", figures: [] });
    expect(r.entries[0].modelId).toBe("claude-something-else");
  });

  /**
   * ⚠️ ZERO IS A CACHE MISS AND NULL IS THE PROVIDER SAYING NOTHING.
   * Collapsing them loses the one reading that would tell us the five-minute
   * window is not being hit in practice.
   */
  it("keeps a cache miss apart from a cache we could not read", async () => {
    parse.mockResolvedValue({ model: "m", usage: { cache_read_input_tokens: 0 }, parsed_output: goodCopy });
    expect((await generateCopy({ ctx: ctx(), account: "a", answers: [], cta: "c", figures: [] })).entries[0].cacheReadTokens).toBe(0);

    parse.mockResolvedValue({ model: "m", usage: { cache_read_input_tokens: 1800 }, parsed_output: goodCopy });
    expect((await generateCopy({ ctx: ctx(), account: "a", answers: [], cta: "c", figures: [] })).entries[0].cacheReadTokens).toBe(1800);

    parse.mockResolvedValue({ model: "m", usage: {}, parsed_output: goodCopy });
    expect((await generateCopy({ ctx: ctx(), account: "a", answers: [], cta: "c", figures: [] })).entries[0].cacheReadTokens).toBeNull();
  });

  it("carries the prompt version for the shape it used", async () => {
    parse.mockResolvedValue({ model: "m", usage: {}, parsed_output: goodCopy });
    const r = await generateCopy({ ctx: ctx(), account: "a", answers: [], cta: "c", figures: [] });
    expect(r.entries[0].promptVersion).toBe("ad_copy_v1");
  });
});

describe("questions", () => {
  it("returns the model's template when it picks a real one", async () => {
    parse.mockResolvedValue({
      model: "m",
      usage: {},
      parsed_output: { template_id: t8.id, reason: "You have the numbers for it.", questions: [{ question: "Q?", options: ["a", "b"], allow_other: false, slot: "" }] },
    });
    const r = await generateQuestions({ prompt: "p", account: "a", fallback: fallbackQuestions });
    expect(r!.template.id).toBe(t8.id);
    expect(r!.degraded).toBe(false);
  });

  /**
   * ⚠️ THE OPERATOR'S TAP OUTRANKS THE MODEL. The switch route is answering a
   * tap on a named angle; a model returning a different id there would
   * silently discard what they just asked for.
   */
  it("keeps the forced template even when the model names another", async () => {
    parse.mockResolvedValue({
      model: "m",
      usage: {},
      parsed_output: { template_id: t7.id, reason: "r", questions: [{ question: "Q?", options: ["a", "b"], allow_other: false, slot: "" }] },
    });
    const r = await generateQuestions({ prompt: "p", account: "a", forcedTemplate: t8, fallback: fallbackQuestions });
    expect(r!.template.id).toBe(t8.id);
    expect(r!.entries[0].kind).toBe("template");
  });

  /**
   * ⚠️ AN EMPTY QUESTION LIST IS SUCCESS IN §50 AND A DEAD END HERE. A ticket
   * with no clarification still sends; an advert with no answers cannot be
   * built at all, so every degraded path lands on a real questionnaire.
   */
  it.each([
    ["no key", async () => { delete process.env.ANTHROPIC_API_KEY; }],
    ["a thrown call", async () => { parse.mockRejectedValue(new Error("boom")); }],
    ["unparseable output", async () => { parse.mockResolvedValue({ model: "m", usage: {}, parsed_output: { questions: [] } }); }],
  ])("falls back to a real questionnaire on %s", async (_label, setup) => {
    await setup();
    const r = await generateQuestions({ prompt: "p", account: "a", fallback: fallbackQuestions });
    expect(r!.questions).toHaveLength(1);
    expect(r!.degraded).toBe(true);
    expect(r!.entries[0].outcome).toBe("error");
  });

  it("returns null rather than an empty form when there is nothing to ask", async () => {
    parse.mockRejectedValue(new Error("boom"));
    const r = await generateQuestions({ prompt: "p", account: "a", fallback: () => [] });
    expect(r).toBeNull();
  });
});

describe("simplify", () => {
  const q = fallbackQuestions()[0];

  it("never returns null, because there is no skip button", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const r = await simplifyQuestion({ question: q, account: "a" });
    expect(r.question.allowOther).toBe(true);
    expect(r.question.options).toEqual([]);
  });

  /**
   * ⚠️ §50's BUG, NOT COPIED. Its budget sums `depth`, so a free
   * drop-to-terminal — no key, a timeout, the budget already gone — charges
   * two units for zero model calls. `calls` counts what we actually spent.
   */
  it("charges nothing when no call was made", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const r = await simplifyQuestion({ question: q, account: "a" });
    expect(r.question.calls).toBe(0);
  });

  it("charges for a call that failed, because we still made it", async () => {
    parse.mockRejectedValue(new Error("timeout"));
    const r = await simplifyQuestion({ question: q, account: "a" });
    expect(r.question.calls).toBe(1);
    expect(r.entries[0].outcome).toBe("error");
  });
});

describe("the copy", () => {
  it("returns what the model wrote when it passes", async () => {
    parse.mockResolvedValue({ model: "m", usage: {}, parsed_output: goodCopy });
    const r = await generateCopy({ ctx: ctx(), account: "a", answers: [], cta: "c", figures: [] });
    expect(r.degraded).toBe(false);
    expect(r.copy.message).toBe(goodCopy.message);
    expect(r.copy.link_url).toBe("https://acme.example/quote");
  });

  /**
   * ⚠️ ONE RETRY, AND IT IS TOLD WHY. A bare "try again" produces the same
   * copy with different adjectives.
   */
  it("retries once with the refusal fed back, then accepts", async () => {
    parse
      .mockResolvedValueOnce({
        model: "m",
        usage: {},
        parsed_output: { ...goodCopy, message: `${goodCopy.message} Typically around £950 a month.` },
      })
      .mockResolvedValueOnce({ model: "m", usage: {}, parsed_output: goodCopy });

    const r = await generateCopy({ ctx: ctx(), account: "a", answers: [], cta: "c", figures: [] });
    expect(parse).toHaveBeenCalledTimes(2);
    expect(r.degraded).toBe(false);
    expect(r.entries.map((e) => e.outcome)).toEqual(["rejected", "ok"]);
    expect(r.entries[0].rejectReason).toBeTruthy();
    expect(r.entries[1].attempt).toBe(2);

    const second = parse.mock.calls[1][0].messages[0].content as string;
    expect(second).toContain("last attempt was refused");
  });

  it("falls back to the template's own words after two refusals", async () => {
    const bad = { ...goodCopy, message: `${goodCopy.message} You will earn £2,000 a month.` };
    parse.mockResolvedValue({ model: "m", usage: {}, parsed_output: bad });
    const r = await generateCopy({ ctx: ctx(), account: "a", answers: [], cta: "c", figures: [] });
    expect(parse).toHaveBeenCalledTimes(2);
    expect(r.degraded).toBe(true);
    expect(r.copy.message).toBe(t7.defaultPrimaryText);
    expect(r.entries).toHaveLength(2);
  });

  /**
   * ⚠️ A TIMEOUT IS NOT RETRIED. The first call has already spent 60 of a
   * 300-second ceiling, and a provider that just timed out is the least likely
   * to answer inside 45. Falling back leaves an advert on the screen.
   */
  it("does not retry a call that threw", async () => {
    parse.mockRejectedValue(new Error("timeout"));
    const r = await generateCopy({ ctx: ctx(), account: "a", answers: [], cta: "c", figures: [] });
    expect(parse).toHaveBeenCalledTimes(1);
    expect(r.degraded).toBe(true);
    expect(r.entries[0].rejectReason).toBe("call_failed");
  });

  it("falls back with no key, without calling anything", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const r = await generateCopy({ ctx: ctx(), account: "a", answers: [], cta: "c", figures: [] });
    expect(parse).not.toHaveBeenCalled();
    expect(r.copy.headline).toBe(t7.defaultHeadline);
  });
});

/**
 * ⚠️ THE FALLBACK IS WHAT WE PUBLISH WHEN EVERYTHING ELSE FAILED, so it has to
 * pass the rules it will be published under — with NOTHING ticked, which is
 * the state a brand new customer is in. A default that names cleaning would
 * advertise cleaning for somebody who does not do it.
 */
describe("every template's own default copy", () => {
  it.each(AD_TEMPLATES.map((t) => [t.id, t] as const))("%s survives an empty selection", (_id, t) => {
    const c = ctx({
      template: t,
      profile: {},
      slots: { company_name: "Acme", landing_url: "https://acme.example", years_trading: "8" },
    });
    const verdict = validateAdCopy(defaultCopyFor(c), c);
    expect(verdict.ok, verdict.ok ? "" : `${verdict.reason}: ${verdict.detail}`).toBe(true);
  });

  it("carries the template's own CTA and the resolved link", () => {
    const c = ctx({ template: t8 });
    expect(defaultCopyFor(c).call_to_action_type).toBe(t8.metaCta);
    expect(defaultCopyFor(c).link_url).toBe("https://acme.example/quote");
  });
});
