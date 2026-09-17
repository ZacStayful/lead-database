import { describe, it, expect } from "vitest";
import {
  forecastBackfillFor,
  forecastFigureColumns,
} from "@/lib/forecastBackfill";
import {
  buildLeadVolumeAggregate,
  type LeadVolumeRow,
} from "@/lib/filterPrediction";
import type { Customer } from "@/lib/types";

/**
 * The stored-forecast backfill (§58): writes the five figure columns the apply
 * route writes, from the same forecast, only where nothing is stored, and
 * never the acknowledgement.
 */

const NOW = new Date("2026-09-17T00:00:00Z");

function rows(n: number, leadType = "management"): LeadVolumeRow[] {
  return Array.from({ length: n }, (_, i) => ({
    postcode_area: "BS",
    bedrooms: "3",
    lead_type: leadType,
    created_at: `2026-08-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
  }));
}

function customer(over: Partial<Customer> = {}): Customer {
  return {
    id: "c1",
    monthly_allocation: 20,
    gr_monthly_allocation: 10,
    filter_status: "active",
    filter_areas: ["BS"],
    filter_min_bedrooms: null,
    filter_max_bedrooms: null,
    filter_expected_leads: null,
    filter_forecast_acknowledged_at: null,
    gr_filter_status: "off",
    ...over,
  } as unknown as Customer;
}

const AGG = buildLeadVolumeAggregate([...rows(60), ...rows(30, "guaranteed_rent")], NOW);

describe("forecastBackfillFor", () => {
  it("writes exactly the five figure columns and never the acknowledgement", () => {
    const d = forecastBackfillFor(customer(), "management", AGG, null);
    expect(d.outcome).toBe("write");
    if (d.outcome !== "write") return;
    const c = forecastFigureColumns("management");
    expect(Object.keys(d.columns).sort()).toEqual(
      [
        c.expectedLeads,
        c.forecastEstimate,
        c.forecastLikelihood,
        c.forecastCostPence,
        c.forecastPricePence,
      ].sort()
    );
    expect(Object.keys(d.columns)).not.toContain("filter_forecast_acknowledged_at");
    expect(d.columns[c.expectedLeads]).toBe(d.forecast.expected);
    expect(d.columns[c.forecastCostPence]).toBe(d.forecast.costPerLeadPence);
    expect(d.forecast.expected).toBeGreaterThan(0);
  });

  it("never overwrites a figure the customer was shown", () => {
    const d = forecastBackfillFor(
      customer({ filter_expected_leads: 4 } as Partial<Customer>),
      "management",
      AGG,
      null
    );
    expect(d).toEqual({ outcome: "skip", reason: "already_stored" });
  });

  it("skips a product with no active filter", () => {
    const d = forecastBackfillFor(customer(), "guaranteed_rent", AGG, null);
    expect(d).toEqual({ outcome: "skip", reason: "filter_off" });
  });

  it("skips, with the forecast's own reason, where nothing can be offered", () => {
    const d = forecastBackfillFor(
      customer({ filter_areas: ["ZZ"] } as Partial<Customer>),
      "management",
      AGG,
      null
    );
    expect(d.outcome).toBe("skip");
    if (d.outcome !== "skip") return;
    expect(d.reason).toMatch(/^not_offerable:/);
  });

  it("writes gr_ columns and only gr_ columns for a guaranteed-rent filter (invariant 6)", () => {
    const d = forecastBackfillFor(
      customer({
        filter_status: "off",
        gr_filter_status: "active",
        gr_filter_areas: ["BS"],
        gr_filter_min_bedrooms: null,
        gr_filter_max_bedrooms: null,
        gr_filter_expected_leads: null,
      } as Partial<Customer>),
      "guaranteed_rent",
      AGG,
      null
    );
    expect(d.outcome).toBe("write");
    if (d.outcome !== "write") return;
    for (const k of Object.keys(d.columns)) expect(k.startsWith("gr_filter_")).toBe(true);
    expect(d.forecast.allocation).toBe(10);
  });
});
