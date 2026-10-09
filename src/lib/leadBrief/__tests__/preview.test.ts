import { describe, it, expect } from "vitest";
import { GROSS_THRESHOLDS } from "@/lib/filterPrediction";
import { distancesFrom, distancesFromNearest } from "@/lib/leadBrief/geo";
import type { BriefInput } from "@/lib/leadBrief/input";
import { prioritiesForStorage } from "@/lib/leadBrief/match";
import { PLAN_MAX_MILES, PREVIEW_FIRST_PICKS, type BriefPlan } from "@/lib/leadBrief/plans";
import {
  computeBriefPreview,
  previewForClient,
  type BriefPreview,
} from "@/lib/leadBrief/preview";
import { MATCH_LABELS, type BriefSupply } from "@/lib/leadBrief/types";
import { leads, otherBrief, supply } from "./fixtures";

const TODAY = "2026-10-08";

function preview(input: BriefInput, plan: BriefPlan, s: BriefSupply): BriefPreview {
  const r = computeBriefPreview(input, plan, s, { today: TODAY });
  if (!r.ok) throw new Error(`expected a preview, got ${JSON.stringify(r.issues)}`);
  return r.preview;
}

/**
 * York, with supply placed so the arithmetic is checkable by hand. Over 13
 * weeks (WEEKS_PER_MONTH 4.33):
 *
 *   YO10 + YO31 (~1 mile)    30 leads   ≈ 10 a month
 *   HG1 (~20 miles)          40 leads   ≈ 13 a month
 *   LS1 (~23 miles)          60 leads   ≈ 20 a month
 *
 * Ten miles holds ~10 a month, under either target. Twenty adds Harrogate:
 * ~23 a month, enough for the 10-lead plan's 13 at confidence but not the
 * 20-lead plan's 26. Thirty adds Leeds: ~43 a month, enough for both.
 */
const YORK = supply({
  leads: [
    ...leads(15, "YO10"),
    ...leads(15, "YO31"),
    ...leads(40, "HG1", { gross: 60000, bedrooms: 4 }),
    ...leads(60, "LS1"),
  ],
});
const YORK_BRIEF: BriefInput = { basePostcode: "YO10 5DD", travelLimitMiles: null };

/**
 * The 0162 CHECKs a stored brief must pass, restated for the row the
 * preview would write. ⚠️ A restatement, not the source: schemaGuard.test.ts
 * pins the patterns and caps against the migration file, and the Phase 2
 * verification inserted a real preview into a scratch database built from
 * the migrations. This catches the engine producing a row shape the
 * database would refuse.
 */
function expectStorable(p: BriefPreview) {
  const outcode = /^[A-Z]{1,2}[0-9][A-Z0-9]?$/;
  const area = /^[A-Z]{1,2}$/;
  const codes = (list: string[], re: RegExp) => {
    expect(list.length).toBeLessThanOrEqual(3000);
    expect(new Set(list).size).toBe(list.length);
    for (const c of list) expect(c).toMatch(re);
  };
  const b = p.brief;

  expect(b.basePostcode).toMatch(/^[A-Z]{1,2}[0-9][A-Z0-9]?( [0-9][A-Z]{2})?$/);
  codes([b.baseOutcode], outcode);
  expect(b.basePostcode === b.baseOutcode || b.basePostcode.startsWith(`${b.baseOutcode} `)).toBe(true);

  const mode = { anywhere: [null], local: [10], growing: [25, 50] }[b.operatingMode];
  expect(mode).toContain(b.travelLimitMiles);

  expect(Number.isInteger(p.serviceRadiusMiles)).toBe(true);
  expect(p.serviceRadiusMiles).toBeGreaterThanOrEqual(1);
  expect(p.serviceRadiusMiles).toBeLessThanOrEqual(PLAN_MAX_MILES[p.plan]);
  if (b.travelLimitMiles !== null) expect(p.serviceRadiusMiles).toBeLessThanOrEqual(b.travelLimitMiles);

  expect(b.essentials.length).toBeLessThanOrEqual(2);
  expect(new Set(b.essentials).size).toBe(b.essentials.length);
  expect(b.essentials.includes("bedrooms")).toBe(b.minBedrooms !== null);
  expect(b.essentials.includes("revenue")).toBe(b.minGross !== null);
  if (b.minBedrooms !== null) {
    expect(b.minBedrooms).toBeGreaterThanOrEqual(1);
    expect(b.minBedrooms).toBeLessThanOrEqual(10);
  }
  if (b.minGross !== null) expect(GROSS_THRESHOLDS as readonly number[]).toContain(b.minGross);

  codes(b.priorityOutcodes, outcode);
  codes(p.serviceOutcodes, outcode);
  codes(p.firstPickOutcodes, outcode);
  codes(p.paceOutcodes, outcode);
  codes(b.similarAreas, area);
  expect(p.serviceOutcodes).toContain(b.baseOutcode);
  expect(p.paceOutcodes.filter((oc) => p.serviceOutcodes.includes(oc))).toEqual([]);

  const stored = prioritiesForStorage(p.priorities);
  expect(stored.length).toBeGreaterThanOrEqual(1);
  expect(stored.length).toBeLessThanOrEqual(4);
  expect(new Set(stored.map((s) => s.key)).size).toBe(stored.length);
  for (const s of stored) if ("threshold" in s) expect(Number.isFinite(s.threshold)).toBe(true);

  for (const [k, v] of Object.entries(p.expectedMix)) {
    expect(MATCH_LABELS).toContain(k);
    expect(Number.isInteger(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(0);
  }
  // Not a CHECK, but the promise the mix makes: it is a split of the plan.
  expect(Object.values(p.expectedMix).reduce((a, n) => a + n, 0)).toBe(p.plan);
}

describe("computeBriefPreview — York on the 20-lead plan", () => {
  const p = preview(YORK_BRIEF, 20, YORK);

  it("widens to the first radius that fills the plan with its buffer, and no further", () => {
    expect(p.capMiles).toBe(75);
    expect(p.serviceRadiusMiles).toBe(30);
    expect(p.meetsTarget).toBe(true);
    expect(p.mixLeansNearby).toBe(false);
    expect(p.cannotMeet).toBeNull();
    expect(p.supplyCheck).toEqual({ target: 26, deliverable: 26, weeks: 13 });
  });

  it("puts the base first and Leeds and Harrogate inside the area", () => {
    expect(p.serviceOutcodes[0]).toBe("YO10");
    expect(p.serviceOutcodes).toEqual(expect.arrayContaining(["YO1", "YO31", "HG1", "LS1"]));
    const d = distancesFrom("YO10")!;
    for (const oc of p.serviceOutcodes) expect(d.get(oc)!).toBeLessThanOrEqual(30);
  });

  it("A5: shows both plans side by side — the 10-lead plan needs less ground", () => {
    expect(p.coverage).toEqual([
      { plan: 10, radiusMiles: 20, meetsTarget: true },
      { plan: 20, radiusMiles: 30, meetsTarget: true },
    ]);
    const ten = preview(YORK_BRIEF, 10, YORK);
    // Whichever plan is chosen, both rows read the same.
    expect(ten.coverage).toEqual(p.coverage);
    expect(ten.serviceRadiusMiles).toBe(20);
    expect(ten.capMiles).toBe(40);
  });

  it("with nobody else around, every outcode inside the cap is a first pick, so there is no pace ring", () => {
    expect(p.firstPickOutcodes[0]).toBe("YO10");
    expect(p.firstPickOutcodes.length).toBeGreaterThan(PREVIEW_FIRST_PICKS);
    expect(p.paceOutcodes).toEqual([]);
    expect(p.firstPickTiers).toHaveLength(PREVIEW_FIRST_PICKS);
    expect(p.firstPickTiers.map((t) => t.outcode)).toEqual(p.firstPickOutcodes.slice(0, PREVIEW_FIRST_PICKS));
  });

  it("offers Leeds and Harrogate as similar areas, never York itself", () => {
    expect(p.similarAreas.map((s) => s.area).sort()).toEqual(["HG", "LS"]);
  });

  it("has nothing to trade off with no essentials, and a mix that is the plan", () => {
    expect(p.tradeoffs).toEqual([]);
    expect(p.expectedMix.nearby_opportunity).toBe(0);
    expectStorable(p);
  });

  it("is deterministic for a fixed day", () => {
    expect(preview(YORK_BRIEF, 20, YORK)).toEqual(p);
  });
});

describe("computeBriefPreview — the areas the customer picks", () => {
  it("⚠️ grows around York AND Leeds when both are picked, so a smaller distance fills the plan", () => {
    // Base only, the 20-lead plan needs 30 miles (above): Leeds is ~23 miles
    // from York, so only the 30-mile step reaches it. With Leeds picked, its
    // leads count from the first step. Ten miles round each area holds York
    // and Leeds (~30 a month), short of 26 at confidence; twenty adds
    // Harrogate and fills it.
    const p = preview({ ...YORK_BRIEF, priorityOutcodes: ["LS1"] }, 20, YORK);
    expect(p.serviceRadiusMiles).toBeLessThan(preview(YORK_BRIEF, 20, YORK).serviceRadiusMiles);
    expect(p.serviceRadiusMiles).toBe(20);
    expect(p.meetsTarget).toBe(true);
    expect(p.serviceOutcodes[0]).toBe("YO10");
    expect(p.serviceOutcodes).toEqual(expect.arrayContaining(["LS1", "LS2", "YO1", "HG1"]));
    // Nothing more than twenty miles from the nearer of the two areas.
    const d = distancesFromNearest(["YO10", "LS1"])!;
    for (const oc of p.serviceOutcodes) expect(d.get(oc)!).toBeLessThanOrEqual(20);
    expect(p.priorityAreaTiers.map((t) => t.outcode)).toEqual(["YO10", "LS1"]);
    expectStorable(p);
    // The 10-lead plan fills at the first step.
    expect(preview({ ...YORK_BRIEF, priorityOutcodes: ["LS1"] }, 10, YORK).serviceRadiusMiles).toBe(10);
  });

  it("⚠️ a ticked similar area becomes part of the area leads come from", () => {
    const p = preview({ ...YORK_BRIEF, similarAreas: ["HG"] }, 10, YORK);
    expect(p.serviceOutcodes).toContain("HG1");
    expect(p.serviceOutcodes.filter((oc) => oc.startsWith("HG")).length).toBeGreaterThan(1);
    // Harrogate's leads count from the first step, so the 10-lead plan fills
    // at ten miles rather than twenty.
    expect(preview(YORK_BRIEF, 10, YORK).serviceRadiusMiles).toBe(20);
    expect(p.serviceRadiusMiles).toBe(10);
    expectStorable(p);
    // On the 20-lead plan York and Harrogate (~23 a month) are still short of
    // 26, so Leeds is needed and the distance is unchanged — but Harrogate is
    // in the area either way.
    const twenty = preview({ ...YORK_BRIEF, similarAreas: ["HG"] }, 20, YORK);
    expect(twenty.serviceRadiusMiles).toBe(30);
    expect(twenty.serviceOutcodes).toContain("HG1");
    expect(twenty.coverage).toEqual([
      { plan: 10, radiusMiles: 10, meetsTarget: true },
      { plan: 20, radiusMiles: 30, meetsTarget: true },
    ]);
  });

  it("⚠️ first picks are measured from the nearest picked area, so they reach past the base's cap", () => {
    // Travel 25: Leeds (~23 miles) is inside the cap, so it is one of the
    // customer's areas. Bradford is ~30 miles from York but ~8 from Leeds, so
    // it is a first pick even though no service-area lead can come from that
    // far. That is the rule as approved — reach is the travel limit, from the
    // nearest area — and it is pinned so it cannot change unnoticed.
    const p = preview({ ...YORK_BRIEF, travelLimitMiles: 25, priorityOutcodes: ["LS1"] }, 20, YORK);
    expect(distancesFrom("YO10")!.get("BD1")!).toBeGreaterThan(25);
    expect(distancesFromNearest(["YO10", "LS1"])!.get("BD1")!).toBeLessThanOrEqual(25);
    expect(p.firstPickOutcodes).toContain("BD1");
    expect(p.serviceOutcodes).not.toContain("BD1");
    // Ordered from the nearest area: both picked areas sit at zero, first.
    expect(p.firstPickOutcodes.slice(0, 2).sort()).toEqual(["LS1", "YO10"]);
    // Base only, Bradford is out of reach.
    expect(preview({ ...YORK_BRIEF, travelLimitMiles: 25 }, 20, YORK).firstPickOutcodes).not.toContain("BD1");
    expectStorable(p);
  });

  it("only suggests similar areas within the cap of the base", () => {
    // Travel 10: Tadcaster (LS24, ~10 miles) is reachable, Harrogate (~17+) is not.
    const p = preview({ ...YORK_BRIEF, travelLimitMiles: 10 }, 20, YORK);
    expect(p.capMiles).toBe(10);
    expect(p.similarAreas.map((a) => a.area)).not.toContain("HG");
    expect(preview(YORK_BRIEF, 20, YORK).similarAreas.map((a) => a.area)).toContain("HG");
  });

  it("an unticked similar area is suggested, not added", () => {
    const p = preview(YORK_BRIEF, 10, YORK);
    expect(p.similarAreas.map((a) => a.area)).toContain("HG");
    // At ten miles round York, Harrogate (~20 miles) is not in the area.
    expect(p.serviceRadiusMiles).toBe(20);
    expect(preview(YORK_BRIEF, 10, supply({ ...YORK, leads: leads(200, "YO10") })).serviceOutcodes).not.toContain("HG1");
  });

  it("shows both plans for the picked areas (A5)", () => {
    const p = preview({ ...YORK_BRIEF, priorityOutcodes: ["LS1"] }, 20, YORK);
    expect(p.coverage).toEqual([
      { plan: 10, radiusMiles: 10, meetsTarget: true },
      { plan: 20, radiusMiles: 20, meetsTarget: true },
    ]);
  });
});

describe("computeBriefPreview — no supply nearby", () => {
  // Plenty of leads, all in London, ~170 miles from York. London is named by
  // a legacy filter, as it is on the live book, so none of it is a first pick:
  // what is left to test is the service area itself.
  const far = supply({ leads: leads(300, "E1"), filteredAreas: ["E"] });

  it("⚠️ widens to the cap, says the plan cannot be met there, and leans the mix to Nearby (widen, never block)", () => {
    const p = preview(YORK_BRIEF, 20, far);
    expect(p.serviceRadiusMiles).toBe(75);
    expect(p.meetsTarget).toBe(false);
    expect(p.mixLeansNearby).toBe(true);
    expect(p.expectedMix).toEqual({ top_match: 0, strong_match: 0, first_pick: 0, nearby_opportunity: 20 });
    expect(p.coverage).toEqual([
      { plan: 10, radiusMiles: 40, meetsTarget: false },
      { plan: 20, radiusMiles: 75, meetsTarget: false },
    ]);
    expectStorable(p);
  });

  it("⚠️ AS ANSWERED ON 9 OCT: an 'anywhere' customer's first picks are nationwide, so far-off supply counts", () => {
    // The same London leads with nobody filtering London: for a York
    // customer who will travel anywhere they are first picks, and the whole
    // plan is expected from them, ~170 miles away. This conflicts with A3
    // ("anywhere still respects the plan cap") and is pinned here so it
    // cannot change, or stay, unnoticed.
    const p = preview(YORK_BRIEF, 20, supply({ leads: leads(300, "E1") }));
    expect(p.meetsTarget).toBe(false);
    expect(p.firstPickOutcodes).toContain("E1");
    expect(p.expectedMix.first_pick).toBe(20);
    // A customer with a travel limit is not affected.
    const limited = preview({ ...YORK_BRIEF, travelLimitMiles: 50 }, 20, supply({ leads: leads(300, "E1") }));
    expect(limited.firstPickOutcodes).not.toContain("E1");
    expect(limited.expectedMix.nearby_opportunity).toBe(20);
  });

  it("A7: offers the three ways forward, with no waitlist", () => {
    const p = preview(YORK_BRIEF, 20, far);
    expect(p.cannotMeet).toEqual({
      reason: "area",
      canWiden: false,
      canSwitchToSmallerPlan: true,
      canBookCall: true,
    });
  });

  it("offers widening only while the customer's own travel limit is what binds", () => {
    const at = (travel: 10 | 25 | 50 | null, plan: BriefPlan) =>
      preview({ basePostcode: "YO10", travelLimitMiles: travel }, plan, far).cannotMeet!.canWiden;
    expect(at(25, 20)).toBe(true);
    expect(at(50, 20)).toBe(true);
    expect(at(null, 20)).toBe(false);
    // 50 miles is already past the 10-lead plan's 40-mile maximum.
    expect(at(50, 10)).toBe(false);
    expect(at(25, 10)).toBe(true);
  });

  it("does not offer a smaller plan to someone already on it", () => {
    expect(preview(YORK_BRIEF, 10, far).cannotMeet!.canSwitchToSmallerPlan).toBe(false);
  });

  it("never reaches past the travel limit, and reports a priority area beyond it", () => {
    const p = preview({ basePostcode: "YO10", travelLimitMiles: 25, priorityOutcodes: ["M1", "LS1"] }, 20, far);
    expect(p.capMiles).toBe(25);
    expect(p.serviceRadiusMiles).toBe(25);
    expect(p.priorityOutsideCap).toEqual(["M1"]);
    expect(p.serviceOutcodes).toContain("LS1");
    expect(p.serviceOutcodes).not.toContain("M1");
    expectStorable(p);
  });

  it("an empty book is a preview too, not a crash", () => {
    const p = preview(YORK_BRIEF, 20, supply());
    expect(p.meetsTarget).toBe(false);
    expect(p.cannotMeet?.reason).toBe("area");
    expectStorable(p);
  });
});

describe("computeBriefPreview — essentials that cannot be met", () => {
  it("⚠️ says the essentials are the reason when the area alone could fill the plan", () => {
    const p = preview({ ...YORK_BRIEF, minBedrooms: 6, minGross: 75000 }, 20, YORK);
    expect(p.meetsTarget).toBe(false);
    expect(p.serviceRadiusMiles).toBe(75);
    expect(p.cannotMeet).toEqual({
      reason: "essentials",
      canWiden: false,
      canSwitchToSmallerPlan: true,
      canBookCall: true,
    });
    expect(p.expectedMix.nearby_opportunity).toBe(20);
    expectStorable(p);
  });

  it("offers the one-step relaxation that fills the plan, as a gain", () => {
    // Only Harrogate's leads are 4-bed; at 3+ the 30-mile circle fills it.
    const p = preview({ ...YORK_BRIEF, minBedrooms: 4 }, 20, YORK);
    expect(p.cannotMeet?.reason).toBe("essentials");
    expect(p.tradeoffs).toEqual([
      { essential: "bedrooms", from: 4, to: 3, radiusMiles: 30, milesSaved: 45, fillsPlan: true },
    ]);
    expectStorable(p);
  });

  it("calls it the area, not the essentials, when dropping them would not help either", () => {
    const p = preview({ ...YORK_BRIEF, minBedrooms: 10, minGross: 75000 }, 20, supply());
    expect(p.cannotMeet?.reason).toBe("area");
    expect(p.tradeoffs).toEqual([]);
  });

  it("refuses an input it cannot place with issues, never a throw", () => {
    expect(computeBriefPreview({ basePostcode: "M50 2HN", travelLimitMiles: 10 }, 10, YORK)).toEqual({
      ok: false,
      issues: [{ code: "base_outcode_unplaceable", outcode: "M50" }],
    });
    expect(computeBriefPreview({ basePostcode: "York", travelLimitMiles: 10 }, 10, YORK).ok).toBe(false);
  });

  it("runs without a fixed day", () => {
    expect(computeBriefPreview(YORK_BRIEF, 10, YORK).ok).toBe(true);
  });
});

describe("computeBriefPreview — other customers", () => {
  // A filter on LS and a brief based in Harrogate take ground from us, which
  // is what puts outcodes in the behind-pace ring.
  const crowded = supply({
    ...YORK,
    filteredAreas: ["LS"],
    otherBriefs: [otherBrief({ customerId: "hg", areaOutcodes: ["HG1"], reachMiles: 25, serviceOutcodes: ["HG1", "HG2"] })],
  });
  const p = preview({ ...YORK_BRIEF, travelLimitMiles: 50 }, 20, crowded);

  it("gives no first pick in an area a legacy filter names or another brief serves", () => {
    expect(p.firstPickOutcodes.some((oc) => oc.startsWith("LS"))).toBe(false);
    expect(p.firstPickOutcodes).not.toContain("HG1");
    expect(p.firstPickOutcodes).not.toContain("HG2");
  });

  it("puts the rest of the cap in the behind-pace ring, beyond the area and apart from first picks", () => {
    expect(p.paceOutcodes.length).toBeGreaterThan(0);
    const d = distancesFrom("YO10")!;
    for (const oc of p.paceOutcodes) {
      expect(p.serviceOutcodes).not.toContain(oc);
      expect(p.firstPickOutcodes).not.toContain(oc);
      expect(d.get(oc)!).toBeLessThanOrEqual(p.capMiles);
    }
    expectStorable(p);
  });

  it("respects another brief's first picks while their lock holds", () => {
    const locked = supply({
      ...YORK,
      otherBriefs: [otherBrief({ areaOutcodes: ["ZE1"], reachMiles: 10, firstPickOutcodes: ["YO1"], lockedUntil: TODAY })],
    });
    expect(preview(YORK_BRIEF, 20, locked).firstPickOutcodes).not.toContain("YO1");
    const r = computeBriefPreview(YORK_BRIEF, 20, locked, { today: "2026-10-09" });
    expect(r.ok && r.preview.firstPickOutcodes).toContain("YO1");
  });

  it("shows the admin's competition tier on the base and the first picks", () => {
    const tiered = preview(YORK_BRIEF, 20, supply({ ...YORK, competition: { "outcode:YO10": "low", "postcode_area:YO": "high" } }));
    expect(tiered.priorityAreaTiers[0]).toEqual({ outcode: "YO10", tier: "low" });
    expect(tiered.firstPickTiers.find((t) => t.outcode === "YO1")?.tier).toBe("high");
  });
});

describe("previewForClient — what a browser may see (A4, locked decision 9)", () => {
  const crowded = supply({
    ...YORK,
    filteredAreas: ["LS"],
    otherBriefs: [otherBrief({ customerId: "hg", areaOutcodes: ["HG1"], reachMiles: 25, serviceOutcodes: ["HG1", "HG2"] })],
  });
  const server = preview({ ...YORK_BRIEF, travelLimitMiles: 50, minBedrooms: 4, priorityOutcodes: ["S1"] }, 20, crowded);
  const client = previewForClient(server);

  it("has exactly these keys — a field added to the preview cannot reach a client by accident", () => {
    // Duplicated on purpose (§27.2): a list derived from the code would pass whatever changed.
    expect(Object.keys(client).sort()).toEqual(
      [
        "basePostcode",
        "baseOutcode",
        "cannotMeet",
        "coverage",
        "expectedMix",
        "firstPicks",
        "meetsTarget",
        "mixLeansNearby",
        "moreFirstPicks",
        "operatingMode",
        "plan",
        "priorities",
        "priorityAreas",
        "priorityOutsideCap",
        "serviceRadiusMiles",
        "similarAreas",
        "tradeoffs",
        "travelLimitMiles",
      ].sort()
    );
  });

  it("carries no key, at any depth, that names a volume, a count or the supply", () => {
    // "mixLeansNearby" is not a /lead/ hit: L-e-a-n-s.
    const banned = /count|volume|supply|deliverable|weeks|holder|contention|deficit|sample|lead|outcodes$/i;
    const walk = (v: unknown, path: string) => {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          expect(k, `${path}.${k}`).not.toMatch(banned);
          walk(x, `${path}.${k}`);
        }
      }
    };
    walk(client, "client");
    // And the walk itself can see a leak: a server-side key fails it.
    expect(() => walk({ serviceOutcodes: [] }, "probe")).toThrow();
    expect(() => walk({ x: { supplyCheck: {} } }, "probe")).toThrow();
  });

  it("⚠️ names no outcode beyond the base, the customer's own areas and the nearest first picks", () => {
    const allowed = new Set([
      server.brief.baseOutcode,
      ...server.brief.priorityOutcodes,
      ...server.priorityOutsideCap,
      ...server.firstPickOutcodes.slice(0, PREVIEW_FIRST_PICKS),
    ]);
    const named = JSON.stringify(client).match(/"[A-Z]{1,2}[0-9][A-Z0-9]?"/g) ?? [];
    for (const q of named) expect(allowed).toContain(q.slice(1, -1));
    // The service and behind-pace lists are far longer than that, and absent.
    expect(server.serviceOutcodes.length + server.paceOutcodes.length).toBeGreaterThan(allowed.size * 2);
    expect(client.firstPicks).toHaveLength(PREVIEW_FIRST_PICKS);
    expect(client.moreFirstPicks).toBe(true);
  });

  it("copies rather than shares, so editing the client object cannot reach the server preview", () => {
    const copy = previewForClient(server);
    copy.coverage[0].radiusMiles = 999;
    copy.expectedMix.top_match = 999;
    copy.similarAreas[0].figures.gross = 999;
    expect(server.similarAreas[0].figures.gross).not.toBe(999);
    expect(server.coverage[0].radiusMiles).not.toBe(999);
    expect(server.expectedMix.top_match).not.toBe(999);
  });

  it("keeps the A7 options and the trade-offs a customer acts on", () => {
    expect(client.cannotMeet).toEqual(server.cannotMeet);
    expect(client.tradeoffs).toEqual(server.tradeoffs);
    expect(client.coverage).toEqual(server.coverage.map(({ plan, radiusMiles, meetsTarget }) => ({ plan, radiusMiles, meetsTarget })));
  });
});
