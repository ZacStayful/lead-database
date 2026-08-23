import { describe, it, expect } from "vitest";
import {
  buildLeadVolumeAggregate,
  predictMonthlyVolume,
  parseBedrooms,
  weeksElapsedSince,
  INGEST_EPOCH_ISO,
  WEEKS_PER_MONTH,
  type LeadVolumeRow,
} from "@/lib/filterPrediction";

const NOW = new Date("2026-08-23T00:00:00Z");

function row(over: Partial<LeadVolumeRow> = {}): LeadVolumeRow {
  return {
    postcode_area: "LS",
    bedrooms: "3",
    lead_type: "management",
    created_at: "2026-08-01T00:00:00Z",
    ...over,
  };
}

describe("parseBedrooms — must stay identical to the SQL in 0026", () => {
  it.each([
    ["3", 3],
    ["3 bed", 3],
    ["2-3", 2],
    ["studio", null],
    ["", null],
    [null, null],
    [undefined, null],
  ])("%s -> %s", (input, expected) => {
    expect(parseBedrooms(input as string | null)).toBe(expected);
  });
});

describe("weeksElapsedSince", () => {
  it("floors at one week so an early window cannot inflate the rate", () => {
    expect(weeksElapsedSince("2026-08-22", new Date("2026-08-23T00:00:00Z"))).toBe(1);
  });

  it("measures real elapsed weeks past the floor", () => {
    // 28 days = exactly 4 weeks.
    expect(
      weeksElapsedSince("2026-07-01", new Date("2026-07-29T00:00:00Z"))
    ).toBeCloseTo(4, 6);
  });
});

describe("buildLeadVolumeAggregate", () => {
  it("counts a matchable lead into both totals and the area/bed index", () => {
    const agg = buildLeadVolumeAggregate([row()], NOW);
    expect(agg.management.totalLeads).toBe(1);
    expect(agg.management.matchableLeads).toBe(1);
    expect(agg.management.areaBedCounts.LS["3"]).toBe(1);
  });

  it("keeps an unparseable lead in totals but out of the index", () => {
    const agg = buildLeadVolumeAggregate(
      [row({ postcode_area: null }), row({ bedrooms: "studio" })],
      NOW
    );
    expect(agg.management.totalLeads).toBe(2);
    expect(agg.management.matchableLeads).toBe(0);
    expect(agg.management.areaBedCounts).toEqual({});
  });

  it("uppercases and trims the area, mirroring the router's expectation", () => {
    const agg = buildLeadVolumeAggregate([row({ postcode_area: " ls " })], NOW);
    expect(agg.management.areaBedCounts.LS["3"]).toBe(1);
  });

  it("drops rows before the ingest epoch", () => {
    const agg = buildLeadVolumeAggregate(
      [row({ created_at: "2026-06-30T23:59:59Z" })],
      NOW
    );
    expect(agg.management.totalLeads).toBe(0);
  });

  it("separates the two products", () => {
    const agg = buildLeadVolumeAggregate(
      [row(), row({ lead_type: "guaranteed_rent" })],
      NOW
    );
    expect(agg.management.totalLeads).toBe(1);
    expect(agg.guaranteed_rent.totalLeads).toBe(1);
  });

  it("ignores a row with an unknown lead_type", () => {
    const agg = buildLeadVolumeAggregate([row({ lead_type: "something" })], NOW);
    expect(agg.management.totalLeads).toBe(0);
    expect(agg.guaranteed_rent.totalLeads).toBe(0);
  });

  // Invariant 11 (0073): a lead claimed from the expired pool, or pooled on the
  // `ignored` basis, is never re-allocated by ordinary routing. Counting it
  // would promise supply the router will never hand over.
  it("drops a retired lead from BOTH totals, not just the matchable index", () => {
    const agg = buildLeadVolumeAggregate(
      [row(), row({ retired: true })],
      NOW
    );
    expect(agg.management.totalLeads).toBe(1);
    expect(agg.management.matchableLeads).toBe(1);
    expect(agg.management.areaBedCounts.LS["3"]).toBe(1);
  });

  it("treats retired: false / null / undefined as live", () => {
    const agg = buildLeadVolumeAggregate(
      [row({ retired: false }), row({ retired: null }), row()],
      NOW
    );
    expect(agg.management.totalLeads).toBe(3);
  });
});

describe("predictMonthlyVolume", () => {
  const agg = buildLeadVolumeAggregate(
    [
      ...Array.from({ length: 10 }, () => row({ postcode_area: "LS", bedrooms: "3" })),
      ...Array.from({ length: 4 }, () => row({ postcode_area: "BD", bedrooms: "1" })),
    ],
    NOW
  );
  const vol = agg.management;

  it("empty areas means anywhere", () => {
    const p = predictMonthlyVolume(vol, { areas: [], minBedrooms: null, maxBedrooms: null });
    expect(p.matchingLeads).toBe(14);
  });

  it("restricts by area, case-insensitively", () => {
    const p = predictMonthlyVolume(vol, { areas: ["ls"], minBedrooms: null, maxBedrooms: null });
    expect(p.matchingLeads).toBe(10);
  });

  it("applies open-ended bedroom bounds", () => {
    expect(
      predictMonthlyVolume(vol, { areas: [], minBedrooms: 2, maxBedrooms: null }).matchingLeads
    ).toBe(10);
    expect(
      predictMonthlyVolume(vol, { areas: [], minBedrooms: null, maxBedrooms: 2 }).matchingLeads
    ).toBe(4);
  });

  it("derives the monthly rate from the elapsed window", () => {
    const p = predictMonthlyVolume(vol, { areas: ["LS"], minBedrooms: null, maxBedrooms: null });
    expect(p.monthlyRate).toBeCloseTo((10 / vol.weeksElapsed) * WEEKS_PER_MONTH, 6);
    expect(p.displayRate).toBe(Math.round(p.monthlyRate));
  });

  it("flags a thin sample as unreliable", () => {
    const thin = buildLeadVolumeAggregate([row(), row()], NOW).management;
    expect(
      predictMonthlyVolume(thin, { areas: [], minBedrooms: null, maxBedrooms: null }).reliable
    ).toBe(false);
  });
});

describe("the ingest epoch", () => {
  it("is the documented day 1 of real history", () => {
    expect(INGEST_EPOCH_ISO).toBe("2026-07-01");
  });
});
