import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  nextResetDate,
  remainingOf,
  remainingSentence,
  resetSentence,
  REPLACEMENT_EMPTY,
  REPLACEMENT_EXHAUSTED,
  REPLACEMENT_NAV_LABEL,
  REPLACEMENT_PATH,
  type ReplacementEntitlement,
} from "@/lib/quality/replacementEntitlement";

const e = (o: Partial<ReplacementEntitlement>): ReplacementEntitlement => ({
  entitlement: 2,
  used: 0,
  remaining: 2,
  resetsOn: null,
  ...o,
});

describe("remainingOf", () => {
  it("subtracts what has been used", () => {
    expect(remainingOf(2, 1)).toBe(1);
  });

  // ⚠️ THE CASE THIS EXISTS FOR. An admin upholding a reviewed claim consumes
  // the entitlement (`resolve_dead_lead_claim` passes p_consumes_allowance for
  // the plain `uphold` action), and that can land after the customer has
  // already spent everything. Without the clamp the header reads "-1 left".
  it("never goes negative when an admin uphold pushes used past the entitlement", () => {
    expect(remainingOf(2, 3)).toBe(0);
  });

  it("treats rubbish as zero rather than NaN", () => {
    expect(remainingOf(Number.NaN, 1)).toBe(0);
    expect(remainingOf(2, Number.NaN)).toBe(2);
  });
});

describe("nextResetDate", () => {
  // ⚠️ THE COALESCE ORDER MUST MIRROR reset_monthly_counts. 0141 keys the claim
  // counter on coalesce(billing_cycle_anchor, gr_billing_cycle_anchor,
  // created_at), so a GR-only customer resets on their GR anchor. Deriving it
  // from anything else prints a day on which nothing happens.
  it("uses the management anchor when there is one", () => {
    expect(
      nextResetDate(
        {
          billing_cycle_anchor: "2026-01-08",
          gr_billing_cycle_anchor: "2026-01-20",
          created_at: "2025-05-03",
        },
        new Date("2026-09-12T00:00:00Z"),
      ),
    ).toBe("2026-10-08");
  });

  it("falls back to the GR anchor for a GR-only customer", () => {
    expect(
      nextResetDate(
        {
          billing_cycle_anchor: null,
          gr_billing_cycle_anchor: "2026-01-20",
          created_at: "2025-05-03",
        },
        new Date("2026-09-12T00:00:00Z"),
      ),
    ).toBe("2026-09-20");
  });

  it("falls back to the signup date when neither product has ever billed", () => {
    expect(
      nextResetDate(
        { billing_cycle_anchor: null, gr_billing_cycle_anchor: null, created_at: "2025-05-03" },
        new Date("2026-09-12T00:00:00Z"),
      ),
    ).toBe("2026-10-03");
  });

  it("returns the same month when the anchor day is still ahead", () => {
    expect(
      nextResetDate(
        { billing_cycle_anchor: "2026-01-20" },
        new Date("2026-09-12T00:00:00Z"),
      ),
    ).toBe("2026-09-20");
  });

  // ⚠️ Mirrors the SQL's `v_dom = v_last_dom and anchor_dom > v_last_dom`
  // branch: an anchor on the 31st falls on the last day of a short month.
  it("clamps a 31st anchor to the last day of a short month", () => {
    expect(
      nextResetDate(
        { billing_cycle_anchor: "2026-01-31" },
        new Date("2026-09-30T00:00:00Z"),
      ),
    ).toBe("2026-10-31");
    expect(
      nextResetDate(
        { billing_cycle_anchor: "2026-01-31" },
        new Date("2026-01-31T00:00:00Z"),
      ),
    ).toBe("2026-02-28");
  });

  it("returns null when there is nothing to anchor on", () => {
    expect(nextResetDate({})).toBeNull();
    expect(nextResetDate({ billing_cycle_anchor: "not a date" })).toBeNull();
  });
});

describe("the published count", () => {
  // §53 reverses §51.3 on THIS SURFACE ONLY. The number has to actually appear,
  // or the hard stop becomes a refusal with no explanation.
  it("states the remaining count and the total", () => {
    expect(remainingSentence(e({ remaining: 2, entitlement: 2 }))).toContain("2 of 2");
  });

  it("says plainly when they are used up", () => {
    const s = remainingSentence(e({ remaining: 0, used: 2 }));
    expect(s.toLowerCase()).toContain("used all");
  });

  it("explains an entitlement of zero rather than showing 0 of 0", () => {
    expect(remainingSentence(e({ entitlement: 0, remaining: 0 }))).toContain(
      "not available",
    );
  });

  it("names the date the count comes back", () => {
    expect(resetSentence(e({ resetsOn: "2026-10-08" }))).toContain("8 October");
    expect(resetSentence(e({ resetsOn: null }))).toBeNull();
  });

  it("points at the date rather than the shortfall once they are used up", () => {
    expect(resetSentence(e({ remaining: 0, resetsOn: "2026-10-08" }))).toContain(
      "You get more on",
    );
  });
});

describe("what the copy may not say", () => {
  // ⚠️ §51.3's vocabulary ban still applies to the MECHANISM even though the
  // COUNT is now published. The customer is told a number of replacements; how
  // it is sized, earned or shared with the credit path stays ours.
  const banned = ["allowance", "quota", "budget", "credit claim"];

  it("names no mechanism in any customer-facing string", () => {
    const strings = [
      REPLACEMENT_EMPTY,
      REPLACEMENT_EXHAUSTED,
      remainingSentence(e({})),
      remainingSentence(e({ remaining: 0 })),
      remainingSentence(e({ entitlement: 0, remaining: 0 })),
      resetSentence(e({ resetsOn: "2026-10-08" })) ?? "",
    ];
    for (const s of strings) {
      for (const word of banned) {
        expect(s.toLowerCase()).not.toContain(word);
      }
    }
  });

  // ⚠️ The module must stay import-free apart from its own copy sibling: the
  // list is a client component and deadLeadPolicy.ts drags plans.ts into the
  // bundle (§21.8, §51.6). Comments stripped first — §46 records a guard that
  // failed on its own explanation and trained the next reader to delete it.
  it("imports nothing that would reach the server bundle", () => {
    const src = readFileSync(
      "src/lib/quality/replacementEntitlement.ts",
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/^import /m);
  });

  it("keeps the nav entry pointing at the page", () => {
    expect(REPLACEMENT_PATH).toBe("/dashboard/replacements");
    expect(REPLACEMENT_NAV_LABEL.length).toBeGreaterThan(0);
  });
});
