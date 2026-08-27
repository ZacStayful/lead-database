import { describe, expect, it } from "vitest";
import { buildPresentationSeed, type SeedLead } from "@/lib/presentationSeed";
import { DEFAULT_PRESENTATION_SETTINGS } from "@/lib/presentationSettings";

const BLANK: SeedLead = {
  address: null,
  lead_name: null,
  phone: null,
  gross_annual_income: null,
  avg_nightly_rate: null,
  occupancy_rate: null,
  long_let_annual_income: null,
  platform_fee_pct: null,
  cleaning_fee_pct: null,
  monthly_revenue_profile: null,
  market_occupancy_rate: null,
  comp_set_size: null,
  comp_set_radius_km: null,
  comp_avg_rating: null,
  comp_avg_review_count: null,
  risk_score: null,
  risk_label: null,
  direct_booking_score: null,
};

const CUSTOMER = { business_name: "Acme Property", presentation_settings: null };

/**
 * The tool's own `merge(base, over)`, copied verbatim from
 * public/income-presentation/index.html.
 *
 * ⚠️ COPIED, NOT IMPORTED — the tool is a static file with no module boundary,
 * and the seam between what this builds and what that merges is where §26.7's
 * array-shrink trap lives. A test that could not see the merge could not catch
 * it.
 */
function merge(base: any, over: any): any {
  const out: any = {};
  for (const k in base) out[k] = base[k];
  for (const k in over) {
    if (over[k] && typeof over[k] === "object" && base[k] && typeof base[k] === "object" && !Array.isArray(over[k]))
      out[k] = merge(base[k], over[k]);
    else out[k] = over[k];
  }
  return out;
}

describe("the market block (0113)", () => {
  it("is null when the analysis stated none of it", () => {
    expect(buildPresentationSeed(BLANK, CUSTOMER).market).toBeNull();
  });

  /**
   * The property's own occupancy is already on the income slide. On its own it
   * is not evidence about the MARKET, and a slide with one restated figure on
   * it is worse than the six slides this tool has always had.
   */
  it("is null when all it has is the property's own occupancy", () => {
    const seed = buildPresentationSeed({ ...BLANK, occupancy_rate: 63 }, CUSTOMER);
    expect(seed.market).toBeNull();
  });

  it("appears as soon as the analysis states one market figure", () => {
    const seed = buildPresentationSeed({ ...BLANK, risk_score: 38, risk_label: "Low-Medium Risk" }, CUSTOMER);
    expect(seed.market).not.toBeNull();
    expect(seed.market!.riskScore).toBe(38);
    expect(seed.market!.compAvgRating).toBeNull();
  });

  it("carries everything a full report stated", () => {
    const seed = buildPresentationSeed(
      {
        ...BLANK,
        occupancy_rate: 63,
        market_occupancy_rate: 62,
        comp_set_size: 48,
        comp_set_radius_km: 1.5,
        comp_avg_rating: 4.8,
        comp_avg_review_count: 42,
        risk_score: 38,
        risk_label: "Low-Medium Risk",
        direct_booking_score: 72,
      },
      CUSTOMER
    );
    expect(seed.market).toEqual({
      occupancy: 63,
      marketOccupancy: 62,
      compSetSize: 48,
      compSetRadiusKm: 1.5,
      compAvgRating: 4.8,
      compAvgReviews: 42,
      riskScore: 38,
      riskLabel: "Low-Medium Risk",
      directBookingScore: 72,
    });
  });

  /** 0 means "no comparable listings nearby", which is a fact worth showing. */
  it("keeps a zero market occupancy and a zero review count", () => {
    const seed = buildPresentationSeed(
      { ...BLANK, occupancy_rate: 63, market_occupancy_rate: 0, comp_avg_review_count: 0 },
      CUSTOMER
    );
    expect(seed.market!.marketOccupancy).toBe(0);
    expect(seed.market!.compAvgReviews).toBe(0);
  });

  it("invents nothing when the report was silent", () => {
    const seed = buildPresentationSeed({ ...BLANK, risk_score: 38, risk_label: "Low Risk" }, CUSTOMER);
    const { occupancy, riskScore, riskLabel, ...rest } = seed.market!;
    expect(Object.values(rest).every((v) => v === null)).toBe(true);
  });
});

describe("what the tool receives", () => {
  /**
   * §26.7: the seed must be COMPLETE, because `merge` copies the base's keys
   * first and therefore cannot shrink an array — a three-step onboarding list
   * merged over five defaults comes back as five.
   */
  it("survives the tool's own merge without growing a list back", () => {
    const seed = buildPresentationSeed(BLANK, {
      business_name: "Acme",
      presentation_settings: { onboarding: [{ title: "Signed", when: "Day 1" }] },
    });
    const toolDefaults = {
      onboarding: DEFAULT_PRESENTATION_SETTINGS.onboarding,
      market: null,
      company: "[Your company]",
    };
    expect(merge(toolDefaults, seed).onboarding).toHaveLength(1);
  });

  /** A market object merged over a null default must arrive whole. */
  it("passes the market block through the merge intact", () => {
    const seed = buildPresentationSeed(
      { ...BLANK, comp_avg_rating: 4.8, comp_avg_review_count: 42 },
      CUSTOMER
    );
    const merged = merge({ market: null }, seed);
    expect(merged.market.compAvgRating).toBe(4.8);
  });

  /** A lead with no report at all must come out exactly like the blank tool. */
  it("leaves a report-less lead looking like the tool's own defaults", () => {
    const seed = buildPresentationSeed(BLANK, CUSTOMER);
    expect(seed.income).toEqual({
      grossAnnual: 60000,
      nightly: 185,
      occupancy: 60,
      longLetAnnual: 14400,
      platform: 15,
      cleaning: 18,
    });
    expect(seed.chart.variance).toBe(0.6);
    expect(seed.monthWeights).toBeNull();
    expect(seed.market).toBeNull();
  });
});
