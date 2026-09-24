import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  GROSS_THRESHOLDS,
  GROSS_BAND_KEYS,
  bandFor,
  allowedBands,
  canFilterByGross,
  deriveAreaBedCounts,
  buildLeadVolumeAggregate,
  predictMonthlyVolume,
  type LeadVolumeRow,
  type ProductVolume,
} from "@/lib/filterPrediction";

const NOW = new Date("2026-09-24T00:00:00Z");

/**
 * The REAL band distribution over the population `fetchLeadVolumeData` builds
 * its aggregate from, measured on production 2026-09-24: management leads with
 * `owner_customer_id is null`, `created_at >= INGEST_EPOCH_ISO`, and both a
 * postcode area and a parseable bedroom count.
 *
 * Fixtures are built from these rather than invented, so the thin cases the
 * forecast has to handle are the thin cases that actually occur.
 */
const LIVE_BANDS = {
  none: 29,
  "0": 27,
  "25000": 32,
  "30000": 67,
  "40000": 46,
  "50000": 39,
  "75000": 23,
} as const;

/** A gross figure that lands squarely inside a given band. */
const IN_BAND: Record<string, number | null> = {
  none: null,
  "0": 12_000,
  "25000": 27_500,
  "30000": 35_000,
  "40000": 44_000,
  "50000": 60_000,
  "75000": 90_000,
};

function row(over: Partial<LeadVolumeRow> = {}): LeadVolumeRow {
  return {
    postcode_area: "LS",
    bedrooms: "3",
    lead_type: "management",
    created_at: "2026-09-01T00:00:00Z",
    ...over,
  };
}

/** One row per lead in the live distribution, all in one area/bed cell. */
function liveRows(): LeadVolumeRow[] {
  const out: LeadVolumeRow[] = [];
  for (const [band, n] of Object.entries(LIVE_BANDS)) {
    for (let i = 0; i < n; i += 1) {
      out.push(row({ gross_annual_income: IN_BAND[band] }));
    }
  }
  return out;
}

describe("bandFor — the band is the highest threshold the figure clears", () => {
  it.each([
    [null, "none"],
    [undefined, "none"],
    [Number.NaN, "none"],
    [0, "0"],
    [-1, "0"],
    [24_999, "0"],
    [25_000, "25000"],
    [29_999, "25000"],
    [30_000, "30000"],
    [39_999, "30000"],
    [40_000, "40000"],
    [49_999, "40000"],
    [50_000, "50000"],
    [74_999, "50000"],
    [75_000, "75000"],
    [149_283, "75000"], // the highest gross in the book
  ])("%s -> %s", (gross, expected) => {
    expect(bandFor(gross as number | null)).toBe(expected);
  });

  it("⚠️ a figure ON a threshold clears it — `>=`, not `>`", () => {
    // The SQL clause is `gross_annual_income >= filter_min_gross`. A lead at
    // exactly £50,000 must be admitted by a £50k floor, or the JS and the SQL
    // disagree at every boundary and half the directions understate.
    for (const t of GROSS_THRESHOLDS) {
      expect(allowedBands(t).has(bandFor(t))).toBe(true);
    }
  });
});

describe("allowedBands — one predicate, no null branch", () => {
  it("a null floor admits EVERY key, including none and 0", () => {
    expect(Array.from(allowedBands(null)).sort()).toEqual([...GROSS_BAND_KEYS].sort());
    expect(allowedBands(null).has("none")).toBe(true);
    expect(allowedBands(null).has("0")).toBe(true);
  });

  it("⚠️ ANY floor excludes both none and 0", () => {
    for (const t of GROSS_THRESHOLDS) {
      expect(allowedBands(t).has("none")).toBe(false);
      expect(allowedBands(t).has("0")).toBe(false);
    }
  });

  it.each([
    [25_000, ["25000", "30000", "40000", "50000", "75000"]],
    [30_000, ["30000", "40000", "50000", "75000"]],
    [40_000, ["40000", "50000", "75000"]],
    [50_000, ["50000", "75000"]],
    [75_000, ["75000"]],
  ])("a floor of %s admits exactly %s", (floor, expected) => {
    expect(Array.from(allowedBands(floor as number)).sort()).toEqual(
      [...expected].sort()
    );
  });

  it("⚠️ >= X is EXACTLY the union of the bands from X up, with no approximation", () => {
    // This is what makes the band edges safe: because the floors are a fixed
    // list, every floor falls ON a band edge, so a banded count and a
    // row-by-row `gross >= floor` count are the same number rather than close.
    const rows = liveRows();
    const vol = buildLeadVolumeAggregate(rows, NOW).management;
    for (const floor of GROSS_THRESHOLDS) {
      const banded = predictMonthlyVolume(vol, {
        areas: [],
        minBedrooms: null,
        maxBedrooms: null,
        minGross: floor,
      }).matchingLeads;
      const rowByRow = rows.filter(
        (r) => r.gross_annual_income != null && r.gross_annual_income >= floor
      ).length;
      expect(banded).toBe(rowByRow);
    }
  });
});

describe("the band keys are the threshold list", () => {
  it("⚠️ derives from GROSS_THRESHOLDS so the two cannot drift", () => {
    // If they ever diverge, every floored quote is computed at the wrong edge.
    // The migration's CHECK is asserted against the same constant.
    expect(GROSS_BAND_KEYS).toEqual([
      "none",
      "0",
      ...GROSS_THRESHOLDS.map(String),
    ]);
  });

  it("is the settled five, £25k-£75k", () => {
    // £100k was measured and dropped: only 7 management leads in the whole
    // book clear it, so no area-restricted filter could ever be quotable, and
    // an unofferable forecast nulls all five forecast columns.
    expect(GROSS_THRESHOLDS).toEqual([25_000, 30_000, 40_000, 50_000, 75_000]);
  });
});

describe("⚠️ THE REGRESSION: with no floor set, nothing moved", () => {
  /**
   * The pre-band accumulation, written out LONGHAND rather than imported.
   *
   * §27.2's rule: a test that derives its expectation from the same source as
   * the code under test passes whatever changed. This is the old
   * `buildLeadVolumeAggregate` inner loop, duplicated on purpose, and it is
   * the only thing standing between this change and silently dropping 10.6%
   * of the management book out of every forecast in the product.
   */
  function oldStyleAreaBedCounts(rows: LeadVolumeRow[]) {
    const out: Record<string, Record<string, number>> = {};
    for (const r of rows) {
      if (r.lead_type !== "management") continue;
      if (!r.created_at || r.created_at.slice(0, 10) < "2026-07-01") continue;
      if (r.retired) continue;
      const area = r.postcode_area?.trim().toUpperCase();
      const m = /\d+/.exec(r.bedrooms ?? "");
      const bed = m ? parseInt(m[0], 10) : null;
      if (!area || bed == null) continue;
      const beds = (out[area] ??= {});
      beds[String(bed)] = (beds[String(bed)] ?? 0) + 1;
    }
    return out;
  }

  const mixed: LeadVolumeRow[] = [
    ...liveRows(),
    row({ postcode_area: "BD", bedrooms: "1", gross_annual_income: 80_000 }),
    row({ postcode_area: "BD", bedrooms: "1", gross_annual_income: null }),
    row({ postcode_area: "M", bedrooms: "4", gross_annual_income: 31_000 }),
    // Unmatchable either way — no area, no bedroom count.
    row({ postcode_area: null, gross_annual_income: 50_000 }),
    row({ bedrooms: "studio", gross_annual_income: 50_000 }),
    // Retired: dropped before totals, band or no band.
    row({ retired: true, gross_annual_income: 90_000 }),
  ];

  const agg = buildLeadVolumeAggregate(mixed, NOW).management;

  it("the DERIVED areaBedCounts is byte-identical to the old accumulation", () => {
    expect(agg.areaBedCounts).toEqual(oldStyleAreaBedCounts(mixed));
  });

  it("⚠️ leads with NO figure stay inside matchableLeads", () => {
    // Adding `|| gross == null` to the `continue` above the band write is the
    // single most dangerous edit available here: it would drop 29 of 263
    // management leads out of EVERY forecast, including unfloored ones,
    // silently and with nothing erroring.
    const noFigure = mixed.filter(
      (r) =>
        r.gross_annual_income == null &&
        !r.retired &&
        r.postcode_area != null &&
        /\d/.test(r.bedrooms ?? "")
    ).length;
    expect(noFigure).toBeGreaterThan(0);
    const oldTotal = Object.values(oldStyleAreaBedCounts(mixed))
      .flatMap((beds) => Object.values(beds))
      .reduce((a, b) => a + b, 0);
    expect(agg.matchableLeads).toBe(oldTotal);
  });

  it("an unfloored prediction counts every band, none included", () => {
    const all = predictMonthlyVolume(agg, {
      areas: [],
      minBedrooms: null,
      maxBedrooms: null,
      minGross: null,
    });
    expect(all.matchingLeads).toBe(agg.matchableLeads);
  });

  it("deriveAreaBedCounts sums the none band in, not around it", () => {
    expect(
      deriveAreaBedCounts({ LS: { "3": { none: 4, "50000": 6 } } })
    ).toEqual({ LS: { "3": 10 } });
  });
});

describe("⚠️ THE ASYMMETRY that guards the whole no-figure semantic", () => {
  const vol = buildLeadVolumeAggregate(liveRows(), NOW).management;

  it("no floor and the LOWEST floor are different numbers", () => {
    // They would be identical if `"none"` and `"0"` were folded together, or
    // if an absent floor were implemented as "the lowest threshold". The live
    // book has 29 leads with no figure and 27 below £25k, so the gap is 56.
    const unfloored = predictMonthlyVolume(vol, {
      areas: [],
      minBedrooms: null,
      maxBedrooms: null,
      minGross: null,
    }).matchingLeads;
    const lowest = predictMonthlyVolume(vol, {
      areas: [],
      minBedrooms: null,
      maxBedrooms: null,
      minGross: GROSS_THRESHOLDS[0],
    }).matchingLeads;
    expect(unfloored).toBe(263);
    expect(lowest).toBe(207);
    expect(unfloored).toBeGreaterThan(lowest);
  });

  it("a lead with no figure is excluded by EVERY floor", () => {
    const only = buildLeadVolumeAggregate(
      [row({ gross_annual_income: null })],
      NOW
    ).management;
    for (const t of GROSS_THRESHOLDS) {
      expect(
        predictMonthlyVolume(only, {
          areas: [],
          minBedrooms: null,
          maxBedrooms: null,
          minGross: t,
        }).matchingLeads
      ).toBe(0);
    }
    expect(
      predictMonthlyVolume(only, {
        areas: [],
        minBedrooms: null,
        maxBedrooms: null,
        minGross: null,
      }).matchingLeads
    ).toBe(1);
  });
});

describe("monotonicity — §28.1's rule, on the new dimension", () => {
  const vol = buildLeadVolumeAggregate(liveRows(), NOW).management;
  const at = (minGross: number | null) =>
    predictMonthlyVolume(vol, {
      areas: [],
      minBedrooms: null,
      maxBedrooms: null,
      minGross,
    });

  it("⚠️ lowering the floor can only RAISE the volume, never lower it", () => {
    const ladder = [...GROSS_THRESHOLDS].sort((a, b) => b - a);
    let previous = 0;
    for (const floor of ladder) {
      const now = at(floor).matchingLeads;
      expect(now).toBeGreaterThanOrEqual(previous);
      previous = now;
    }
    // And removing it entirely is the largest of all.
    expect(at(null).matchingLeads).toBeGreaterThanOrEqual(previous);
  });

  it("matches the live cumulative counts exactly", () => {
    expect(at(75_000).matchingLeads).toBe(23);
    expect(at(50_000).matchingLeads).toBe(62);
    expect(at(40_000).matchingLeads).toBe(108);
    expect(at(30_000).matchingLeads).toBe(175);
    expect(at(25_000).matchingLeads).toBe(207);
    expect(at(null).matchingLeads).toBe(263);
  });
});

describe("⚠️ a source with no band data cannot answer a floor", () => {
  /** What `toProductVolume` produces for a payload that predates banding. */
  const legacy: ProductVolume = {
    windowStart: "2026-07-01",
    weeksElapsed: 12.1,
    totalLeads: 40,
    matchableLeads: 40,
    areaBedCounts: { LS: { "3": 40 } },
    areaBedBandCounts: null,
  };

  it("canFilterByGross is the gate, and it says no", () => {
    expect(canFilterByGross(legacy)).toBe(false);
    expect(
      canFilterByGross(buildLeadVolumeAggregate(liveRows(), NOW).management)
    ).toBe(true);
  });

  it("⚠️ an unfloored prediction is UNAFFECTED — the totals still work", () => {
    // Normalising to all-"none" is truthful: that source tells us nothing
    // about any lead's gross, and an absent floor admits "none".
    const p = predictMonthlyVolume(legacy, {
      areas: [],
      minBedrooms: null,
      maxBedrooms: null,
      minGross: null,
    });
    expect(p.matchingLeads).toBe(40);
    expect(p.grossFilterApplied).toBe(true);
  });

  it("⚠️ a floor is reported as NOT APPLIED rather than quoting zero", () => {
    // Quoting zero is §58.2's failure — indistinguishable from a real answer,
    // on a marketing page. The flag is the second layer; the first is that
    // `canFilterByGross` hides the control entirely.
    const p = predictMonthlyVolume(legacy, {
      areas: [],
      minBedrooms: null,
      maxBedrooms: null,
      minGross: 50_000,
    });
    expect(p.grossFilterApplied).toBe(false);
    expect(p.matchingLeads).toBe(40);
  });

  it("with real band data the flag is true and the floor bites", () => {
    const vol = buildLeadVolumeAggregate(liveRows(), NOW).management;
    const p = predictMonthlyVolume(vol, {
      areas: [],
      minBedrooms: null,
      maxBedrooms: null,
      minGross: 50_000,
    });
    expect(p.grossFilterApplied).toBe(true);
    expect(p.matchingLeads).toBe(62);
  });
});

describe("rawMatching — the unfloored count Phase 3 ranks on", () => {
  it("is the pre-Math.floor value, so small real gains survive", () => {
    // Two filtered competitors under the ceiling: share is 1, so raw == floor.
    const vol = buildLeadVolumeAggregate(liveRows(), NOW).management;
    const p = predictMonthlyVolume(vol, {
      areas: [],
      minBedrooms: null,
      maxBedrooms: null,
      minGross: null,
    });
    expect(p.rawMatching).toBe(263);
    expect(p.matchingLeads).toBe(263);
  });

  it("keeps the fraction that Math.floor discards", () => {
    const vol = buildLeadVolumeAggregate(liveRows(), NOW).management;
    // Five filtered customers against a ceiling of four: share = 4/5.
    const contention = {
      filteredCustomers: { LS: 4 },
      byBand: {
        LS: Object.fromEntries(GROSS_BAND_KEYS.map((k) => [k, 4])),
      },
      everywhereByBand: {},
      maxPerLead: 4,
    };
    const p = predictMonthlyVolume(
      vol,
      { areas: ["LS"], minBedrooms: null, maxBedrooms: null, minGross: null },
      contention
    );
    expect(p.rawMatching).toBeCloseTo(263 * 0.8, 6);
    expect(p.matchingLeads).toBe(Math.floor(263 * 0.8));
    expect(p.rawMatching).toBeGreaterThan(p.matchingLeads);
  });
});

describe("⚠️ the migration's CHECK and GROSS_THRESHOLDS are ONE list", () => {
  /**
   * The `cancelOptions.ts` arrangement (§29): asserted mechanically, against
   * the migration's own text, rather than trusted to review.
   *
   * If the two diverge, the database admits a floor the prediction has no
   * band edge for — so every quote at that floor is computed at the WRONG
   * EDGE, and half the directions overstate. Nothing else would notice.
   */
  const sql = readFileSync(
    resolve(__dirname, "../../../supabase/migrations/0158_filter_min_gross.sql"),
    "utf8"
  );

  it("the CHECK lists exactly the TypeScript thresholds, in order", () => {
    const m = /filter_min_gross in \(([^)]*)\)/.exec(sql);
    expect(m).not.toBeNull();
    const fromSql = m![1].split(",").map((v) => parseInt(v.trim(), 10));
    expect(fromSql).toEqual([...GROSS_THRESHOLDS]);
  });

  it("⚠️ and there is no gr_ mirror in the migration", () => {
    // Guaranteed rent has zero leads carrying a gross figure, so a gr_ column
    // could never hold a meaningful value. Pinned here so "completing the
    // symmetry" fails a test rather than reading as a tidy-up.
    expect(sql).not.toMatch(/gr_filter_min_gross/);
  });

  it("names the unit, because it is the one money column in POUNDS", () => {
    expect(sql).toMatch(/POUNDS, NOT PENCE/);
  });
});
