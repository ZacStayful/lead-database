import { describe, expect, it } from "vitest";
import {
  AD_PACK,
  CACHE_MINIMUM_TOKENS,
  COPY_INSTRUCTIONS,
  PROMPT_VERSIONS,
  QUESTIONS_INSTRUCTIONS,
  SIMPLIFY_INSTRUCTIONS,
  adPackTokenFloor,
  angleListFor,
  copyUser,
  questionsUser,
  simplifyUser,
  systemFor,
} from "../prompts";
import { AD_TEMPLATES, templateById } from "../templates";
import type { Question } from "../schemas";

const t8 = templateById("years-properties-review")!;
const t7 = templateById("what-would-it-earn")!;
const t6 = templateById("rules-keep-changing")!;

describe("the cached pack", () => {
  /**
   * ⚠️ THE MEASUREMENT, NOT THE ATTRIBUTE. Anthropic's cache silently ignores
   * a breakpoint under ~1024 tokens, so a test asserting `cache_control` is
   * present would pass while the cache did nothing whatever — which is exactly
   * the false confidence the plan for this feature warned about. The pack is
   * ~7.5 KB against §50's ~22 KB, so it was a live question rather than a
   * hypothetical one.
   */
  it("clears the cache minimum, pessimistically counted", () => {
    expect(adPackTokenFloor()).toBeGreaterThan(CACHE_MINIMUM_TOKENS);
  });

  /**
   * The actual figure, so a shrink is reported rather than silently costing
   * the cache. Headroom is under 50%, which is not a lot of pack to lose.
   */
  it("records what that figure actually is", () => {
    expect(adPackTokenFloor()).toBeGreaterThanOrEqual(1400);
    expect(AD_PACK.length).toBeGreaterThanOrEqual(7_000);
  });

  it("puts the breakpoint on the pack and nowhere else", () => {
    const blocks = systemFor("task");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toBe(AD_PACK);
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
    // ⚠️ The varying block must NOT be cached. Three instruction strings behind
    // one breakpoint is three cache writes and no reads.
    expect(blocks[1].cache_control).toBeUndefined();
  });

  it("is the same bytes on every call, or there is nothing to cache", () => {
    expect(systemFor("a")[0].text).toBe(systemFor("b")[0].text);
  });
});

describe("what the pack says", () => {
  it("carries the spec's two objections", () => {
    expect(AD_PACK).toContain("CERTAINTY objection");
    expect(AD_PACK).toContain("TIMING objection");
    expect(AD_PACK.toLowerCase()).toContain("worst case");
  });

  it("names every template and every angle, from the registry", () => {
    for (const t of AD_TEMPLATES) {
      expect(AD_PACK).toContain(t.id);
      for (const angle of t.angles) expect(AD_PACK).toContain(angle);
    }
  });

  /**
   * ⚠️ `pricing` IS THE ONE AMBIGUOUS TOKEN IN EITHER SERVICE VOCABULARY — as
   * a service it means managing the nightly rate, as English it means what the
   * operator charges. The validator keeps it strict; this is where the
   * ambiguity is designed out, so an advert never says "pricing" meaning the
   * fee and get refused for naming a service the customer does not sell.
   */
  it("tells the model to call their charge a fee, never a price", () => {
    expect(AD_PACK).toMatch(/Call the customer's own charge a \*\*fee\*\*/);
    expect(AD_PACK).toContain('never "pricing"');
  });

  it("states every rule the validator will reject on", () => {
    const lowered = AD_PACK.toLowerCase();
    for (const needle of [
      "never state a figure",
      "never say what a landlord will earn",
      "never state an occupancy rate",
      "never claim a market position",
      "never mention stayful",
      "never put a link",
      "never quote anybody",
      "never name a service",
    ]) {
      expect(lowered).toContain(needle);
    }
  });

  it("says the headline is not the model's to write", () => {
    expect(AD_PACK).toContain("YOU DO NOT WRITE THE HEADLINE");
  });

  it("gives T6 its legal warning where T6 is described", () => {
    const section = AD_PACK.slice(AD_PACK.indexOf(t6.id));
    expect(section).toContain(t6.footerLine!);
    expect(section.toLowerCase()).toContain("never give it");
  });
});

describe("the three shapes", () => {
  it("has one version string each", () => {
    const versions = Object.values(PROMPT_VERSIONS);
    expect(new Set(versions).size).toBe(versions.length);
    for (const v of versions) expect(v.length).toBeLessThanOrEqual(40);
  });

  it("keeps the pack out of the instructions", () => {
    for (const block of [QUESTIONS_INSTRUCTIONS, SIMPLIFY_INSTRUCTIONS, COPY_INSTRUCTIONS]) {
      expect(block).not.toContain(AD_PACK.slice(0, 200));
    }
  });
});

describe("the questions turn", () => {
  it("leads with their own words", () => {
    const text = questionsUser({ prompt: "Ad for landlords in Leeds", account: "BRIEF", forcedTemplate: null });
    expect(text).toContain("Ad for landlords in Leeds");
    expect(text).toContain("BRIEF");
    expect(text).not.toContain("already chosen");
  });

  /**
   * The switch route is answering a tap on a named angle. A turn that does not
   * say so invites the model to re-pick, and the operator's tap is lost.
   */
  it("names the template when the operator has chosen one", () => {
    const text = questionsUser({ prompt: "p", account: "a", forcedTemplate: t8 });
    expect(text).toContain("already chosen");
    expect(text).toContain(t8.id);
  });
});

describe("the simplify turn", () => {
  const q: Question = {
    id: "q1",
    question: "What is your fee basis?",
    options: ["Of gross", "Of net"],
    allowOther: false,
    depth: 0,
    calls: 0,
  };
  it("carries the question and the options it offered", () => {
    const text = simplifyUser({ question: q, account: "BRIEF" });
    expect(text).toContain("What is your fee basis?");
    expect(text).toContain("Of gross · Of net");
  });
});

describe("the copy turn", () => {
  const base = {
    account: "BRIEF",
    answers: [{ id: "q1", question: "How many?", answer: "140", depth: 0 }],
    fixed: { headline: "H", sub: "S" },
    cta: "Talk to us",
    figures: ["140 properties managed."],
  };

  it("shows the fixed headline and sub so they are not repeated", () => {
    const text = copyUser({ template: t7, ...base });
    expect(text).toContain("Headline: H");
    expect(text).toContain("Sub-line: S");
  });

  it("states the figures, or states that there are none", () => {
    expect(copyUser({ template: t7, ...base })).toContain("140 properties managed.");
    expect(copyUser({ template: t7, ...base, figures: [] })).toContain("states no numbers at all");
  });

  /**
   * ⚠️ A BARE "try again" PRODUCES THE SAME COPY WITH DIFFERENT ADJECTIVES.
   * The retry only earns its cost if it is told what was wrong, and in its own
   * terms — our rejection code must never reach the model.
   */
  it("feeds the refusal back in plain words, never as a code", () => {
    const text = copyUser({
      template: t7,
      ...base,
      rejection: { reason: "figure_not_in_slots", detail: "money 950" },
    });
    expect(text).toContain("last attempt was refused");
    expect(text).toContain("stated a number the customer never gave us");
    expect(text).not.toContain("figure_not_in_slots");
  });

  it("asks a rewrite for a different angle, showing the last one", () => {
    const text = copyUser({ template: t7, ...base, previousMessage: "The old advert." });
    expect(text).toContain("The old advert.");
    expect(text).toContain("DIFFERENT angle");
  });
});

/**
 * ⚠️ OMISSION IS THE FIRST LAYER AND THE ONLY ONE THAT CANNOT BE ARGUED WITH.
 * The spec offers "what landlords say, in their words if a quote is supplied";
 * offered without a quote, the model writes a plausible testimonial that
 * passes every other rule in the file.
 */
describe("T8's quote angle", () => {
  it("is not in the list a template is asked to choose from", () => {
    expect(angleListFor(t8)).toHaveLength(t8.angles.length - 1);
    expect(angleListFor(t8).join(" ")).not.toContain("in their words");
  });

  it("leaves the other templates' angles alone", () => {
    for (const t of AD_TEMPLATES) {
      if (t.id === "years-properties-review") continue;
      expect(angleListFor(t)).toEqual([...t.angles]);
    }
  });

  it("is what the copy turn actually offers", () => {
    const text = copyUser({
      template: t8,
      account: "a",
      answers: [],
      fixed: { headline: "H", sub: "S" },
      cta: "c",
      figures: [],
    });
    expect(text).not.toContain("in their words");
  });
});
