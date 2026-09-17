import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  HOLD_COPY,
  MANAGE_BILLING_PATH,
  REPLACEMENT_CHAINED_ACTION,
  REPLACEMENT_CHAINED_NOTICE,
  REPLACEMENT_EMPTY,
  REPLACEMENT_NAV_LABEL,
  REPLACEMENT_PATH,
  availableSentence,
  exhaustedSentence,
  holdSentence,
  nextGrantDate,
  nextGrantSentence,
  type ReplacementEntitlement,
} from "@/lib/quality/replacementEntitlement";

const e = (o: Partial<ReplacementEntitlement>): ReplacementEntitlement => ({
  available: 2,
  monthlyGrant: 2,
  nextGrantOn: null,
  ...o,
});

describe("nextGrantDate", () => {
  // ⚠️ THE COALESCE ORDER MUST MIRROR replacement_cycle_start (0153) — the
  // same order 0141 keyed the claim counter on: coalesce(billing_cycle_anchor,
  // gr_billing_cycle_anchor, created_at), so a GR-only customer is granted on
  // their GR anchor. Deriving it from anything else prints a day on which
  // nothing happens.
  it("uses the management anchor when there is one", () => {
    expect(
      nextGrantDate(
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
      nextGrantDate(
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
      nextGrantDate(
        { billing_cycle_anchor: null, gr_billing_cycle_anchor: null, created_at: "2025-05-03" },
        new Date("2026-09-12T00:00:00Z"),
      ),
    ).toBe("2026-10-03");
  });

  it("returns the same month when the anchor day is still ahead", () => {
    expect(
      nextGrantDate(
        { billing_cycle_anchor: "2026-01-20" },
        new Date("2026-09-12T00:00:00Z"),
      ),
    ).toBe("2026-09-20");
  });

  // ⚠️ Mirrors the SQL's month-end clamp: an anchor on the 31st falls on the
  // last day of a short month.
  it("clamps a 31st anchor to the last day of a short month", () => {
    expect(
      nextGrantDate(
        { billing_cycle_anchor: "2026-01-31" },
        new Date("2026-09-30T00:00:00Z"),
      ),
    ).toBe("2026-10-31");
    expect(
      nextGrantDate(
        { billing_cycle_anchor: "2026-01-31" },
        new Date("2026-01-31T00:00:00Z"),
      ),
    ).toBe("2026-02-28");
  });

  it("returns null when there is nothing to anchor on", () => {
    expect(nextGrantDate({})).toBeNull();
    expect(nextGrantDate({ billing_cycle_anchor: "not a date" })).toBeNull();
  });
});

describe("the published count", () => {
  // §53 reverses §51.3 on THIS SURFACE ONLY. The number has to actually appear,
  // or the hard stop becomes a refusal with no explanation.
  it("states how many are available", () => {
    expect(availableSentence(e({ available: 3 }))).toBe(
      "You have 3 replacements available.",
    );
  });

  it("gets the singular right", () => {
    expect(availableSentence(e({ available: 1 }))).toBe(
      "You have 1 replacement available.",
    );
  });

  // ⚠️ Never "N of N this month". A balance that carries over makes that
  // sentence false the first time somebody carries one.
  it("never phrases the balance as a share of this month", () => {
    for (const n of [0, 1, 2, 5]) {
      const s = availableSentence(e({ available: n })).toLowerCase();
      expect(s).not.toContain(" of ");
      expect(s).not.toContain("this month");
    }
  });

  it("says plainly when there are none right now", () => {
    expect(availableSentence(e({ available: 0 }))).toBe(
      "You have no replacements available right now.",
    );
  });

  it("explains an account that accrues nothing rather than showing a zero", () => {
    expect(availableSentence(e({ available: 0, monthlyGrant: 0 }))).toContain(
      "not available",
    );
  });
});

describe("what the next billing date adds", () => {
  it("names the number, the date, and that unused ones carry over", () => {
    const s = nextGrantSentence(e({ monthlyGrant: 2, nextGrantOn: "2026-10-08" }));
    expect(s).toBe(
      "2 more are added on 8 October, and anything you don't use carries over.",
    );
  });

  it("gets the singular right", () => {
    expect(nextGrantSentence(e({ monthlyGrant: 1, nextGrantOn: "2026-10-08" }))).toBe(
      "1 more is added on 8 October, and anything you don't use carries over.",
    );
  });

  // ⚠️ A written-off customer or one holding no product accrues nothing, and
  // "0 more are added on 8 October" is a lie about a date on which nothing
  // happens.
  it("says nothing when the grant is zero", () => {
    expect(nextGrantSentence(e({ monthlyGrant: 0, nextGrantOn: "2026-10-08" }))).toBeNull();
  });

  it("says nothing when the date cannot be resolved", () => {
    expect(nextGrantSentence(e({ monthlyGrant: 2, nextGrantOn: null }))).toBeNull();
    expect(nextGrantSentence(e({ monthlyGrant: 2, nextGrantOn: "nonsense" }))).toBeNull();
  });
});

describe("the exhausted state", () => {
  it("points at the lead page and names the next grant date", () => {
    const s = exhaustedSentence(e({ available: 0, monthlyGrant: 1, nextGrantOn: "2026-10-08" }));
    expect(s).toContain("report these from the lead itself");
    expect(s).toContain("8 October");
  });

  it("drops the date when nothing accrues", () => {
    const s = exhaustedSentence(e({ available: 0, monthlyGrant: 0, nextGrantOn: "2026-10-08" }));
    expect(s).toContain("report these from the lead itself");
    expect(s).not.toContain("October");
  });

  it("never promises a swap", () => {
    const s = exhaustedSentence(e({ available: 0, nextGrantOn: "2026-10-08" })).toLowerCase();
    expect(s).not.toContain("swap");
  });
});

describe("holds", () => {
  it("tells a past-due customer to check with their bank and that the count is kept", () => {
    const s = HOLD_COPY.past_due.toLowerCase();
    expect(s).toContain("declined");
    expect(s).toContain("bank");
    expect(s).toContain("kept");
    expect(MANAGE_BILLING_PATH).toBe("/dashboard/packages");
  });

  it("tells a paused customer it comes back on resume and keeps building", () => {
    const s = HOLD_COPY.paused.toLowerCase();
    expect(s).toContain("paused");
    expect(s).toContain("keeps building");
  });

  it("names the product only when asked to", () => {
    expect(holdSentence("paused", null)).toBe(HOLD_COPY.paused);
    expect(holdSentence("past_due", "guaranteed_rent")).toBe(
      `Guaranteed rent: ${HOLD_COPY.past_due}`,
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
      REPLACEMENT_CHAINED_NOTICE,
      REPLACEMENT_CHAINED_ACTION,
      REPLACEMENT_EMPTY,
      HOLD_COPY.past_due,
      HOLD_COPY.paused,
      availableSentence(e({})),
      availableSentence(e({ available: 1 })),
      availableSentence(e({ available: 0 })),
      availableSentence(e({ available: 0, monthlyGrant: 0 })),
      nextGrantSentence(e({ nextGrantOn: "2026-10-08" })) ?? "",
      nextGrantSentence(e({ monthlyGrant: 1, nextGrantOn: "2026-10-08" })) ?? "",
      exhaustedSentence(e({ available: 0, nextGrantOn: "2026-10-08" })),
      exhaustedSentence(e({ available: 0, monthlyGrant: 0 })),
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

describe("a row whose slot is already a replacement (§53.12)", () => {
  /**
   * ⚠️ The mechanics already worked before this: a chained report comes back
   * with the neutral review sentence and nothing is swapped. What did not work
   * was the row, whose button said "Swap this lead" right up until it did not
   * — §52.4's objection to a control that silently behaves differently from
   * how it reads.
   */
  it("promises a look, never a swap", () => {
    expect(REPLACEMENT_CHAINED_NOTICE.toLowerCase()).not.toContain("swap");
    expect(REPLACEMENT_CHAINED_ACTION.toLowerCase()).not.toContain("swap");
  });

  /**
   * ⚠️ This one is safe to say out loud ONLY because it is the customer's own
   * history. The other two review valves must stay silent: `quality_review_required`
   * is an admin judgement about them, and a peer working the same landlord is
   * §19.7's forbidden disclosure. So the notice must not drift into naming
   * either.
   */
  it("says nothing about anybody else", () => {
    const text = REPLACEMENT_CHAINED_NOTICE.toLowerCase();
    // ⚠️ "another" is NOT banned — the sentence is allowed to talk about
    // another LEAD. What it may never name is another person.
    for (const word of ["operator", "someone else", "somebody else"]) {
      expect(text).not.toContain(word);
    }
  });

  /**
   * ⚠️ The list renders both from the shared constants rather than writing its
   * own strings, or every assertion above is decorative. Anchored on the real
   * file, comments stripped — §46 records a guard that failed on its own
   * explanation.
   */
  it("is what the list actually renders", () => {
    const src = readFileSync(
      "src/components/dashboard/ReplacementList.tsx",
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src).toContain("{REPLACEMENT_CHAINED_NOTICE}");
    expect(src).toContain("REPLACEMENT_CHAINED_ACTION");
    // The depth has to reach the row, or nothing can branch on it.
    expect(src).toContain("item.replacementDepth > 0");
    // And so does a hold, or the button stays live on a failing card.
    expect(src).toContain("held !== null ||");
    expect(src).toContain("holdSentence(");
  });
});
