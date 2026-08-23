import { describe, it, expect } from "vitest";
import { selectCombinedCandidates } from "@/lib/ingest";
import { CONTENDED_FILTERED_CUSTOMERS } from "@/lib/types";
import {
  buildLeadVolumeAggregate,
  predictMonthlyVolume,
  contentionShare,
  type AreaContention,
  type LeadVolumeRow,
} from "@/lib/filterPrediction";

const NOW = new Date("2026-08-23T00:00:00Z");
const f = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    customer_id: `filtered-${i}`,
    priority_score: 10 - i,
  }));
const u = (deficits: number[]) =>
  deficits.map((d, i) => ({ customer_id: `unfiltered-${i}`, deficit: d }));

describe("selectCombinedCandidates — the critically-behind override", () => {
  it("lets a critically-behind unfiltered customer jump an uncontended lead", () => {
    const picked = selectCombinedCandidates(f(2), u([9]), 3);
    expect(picked[0]).toBe("unfiltered-0");
    expect(picked.slice(1)).toEqual(["filtered-0", "filtered-1"]);
  });

  it("prefers filtered customers when nobody is critically behind", () => {
    const picked = selectCombinedCandidates(f(2), u([1]), 3);
    expect(picked).toEqual(["filtered-0", "filtered-1", "unfiltered-0"]);
  });

  it("falls back to unfiltered order once filtered candidates run out", () => {
    expect(selectCombinedCandidates(f(1), u([0, 0]), 3)).toEqual([
      "filtered-0",
      "unfiltered-0",
      "unfiltered-1",
    ]);
  });
});

describe("selectCombinedCandidates — contention", () => {
  it("suppresses the override once the lead is contended", () => {
    const picked = selectCombinedCandidates(
      f(CONTENDED_FILTERED_CUSTOMERS),
      u([99]),
      CONTENDED_FILTERED_CUSTOMERS
    );
    expect(picked).toEqual(["filtered-0", "filtered-1", "filtered-2", "filtered-3"]);
    expect(picked).not.toContain("unfiltered-0");
  });

  it("does not suppress it one candidate short of the ceiling", () => {
    const picked = selectCombinedCandidates(
      f(CONTENDED_FILTERED_CUSTOMERS - 1),
      u([99]),
      CONTENDED_FILTERED_CUSTOMERS
    );
    expect(picked[0]).toBe("unfiltered-0");
  });

  // The flag is read from the pool as fetched. Recomputing it mid-loop, as
  // entries shift off the front, would let the override back in halfway
  // through and hand a contended lead's last slot to an unfiltered customer.
  it("stays contended for every slot, not just the first", () => {
    const picked = selectCombinedCandidates(f(5), u([99, 99, 99, 99]), 4);
    expect(picked.every((id) => id.startsWith("filtered-"))).toBe(true);
  });

  it("never assigns the same customer twice", () => {
    const picked = selectCombinedCandidates(f(6), u([99, 5]), 4);
    expect(new Set(picked).size).toBe(picked.length);
  });

  it("respects the slot count even when contended", () => {
    expect(selectCombinedCandidates(f(9), u([99]), 2)).toHaveLength(2);
  });
});

describe("contentionShare", () => {
  const contention = (n: number): AreaContention => ({
    filteredCustomers: { LS: n },
    maxPerLead: CONTENDED_FILTERED_CUSTOMERS,
  });

  it("is unshared until the ceiling — the cliff is exactly at 5", () => {
    // n existing + 1 for the customer being quoted.
    expect(contentionShare("LS", contention(0))).toBe(1);
    expect(contentionShare("LS", contention(3))).toBe(1); // 4 competitors
    expect(contentionShare("LS", contention(4))).toBeCloseTo(4 / 5, 10);
    expect(contentionShare("LS", contention(5))).toBeCloseTo(4 / 6, 10);
  });

  it("is case-insensitive on the area", () => {
    expect(contentionShare("ls", contention(4))).toBeCloseTo(4 / 5, 10);
  });

  it("treats an unknown area as uncontended", () => {
    expect(contentionShare("ZZ", contention(9))).toBe(1);
  });

  it("counts bedroom-only filters as competing everywhere", () => {
    const everywhere: AreaContention = {
      filteredCustomers: {},
      maxPerLead: CONTENDED_FILTERED_CUSTOMERS,
      everywhere: 6,
    };
    expect(contentionShare("ZZ", everywhere)).toBeCloseTo(4 / 7, 10);
  });

  it("is unshared when there is no contention data at all", () => {
    expect(contentionShare("LS", null)).toBe(1);
  });
});

describe("predictMonthlyVolume with contention", () => {
  const rows: LeadVolumeRow[] = [
    ...Array.from({ length: 20 }, () => ({
      postcode_area: "LS",
      bedrooms: "3",
      lead_type: "management",
      created_at: "2026-08-01T00:00:00Z",
    })),
    ...Array.from({ length: 20 }, () => ({
      postcode_area: "BD",
      bedrooms: "3",
      lead_type: "management",
      created_at: "2026-08-01T00:00:00Z",
    })),
  ];
  const vol = buildLeadVolumeAggregate(rows, NOW).management;
  const sel = { areas: [], minBedrooms: null, maxBedrooms: null };

  it("leaves an uncontended filter untouched", () => {
    const c: AreaContention = {
      filteredCustomers: { LS: 2, BD: 1 },
      maxPerLead: CONTENDED_FILTERED_CUSTOMERS,
    };
    expect(predictMonthlyVolume(vol, sel, c).matchingLeads).toBe(40);
  });

  // A filter spanning a crowded area and an empty one is contended only in the
  // crowded one; applying an average would understate one and overstate other.
  it("shares per area, not across the whole filter", () => {
    const c: AreaContention = {
      filteredCustomers: { LS: 7, BD: 0 },
      maxPerLead: CONTENDED_FILTERED_CUSTOMERS,
    };
    // LS: 20 * 4/8 = 10. BD: 20 * 1 = 20.
    expect(predictMonthlyVolume(vol, sel, c).matchingLeads).toBe(30);
  });

  it("floors to whole leads", () => {
    const c: AreaContention = {
      filteredCustomers: { LS: 5, BD: 5 },
      maxPerLead: CONTENDED_FILTERED_CUSTOMERS,
    };
    // 20 * 4/6 = 13.33 per area -> 26.67 total -> 26.
    const p = predictMonthlyVolume(vol, sel, c);
    expect(Number.isInteger(p.matchingLeads)).toBe(true);
    expect(p.matchingLeads).toBe(26);
  });

  it("matches the uncontended prediction when contention is omitted", () => {
    expect(predictMonthlyVolume(vol, sel).matchingLeads).toBe(
      predictMonthlyVolume(vol, sel, null).matchingLeads
    );
  });
});
