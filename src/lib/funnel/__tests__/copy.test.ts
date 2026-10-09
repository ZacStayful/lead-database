/**
 * The funnel's copy (batch 02 Phase 3).
 *
 * WHAT BREAKS IF THESE FAIL
 * -------------------------
 * A price on the plan screen that disagrees with the price Stripe charges is a
 * complaint on day one. The FAQ is a published claim to somebody about to pay:
 * the approved corrections (C4: "normally" up to three operators, one lead a
 * working day; C7: no replacement sentence) are what make it true, and the
 * discount expiry must be in UK time or it is an hour wrong for half the year.
 */
import { describe, expect, it } from "vitest";
import { PLANS } from "@/lib/plans";
import { RELEASE_RULE } from "@/lib/releaseCopy";
import { FUNNEL_COPY, FUNNEL_FAQ, FUNNEL_PLAN_PRICES, discountExpiry, planPriceLine } from "@/lib/funnel/copy";

describe("the plan prices", () => {
  it("are the Management plans' own prices", () => {
    expect(FUNNEL_PLAN_PRICES[10]).toBe(PLANS.lead_10.priceGbp);
    expect(FUNNEL_PLAN_PRICES[20]).toBe(PLANS.lead_20.priceGbp);
    expect(PLANS.lead_10.leads).toBe(10);
    expect(PLANS.lead_20.leads).toBe(20);
  });

  it("read as a plain line", () => {
    expect(planPriceLine(10)).toBe("10 leads a month, £150 a month");
    expect(planPriceLine(20)).toBe("20 leads a month, £300 a month");
  });
});

describe("discountExpiry", () => {
  it("is in UK time: an hour ahead of UTC in summer, equal in winter", () => {
    expect(discountExpiry("2026-10-10T09:00:00Z")).toBe("10:00 on 10 October");
    expect(discountExpiry("2026-12-10T09:00:00Z")).toBe("09:00 on 10 December");
  });

  it("is null for a date it cannot read", () => {
    expect(discountExpiry("nonsense")).toBeNull();
  });
});

describe("the FAQ (02 Phase 3, with C4 and C7)", () => {
  const all = FUNNEL_FAQ.map((f) => `${f.q} ${f.a}`).join("\n");

  it("asks the six questions the doc lists, in order", () => {
    expect(FUNNEL_FAQ.map((f) => f.q)).toEqual([
      "How many other operators get the same lead?",
      "Are these leads any good?",
      "How fast do leads arrive, and how do I contact them?",
      "What should I realistically expect?",
      "How is this different from running my own ads?",
      "What if it doesn't work for me?",
    ]);
  });

  it("C4: up to three operators, normally, and never 'a maximum' or 'never more'", () => {
    expect(FUNNEL_FAQ[0].a).toBe("Each lead normally goes to up to three operators at once.");
    expect(all).not.toMatch(/maximum of (two|three)/i);
    expect(all).not.toMatch(/never more/i);
  });

  it("C4: the speed answer is the release rule, never 'within minutes'", () => {
    expect(FUNNEL_FAQ[2].a.startsWith(RELEASE_RULE)).toBe(true);
    expect(all).not.toMatch(/within minutes/i);
  });

  it("C7: no replacement sentence", () => {
    expect(all).not.toMatch(/replace/i);
  });

  it("states the credit-based promise and nothing stronger", () => {
    expect(FUNNEL_FAQ[5].a).toContain("Every lead you pay for is delivered.");
    expect(all).not.toMatch(/guarantee/i);
  });

  it("C9: does not claim every lead is financially modelled", () => {
    expect(all).not.toMatch(/each one is financially modelled/i);
  });
});

describe("the preview's 'How your leads work' block", () => {
  it("is the doc's three points", () => {
    expect(FUNNEL_COPY.howPoints).toEqual([
      "Your leads are matched to what you've told us, best matches first.",
      "Every lead is labelled Top match, Strong match, First pick or Nearby opportunity, with a “Why you got this lead” explanation.",
      "Every lead you pay for is delivered. If a month runs short, the balance carries forward.",
    ]);
  });
});

describe("nothing in the funnel's copy states a volume or a count", () => {
  it("no 'N leads in', no 'landlords enquire', no per-area figure", () => {
    const text = JSON.stringify(FUNNEL_COPY) + JSON.stringify(FUNNEL_FAQ);
    expect(text).not.toMatch(/\d+ leads? (in|from|near)\b/i);
    expect(text).not.toMatch(/\d+ landlords/i);
    expect(text).not.toMatch(/\bper area\b/i);
  });
});
