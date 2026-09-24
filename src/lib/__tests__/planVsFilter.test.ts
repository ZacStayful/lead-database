import { describe, it, expect } from "vitest";
import {
  BANKED_MONTHS,
  bankedCreditSentence,
  downgradeRelief,
  planGapSentence,
  planVsFilter,
  type PlanVsFilterUnder,
} from "@/lib/planVsFilter";

/**
 * ⚠️ THE FIXTURES ARE THE REAL PRODUCTION ROWS, read 2026-09-24, not invented
 * ones — and the list is chosen to defeat the UNIFORM-FIXTURE TRAP.
 *
 * §68 records eleven assertions in this repository written weak enough to
 * survive their own mutation, three of them last week, and one was exactly this
 * shape: every fixture giving every band the same count, so the rule under test
 * was never actually exercised. Here the equivalent is every fixture being
 * under plan — a mutation returning "under_plan" unconditionally then survives
 * untouched.
 *
 * So SIMON is in this list because he is `covered`, and JAMES because he is
 * under plan WITHOUT being banked. Those two separate the three verdicts and
 * the two halves of the `banked` threshold. Do not trim the list.
 */
const ROWS = {
  // £300/20 plan, forecast 1 a month at £300 a lead, 32 credits banked.
  allan: { allocation: 20, expected: 1, balance: 32, costPerLeadPence: 30000, acknowledged: true },
  // Never ticked — the §58.3 backfill wrote this figure.
  myles: { allocation: 20, expected: 5, balance: 28, costPerLeadPence: 6000, acknowledged: false },
  sarah: { allocation: 10, expected: 1, balance: 8, costPerLeadPence: 15000, acknowledged: true },
  // ⚠️ Under plan by ONE, 0.7 months banked — must stay silent.
  james: { allocation: 10, expected: 9, balance: 6, costPerLeadPence: 1667, acknowledged: true },
  michael: { allocation: 10, expected: 2, balance: 2, costPerLeadPence: 7500, acknowledged: false },
  hhe: { allocation: 10, expected: 5, balance: 2, costPerLeadPence: 3000, acknowledged: true },
  // ⚠️ Healthy: forecast covers the plan exactly.
  simon: { allocation: 20, expected: 20, balance: 8, costPerLeadPence: 1500, acknowledged: true },
} as const;

const under = (k: keyof typeof ROWS): PlanVsFilterUnder => {
  const v = planVsFilter(ROWS[k]);
  if (v.kind !== "under_plan") throw new Error(`${k} is ${v.kind}, expected under_plan`);
  return v;
};

describe("planVsFilter — the verdict", () => {
  it("reports a healthy filter as covered, not as a gap", () => {
    expect(planVsFilter(ROWS.simon).kind).toBe("covered");
  });

  it("reports a filter forecast above its plan as covered", () => {
    expect(planVsFilter({ ...ROWS.simon, expected: 25 }).kind).toBe("covered");
  });

  it.each([
    ["allan", 19],
    ["myles", 15],
    ["sarah", 9],
    ["james", 1],
    ["michael", 8],
    ["hhe", 5],
  ] as const)("computes %s's shortfall as %i a month", (key, shortfall) => {
    expect(under(key).shortfall).toBe(shortfall);
  });

  it("says no_figure rather than guessing when there is no stored forecast", () => {
    expect(planVsFilter({ ...ROWS.allan, expected: null }).kind).toBe("no_figure");
  });

  it("⚠️ no_figure and covered are different answers, never collapsed", () => {
    // "we cannot put a number on this" and "this covers your plan" are opposite
    // facts; collapsing them reassures the one customer we cannot reassure.
    expect(planVsFilter({ ...ROWS.allan, expected: null }).kind).not.toBe("covered");
  });

  it("says no_figure when there is no plan to compare against", () => {
    expect(planVsFilter({ ...ROWS.allan, allocation: 0 }).kind).toBe("no_figure");
  });
});

describe("planVsFilter — the banked threshold", () => {
  it("⚠️ stays silent for a customer under plan but barely banked", () => {
    const v = under("james");
    expect(v.monthsBanked).toBeCloseTo(6 / 9, 5);
    expect(v.banked).toBe(false);
    expect(bankedCreditSentence(v)).toBeNull();
  });

  it.each(["michael", "hhe"] as const)("stays silent for %s", (key) => {
    expect(under(key).banked).toBe(false);
  });

  it.each([
    ["allan", 32],
    ["sarah", 8],
  ] as const)("names %s's balance at %i months' worth", (key, months) => {
    const v = under(key);
    expect(v.monthsBanked).toBeCloseTo(months, 5);
    expect(v.banked).toBe(true);
  });

  it("fires exactly at the threshold, not one side of it", () => {
    const at = planVsFilter({ ...ROWS.allan, expected: 2, balance: 2 * BANKED_MONTHS });
    const below = planVsFilter({ ...ROWS.allan, expected: 2, balance: 2 * BANKED_MONTHS - 1 });
    expect(at.kind === "under_plan" && at.banked).toBe(true);
    expect(below.kind === "under_plan" && below.banked).toBe(false);
  });

  it("⚠️ never divides by zero on a filter forecast at nothing", () => {
    const v = planVsFilter({ ...ROWS.allan, expected: 0 });
    expect(v.kind).toBe("under_plan");
    expect(v.kind === "under_plan" && v.monthsBanked).toBeNull();
    expect(v.kind === "under_plan" && v.banked).toBe(false);
    expect(v.kind === "under_plan" && Number.isFinite(v.shortfall)).toBe(true);
  });
});

describe("planVsFilter — the copy rules", () => {
  const sentences = (["allan", "myles", "sarah", "james", "michael", "hhe"] as const)
    .flatMap((k) => [planGapSentence(under(k)), bankedCreditSentence(under(k))])
    .filter((s): s is string => s != null);

  it("⚠️ always says 'at least', never a bare forecast number", () => {
    // The figure is a lower bound at FORECAST_CONFIDENCE, missed about one
    // month in six by construction (§28.0).
    for (const k of ["allan", "myles", "sarah", "james", "michael", "hhe"] as const) {
      expect(planGapSentence(under(k))).toContain("at least");
    }
  });

  it.each([
    "refund",
    "credited back",
    "credit back",
    "money back",
    "compensat",
    "reimburs",
    "make it good",
    "put it right",
    "owe you back",
  ])("⚠️ never offers or implies a refund (%s)", (banned) => {
    // types.ts, of these very columns: "nothing settles a shortfall against it,
    // and no copy reading these may offer to".
    for (const s of sentences) expect(s.toLowerCase()).not.toContain(banned);
  });

  it.each(["you agreed", "you accepted", "as agreed", "you signed up for"])(
    "⚠️ never claims they agreed to the figure (%s)",
    (banned) => {
      // Two of the eight live filtered customers never ticked; the backfill
      // wrote their figure.
      for (const s of sentences) expect(s.toLowerCase()).not.toContain(banned);
    }
  );

  it("states both figures in the gap sentence", () => {
    const s = planGapSentence(under("allan"));
    expect(s).toContain("20 leads a month");
    expect(s).toContain("at least 1");
    expect(s).toContain("19 leads a month");
  });

  it("⚠️ frames the balance as a comparison, never as a delivery estimate", () => {
    // expected is a LOWER bound, so the real time to drain is at MOST this
    // figure. Promising a wait would be a promise we have not made.
    const s = bankedCreditSentence(under("allan"))!;
    expect(s).toContain("32 leads of credit unspent");
    expect(s).toContain("forecast rate");
    expect(s).toContain("worth");
    expect(s).not.toMatch(/will (take|arrive|be delivered)/i);
  });

  it("pluralises a single lead correctly on both sentences", () => {
    expect(planGapSentence(under("james"))).toContain("a gap of 1 lead a month");
    const one = planVsFilter({ ...ROWS.allan, expected: 1, balance: 1 * BANKED_MONTHS });
    expect(bankedCreditSentence(one as PlanVsFilterUnder)).toContain("3 months' worth");
  });
});

describe("downgradeRelief — ⚠️ a cheaper plan is not automatically a fix", () => {
  const HIGH = 5000; // HIGH_COST_PER_LEAD_PENCE, passed in rather than imported

  it("calls Allan's £150-a-lead downgrade cheaper but still poor", () => {
    // recommendedDowngrade(1, 20) returns the £150/10 plan: £150 a lead.
    expect(downgradeRelief(15000, HIGH)).toBe("cheaper_but_still_poor");
  });

  it("calls a downgrade that lands at the going rate a fix", () => {
    expect(downgradeRelief(1500, HIGH)).toBe("fix");
  });

  it("treats the threshold itself as a fix, not a failure", () => {
    expect(downgradeRelief(HIGH, HIGH)).toBe("fix");
    expect(downgradeRelief(HIGH + 1, HIGH)).toBe("cheaper_but_still_poor");
  });
});
