import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  applyContention,
  PUBLIC_VOLUME_SCHEMA_VERSION,
  toProductVolume,
  areasInPayload,
  type PublicFilterVolume,
} from "@/lib/publicFilterVolume";
import {
  canFilterByGross,
  predictMonthlyVolume,
  GROSS_BAND_KEYS,
  INGEST_EPOCH_ISO,
  type AreaBedBandCounts,
  type AreaContention,
  type GrossBand,
  type ProductVolume,
} from "@/lib/filterPrediction";
import { CONTENDED_FILTERED_CUSTOMERS } from "@/lib/types";

const payload: PublicFilterVolume = {
  management: {
    windowStart: INGEST_EPOCH_ISO,
    weeksElapsed: 7.5,
    totalLeads: 40,
    matchableLeads: 30,
    areaBedCounts: { LS: { "3": 20 }, BD: { "2": 10 } },
  },
  guaranteed_rent: {
    windowStart: INGEST_EPOCH_ISO,
    weeksElapsed: 7.5,
    totalLeads: 10,
    matchableLeads: 10,
    areaBedCounts: { M: { "3": 10 } },
  },
  generatedAt: "2026-08-23T00:00:00Z",
};

describe("toProductVolume", () => {
  it("selects the right product", () => {
    expect(toProductVolume(payload, "management").areaBedCounts).toHaveProperty("LS");
    expect(toProductVolume(payload, "guaranteed_rent").areaBedCounts).toHaveProperty("M");
  });

  // A cached payload ages. Trusting its stored weeksElapsed would divide this
  // month's leads by a six-hour-old window and drift the rate upward.
  it("recomputes the window from the epoch rather than trusting the cache", () => {
    const v = toProductVolume(payload, "management", new Date("2026-09-23T00:00:00Z"));
    expect(v.weeksElapsed).toBeGreaterThan(payload.management.weeksElapsed);
  });

  it("survives a payload missing fields", () => {
    const empty = { generatedAt: "" } as unknown as PublicFilterVolume;
    const v = toProductVolume(empty, "management");
    expect(v.areaBedCounts).toEqual({});
    expect(v.totalLeads).toBe(0);
  });
});

describe("areasInPayload", () => {
  it("returns only that product's areas, sorted", () => {
    expect(areasInPayload(payload, "management")).toEqual(["BD", "LS"]);
    expect(areasInPayload(payload, "guaranteed_rent")).toEqual(["M"]);
  });

  // Unioning the two put areas with zero GR leads in front of a GR prospect,
  // who picks one and is told there is not enough data to forecast it. The two
  // books really do differ in coverage; the picker must not blur that.
  it("never offers one product's areas to the other", () => {
    expect(areasInPayload(payload, "guaranteed_rent")).not.toContain("LS");
    expect(areasInPayload(payload, "management")).not.toContain("M");
  });

  it("survives a payload with no product block", () => {
    const empty = { generatedAt: "" } as unknown as PublicFilterVolume;
    expect(areasInPayload(empty, "management")).toEqual([]);
  });
});

// The published counts are already the share a newcomer could expect. That is
// what lets the estimate be honest WITHOUT the payload carrying how many
// customers hold each area — shipping raw counts plus a contention map would
// quote the same number and hand anyone with devtools our customer list.
describe("contention is pre-applied, not published", () => {
  /**
   * ⚠️ THE REAL `applyContention`, not a copy of it. This block used to
   * reimplement the function locally, which is §42.8's trap — a test that
   * writes its own version of the thing under test asserts a version that is
   * never running. It mattered here: the real one now scales per (area,
   * BAND) and derives the bedroom totals from the result, and a local
   * area-only copy would have kept passing against that.
   */
  const NOW_W = 7.5;

  /** Every band carries the same count: nobody has a floor, today's world. */
  const everyBand = (n: number): Partial<Record<GrossBand, number>> =>
    Object.fromEntries(GROSS_BAND_KEYS.map((k) => [k, n]));

  const contention = (existing: number): AreaContention => ({
    filteredCustomers: { LS: existing },
    byBand: { LS: everyBand(existing) },
    everywhereByBand: {},
    maxPerLead: CONTENDED_FILTERED_CUSTOMERS,
  });

  /** 20 three-bed LS leads, all in one band, as a ProductVolume. */
  const volumeOf = (band: GrossBand, n = 20): ProductVolume => {
    const bands = { LS: { "3": { [band]: n } } } as AreaBedBandCounts;
    return {
      windowStart: INGEST_EPOCH_ISO,
      weeksElapsed: NOW_W,
      totalLeads: n,
      matchableLeads: n,
      areaBedCounts: { LS: { "3": n } },
      areaBedBandCounts: bands,
    };
  };

  it("leaves an uncontended area at full volume", () => {
    const out = applyContention(volumeOf("30000"), contention(1));
    expect(out.areaBedCounts).toEqual({ LS: { "3": 20 } });
  });

  it("scales a crowded area down", () => {
    // 8 competitors including the newcomer -> 4/8 -> 10 of 20.
    const out = applyContention(volumeOf("30000"), contention(7));
    expect(out.areaBedCounts).toEqual({ LS: { "3": 10 } });
  });

  it("⚠️ publishes the bands, already scaled — the estimator needs them", () => {
    const out = applyContention(volumeOf("50000"), contention(7));
    expect(out.areaBedBandCounts).toEqual({ LS: { "3": { "50000": 10 } } });
  });

  it("⚠️ areaBedCounts is DERIVED from the scaled bands, so they agree", () => {
    // Two bands scaling by different factors is exactly the case a separately
    // scaled bedroom total could not be reconciled with.
    const vol: ProductVolume = {
      windowStart: INGEST_EPOCH_ISO,
      weeksElapsed: NOW_W,
      totalLeads: 40,
      matchableLeads: 40,
      areaBedCounts: { LS: { "3": 40 } },
      areaBedBandCounts: { LS: { "3": { "30000": 20, "75000": 20 } } },
    };
    const c: AreaContention = {
      filteredCustomers: { LS: 7 },
      // Crowded at £30k, empty at £75k.
      byBand: { LS: { "30000": 7, "75000": 0 } },
      everywhereByBand: {},
      maxPerLead: CONTENDED_FILTERED_CUSTOMERS,
    };
    const out = applyContention(vol, c);
    expect(out.areaBedBandCounts).toEqual({
      LS: { "3": { "30000": 10, "75000": 20 } },
    });
    // 10 + 20, summed from the bands rather than scaled independently.
    expect(out.areaBedCounts).toEqual({ LS: { "3": 30 } });
    expect(out.matchableLeads).toBe(30);
  });

  it("produces the same quote as the logged-in path would", () => {
    const vol = volumeOf("30000");
    const c = contention(7);
    const sel = {
      areas: ["LS"],
      minBedrooms: null,
      maxBedrooms: null,
      minGross: null,
    };

    // Dashboard: raw counts + contention passed in at predict time.
    const loggedIn = predictMonthlyVolume(vol, sel, c);
    // Public: counts already scaled, no contention passed.
    const publicProduct = applyContention(vol, c);
    const anonymous = predictMonthlyVolume(
      { ...vol, ...publicProduct, areaBedBandCounts: publicProduct.areaBedBandCounts ?? null },
      sel
    );

    expect(anonymous.matchingLeads).toBe(loggedIn.matchingLeads);
  });

  it("never scales a count up", () => {
    for (const existing of [0, 1, 3, 4, 9, 40]) {
      const out = applyContention(volumeOf("30000"), contention(existing));
      expect(out.areaBedCounts.LS?.["3"] ?? 0).toBeLessThanOrEqual(20);
    }
  });
});

describe("⚠️ the schema version, and the old-payload trap it closes", () => {
  const base = {
    windowStart: INGEST_EPOCH_ISO,
    weeksElapsed: 7.5,
    totalLeads: 20,
    matchableLeads: 20,
    areaBedCounts: { LS: { "3": 20 } },
  };

  it("an OLD payload yields NULL bands, never {}", () => {
    // §18.3's three outcomes. `{}` would read as "no lead clears any floor"
    // and quote ZERO on a marketing page — §58.2's failure self-inflicted —
    // and it would be indistinguishable from the un-primed `{}` row that 0099
    // deliberately ships.
    const old: PublicFilterVolume = {
      management: base,
      guaranteed_rent: base,
      generatedAt: "2026-09-01T00:00:00Z",
    };
    const v = toProductVolume(old, "management");
    expect(v.areaBedBandCounts).toBeNull();
    expect(v.areaBedCounts).toEqual({ LS: { "3": 20 } });
  });

  it("an UN-PRIMED payload also yields null bands, and no throw", () => {
    const v = toProductVolume({} as PublicFilterVolume, "management");
    expect(v.areaBedBandCounts).toBeNull();
    expect(v.areaBedCounts).toEqual({});
  });

  it("a CURRENT payload carries the bands through", () => {
    const current: PublicFilterVolume = {
      management: {
        ...base,
        areaBedBandCounts: { LS: { "3": { "50000": 12, none: 8 } } },
      },
      guaranteed_rent: base,
      generatedAt: "2026-09-24T00:00:00Z",
      schemaVersion: PUBLIC_VOLUME_SCHEMA_VERSION,
    };
    const v = toProductVolume(current, "management");
    expect(v.areaBedBandCounts).toEqual({ LS: { "3": { "50000": 12, none: 8 } } });
    // And it can now answer a floor.
    expect(canFilterByGross(v)).toBe(true);
    expect(
      predictMonthlyVolume(v, {
        areas: [],
        minBedrooms: null,
        maxBedrooms: null,
        minGross: 50_000,
      }).matchingLeads
    ).toBe(12);
  });

  it("⚠️ and an old payload CANNOT answer one — the gate says so", () => {
    const old: PublicFilterVolume = {
      management: base,
      guaranteed_rent: base,
      generatedAt: "2026-09-01T00:00:00Z",
    };
    expect(canFilterByGross(toProductVolume(old, "management"))).toBe(false);
  });

  it("the version is 2 — bumped when areaBedBandCounts was added", () => {
    expect(PUBLIC_VOLUME_SCHEMA_VERSION).toBe(2);
  });
});

describe("⚠️ the version is part of the ATOMIC CLAIM, not a check beside it", () => {
  /**
   * File-text, because the claim is a PostgREST filter string and §65.6
   * records that shape as impossible to test without PostgREST running.
   * Left out of the claim, a deploy serves the OLD shape for six hours and
   * every revenue-floored estimate on both landing pages quotes zero.
   */
  const route = readFileSync(
    resolve(__dirname, "../../app/api/filter-estimate/public/route.ts"),
    "utf8"
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+/g, " ");

  it("the staleness filter tests the version in BOTH directions", () => {
    expect(route).toContain("schema_version.is.null");
    expect(route).toContain(
      "schema_version.neq.${PUBLIC_VOLUME_SCHEMA_VERSION}"
    );
  });

  it("the claim WRITES the version, so the next request does not re-claim", () => {
    expect(route).toMatch(
      /generated_at: new Date\(\)\.toISOString\(\), schema_version: PUBLIC_VOLUME_SCHEMA_VERSION/
    );
  });

  it("and the rebuild stamps it on the row beside the payload", () => {
    expect(route).toMatch(
      /payload, generated_at: payload\.generatedAt, schema_version: PUBLIC_VOLUME_SCHEMA_VERSION/
    );
  });
});
