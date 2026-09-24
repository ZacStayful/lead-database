import { describe, it, expect } from "vitest";
import { filterKindLabel, type LeadFilterView } from "@/lib/leadFilter";

/**
 * `filterKindLabel` had no test at all, which a mutation run found: removing
 * the town from it left every suite green while admin silently went back to
 * reading "Radius: 20 mi from SP1" for a search made by typing Salisbury.
 */
const view = (over: Partial<LeadFilterView> = {}): LeadFilterView => ({
  leadType: "management",
  label: "Management",
  status: "active",
  areas: ["SP", "BA"],
  minBedrooms: null,
  maxBedrooms: null,
  minGross: null,
  liftDate: null,
  selectionMode: "radius",
  radiusOutcode: "SP1",
  radiusMiles: 20,
  radiusPlace: "Salisbury",
  expectedLeads: null,
  forecastCostPerLeadPence: null,
  forecastLikelihoodPct: null,
  forecastAcknowledgedAt: null,
  ...over,
});

describe("filterKindLabel", () => {
  it("⚠️ names the town the customer actually typed", () => {
    expect(filterKindLabel(view())).toBe("Radius: 20 mi from Salisbury (SP1)");
  });

  it("falls back to the bare outcode", () => {
    // Every radius filter set before 0157, and every one centred on a
    // postcode rather than a name.
    expect(filterKindLabel(view({ radiusPlace: null }))).toBe(
      "Radius: 20 mi from SP1"
    );
  });

  it("⚠️ says hand-picked unless the mode really was radius", () => {
    // A stale radius outcode behind a hand-picked filter must not be read as
    // a radius search — 0094 deliberately does not clear these on a lift.
    expect(filterKindLabel(view({ selectionMode: "areas" }))).toBe(
      "Hand-picked areas"
    );
    expect(filterKindLabel(view({ selectionMode: null }))).toBe(
      "Hand-picked areas"
    );
  });

  it("says hand-picked when the radius details are incomplete", () => {
    expect(filterKindLabel(view({ radiusOutcode: null }))).toBe(
      "Hand-picked areas"
    );
    expect(filterKindLabel(view({ radiusMiles: null }))).toBe(
      "Hand-picked areas"
    );
  });

  it("carries the new distances", () => {
    expect(filterKindLabel(view({ radiusMiles: 100 }))).toContain("100 mi");
  });
});
