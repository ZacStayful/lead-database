import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildLeadVolumeAggregate,
  contentionShare,
  fetchAreaContention,
  predictMonthlyVolume,
  GROSS_BAND_KEYS,
  type AreaContention,
  type GrossBand,
  type LeadVolumeRow,
} from "@/lib/filterPrediction";

/**
 * Per-band contention (§C).
 *
 * §28.5 states the rule these exist to keep: "the estimate must agree with
 * the router, or the number quoted is one the engine was never going to
 * deliver." The router shares a SPECIFIC lead among the customers who match
 * THAT lead — which, once a revenue floor exists, includes its revenue.
 *
 * ⚠️ EVERY FIXTURE HERE GIVES DIFFERENT BANDS DIFFERENT COUNTS. A fixture
 * where each band carries the same number makes per-band and area-only
 * contention arithmetically identical, so it passes under either rule and
 * asserts nothing. A mutation run found exactly that: three guards written
 * over uniform fixtures survived their own mutation.
 */

const NOW = new Date("2026-09-24T00:00:00Z");

function row(gross: number | null): LeadVolumeRow {
  return {
    postcode_area: "LS",
    bedrooms: "3",
    lead_type: "management",
    created_at: "2026-09-01T00:00:00Z",
    gross_annual_income: gross,
  };
}

describe("⚠️ the share is taken per (area, BAND), not once per area", () => {
  // 20 leads, all at £90k — the "75000" band.
  const vol = buildLeadVolumeAggregate(
    Array.from({ length: 20 }, () => row(90_000)),
    NOW
  ).management;

  // Seven competitors at £75k+, NONE elsewhere. Area-only contention reads
  // whichever band it happens to look at; only the right band gives 4/8.
  const c: AreaContention = {
    filteredCustomers: { LS: 7 },
    byBand: { LS: { "75000": 7 } },
    everywhereByBand: {},
    maxPerLead: 4,
  };

  const anyBand = (minGross: number | null) =>
    predictMonthlyVolume(
      vol,
      { areas: ["LS"], minBedrooms: null, maxBedrooms: null, minGross },
      c
    );

  it("scales the £75k leads by the £75k competition", () => {
    // 20 * 4/8 = 10. Reading the "none" band instead would find 0
    // competitors, share 1, and quote all 20.
    expect(anyBand(75_000).matchingLeads).toBe(10);
  });

  it("and an unfloored quote over the SAME leads is scaled the same way", () => {
    // The leads are still £90k leads whoever is asking; what decides the
    // share is the band the LEAD is in, not the floor the reader set.
    expect(anyBand(null).matchingLeads).toBe(10);
  });

  it("⚠️ leads in an UNCONTENDED band are not scaled at all", () => {
    const mixed = buildLeadVolumeAggregate(
      [
        ...Array.from({ length: 20 }, () => row(90_000)), // "75000", 7 rivals
        ...Array.from({ length: 20 }, () => row(35_000)), // "30000", none
      ],
      NOW
    ).management;
    // 10 + 20 = 30. Area-only contention scales both by the same factor and
    // answers 20, or both by 1 and answers 40 — never 30.
    expect(
      predictMonthlyVolume(
        mixed,
        { areas: ["LS"], minBedrooms: null, maxBedrooms: null, minGross: null },
        c
      ).matchingLeads
    ).toBe(30);
  });
});

describe("contentionShare reads the band it is given", () => {
  const c: AreaContention = {
    filteredCustomers: { LS: 7 },
    byBand: { LS: { "75000": 7, "30000": 1 } },
    everywhereByBand: {},
    maxPerLead: 4,
  };

  it("crowded in one band, empty in another, from ONE area", () => {
    expect(contentionShare("LS", "75000", c)).toBeCloseTo(4 / 8, 10);
    expect(contentionShare("LS", "30000", c)).toBe(1);
    expect(contentionShare("LS", "none", c)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// fetchAreaContention — the function that BUILDS the band map
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

/**
 * A fake admin client that answers the one query `fetchAreaContention` makes.
 * Records the select list so the invariant-6 assertion can check WHAT was
 * asked for, not only what came back.
 */
function fakeAdmin(rows: Row[] | null, error: { message: string } | null = null) {
  const seen = { select: "", eqs: [] as [string, string][] };
  const client = {
    from() {
      const chain: Record<string, unknown> = {};
      chain.select = (s: string) => {
        seen.select = s;
        return chain;
      };
      chain.in = () => chain;
      chain.eq = (col: string, val: string) => {
        seen.eqs.push([col, val]);
        return chain;
      };
      chain.neq = () => chain;
      chain.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: rows, error });
      return chain;
    },
  } as unknown as SupabaseClient;
  return { client, seen };
}

describe("fetchAreaContention — a competitor contends only where their floor lets them", () => {
  it("⚠️ counts a FLOORED competitor into their bands only", async () => {
    const { client } = fakeAdmin([
      { id: "c1", filter_areas: ["LS"], filter_status: "active", filter_min_gross: 75000 },
    ]);
    const c = await fetchAreaContention(client, "management");
    expect(c.byBand.LS).toEqual({ "75000": 1 });
    // The headcount is band-blind and still counts them — it is for display.
    expect(c.filteredCustomers.LS).toBe(1);
  });

  it("a floor-less competitor counts under EVERY band", async () => {
    const { client } = fakeAdmin([
      { id: "c1", filter_areas: ["LS"], filter_status: "active", filter_min_gross: null },
    ]);
    const c = await fetchAreaContention(client, "management");
    expect(Object.keys(c.byBand.LS).sort()).toEqual([...GROSS_BAND_KEYS].sort());
  });

  it("⚠️ two competitors with DIFFERENT floors stack only where they overlap", async () => {
    const { client } = fakeAdmin([
      { id: "c1", filter_areas: ["LS"], filter_status: "active", filter_min_gross: 30000 },
      { id: "c2", filter_areas: ["LS"], filter_status: "active", filter_min_gross: 75000 },
    ]);
    const c = await fetchAreaContention(client, "management");
    expect(c.byBand.LS["75000"]).toBe(2); // both
    expect(c.byBand.LS["30000"]).toBe(1); // only the £30k one
    expect(c.byBand.LS.none).toBeUndefined(); // neither takes a no-figure lead
    expect(c.filteredCustomers.LS).toBe(2);
  });

  it("a bedroom-only filter is a floor under every area, in its own bands", async () => {
    const { client } = fakeAdmin([
      { id: "c1", filter_areas: [], filter_status: "active", filter_min_gross: 50000 },
      { id: "c2", filter_areas: ["LS"], filter_status: "active", filter_min_gross: null },
    ]);
    const c = await fetchAreaContention(client, "management");
    expect(c.everywhereByBand).toEqual({ "50000": 1, "75000": 1 });
    // LS gets its own competitor plus the everywhere one, band by band.
    expect(c.byBand.LS["75000"]).toBe(2);
    expect(c.byBand.LS["25000"]).toBe(1);
    expect(c.byBand.LS.none).toBe(1);
    // And an area nobody names falls back to everywhereByBand.
    expect(contentionShare("ZZ", "75000", { ...c, maxPerLead: 1 })).toBeCloseTo(1 / 2, 10);
    expect(contentionShare("ZZ", "none", { ...c, maxPerLead: 1 })).toBe(1);
  });

  it("⚠️ INVARIANT 6: the GR branch never asks for a management floor", async () => {
    const { client, seen } = fakeAdmin([
      // If the GR branch read it, this row would be banded at £75k.
      { id: "c1", gr_filter_areas: ["LS"], gr_filter_status: "active", filter_min_gross: 75000 },
    ]);
    const c = await fetchAreaContention(client, "guaranteed_rent");
    expect(seen.select).not.toContain("filter_min_gross");
    expect(seen.eqs).toContainEqual(["gr_subscription_status", "active"]);
    // Counted under every band, because no GR lead carries a gross figure.
    expect(Object.keys(c.byBand.LS).sort()).toEqual([...GROSS_BAND_KEYS].sort());
  });

  it("the management branch DOES ask for it", async () => {
    const { client, seen } = fakeAdmin([]);
    await fetchAreaContention(client, "management");
    expect(seen.select).toContain("filter_min_gross");
  });

  it("fails OPEN on a read error — an empty map quotes the unshared volume", async () => {
    const { client } = fakeAdmin(null, { message: "Gateway Timeout" });
    const c = await fetchAreaContention(client, "management");
    expect(c.byBand).toEqual({});
    expect(c.everywhereByBand).toEqual({});
    expect(contentionShare("LS", "75000", c)).toBe(1);
  });
});

describe("⚠️ inert on today's book — nobody has a floor", () => {
  it("every competitor floor-less reduces exactly to the old headcount", async () => {
    const { client } = fakeAdmin([
      { id: "c1", filter_areas: ["LS", "BD"], filter_status: "active", filter_min_gross: null },
      { id: "c2", filter_areas: ["LS"], filter_status: "active", filter_min_gross: null },
      { id: "c3", filter_areas: [], filter_status: "active", filter_min_gross: null },
    ]);
    const c = await fetchAreaContention(client, "management");
    for (const band of GROSS_BAND_KEYS) {
      expect(c.byBand.LS[band as GrossBand]).toBe(c.filteredCustomers.LS);
      expect(c.byBand.BD[band as GrossBand]).toBe(c.filteredCustomers.BD);
    }
    expect(c.filteredCustomers).toEqual({ LS: 3, BD: 2 });
  });
});
