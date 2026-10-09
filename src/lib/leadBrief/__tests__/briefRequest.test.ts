import { describe, it, expect } from "vitest";
import { MAX_EXTRA_AREAS, parseBriefBody } from "@/lib/leadBrief/briefRequest";

describe("parseBriefBody", () => {
  it("reads the named fields", () => {
    const p = parseBriefBody({
      basePostcode: "YO10 5DD",
      priorityOutcodes: ["LS6", " HG1 "],
      travelLimitMiles: 25,
      minBedrooms: 3,
      minGross: 40000,
      similarAreas: ["LS"],
      shownRadiusMiles: 30,
    });
    expect(p.input).toEqual({
      basePostcode: "YO10 5DD",
      priorityOutcodes: ["LS6", "HG1"],
      travelLimitMiles: 25,
      minBedrooms: 3,
      minGross: 40000,
      similarAreas: ["LS"],
    });
    expect(p.similarAreasGiven).toBe(true);
    expect(p.shownRadiusMiles).toBe(30);
  });

  it("keeps null as anywhere and leaves a missing travel limit for the validator", () => {
    expect(parseBriefBody({ travelLimitMiles: null }).input.travelLimitMiles).toBeNull();
    expect(parseBriefBody({}).input.travelLimitMiles).toBeUndefined();
  });

  it("knows when no similar areas were sent (the first preview)", () => {
    expect(parseBriefBody({ basePostcode: "YO10" }).similarAreasGiven).toBe(false);
    expect(parseBriefBody({ basePostcode: "YO10", similarAreas: [] }).similarAreasGiven).toBe(true);
  });

  it("reads nothing outside the closed set (no ranking, thresholds or plan from the body)", () => {
    const p = parseBriefBody({
      basePostcode: "YO10",
      travelLimitMiles: 10,
      ranking: ["revenue"],
      thresholds: { revenue: 1 },
      plan: 10,
      allocation: 10,
      serviceOutcodes: ["ZZ1"],
    });
    expect(Object.keys(p.input).sort()).toEqual(
      ["basePostcode", "minBedrooms", "minGross", "priorityOutcodes", "similarAreas", "travelLimitMiles"].sort()
    );
  });

  it("caps the number of extra areas", () => {
    const many = Array.from({ length: 50 }, (_, i) => `LS${i + 1}`);
    expect(parseBriefBody({ priorityOutcodes: many }).input.priorityOutcodes).toHaveLength(MAX_EXTRA_AREAS);
  });

  it("survives a junk body", () => {
    expect(parseBriefBody(null).input.basePostcode).toBe("");
    expect(parseBriefBody("x").input.priorityOutcodes).toEqual([]);
    expect(parseBriefBody({ minBedrooms: "3" }).input.minBedrooms).toBeNull();
  });
});
