import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  LABEL_BADGE_TITLES,
  LABEL_EXPLANATIONS,
  LABEL_NAMES,
  LABEL_SHORT,
  NOT_FOR_ME_COPY,
  NOT_FOR_ME_REASONS,
  PRIORITY_NAMES,
  WHY_COPY,
  checklistLines,
  isLabelKey,
  monthLine,
  nearbyTip,
  notificationLabel,
  offersNotForMe,
  parseMatchReasons,
  reasonLine,
  type LabelKey,
  type LabelPriority,
  type LabelReasons,
} from "@/lib/leadBrief/labelCopy";
import { FIT_REASONS } from "@/lib/outcomeReasons";
import { MATCH_LABELS, PRIORITY_KEYS } from "@/lib/leadBrief/types";
import { buildBriefMatch } from "@/lib/leadBrief/score";
import { lead } from "./fixtures";

/**
 * Every customer-facing word about a lead's label (Phase 5). The copy rules
 * live at the top of labelCopy.ts; each one is asserted here against the real
 * output, not a restatement of it (§42.8).
 */

function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const LABEL_COPY = readFileSync("src/lib/leadBrief/labelCopy.ts", "utf8");

const P = (
  key: LabelPriority["key"],
  threshold: number | null,
  value: number | null,
  met: boolean | null
): LabelPriority => ({ key, threshold, value, met });

const ALL_MET: LabelPriority[] = [
  P("location", 12, 8.2, true),
  P("revenue", 40000, 42300, true),
  P("bedrooms", 3, 4, true),
  P("occupancy", 60, 64, true),
];

function reasons(over: Partial<LabelReasons> = {}): LabelReasons {
  return { v: 1, area: "service", first_pick: false, priorities: ALL_MET, ...over };
}

const PROGRESS = { received: 7, allocation: 20, days_left: 12 };

describe("labelCopy — the shapes stay equal to the engine's", () => {
  it("names every label the engine writes, and nothing else", () => {
    for (const k of MATCH_LABELS) {
      expect(isLabelKey(k)).toBe(true);
      expect(LABEL_NAMES[k]).toBeTruthy();
      expect(LABEL_EXPLANATIONS[k]).toBeTruthy();
      expect(LABEL_BADGE_TITLES[k]).toBeTruthy();
      expect(LABEL_SHORT[k]).toBeTruthy();
    }
    expect(Object.keys(LABEL_NAMES).sort()).toEqual([...MATCH_LABELS].sort());
    expect(isLabelKey("best_match")).toBe(false);
    expect(isLabelKey(null)).toBe(false);
    expect(isLabelKey(undefined)).toBe(false);
  });

  it("names every priority the engine judges", () => {
    expect(Object.keys(PRIORITY_NAMES).sort()).toEqual([...PRIORITY_KEYS].sort());
  });

  it("reads exactly what buildBriefMatch writes, progress and competition included", () => {
    const brief = {
      allocation: 20,
      travel_limit_miles: 25,
      base_outcode: "YO1",
      priority_outcodes: [],
      similar_areas: [],
      priorities: [
        { key: "location", threshold: 10 },
        { key: "revenue", threshold: 40000 },
      ],
      service_outcodes: ["YO1", "YO10"],
      first_pick_outcodes: ["YO8"],
      pace_outcodes: ["YO7"],
    };
    const nearby = buildBriefMatch(lead("YO7", { gross: 20000 }), brief, {
      isFirstSale: false,
      progress: PROGRESS,
    });
    expect(parseMatchReasons(JSON.parse(JSON.stringify(nearby.reasons)))).toEqual(nearby.reasons);
    const pick = buildBriefMatch(lead("YO8", { gross: 20000 }), brief, {
      isFirstSale: true,
      competition: "low",
    });
    expect(parseMatchReasons(JSON.parse(JSON.stringify(pick.reasons)))).toEqual(pick.reasons);
  });

  it("refuses anything that is not a v1 object, so a bad row hides the panel", () => {
    expect(parseMatchReasons(null)).toBeNull();
    expect(parseMatchReasons("x")).toBeNull();
    expect(parseMatchReasons([])).toBeNull();
    expect(parseMatchReasons({ ...reasons(), v: 2 })).toBeNull();
    expect(parseMatchReasons({ ...reasons(), area: "elsewhere" })).toBeNull();
    expect(parseMatchReasons({ ...reasons(), first_pick: "yes" })).toBeNull();
    expect(parseMatchReasons({ ...reasons(), priorities: [{ key: "holders" }] })).toBeNull();
    expect(
      parseMatchReasons({ ...reasons(), priorities: [{ key: "revenue", threshold: 1, value: 2, met: "y" }] })
    ).toBeNull();
    // Unknown extras are ignored, never echoed back.
    const extra = parseMatchReasons({ ...reasons(), competition: "none", progress: { received: "x" } });
    expect(extra).not.toBeNull();
    expect(extra).not.toHaveProperty("competition");
    expect(extra).not.toHaveProperty("progress");
  });
});

describe("labelCopy — the one-line reason (D6)", () => {
  it("Top match never says it was sent first (C4)", () => {
    const line = reasonLine("top_match", reasons());
    expect(line).toBe("Sent to you because it matches your brief exactly.");
    expect(line.toLowerCase()).not.toContain("first");
  });

  it("Strong match names the one priority and the gap", () => {
    const r = reasons({
      priorities: [P("location", 12, 8.2, true), P("revenue", 40000, 36000, false), P("bedrooms", 3, 3, true)],
    });
    expect(reasonLine("strong_match", r)).toBe(
      "It matches your brief apart from projected revenue: £4,000 under your £40k."
    );
    const far = reasons({ priorities: [P("location", 12, 14.3, false), P("revenue", 40000, 42000, true)] });
    expect(reasonLine("strong_match", far)).toBe(
      "It matches your brief apart from location: 2.3 miles beyond your 12 miles."
    );
    const unknown = reasons({ priorities: [P("location", 12, 3, true), P("revenue", 40000, null, false)] });
    expect(reasonLine("strong_match", unknown)).toBe(
      "It matches your brief apart from projected revenue, which there's no figure for yet."
    );
  });

  it("First pick never claims first or closest (C5), and says base and low competition only when true", () => {
    const bare = reasonLine("first_pick", reasons({ area: "first_pick", first_pick: true, priorities: [P("location", 12, 30, false)] }));
    expect(bare).toBe(
      "This property is in one of your first-pick areas, which puts you in a strong position to sign this landlord."
    );
    const near = reasonLine("first_pick", reasons({ area: "first_pick", first_pick: true, competition: "low" }));
    expect(near).toBe(
      "This property is in one of your first-pick areas, close to your base, in an area with low competition from management companies, which puts you in a strong position to sign this landlord."
    );
    const busy = reasonLine("first_pick", reasons({ area: "first_pick", first_pick: true, competition: "high" }));
    expect(busy).not.toContain("competition");
    for (const line of [bare, near, busy]) {
      expect(line).not.toMatch(/first operator|closest|first to receive/i);
    }
  });

  it("Nearby: the routed C6 / A11 sentences, with the customer's own progress", () => {
    expect(reasonLine("nearby_opportunity", reasons({ progress: PROGRESS }))).toBe(
      "This was the strongest lead available to you today inside your service area, sent to keep your 20 leads on track. You're on 7 of 20, with 12 days left in your cycle."
    );
    expect(reasonLine("nearby_opportunity", reasons({ area: "first_pick", progress: PROGRESS }))).toBe(
      "This was the strongest lead available to you today in one of your first-pick areas, sent to keep your 20 leads on track. You're on 7 of 20, with 12 days left in your cycle."
    );
    expect(reasonLine("nearby_opportunity", reasons({ area: "pace", progress: PROGRESS }))).toBe(
      "Just outside your usual area, sent to keep your 20 leads on track. You're on 7 of 20, with 12 days left in your cycle."
    );
    expect(
      reasonLine("nearby_opportunity", reasons({ area: "pace", progress: { received: 7, allocation: 20, days_left: 1 } }))
    ).toContain("with 1 day left");
  });

  it("Nearby without stored progress (hand-placed) never says it was sent to keep them on track", () => {
    expect(reasonLine("nearby_opportunity", reasons())).toBe("Inside your service area.");
    expect(reasonLine("nearby_opportunity", reasons({ area: "first_pick" }))).toBe("In one of your first-pick areas.");
    expect(reasonLine("nearby_opportunity", reasons({ area: "pace" }))).toBe("Just outside your usual area.");
    expect(reasonLine("nearby_opportunity", reasons({ area: "outside" }))).toBe("Outside your usual area.");
    // The decided wording for a lead outside every area, even if progress was stored.
    expect(reasonLine("nearby_opportunity", reasons({ area: "outside", progress: PROGRESS }))).toBe(
      "Outside your usual area."
    );
  });

  it("drops the progress sentence when it would not be true", () => {
    for (const progress of [
      { received: 20, allocation: 20, days_left: 5 },
      { received: 21, allocation: 20, days_left: 5 },
      { received: 3, allocation: 20, days_left: 0 },
    ]) {
      expect(reasonLine("nearby_opportunity", reasons({ area: "pace", progress }))).toBe(
        "Just outside your usual area."
      );
    }
  });
});

describe("labelCopy — the checklist", () => {
  it("one line per judged priority, in ranked order, unjudged left out", () => {
    const lines = checklistLines(
      reasons({
        priorities: [
          P("revenue", 40000, 42300, true),
          P("occupancy", null, 55, null),
          P("location", 12, 8.2, true),
          P("bedrooms", 3, 2, false),
        ],
      })
    );
    expect(lines.map((l) => l.key)).toEqual(["revenue", "location", "bedrooms"]);
    expect(lines.map((l) => l.detail)).toEqual([
      "£42,300 a year, your priority £40k+",
      "8.2 miles from your nearest area, within your 12 miles",
      "2 bedrooms, 1 fewer than your 3",
    ]);
    expect(lines.map((l) => l.met)).toEqual([true, true, false]);
  });

  it("says what was missed, and by how much", () => {
    const [loc, rev, beds, occ] = checklistLines(
      reasons({
        priorities: [
          P("location", 12, 14.3, false),
          P("revenue", 40000, 36000, false),
          P("bedrooms", 3, 1, false),
          P("occupancy", 60, 54, false),
        ],
      })
    );
    expect(loc.detail).toBe("14.3 miles from your nearest area, 2.3 miles beyond your 12 miles");
    expect(rev.detail).toBe("£36,000 a year, £4,000 under your £40k");
    expect(beds.detail).toBe("1 bedroom, 2 fewer than your 3");
    expect(occ.detail).toBe("54%, 6 points under your 60%");
  });

  it("a missing figure says so, and is never shown as met", () => {
    const lines = checklistLines(
      reasons({ priorities: [P("revenue", 40000, null, false), P("occupancy", 60, null, false)] })
    );
    expect(lines.map((l) => l.detail)).toEqual([
      "No projected revenue for this property yet",
      "No projected occupancy for this property yet",
    ]);
    expect(lines.every((l) => !l.met)).toBe(true);
  });

  it("location met beyond its distance (a similar area) says the customer added it", () => {
    const [far] = checklistLines(reasons({ priorities: [P("location", 12, 30, true)] }));
    expect(far.detail).toBe("In one of the areas you added");
    const [unplaced] = checklistLines(reasons({ priorities: [P("location", 12, null, true)] }));
    expect(unplaced.detail).toBe("In one of the areas you added");
    expect(unplaced.met).toBe(true);
  });
});

describe("labelCopy — the Nearby tip (A6, gain-framed)", () => {
  it("outside the service area, the tip is the area itself", () => {
    expect(nearbyTip(reasons({ area: "pace" }), "YO7")).toBe(
      "Adding YO7 to your areas would bring leads like this into your service area."
    );
    expect(nearbyTip(reasons({ area: "outside" }), "LS1")).toContain("Adding LS1");
    expect(nearbyTip(reasons({ area: "outside" }), null)).toBeNull();
  });

  it("one miss: names it, and it would make a top match", () => {
    expect(
      nearbyTip(reasons({ priorities: [P("location", 12, 3, true), P("revenue", 40000, 36400, false)] }), "YO10")
    ).toBe("Including £36k+ properties would turn leads like this into top matches.");
  });

  it("two misses: the smallest relative gap, and it would make a strong match", () => {
    const tip = nearbyTip(
      reasons({
        priorities: [
          P("location", 12, 14.3, false), // 19% over
          P("revenue", 40000, 36000, false), // 10% under
          P("bedrooms", 3, 3, true),
        ],
      }),
      "YO10"
    );
    expect(tip).toBe("Including £36k+ properties would turn leads like this into strong matches.");
    expect(
      nearbyTip(reasons({ priorities: [P("location", 12, 12.4, false), P("bedrooms", 3, 2, false)] }), "YO10")
    ).toBe("Including properties up to 13 miles from your areas would turn leads like this into strong matches.");
    expect(
      nearbyTip(reasons({ priorities: [P("occupancy", 60, 54.6, false), P("bedrooms", 3, 1, false)] }), "YO10")
    ).toBe("Including properties at 54%+ occupancy would turn leads like this into strong matches.");
    expect(
      nearbyTip(reasons({ priorities: [P("bedrooms", 3, 2, false), P("revenue", 40000, 10000, false)] }), "YO10")
    ).toBe("Including 2-bedroom properties would turn leads like this into strong matches.");
  });

  it("no tip when nothing single would do it", () => {
    expect(nearbyTip(reasons(), "YO10")).toBeNull();
    expect(
      nearbyTip(
        reasons({
          priorities: [P("location", 12, 20, false), P("revenue", 40000, 1, false), P("bedrooms", 3, 1, false)],
        }),
        "YO10"
      )
    ).toBeNull();
    expect(nearbyTip(reasons({ priorities: [P("revenue", 40000, null, false)] }), "YO10")).toBeNull();
    expect(nearbyTip(reasons({ priorities: [P("bedrooms", 3, 0, false)] }), "YO10")).toBeNull();
  });

  it("never tells them to drop a priority", () => {
    const tips = [
      nearbyTip(reasons({ priorities: [P("revenue", 40000, 36400, false)] }), "YO10"),
      nearbyTip(reasons({ area: "pace" }), "YO7"),
    ];
    for (const t of tips) expect(t).not.toMatch(/\b(drop|remove|lower|relax)\b/i);
  });
});

describe("labelCopy — alerts and the home line", () => {
  it("the notification names the label in brackets", () => {
    expect(notificationLabel("top_match")).toBe(" (Top match)");
    expect(notificationLabel("nearby_opportunity")).toBe(" (Nearby opportunity)");
  });

  it("the month line names all four, in label order", () => {
    expect(monthLine({ top_match: 3, strong_match: 2, first_pick: 1, nearby_opportunity: 4 })).toBe(
      "This month: 3 top · 2 strong · 1 first pick · 4 nearby"
    );
  });
});

describe("labelCopy — Not for me (D10)", () => {
  it("offers exactly the three reject reasons, worded as reject words them", () => {
    expect([...NOT_FOR_ME_REASONS]).toEqual(["wrong_area", "wrong_property", "poor_numbers"]);
    for (const r of NOT_FOR_ME_REASONS) {
      expect(NOT_FOR_ME_COPY.reasons[r]).toBe(FIT_REASONS[r]);
    }
  });

  it("is offered on Strong and Nearby only", () => {
    const offered = (["top_match", "strong_match", "first_pick", "nearby_opportunity"] as LabelKey[]).filter(
      offersNotForMe
    );
    expect(offered).toEqual(["strong_match", "nearby_opportunity"]);
    expect(offersNotForMe(null)).toBe(false);
    expect(offersNotForMe(undefined)).toBe(false);
  });

  it("says it is final and still counts, and never mentions a replacement", () => {
    expect(NOT_FOR_ME_COPY.consequence).toBe(
      "Passing on a lead is final, and it still counts toward your leads this month."
    );
    const all = JSON.stringify(NOT_FOR_ME_COPY).toLowerCase();
    for (const word of ["replace", "refund", "credit", "swap", "instead"]) expect(all).not.toContain(word);
  });
});

describe("labelCopy — words it never uses", () => {
  /** Every string literal in the module, comments stripped (§46's trap). */
  const literals = Array.from(
    strip(LABEL_COPY).matchAll(/"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)
  )
    .map((m) => m[0])
    .join("\n");

  const BANNED = [
    // A9
    /\bfilter/i,
    /\bminimum/i,
    /\brestricted/i,
    /\bexpanded/i,
    /\boverride/i,
    /\btop[- ]?up/i,
    /outside your criteria/i,
    /non-?matching/i,
    // Phase 5: never about other holders, supply or a promise.
    /guarantee/i,
    /\boperator/i,
    /deficit/i,
    /\bvolume/i,
    /\bshared/i,
    /\bholder/i,
    /replace/i,
    /!/,
  ];

  for (const re of BANNED) {
    it(`never says ${re}`, () => {
      expect(literals).not.toMatch(re);
    });
  }

  it("the scan sees the copy (guards the guard)", () => {
    expect(literals).toContain("Why you got this lead");
    expect(literals).toContain("which puts you in a strong position to sign this landlord.");
  });

  it("has no imports, so client components can use it", () => {
    expect(strip(LABEL_COPY)).not.toMatch(/^import /m);
    expect(strip(LABEL_COPY)).not.toMatch(/\brequire\(/);
  });

  it("the why panel's fixed words", () => {
    expect(WHY_COPY.title).toBe("Why you got this lead");
    expect(WHY_COPY.firstPickTag).toBe("It's also in one of your first-pick areas.");
  });
});

describe("labelCopy — the badge hover text claims nothing conditional", () => {
  it("never says close to your base or on track", () => {
    for (const k of MATCH_LABELS) {
      expect(LABEL_BADGE_TITLES[k]).not.toMatch(/base|on track|first operator|closest/i);
    }
  });
});
