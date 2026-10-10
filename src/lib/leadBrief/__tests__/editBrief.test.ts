import { describe, it, expect } from "vitest";
import {
  BEDROOM_LEVELS,
  LOCATION_LEVELS,
  OCCUPANCY_LEVELS,
  REVENUE_LEVELS,
  basePostcodeChanged,
  buildEditedPriorities,
  carryEditToScheduled,
  keptForRecompute,
  offeredLevels,
  parseEditBody,
  planAndTravelOf,
  readStoredPriorities,
  sameAreaAnswers,
  type StoredPriority,
} from "@/lib/leadBrief/editBrief";
import { briefRowFromPreview } from "@/lib/leadBrief/briefRow";
import { normaliseBriefInput } from "@/lib/leadBrief/input";
import { computeBriefPreview } from "@/lib/leadBrief/preview";
import { leads, supply } from "./fixtures";

/**
 * The "Your brief" editor's rules (Lead Brief Phase 5, Part B): what a
 * priorities edit may change, how a pending area change keeps it, and what an
 * area recompute keeps from the stored brief.
 */

const STORED: StoredPriority[] = [
  { key: "location", threshold: 20, chosen: false },
  { key: "revenue", threshold: 40000, chosen: false },
  { key: "bedrooms", threshold: 3, chosen: false },
  { key: "occupancy", threshold: 55, chosen: false },
];

const ID = "0f9c2a3e-1b2c-4d5e-8f90-123456789abc";

describe("readStoredPriorities", () => {
  it("reads key, threshold and the chosen marker, in stored order", () => {
    expect(
      readStoredPriorities([
        { key: "revenue", threshold: 40000, chosen: true },
        { key: "location" },
      ])
    ).toEqual([
      { key: "revenue", threshold: 40000, chosen: true },
      { key: "location", threshold: null, chosen: false },
    ]);
  });

  it("drops unknown keys, duplicates and junk, and never throws", () => {
    expect(readStoredPriorities(null)).toEqual([]);
    expect(readStoredPriorities({ key: "location" })).toEqual([]);
    expect(
      readStoredPriorities([
        { key: "price", threshold: 1 },
        "location",
        { key: "location", threshold: "20" },
        { key: "location", threshold: 30 },
      ])
    ).toEqual([{ key: "location", threshold: null, chosen: false }]);
  });

  it("only a literal true is chosen", () => {
    expect(readStoredPriorities([{ key: "location", threshold: 5, chosen: "true" }])[0].chosen).toBe(false);
  });
});

describe("offeredLevels", () => {
  it("cuts location at the plan's reach and the travel limit (A3)", () => {
    expect(offeredLevels("location", { plan: 10, travel: null, current: null })).toEqual(
      LOCATION_LEVELS.filter((m) => m <= 40)
    );
    expect(offeredLevels("location", { plan: 20, travel: null, current: null })).toEqual([...LOCATION_LEVELS]);
    expect(offeredLevels("location", { plan: 20, travel: 25, current: null })).toEqual([5, 10, 15, 20, 25]);
  });

  it("the fixed lists for the other priorities", () => {
    expect(offeredLevels("revenue", { plan: 20, travel: null, current: null })).toEqual([...REVENUE_LEVELS]);
    expect(offeredLevels("bedrooms", { plan: 20, travel: null, current: null })).toEqual([...BEDROOM_LEVELS]);
    expect(offeredLevels("occupancy", { plan: 20, travel: null, current: null })).toEqual([...OCCUPANCY_LEVELS]);
  });

  it("always includes the current level, in order, so the select can show it", () => {
    expect(offeredLevels("location", { plan: 10, travel: null, current: 12 })).toEqual([5, 10, 12, 15, 20, 25, 30, 40]);
    expect(offeredLevels("revenue", { plan: 20, travel: null, current: 42300 })).toContain(42300);
  });

  it("never offers bedrooms above 5", () => {
    expect(Math.max(...BEDROOM_LEVELS)).toBe(5);
  });
});

describe("buildEditedPriorities", () => {
  const base = { stored: STORED, essentials: [] as ("bedrooms" | "revenue")[], plan: 20 as const, travel: null };

  it("reorders, keeping every engine-set level unpinned", () => {
    const r = buildEditedPriorities({
      ...base,
      edit: { ranking: ["revenue", "location", "bedrooms", "occupancy"], levels: {} },
    });
    expect(r).toEqual({
      ok: true,
      changed: true,
      priorities: [
        { key: "revenue", threshold: 40000 },
        { key: "location", threshold: 20 },
        { key: "bedrooms", threshold: 3 },
        { key: "occupancy", threshold: 55 },
      ],
    });
  });

  it("a level the customer sets is marked chosen", () => {
    const r = buildEditedPriorities({
      ...base,
      edit: { ranking: STORED.map((p) => p.key), levels: { location: 15 } },
    });
    expect(r.ok && r.priorities[0]).toEqual({ key: "location", threshold: 15, chosen: true });
    expect(r.ok && r.changed).toBe(true);
  });

  it("sending the current engine-set level back changes nothing and pins nothing", () => {
    const r = buildEditedPriorities({
      ...base,
      edit: { ranking: STORED.map((p) => p.key), levels: { location: 20 } },
    });
    expect(r).toEqual({
      ok: true,
      changed: false,
      priorities: STORED.map((p) => ({ key: p.key, threshold: p.threshold })),
    });
  });

  it("re-sending a chosen level keeps it chosen", () => {
    const stored = STORED.map((p) => (p.key === "location" ? { ...p, threshold: 15, chosen: true } : p));
    const r = buildEditedPriorities({ ...base, stored, edit: { ranking: STORED.map((p) => p.key), levels: { location: 15 } } });
    expect(r.ok && r.priorities[0]).toEqual({ key: "location", threshold: 15, chosen: true });
    expect(r.ok && r.changed).toBe(false);
  });

  it("refuses a ranking that is not exactly the stored keys", () => {
    for (const ranking of [
      ["location", "revenue", "bedrooms"],
      ["location", "revenue", "bedrooms", "bedrooms"],
      ["location", "revenue", "bedrooms", "occupancy", "location"],
    ] as ("location" | "revenue" | "bedrooms" | "occupancy")[][]) {
      expect(buildEditedPriorities({ ...base, edit: { ranking, levels: {} } })).toEqual({
        ok: false,
        code: "ranking_invalid",
      });
    }
  });

  it("an essential's level is set under Q3, never here (decided 9 Oct)", () => {
    const r = buildEditedPriorities({
      ...base,
      essentials: ["bedrooms"],
      edit: { ranking: STORED.map((p) => p.key), levels: { bedrooms: 2 } },
    });
    expect(r).toEqual({ ok: false, code: "level_essential", key: "bedrooms" });
  });

  it("refuses a level that is not offered", () => {
    expect(
      buildEditedPriorities({ ...base, plan: 10, edit: { ranking: STORED.map((p) => p.key), levels: { location: 75 } } })
    ).toEqual({ ok: false, code: "level_invalid", key: "location" });
    expect(
      buildEditedPriorities({ ...base, edit: { ranking: STORED.map((p) => p.key), levels: { bedrooms: 6 } } })
    ).toEqual({ ok: false, code: "level_invalid", key: "bedrooms" });
    expect(
      buildEditedPriorities({ ...base, edit: { ranking: STORED.map((p) => p.key), levels: { revenue: 41234 } } })
    ).toEqual({ ok: false, code: "level_invalid", key: "revenue" });
  });

  it("refuses a level for a priority the brief does not have", () => {
    const stored = STORED.filter((p) => p.key !== "occupancy");
    expect(
      buildEditedPriorities({
        ...base,
        stored,
        edit: { ranking: stored.map((p) => p.key), levels: { occupancy: 60 } },
      })
    ).toEqual({ ok: false, code: "level_invalid", key: "occupancy" });
  });

  it("never writes a null threshold (the 0162 CHECK refuses one)", () => {
    const stored = STORED.map((p) => (p.key === "occupancy" ? { ...p, threshold: null } : p));
    const r = buildEditedPriorities({ ...base, stored, edit: { ranking: stored.map((p) => p.key), levels: {} } });
    expect(r.ok && r.priorities[3]).toEqual({ key: "occupancy" });
  });

  it("an unset level can be set", () => {
    const stored = STORED.map((p) => (p.key === "occupancy" ? { ...p, threshold: null } : p));
    const r = buildEditedPriorities({
      ...base,
      stored,
      edit: { ranking: stored.map((p) => p.key), levels: { occupancy: 60 } },
    });
    expect(r.ok && r.priorities[3]).toEqual({ key: "occupancy", threshold: 60, chosen: true });
  });
});

describe("carryEditToScheduled", () => {
  const scheduled: StoredPriority[] = [
    { key: "location", threshold: 30, chosen: false },
    { key: "revenue", threshold: 50000, chosen: false },
    { key: "bedrooms", threshold: 2, chosen: false },
    { key: "occupancy", threshold: 50, chosen: false },
  ];

  it("takes the new ranking and the chosen levels, keeping engine-set levels from the pending area", () => {
    const out = carryEditToScheduled({
      scheduled,
      scheduledEssentials: [],
      edited: [
        { key: "occupancy", threshold: 60, chosen: true },
        { key: "location", threshold: 20 },
        { key: "revenue", threshold: 40000 },
        { key: "bedrooms", threshold: 3 },
      ],
    });
    expect(out).toEqual([
      { key: "occupancy", threshold: 60, chosen: true },
      { key: "location", threshold: 30 },
      { key: "revenue", threshold: 50000 },
      { key: "bedrooms", threshold: 2 },
    ]);
  });

  it("never overwrites a priority that is an essential in the pending brief", () => {
    const out = carryEditToScheduled({
      scheduled,
      scheduledEssentials: ["revenue"],
      edited: [
        { key: "revenue", threshold: 30000, chosen: true },
        { key: "location", threshold: 20 },
        { key: "bedrooms", threshold: 3 },
        { key: "occupancy", threshold: 55 },
      ],
    });
    expect(out[0]).toEqual({ key: "revenue", threshold: 50000 });
  });

  it("a priority only the pending brief has keeps its place at the end", () => {
    const out = carryEditToScheduled({
      scheduled,
      scheduledEssentials: [],
      edited: [
        { key: "revenue", threshold: 40000 },
        { key: "location", threshold: 20 },
      ],
    });
    expect(out.map((p) => p.key)).toEqual(["revenue", "location", "bedrooms", "occupancy"]);
  });
});

describe("keptForRecompute", () => {
  it("keeps the ranking and the chosen levels only", () => {
    const stored: StoredPriority[] = [
      { key: "revenue", threshold: 40000, chosen: false },
      { key: "location", threshold: 15, chosen: true },
      { key: "occupancy", threshold: 60, chosen: true },
      { key: "bedrooms", threshold: 3, chosen: false },
    ];
    expect(keptForRecompute(stored, { minBedrooms: null, minGross: null })).toEqual({
      ranking: ["revenue", "location", "occupancy", "bedrooms"],
      thresholds: { location: 15, occupancy: 60 },
    });
  });

  it("drops a chosen level on a priority that becomes an essential (its level is the Q3 answer)", () => {
    const stored: StoredPriority[] = [
      { key: "revenue", threshold: 40000, chosen: true },
      { key: "bedrooms", threshold: 3, chosen: true },
      { key: "location", threshold: 15, chosen: true },
    ];
    expect(keptForRecompute(stored, { minBedrooms: 2, minGross: 50000 }).thresholds).toEqual({ location: 15 });
  });

  it("feeds an area recompute that keeps the ranking and the chosen level", () => {
    const s = supply({ leads: [...leads(30, "YO10"), ...leads(30, "YO31"), ...leads(60, "LS1")] });
    const kept = keptForRecompute(
      [
        { key: "occupancy", threshold: 60, chosen: true },
        { key: "location", threshold: 20, chosen: false },
        { key: "revenue", threshold: 40000, chosen: false },
        { key: "bedrooms", threshold: 2, chosen: false },
      ],
      { minBedrooms: null, minGross: null }
    );
    const r = computeBriefPreview(
      { basePostcode: "YO10 5DD", travelLimitMiles: 50, ranking: kept.ranking, thresholds: kept.thresholds },
      20,
      s,
      { today: "2026-10-09" }
    );
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(r.preview.priorities.map((p) => p.key)).toEqual(["occupancy", "location", "revenue", "bedrooms"]);
    expect(r.preview.priorities[0].threshold).toBe(60);

    const row = briefRowFromPreview(r.preview, {
      customerId: "c1",
      version: 1,
      lockedUntil: null,
      now: new Date("2026-10-09T10:00:00Z"),
      status: "scheduled",
      chosenKeys: Object.keys(kept.thresholds) as ("occupancy")[],
    });
    expect(row.status).toBe("scheduled");
    expect(row.priorities[0]).toEqual({ key: "occupancy", threshold: 60, chosen: true });
    // An engine-set level is never marked chosen.
    expect(row.priorities.slice(1).some((p) => "chosen" in p)).toBe(false);
  });
});

describe("basePostcodeChanged (batch 05, locked decision 1)", () => {
  // Both routes compare the normalised answer to the stored row, so drive it
  // through normaliseBriefInput rather than hand-writing canonical strings.
  function typed(basePostcode: string): string {
    const r = normaliseBriefInput({ basePostcode, travelLimitMiles: 25 });
    if (!r.ok) throw new Error(`fixture did not normalise: ${basePostcode}`);
    return r.brief.basePostcode;
  }
  const row = { base_postcode: "YO10 5DD" };

  it("the same postcode, however it is typed, is not a change", () => {
    expect(basePostcodeChanged(row, { basePostcode: typed("YO10 5DD") })).toBe(false);
    expect(basePostcodeChanged(row, { basePostcode: typed("yo105dd") })).toBe(false);
    expect(basePostcodeChanged(row, { basePostcode: typed("  yo10   5dd ") })).toBe(false);
  });

  it("another postcode is a change, in the same outcode or another", () => {
    expect(basePostcodeChanged(row, { basePostcode: typed("YO10 4AA") })).toBe(true);
    expect(basePostcodeChanged(row, { basePostcode: typed("LS1 4AP") })).toBe(true);
  });

  it("is strict between an outcode and a full postcode in it", () => {
    expect(basePostcodeChanged(row, { basePostcode: typed("YO10") })).toBe(true);
    expect(basePostcodeChanged({ base_postcode: "YO10" }, { basePostcode: typed("YO10 5DD") })).toBe(true);
    expect(basePostcodeChanged({ base_postcode: "YO10" }, { basePostcode: typed("yo10") })).toBe(false);
  });
});

describe("sameAreaAnswers", () => {
  const row = {
    base_postcode: "YO10 5DD",
    priority_outcodes: ["YO31", "HG1"],
    travel_limit_miles: 25,
    min_bedrooms: 3,
    min_gross: null,
    similar_areas: ["LS"],
  };
  const same = {
    basePostcode: "YO10 5DD",
    priorityOutcodes: ["HG1", "YO31"],
    travelLimitMiles: 25 as const,
    minBedrooms: 3,
    minGross: null,
    similarAreas: ["LS"],
  };

  it("is the same in any order", () => {
    expect(sameAreaAnswers(row, same)).toBe(true);
  });

  it("any one answer different is a change", () => {
    expect(sameAreaAnswers(row, { ...same, basePostcode: "YO31 7AA" })).toBe(false);
    expect(sameAreaAnswers(row, { ...same, priorityOutcodes: ["YO31"] })).toBe(false);
    expect(sameAreaAnswers(row, { ...same, travelLimitMiles: null })).toBe(false);
    expect(sameAreaAnswers(row, { ...same, minBedrooms: null })).toBe(false);
    expect(sameAreaAnswers(row, { ...same, minGross: 40000 })).toBe(false);
    expect(sameAreaAnswers(row, { ...same, similarAreas: [] })).toBe(false);
  });

  it("null lists on the row read as empty", () => {
    expect(
      sameAreaAnswers(
        { ...row, priority_outcodes: null, similar_areas: null },
        { ...same, priorityOutcodes: [], similarAreas: [] }
      )
    ).toBe(true);
  });
});

describe("parseEditBody", () => {
  it("reads a priorities edit as a closed set of named fields", () => {
    expect(
      parseEditBody({
        kind: "priorities",
        expectedActiveId: ID,
        ranking: ["revenue", "location"],
        levels: { location: 15 },
        anything: "else",
      })
    ).toEqual({ kind: "priorities", expectedActiveId: ID, edit: { ranking: ["revenue", "location"], levels: { location: 15 } } });
  });

  it("refuses a missing or malformed active id, kind, ranking or level", () => {
    expect(parseEditBody(null)).toBeNull();
    expect(parseEditBody([])).toBeNull();
    expect(parseEditBody({ kind: "priorities", ranking: [] })).toBeNull();
    expect(parseEditBody({ kind: "priorities", expectedActiveId: "not-a-uuid", ranking: [] })).toBeNull();
    expect(parseEditBody({ kind: "rename", expectedActiveId: ID })).toBeNull();
    expect(parseEditBody({ kind: "priorities", expectedActiveId: ID, ranking: ["price"] })).toBeNull();
    expect(parseEditBody({ kind: "priorities", expectedActiveId: ID, ranking: "location" })).toBeNull();
    expect(
      parseEditBody({ kind: "priorities", expectedActiveId: ID, ranking: ["location"], levels: { price: 1 } })
    ).toBeNull();
    expect(
      parseEditBody({ kind: "priorities", expectedActiveId: ID, ranking: ["location"], levels: { location: "15" } })
    ).toBeNull();
    expect(
      parseEditBody({
        kind: "priorities",
        expectedActiveId: ID,
        ranking: ["location", "revenue", "bedrooms", "occupancy", "location"],
      })
    ).toBeNull();
  });

  it("hands an area change's answers to the questionnaire's parser", () => {
    const body = { kind: "area", expectedActiveId: ID, basePostcode: "YO10 5DD", shownRadiusMiles: 25 };
    expect(parseEditBody(body)).toEqual({ kind: "area", expectedActiveId: ID, body });
  });
});

describe("planAndTravelOf", () => {
  it("reads the plan and travel limit stored on a version", () => {
    expect(planAndTravelOf({ allocation: 10, travel_limit_miles: 25 })).toEqual({ plan: 10, travel: 25 });
    expect(planAndTravelOf({ allocation: 20, travel_limit_miles: null })).toEqual({ plan: 20, travel: null });
  });

  it("an odd value falls back safely", () => {
    expect(planAndTravelOf({ allocation: 8, travel_limit_miles: 30 })).toEqual({ plan: 10, travel: null });
    expect(planAndTravelOf({ allocation: 30, travel_limit_miles: 50 })).toEqual({ plan: 20, travel: 50 });
  });
});
