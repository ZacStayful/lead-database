import { describe, it, expect } from "vitest";
import { briefRowFromPreview, nextBriefVersion } from "@/lib/leadBrief/briefRow";
import { computeBriefPreview, type BriefPreview } from "@/lib/leadBrief/preview";
import type { BriefInput } from "@/lib/leadBrief/input";
import type { BriefPlan } from "@/lib/leadBrief/plans";
import type { BriefSupply } from "@/lib/leadBrief/types";
import { leads, supply } from "./fixtures";

const YORK = supply({
  leads: [
    ...leads(15, "YO10"),
    ...leads(15, "YO31"),
    ...leads(40, "HG1", { gross: 60000, bedrooms: 4 }),
    ...leads(60, "LS1"),
  ],
});

function preview(input: BriefInput, plan: BriefPlan, s: BriefSupply = YORK): BriefPreview {
  const r = computeBriefPreview(input, plan, s, { today: "2026-10-09" });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.preview;
}

const NOW = new Date("2026-10-09T10:00:00Z");

describe("briefRowFromPreview", () => {
  it("writes the brief the customer gave and what the engine computed", () => {
    const p = preview({ basePostcode: "yo10 5dd", travelLimitMiles: 25, minGross: 40000 }, 20);
    const row = briefRowFromPreview(p, {
      customerId: "c1",
      version: 1,
      lockedUntil: "2026-11-09",
      now: NOW,
    });
    expect(row).toMatchObject({
      customer_id: "c1",
      version: 1,
      status: "active",
      origin: "customer",
      base_postcode: "YO10 5DD",
      base_outcode: "YO10",
      operating_mode: "growing",
      travel_limit_miles: 25,
      allocation: 20,
      essentials: ["revenue"],
      min_gross: 40000,
      min_bedrooms: null,
      service_radius_miles: p.serviceRadiusMiles,
      locked_until: "2026-11-09",
      confirmed_at: NOW.toISOString(),
    });
    expect(row.service_outcodes).toContain("YO10");
    expect(row.service_outcodes).toEqual(p.serviceOutcodes);
    expect(row.first_pick_outcodes).toEqual(p.firstPickOutcodes);
    expect(row.pace_outcodes).toEqual(p.paceOutcodes);
    expect(row.mix_leans_nearby).toBe(p.mixLeansNearby);
    expect(row.expected_mix).toEqual(p.expectedMix);
  });

  it("never writes a null threshold into priorities (the 0162 CHECK refuses it)", () => {
    const p = preview({ basePostcode: "YO10", travelLimitMiles: null }, 20, supply({ leads: [] }));
    const row = briefRowFromPreview(p, { customerId: "c1", version: 1, lockedUntil: null, now: NOW });
    for (const entry of row.priorities) {
      if ("threshold" in entry) expect(typeof entry.threshold).toBe("number");
    }
    expect(JSON.stringify(row.priorities)).not.toContain("null");
  });

  it("stores the plan the brief was computed for, which sets the radius cap", () => {
    const p10 = preview({ basePostcode: "YO10", travelLimitMiles: null }, 10);
    const row = briefRowFromPreview(p10, { customerId: "c1", version: 1, lockedUntil: null, now: NOW });
    expect(row.allocation).toBe(10);
    expect(row.service_radius_miles).toBeLessThanOrEqual(40);
  });

  it("anywhere is stored as a null travel limit with mode anywhere", () => {
    const p = preview({ basePostcode: "YO10", travelLimitMiles: null }, 20);
    const row = briefRowFromPreview(p, { customerId: "c1", version: 1, lockedUntil: null, now: NOW });
    expect(row.travel_limit_miles).toBeNull();
    expect(row.operating_mode).toBe("anywhere");
  });

  it("copies the lists rather than sharing them with the preview", () => {
    const p = preview({ basePostcode: "YO10", travelLimitMiles: 25 }, 20);
    const row = briefRowFromPreview(p, { customerId: "c1", version: 1, lockedUntil: null, now: NOW });
    row.service_outcodes.push("ZZ1");
    expect(p.serviceOutcodes).not.toContain("ZZ1");
  });
});

describe("nextBriefVersion", () => {
  it("starts at 1 and follows the highest stored version", () => {
    expect(nextBriefVersion([])).toBe(1);
    expect(nextBriefVersion([1, 3, 2])).toBe(4);
  });
});
