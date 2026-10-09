import { describe, it, expect } from "vitest";
import {
  buildBriefMatch,
  matchAreaFor,
  MATCH_REASONS_VERSION,
  prioritiesFromStorage,
  rankBriefCandidates,
  supplyLeadOf,
  type BriefCandidateRow,
} from "@/lib/leadBrief/score";
import type { Lead } from "@/lib/types";
import { lead } from "./fixtures";

const PRIORITIES = [
  { key: "location", threshold: 10 },
  { key: "revenue", threshold: 40000 },
  { key: "bedrooms", threshold: 3 },
  { key: "occupancy", threshold: 60 },
];

function row(over: Partial<BriefCandidateRow> = {}): BriefCandidateRow {
  return {
    customer_id: "c",
    brief_id: "b",
    deficit: "0",
    last_assignment_at: null,
    in_service: true,
    in_first_pick: false,
    pace_only: false,
    allocation: 20,
    travel_limit_miles: 25,
    base_outcode: "YO1",
    priority_outcodes: [],
    similar_areas: [],
    priorities: PRIORITIES,
    ...over,
  };
}

const BRIEF = {
  allocation: 20,
  travel_limit_miles: 25,
  base_outcode: "YO1",
  priority_outcodes: [],
  similar_areas: [],
  priorities: PRIORITIES,
  service_outcodes: ["YO1", "YO10"],
  first_pick_outcodes: ["YO8"],
  pace_outcodes: ["YO7"],
};

describe("supplyLeadOf — a leads row as the engine sees it", () => {
  const base = {
    postcode: " yo10 5dd ",
    postcode_area: "yo",
    bedrooms: "3 bed",
    gross_annual_income: 42000,
    avg_nightly_rate: 150,
    occupancy_rate: 61,
  } as unknown as Lead;

  it("reads the outcode the way 0161 does, and the first run of bedroom digits", () => {
    expect(supplyLeadOf(base)).toEqual({
      outcode: "YO10",
      area: "YO",
      bedrooms: 3,
      gross: 42000,
      nightly: 150,
      occupancy: 61,
    });
  });

  it("turns PostgREST's numeric strings into numbers and blanks into null", () => {
    const s = supplyLeadOf({
      ...base,
      gross_annual_income: "42000.50" as unknown as number,
      occupancy_rate: null,
      bedrooms: "studio",
      postcode: null,
    });
    expect(s.gross).toBe(42000.5);
    expect(s.occupancy).toBeNull();
    expect(s.bedrooms).toBeNull();
    expect(s.outcode).toBeNull();
  });
});

describe("prioritiesFromStorage", () => {
  it("reads an omitted threshold as not resolved", () => {
    expect(prioritiesFromStorage([{ key: "location", threshold: 12 }, { key: "occupancy" }])).toEqual([
      { key: "location", threshold: 12 },
      { key: "occupancy", threshold: null },
    ]);
  });

  it("drops unknown keys, repeats and anything that is not a list", () => {
    expect(prioritiesFromStorage([{ key: "holders" }, { key: "revenue", threshold: 1 }, { key: "revenue", threshold: 2 }])).toEqual([
      { key: "revenue", threshold: 1 },
    ]);
    expect(prioritiesFromStorage({ key: "revenue" })).toEqual([]);
    expect(prioritiesFromStorage(null)).toEqual([]);
  });
});

describe("rankBriefCandidates — the order brief customers are offered a lead in", () => {
  const good = lead("YO10", { gross: 50000, bedrooms: 4, occupancy: 70 });

  it("puts a better match first, whatever the deficits say", () => {
    const ranked = rankBriefCandidates(good, [
      row({ customer_id: "weak", deficit: "9", priorities: [{ key: "revenue", threshold: 90000 }] }),
      row({ customer_id: "strong", deficit: "0" }),
    ]);
    expect(ranked.map((r) => r.customerId)).toEqual(["strong", "weak"]);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it("breaks a tie on score with the deficit, largest first", () => {
    const ranked = rankBriefCandidates(good, [
      row({ customer_id: "level", deficit: "0" }),
      row({ customer_id: "behind", deficit: "3" }),
    ]);
    expect(ranked.map((r) => r.customerId)).toEqual(["behind", "level"]);
  });

  it("then whoever waited longest, with never-served first", () => {
    const ranked = rankBriefCandidates(good, [
      row({ customer_id: "recent", last_assignment_at: "2026-10-08T09:00:00Z" }),
      row({ customer_id: "older", last_assignment_at: "2026-10-01T09:00:00Z" }),
      row({ customer_id: "never", last_assignment_at: null }),
    ]);
    expect(ranked.map((r) => r.customerId)).toEqual(["never", "older", "recent"]);
  });

  it("offers a behind-pace widening only after every in-area customer", () => {
    const ranked = rankBriefCandidates(good, [
      row({ customer_id: "pace", pace_only: true, in_service: false, deficit: "9" }),
      row({ customer_id: "inArea", deficit: "0", priorities: [{ key: "revenue", threshold: 90000 }] }),
    ]);
    expect(ranked.map((r) => r.customerId)).toEqual(["inArea", "pace"]);
  });

  it("keeps the SQL's order when everything else is equal", () => {
    const ranked = rankBriefCandidates(good, [row({ customer_id: "a" }), row({ customer_id: "b" })]);
    expect(ranked.map((r) => r.customerId)).toEqual(["a", "b"]);
  });
});

describe("matchAreaFor", () => {
  it("names why the lead was reachable, service area first", () => {
    expect(matchAreaFor("YO10", BRIEF)).toBe("service");
    expect(matchAreaFor("YO8", BRIEF)).toBe("first_pick");
    expect(matchAreaFor("YO7", BRIEF)).toBe("pace");
    expect(matchAreaFor("LS1", BRIEF)).toBe("outside");
    expect(matchAreaFor(null, BRIEF)).toBe("outside");
    expect(matchAreaFor("YO1", { ...BRIEF, first_pick_outcodes: ["YO1"] })).toBe("service");
  });
});

describe("buildBriefMatch — the label on a delivery", () => {
  const perfect = lead("YO10", { gross: 50000, bedrooms: 4, occupancy: 70 });

  it("calls a lead meeting every judged priority a Top match", () => {
    const m = buildBriefMatch(perfect, BRIEF, { isFirstSale: true });
    expect(m.label).toBe("top_match");
    expect(m.reasons.first_pick).toBe(false);
    expect(m.score).toBe(100);
  });

  it("calls a lead missing exactly one priority a Strong match", () => {
    const m = buildBriefMatch(lead("YO10", { gross: 30000, bedrooms: 4, occupancy: 70 }), BRIEF, {
      isFirstSale: true,
    });
    expect(m.label).toBe("strong_match");
    const revenue = m.reasons.priorities.find((p) => p.key === "revenue");
    expect(revenue).toEqual({ key: "revenue", threshold: 40000, value: 30000, met: false });
  });

  it("gives First pick only on the lead's first sale (D6)", () => {
    const weak = lead("YO8", { gross: 20000, bedrooms: 1, occupancy: 30 });
    expect(buildBriefMatch(weak, BRIEF, { isFirstSale: true }).label).toBe("first_pick");
    expect(buildBriefMatch(weak, BRIEF, { isFirstSale: false }).label).toBe("nearby_opportunity");
  });

  it("puts a First pick tag on a Top match rather than replacing it", () => {
    const m = buildBriefMatch(lead("YO8", { gross: 50000, bedrooms: 4, occupancy: 70 }), {
      ...BRIEF,
      priorities: [{ key: "revenue", threshold: 40000 }],
    }, { isFirstSale: true });
    expect(m.label).toBe("top_match");
    expect(m.reasons.first_pick).toBe(true);
    expect(m.reasons.area).toBe("first_pick");
  });

  it("calls a behind-pace or hand-placed lead a Nearby opportunity whatever it scores", () => {
    const outside = lead("YO7", { gross: 50000, bedrooms: 4, occupancy: 70 });
    const pace = buildBriefMatch(outside, { ...BRIEF, priorities: [{ key: "revenue", threshold: 1 }] }, { isFirstSale: true });
    expect(pace.label).toBe("nearby_opportunity");
    expect(pace.reasons.area).toBe("pace");
    const placed = buildBriefMatch(lead("LS1", { gross: 50000 }), { ...BRIEF, priorities: [{ key: "revenue", threshold: 1 }] }, { isFirstSale: true });
    expect(placed.label).toBe("nearby_opportunity");
    expect(placed.reasons.area).toBe("outside");
  });

  it("rounds the distance to a tenth of a mile", () => {
    const m = buildBriefMatch(perfect, BRIEF, { isFirstSale: true });
    const loc = m.reasons.priorities.find((p) => p.key === "location")!;
    expect(loc.value).not.toBeNull();
    expect(Number.isInteger((loc.value as number) * 10)).toBe(true);
  });

  it("stores only the customer's brief and the lead's own figures (locked decision 9)", () => {
    const m = buildBriefMatch(perfect, BRIEF, { isFirstSale: true });
    expect(Object.keys(m.reasons).sort()).toEqual(["area", "first_pick", "priorities", "v"]);
    expect(m.reasons.v).toBe(MATCH_REASONS_VERSION);
    for (const p of m.reasons.priorities) {
      expect(Object.keys(p).sort()).toEqual(["key", "met", "threshold", "value"]);
    }
    const text = JSON.stringify(m.reasons).toLowerCase();
    for (const banned of ["holder", "operator", "deficit", "volume", "count", "share"]) {
      expect(text).not.toContain(banned);
    }
  });
});
