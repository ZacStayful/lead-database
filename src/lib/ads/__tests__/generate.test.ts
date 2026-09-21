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

import { copyMaxTokens, generateCopy, generateQuestions, simplifyQuestion } from "../generate";
import type { ValidationContext } from "../validateAdCopy";
import { angleListFor } from "../prompts";
import { templateById } from "../templates";
import { GENERATION_STALE_MS } from "../session";
import type { Question } from "../schemas";

const t7 = templateById("what-would-it-earn")!;
const t8 = templateById("years-properties-review")!;

const ctx = (over: Partial<ValidationContext> = {}): ValidationContext => ({
  template: t7,
  slots: { company_name: "Acme Lets", landing_url: "https://acme.example/quote", city: "Leeds" },
  profile: {},
  targeting: { kind: "areas", areas: ["LS"] },
  example: { headline: "H", sub: "S" },
  ...over,
});

const body = (n: number) =>
  `Landlords with a property let out: this is short let management, angle ${n}. ` +
  "We look after it and send you the statement. Send the postcode and we will work it out.";

/** A whole response, one variant per angle the template offers. */
function reply(template = t7, over: (i: number) => Record<string, unknown> = () => ({})) {
  const angles = angleListFor(template, { slots: { properties_managed: "140" } });
  return {
    image_headline: "Landlords: what would your place actually do?",
    image_sub: "Send the postcode and we will work it out against your rent.",
    variants: angles.map((a, i) => ({
      angle_key: a.key,
      message: body(i),
      headline: `Angle ${i}`,
      description: `Ask about ${i}`,
      ...over(i),
    })),
  };
}

const goodCopy = reply();

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

  /**
   * ⚠️ A FLAT CEILING IS HOW FIVE ANGLES BECOME ONE. Default effort means the
   * budget covers the thinking as well as the output, and five primary texts is
   * roughly five times the output of one — at a flat 8,000 the answer is
   * TRUNCATED, `messages.parse` yields null, and the failure presents as "the
   * model wrote something generic" rather than as an error.
   */
  it("scales max_tokens with the number of angles asked for", async () => {
    expect(copyMaxTokens(5)).toBeGreaterThan(copyMaxTokens(1));
    parse.mockResolvedValue({ model: "m", usage: {}, parsed_output: goodCopy });
    await generateCopy({ ctx: ctx(), account: "a", answers: [], cta: "c", figures: [] });
    expect(parse.mock.calls[0][0].max_tokens).toBe(copyMaxTokens(angleListFor(t7).length));
  });

  /**
   * ⚠️ THE TWO TIMEOUTS MUST SUM TO LESS THAN THE STALE WINDOW. A killed lambda
   * leaves the draft in `generating`, and only the stale window can reclaim it
   * — so a budget that outran it would strand the operator on a spinner with
   * Retry refusing as `busy`.
   */
  it("cannot outlive the window that reclaims a stuck draft", async () => {
    parse.mockResolvedValue({ model: "m", usage: {}, parsed_output: goodCopy });
    await generateCopy({ ctx: ctx(), account: "a", answers: [], cta: "c", figures: [] });
    parse.mockResolvedValue({ model: "m", usage: {}, parsed_output: { variants: [] } });
    await generateCopy({ ctx: ctx(), account: "a", answers: [], cta: "c", figures: [] });
    const total = ctor.mock.calls
      .map(([o]) => (o as { timeout: number }).timeout)
      .reduce((a, b) => a + b, 0);
    expect(total).toBeLessThan(GENERATION_STALE_MS);
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
    expect(r.entries[0].promptVersion).toBe("ad_copy_v2");
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
   * with no clarification still sends; an ad with no answers cannot be
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
  it("returns every angle the model wrote when they pass", async () => {
    parse.mockResolvedValue({ model: "m", usage: {}, parsed_output: goodCopy });
    const r = await generateCopy({ ctx: ctx(), account: "a", answers: [], cta: "c", figures: [] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.copy.variants).toHaveLength(angleListFor(t7).length);
    expect(r.copy.variants[0].message).toBe(body(0));
    expect(r.copy.link_url).toBe("https://acme.example/quote");
    expect(r.copy.provenance.written).toBe(r.copy.provenance.offered);
  });

  /**
   * ⚠️ AND THE FIRST CALL ASKS FOR ALL OF THEM. Nothing asserted this, and a
   * mutation slicing the offered list to one survived the whole suite: the
   * fake returns five whatever the prompt says, and the validator is handed the
   * unsliced key list, so every behavioural test passed while the model was
   * being asked for a single angle. This is the assertion that sees it.
   */
  it("asks for every angle the template offers", async () => {
    parse.mockResolvedValue({ model: "m", usage: {}, parsed_output: goodCopy });
    await generateCopy({ ctx: ctx(), account: "a", answers: [], cta: "c", figures: [] });
    const text = parse.mock.calls[0][0].messages[0].content as string;
    const angles = angleListFor(t7, { slots: { properties_managed: "140" } });
    expect(angles.length).toBeGreaterThan(1);
    for (const a of angles) expect(text, a.key).toContain(a.key);
  });

  /**
   * ⚠️ THE RETRY ASKS ONLY FOR WHAT IT LOST. A retry that re-asks for all five
   * pays a second time for the four that were already good, and risks losing
   * them — which is why the rejection is per angle rather than per response.
   */
  it("retries only the refused angles, and keeps the rest", async () => {
    const angles = angleListFor(t7);
    parse
      .mockResolvedValueOnce({
        model: "m",
        usage: {},
        parsed_output: reply(t7, (i) =>
          i === 1 ? { message: `${body(1)} Typically around \u00A3950 a month.` } : {}
        ),
      })
      .mockResolvedValueOnce({
        model: "m",
        usage: {},
        parsed_output: {
          image_headline: "Landlords: what would your place actually do?",
          image_sub: "Send the postcode and we will work it out against your rent.",
          variants: [
            { angle_key: angles[1].key, message: body(91), headline: "H", description: "D" },
          ],
        },
      });

    const r = await generateCopy({ ctx: ctx(), account: "a", answers: [], cta: "c", figures: [] });
    expect(parse).toHaveBeenCalledTimes(2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.copy.variants).toHaveLength(angles.length);
    expect(r.copy.provenance.written).toBe(angles.length);

    // ⚠️ THE SECOND CALL ASKED FOR ONE ANGLE, NOT ALL OF THEM.
    const second = parse.mock.calls[1][0];
    const text = second.messages[0].content as string;
    expect(text).toContain("refused last time");
    expect(text).toContain(angles[1].key);
    expect(text).not.toContain(`\`${angles[0].key}\``);
    expect(second.max_tokens).toBe(copyMaxTokens(1));
  });

  /**
   * ⚠️ NOT AN AD. Both attempts failing used to return the template's own
   * default text, which the route stored and the page rendered under "the words
   * were drafted by AI". That is exactly what the owner judged as terrible:
   * production shows both calls recording `not_configured` and copy
   * byte-identical to T7's defaults.
   */
  it("writes nothing at all after two refusals", async () => {
    parse.mockResolvedValue({
      model: "m",
      usage: {},
      parsed_output: reply(t7, () => ({ message: `${body(0)} You will earn \u00A32,000 a month.` })),
    });
    const r = await generateCopy({ ctx: ctx(), account: "a", answers: [], cta: "c", figures: [] });
    expect(parse).toHaveBeenCalledTimes(2);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("rejected");
    expect(r.entries).toHaveLength(2);
  });

  it("⚠️ but keeps a partial ad rather than demanding all five", async () => {
    parse.mockResolvedValue({
      model: "m",
      usage: {},
      parsed_output: reply(t7, (i) => (i < 2 ? { description: "Powered by Stayful" } : {})),
    });
    const r = await generateCopy({ ctx: ctx(), account: "a", answers: [], cta: "c", figures: [] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.copy.provenance.written).toBe(angleListFor(t7).length - 2);
    expect(r.copy.provenance.written).toBeLessThan(r.copy.provenance.offered);
  });

  /**
   * ⚠️ A TIMEOUT IS NOT RETRIED. The first call has already spent two minutes
   * of a five-minute ceiling, and a provider that just timed out is the least
   * likely to answer inside seventy-five seconds.
   */
  it("does not retry a call that threw", async () => {
    parse.mockRejectedValue(new Error("timeout"));
    const r = await generateCopy({ ctx: ctx(), account: "a", answers: [], cta: "c", figures: [] });
    expect(parse).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("call_failed");
    expect(r.entries[0].rejectReason).toBe("call_failed");
  });

  it("⚠️ but a thrown RETRY keeps what the first attempt earned", async () => {
    parse
      .mockResolvedValueOnce({
        model: "m",
        usage: {},
        parsed_output: reply(t7, (i) => (i === 0 ? { description: "Powered by Stayful" } : {})),
      })
      .mockRejectedValueOnce(new Error("timeout"));
    const r = await generateCopy({ ctx: ctx(), account: "a", answers: [], cta: "c", figures: [] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.copy.variants).toHaveLength(angleListFor(t7).length - 1);
  });

  it("writes nothing with no key, without calling anything", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const r = await generateCopy({ ctx: ctx(), account: "a", answers: [], cta: "c", figures: [] });
    expect(parse).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("not_configured");
    expect(r.entries[0].rejectReason).toBe("not_configured");
  });

  /**
   * ⚠️ THE IMAGE IS ONE PAIR SHARED BY EVERY VARIANT, so an unusable pair falls
   * back to the template's example rather than throwing away five good texts —
   * and `provenance.image` is what stops that being silent.
   */
  it("falls back on the image alone, and says so", async () => {
    parse.mockResolvedValue({
      model: "m",
      usage: {},
      parsed_output: { ...goodCopy, image_headline: "We look after 400 properties.", image_sub: "x" },
    });
    const r = await generateCopy({ ctx: ctx(), account: "a", answers: [], cta: "c", figures: [] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.copy.image).toEqual({ headline: "H", sub: "S" });
    expect(r.copy.provenance.image).toBe("example");
    expect(r.copy.variants).toHaveLength(angleListFor(t7).length);
  });
});

/**
 * ⚠️ THE "every template's own default copy" SUITE IS GONE BECAUSE THE FIELDS
 * ARE. It asserted that `defaultPrimaryText` and its two siblings would survive
 * the validator with nothing ticked — a good test of a bad idea. What a
 * rejected generation collapsed to was an ad we stored, stamped with a model
 * id, and rendered under a line saying the AI had written it.
 */
