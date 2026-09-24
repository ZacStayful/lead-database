import { describe, it, expect } from "vitest";
import { selectCombinedCandidates } from "@/lib/ingest";
import { CONTENDED_FILTERED_CUSTOMERS } from "@/lib/types";
import {
  buildLeadVolumeAggregate,
  predictMonthlyVolume,
  contentionShare,
  GROSS_BAND_KEYS,
  type AreaContention,
  type GrossBand,
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
  /** Every band carries the same count: nobody has a floor, today's world. */
  const everyBand = (n: number): Partial<Record<GrossBand, number>> =>
    Object.fromEntries(GROSS_BAND_KEYS.map((k) => [k, n]));

  const contention = (n: number): AreaContention => ({
    filteredCustomers: { LS: n },
    byBand: { LS: everyBand(n) },
    everywhereByBand: {},
    maxPerLead: CONTENDED_FILTERED_CUSTOMERS,
  });

  it("is unshared until the ceiling — the cliff is exactly at 5", () => {
    // n existing + 1 for the customer being quoted.
    expect(contentionShare("LS", "30000", contention(0))).toBe(1);
    expect(contentionShare("LS", "30000", contention(3))).toBe(1); // 4 competitors
    expect(contentionShare("LS", "30000", contention(4))).toBeCloseTo(4 / 5, 10);
    expect(contentionShare("LS", "30000", contention(5))).toBeCloseTo(4 / 6, 10);
  });

  it("is case-insensitive on the area", () => {
    expect(contentionShare("ls", "30000", contention(4))).toBeCloseTo(4 / 5, 10);
  });

  it("treats an unknown area as uncontended", () => {
    expect(contentionShare("ZZ", "30000", contention(9))).toBe(1);
  });

  it("counts bedroom-only filters as competing everywhere", () => {
    const everywhere: AreaContention = {
      filteredCustomers: {},
      byBand: {},
      everywhereByBand: everyBand(6),
      maxPerLead: CONTENDED_FILTERED_CUSTOMERS,
      everywhere: 6,
    };
    expect(contentionShare("ZZ", "30000", everywhere)).toBeCloseTo(4 / 7, 10);
  });

  it("is unshared when there is no contention data at all", () => {
    expect(contentionShare("LS", "30000", null)).toBe(1);
  });

  // ------------------------------------------------------------------ §C
  it("⚠️ a floored competitor contends ONLY in the bands their floor admits", () => {
    // Four £75k-floor competitors in LS. A lead at £30k is contended by none
    // of them; a lead at £90k by all four. Keyed area-only — as it was before
    // this — BOTH would read 4/5, deflating the £30k quote by a fifth for
    // competitors who could never have received it.
    const c: AreaContention = {
      filteredCustomers: { LS: 4 },
      byBand: { LS: { "75000": 4 } },
      everywhereByBand: {},
      maxPerLead: CONTENDED_FILTERED_CUSTOMERS,
    };
    expect(contentionShare("LS", "30000", c)).toBe(1);
    expect(contentionShare("LS", "75000", c)).toBeCloseTo(4 / 5, 10);
  });

  it("⚠️ customers with DISJOINT floors do not contend at all", () => {
    // Four competitors, one per band, plus the customer being quoted: the
    // headcount is 4 and would trip the ceiling, but no two of them can ever
    // want the same lead.
    const c: AreaContention = {
      filteredCustomers: { LS: 4 },
      byBand: { LS: { "25000": 1, "30000": 1, "50000": 1, "75000": 1 } },
      everywhereByBand: {},
      maxPerLead: CONTENDED_FILTERED_CUSTOMERS,
    };
    for (const band of ["25000", "30000", "50000", "75000"] as GrossBand[]) {
      expect(contentionShare("LS", band, c)).toBe(1);
    }
  });

  it("a floor-less competitor still contends in every band", () => {
    const c: AreaContention = {
      filteredCustomers: { LS: 4 },
      byBand: { LS: everyBand(4) },
      everywhereByBand: {},
      maxPerLead: CONTENDED_FILTERED_CUSTOMERS,
    };
    for (const band of GROSS_BAND_KEYS) {
      expect(contentionShare("LS", band, c)).toBeCloseTo(4 / 5, 10);
    }
  });
});

describe("predictMonthlyVolume with contention", () => {
  const bandsOf = (n: number): Partial<Record<GrossBand, number>> =>
    Object.fromEntries(GROSS_BAND_KEYS.map((k) => [k, n]));

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
  const sel = { areas: [], minBedrooms: null, maxBedrooms: null, minGross: null };

  it("leaves an uncontended filter untouched", () => {
    const c: AreaContention = {
      filteredCustomers: { LS: 2, BD: 1 },
      // Nobody has a floor, so every band carries the headcount — which is
      // what makes this change INERT on today's book.
      byBand: { LS: bandsOf(2), BD: bandsOf(1) },
      everywhereByBand: {},
      maxPerLead: CONTENDED_FILTERED_CUSTOMERS,
    };
    expect(predictMonthlyVolume(vol, sel, c).matchingLeads).toBe(40);
  });

  // A filter spanning a crowded area and an empty one is contended only in the
  // crowded one; applying an average would understate one and overstate other.
  it("shares per area, not across the whole filter", () => {
    const c: AreaContention = {
      filteredCustomers: { LS: 7, BD: 0 },
      // Nobody has a floor, so every band carries the headcount — which is
      // what makes this change INERT on today's book.
      byBand: { LS: bandsOf(7), BD: bandsOf(0) },
      everywhereByBand: {},
      maxPerLead: CONTENDED_FILTERED_CUSTOMERS,
    };
    // LS: 20 * 4/8 = 10. BD: 20 * 1 = 20.
    expect(predictMonthlyVolume(vol, sel, c).matchingLeads).toBe(30);
  });

  it("floors to whole leads", () => {
    const c: AreaContention = {
      filteredCustomers: { LS: 5, BD: 5 },
      // Nobody has a floor, so every band carries the headcount — which is
      // what makes this change INERT on today's book.
      byBand: { LS: bandsOf(5), BD: bandsOf(5) },
      everywhereByBand: {},
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
