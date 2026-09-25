import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  filterSummary,
  filterTooltip,
  revenuePhrase,
  type LeadFilterView,
} from "@/lib/leadFilter";
import { GROSS_THRESHOLDS, formatGrossThreshold, isGrossThreshold } from "@/lib/filterPrediction";

/**
 * The revenue floor's route and display halves.
 *
 * ⚠️ FILE-TEXT FOR THE ROUTE, because `vitest.config.mts` is PURE UNITS ONLY —
 * no network, no database — and every guard below is about a Supabase call
 * shape or an update object that only PostgREST could evaluate. §42.8 records
 * what a test that writes its OWN copy of a query asserts: a query that is
 * never running, and 91 destroyed sequence runs.
 */
const strip = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+/g, " ");

const route = strip(
  readFileSync(resolve(__dirname, "../../app/api/customer/filter/route.ts"), "utf8")
);
const account = strip(
  readFileSync(resolve(__dirname, "../api/service/account.ts"), "utf8")
);

describe("isGrossThreshold — the ONE validator", () => {
  it("accepts every offered floor and nothing else", () => {
    for (const t of GROSS_THRESHOLDS) expect(isGrossThreshold(t)).toBe(true);
    // ⚠️ A value BETWEEN two thresholds is the case a range check would let
    // through: it bands at the wrong edge and the CHECK then 500s the write.
    for (const bad of [24_999, 26_000, 35_000, 60_000, 74_999, 100_000, 0, -50_000]) {
      expect(isGrossThreshold(bad)).toBe(false);
    }
  });

  it("refuses a string that looks like one", () => {
    expect(isGrossThreshold("50000")).toBe(false);
    expect(isGrossThreshold(null)).toBe(false);
    expect(isGrossThreshold(undefined)).toBe(false);
    expect(isGrossThreshold(NaN)).toBe(false);
  });
});

describe("formatGrossThreshold", () => {
  it("renders every threshold in thousands", () => {
    expect(GROSS_THRESHOLDS.map(formatGrossThreshold)).toEqual([
      "£25k",
      "£30k",
      "£40k",
      "£50k",
      "£75k",
    ]);
  });
});

describe("⚠️ the apply route", () => {
  it("validates against the LIST, never a range", () => {
    expect(route).toContain("isGrossThreshold(g)");
    // A bare comparison would admit £60,000, which no band admits.
    expect(route).not.toMatch(/min_gross[\s\S]{0,80}>=\s*25000/);
  });

  it("⚠️ REFUSES a floor on guaranteed rent rather than dropping it", () => {
    // Dropping it means the customer believes they set one, and then reads
    // every lead that arrives as the filter failing.
    expect(route).toMatch(
      /product === "guaranteed_rent" && body\.min_gross != null[\s\S]{0,400}status: 400/
    );
    expect(route).toContain("gross_not_supported");
  });

  it("⚠️ the GR column map cannot NAME the column, let alone write it", () => {
    // Invariant 6 satisfied structurally. `cols()`'s GR branch returns null,
    // so even with the refusal above deleted there is nothing to write to.
    expect(route).toMatch(/gr_filter_forecast_acknowledged_at",[\s\S]{0,40}minGross: null/);
    expect(route).not.toContain("gr_filter_min_gross");
  });

  it("⚠️ writes the column UNCONDITIONALLY, not only-when-present", () => {
    // Written only when a floor arrives, a customer who set £75k and later
    // edits their areas keeps a floor the UI no longer shows and cannot
    // clear — §28.7's class exactly.
    expect(route).toContain("...(c.minGross ? { [c.minGross]: minGross } : {})");
    expect(route).not.toMatch(/if \(minGross !== null\) update\[/);
  });

  it("passes the floor to the forecast, never a literal null", () => {
    expect(route).toMatch(
      /predictMonthlyVolume\( aggregate\[product\], \{ areas, minBedrooms: min, maxBedrooms: max, minGross \}/
    );
  });

  it("⚠️ asks `releasable_filter_assignments` about the floor being APPLIED", () => {
    // The stored column is still the OLD filter's at that point — the update
    // has not run yet — so the RPC must be told, not left to read.
    expect(route).toMatch(
      /"releasable_filter_assignments",[\s\S]{0,400}p_min_gross: minGross/
    );
  });

  it("lets a revenue floor stand alone as a filter", () => {
    // areas + bedrooms + floor: a floor on its own is a real selection, and
    // refusing it would be the only dimension that could not be used by itself.
    expect(route).toMatch(
      /areas\.length === 0 && min === null && max === null && minGross === null/
    );
  });
});

describe("⚠️ /v1/me reports the floor as a fixed field", () => {
  it("names it, per product, never spread", () => {
    expect(account).toContain("min_gross: gr ? null : customer.filter_min_gross ?? null");
  });

  it("⚠️ NULL on guaranteed rent, never a gr_ column", () => {
    expect(account).not.toContain("gr_filter_min_gross");
  });
});

// -------------------------------------------------------------------- display
const view = (over: Partial<LeadFilterView> = {}): LeadFilterView => ({
  leadType: "management",
  label: "Management",
  status: "active",
  areas: ["BS"],
  minBedrooms: 3,
  maxBedrooms: null,
  minGross: null,
  liftDate: null,
  selectionMode: "areas",
  radiusOutcode: null,
  radiusMiles: null,
  radiusPlace: null,
  expectedLeads: null,
  forecastCostPerLeadPence: null,
  forecastLikelihoodPct: null,
  forecastAcknowledgedAt: null,
  ...over,
});

describe("the summary line", () => {
  it("is byte-identical to today when no floor is set", () => {
    expect(filterSummary(view())).toBe("3+ beds · Bristol");
  });

  it("⚠️ carries the floor as its OWN segment", () => {
    // Folded into the bedroom phrase, an admin reading a thin forecast could
    // not see which of the two dimensions is the narrow one.
    expect(filterSummary(view({ minGross: 50_000 }))).toBe(
      "3+ beds · £50k+ revenue · Bristol"
    );
  });

  it("stands alone when it is the only constraint", () => {
    expect(
      filterSummary(view({ minBedrooms: null, areas: [], minGross: 25_000 }))
    ).toBe("£25k+ revenue · anywhere");
  });

  it("revenuePhrase is null for no floor, so nothing renders an empty segment", () => {
    expect(revenuePhrase(null)).toBeNull();
    expect(revenuePhrase(75_000)).toBe("£75k+ revenue");
  });
});

describe("the tooltip", () => {
  it("⚠️ names it as the PROPERTY's projected revenue", () => {
    // "Revenue: £50k" could be read as the customer's own income; §25's
    // figure is Stayful's projection for the property.
    expect(filterTooltip(view({ minGross: 50_000 }))).toContain(
      "Minimum property revenue: £50k a year projected gross"
    );
  });

  it("says Any rather than omitting the line", () => {
    expect(filterTooltip(view())).toContain("Minimum property revenue: Any");
  });
});
