import { describe, it, expect } from "vitest";
import {
  ANALYSIS_SHEET_HELP,
  LEAD_ANALYSIS_PRICE_PENCE,
  analysability,
  analysisQuote,
  buildOutcomeFromAnalyserResponse,
  describeIneligibility,
  formatPence,
  parseBedrooms,
  type AnalyserSuccess,
} from "../leadAnalysis";

describe("parseBedrooms", () => {
  it("reads the shapes a real spreadsheet holds", () => {
    expect(parseBedrooms("3")).toBe(3);
    expect(parseBedrooms("3 bed")).toBe(3);
    expect(parseBedrooms("3 bedrooms")).toBe(3);
    expect(parseBedrooms("3.0")).toBe(3);
    expect(parseBedrooms(4)).toBe(4);
    expect(parseBedrooms("  2  ")).toBe(2);
  });

  it("counts a studio as zero rather than nothing", () => {
    expect(parseBedrooms("Studio")).toBe(0);
    expect(parseBedrooms("studio")).toBe(0);
  });

  it("returns null for anything that is not a count", () => {
    expect(parseBedrooms("Ask agent")).toBeNull();
    expect(parseBedrooms("")).toBeNull();
    expect(parseBedrooms(null)).toBeNull();
    expect(parseBedrooms(undefined)).toBeNull();
  });

  it("keeps a negative negative, so validation can refuse it", () => {
    // The minus sign is inside the regex on purpose: dropping it would turn
    // "-1" into 1 and quietly analyse a property nobody described.
    expect(parseBedrooms("-1")).toBe(-1);
    expect(analysability({ address: "1 A St, BS1 5TR", bedrooms: "-1" }).code).toBe(
      "bedrooms_out_of_range"
    );
  });
});

describe("analysability", () => {
  it("accepts a lead whose address carries its own postcode", () => {
    const v = analysability({ address: "12 Bourneside Road, Bristol BS4 3AA", bedrooms: "3" });
    expect(v.ok).toBe(true);
    expect(v.input).toEqual({
      address: "12 Bourneside Road, Bristol BS4 3AA",
      postcode: "BS4 3AA",
      bedrooms: 3,
    });
  });

  it("accepts a separate postcode column", () => {
    const v = analysability({ address: "12 Bourneside Road", postcode: "bs4 3aa", bedrooms: "3" });
    expect(v.ok).toBe(true);
    expect(v.input?.postcode).toBe("BS4 3AA");
  });

  it("needs no name, email or phone — only the property", () => {
    expect(analysability({ address: "1 A St, BS1 5TR", bedrooms: "Studio" }).ok).toBe(true);
  });

  it("refuses an address with no postcode", () => {
    expect(analysability({ address: "12 Bourneside Road, Bristol", bedrooms: "3" }).code).toBe(
      "no_postcode"
    );
  });

  it("refuses two different postcodes rather than guessing", () => {
    // Picking one and charging for it is guessing with somebody's money.
    expect(
      analysability({ address: "12 Foo St BS4 3AA and 9 Bar St BS7 8PL", bedrooms: "3" }).code
    ).toBe("ambiguous_postcode");
  });

  it("is untroubled by the same postcode written twice", () => {
    expect(analysability({ address: "BS4 3AA, Bristol, BS4 3AA", bedrooms: "3" }).ok).toBe(true);
  });

  it("refuses a missing or impossible bedroom count", () => {
    expect(analysability({ address: "1 A St, BS1 5TR", bedrooms: null }).code).toBe("no_bedrooms");
    expect(analysability({ address: "1 A St, BS1 5TR", bedrooms: "Ask agent" }).code).toBe(
      "no_bedrooms"
    );
    expect(analysability({ address: "1 A St, BS1 5TR", bedrooms: "14" }).code).toBe(
      "bedrooms_out_of_range"
    );
  });

  it("refuses a lead with nothing at all", () => {
    expect(analysability({ address: null, bedrooms: "3" }).code).toBe("no_address");
  });

  it("marks a lead that already has figures rather than re-charging for it", () => {
    const v = analysability({
      address: "1 A St, BS1 5TR",
      bedrooms: "3",
      gross_annual_income: 41000,
    });
    expect(v.code).toBe("already_analysed");
    expect(v.ok).toBe(false);
    expect(v.input).not.toBeNull();
  });

  it("treats a Guaranteed Rent lead exactly like a management one", () => {
    // GR is in scope. The product difference is what is SHOWN (no management
    // fee line), not what can be analysed.
    expect(
      analysability({ lead_type: "guaranteed_rent", address: "1 A St, BS1 5TR", bedrooms: "3" }).ok
    ).toBe(true);
  });
});

describe("analysisQuote", () => {
  it("charges for the runnable rows only, at £3 each", () => {
    const q = analysisQuote([
      { id: "a", address: "1 A St, BS1 5TR", bedrooms: "3" },
      { id: "b", address: "2 B St, BS1 5TR", bedrooms: "2" },
      { id: "c", address: "3 C St", bedrooms: "2" },
      { id: "d", address: "4 D St, BS1 5TR", bedrooms: "" },
    ]);
    expect(q.eligible.map((l) => l.id)).toEqual(["a", "b"]);
    expect(q.ineligible.map((x) => x.code)).toEqual(["no_postcode", "no_bedrooms"]);
    expect(q.amountPence).toBe(600);
  });

  it("quotes ten rows at thirty pounds", () => {
    const leads = Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      address: `${i} A St, BS1 5TR`,
      bedrooms: "2",
    }));
    const q = analysisQuote(leads);
    expect(q.amountPence).toBe(10 * LEAD_ANALYSIS_PRICE_PENCE);
    expect(formatPence(q.amountPence)).toBe("£30");
  });

  it("quotes nothing when nothing is runnable", () => {
    expect(analysisQuote([{ address: "no postcode here", bedrooms: "3" }]).amountPence).toBe(0);
  });
});

describe("formatPence", () => {
  it("keeps whole pounds whole", () => {
    expect(formatPence(300)).toBe("£3");
    expect(formatPence(55_200)).toBe("£552");
    expect(formatPence(450)).toBe("£4.50");
  });
});

describe("describeIneligibility", () => {
  it("gives every refusal something the customer can act on", () => {
    for (const code of [
      "no_address",
      "no_postcode",
      "ambiguous_postcode",
      "no_bedrooms",
      "bedrooms_out_of_range",
      "already_analysed",
      "analysis_pending",
    ] as const) {
      expect(describeIneligibility(code).length).toBeGreaterThan(10);
    }
    expect(describeIneligibility("ok")).toBe("");
  });

  it("points a missing postcode at the fix the mapping screen offers", () => {
    expect(describeIneligibility("no_postcode")).toMatch(/own column/i);
    expect(ANALYSIS_SHEET_HELP.points.some((p) => p.label === "Postcode")).toBe(true);
  });
});

// ─── The seam ─────────────────────────────────────────────────────

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"

function reply(overrides: Partial<AnalyserSuccess["figures"]> = {}, top: Partial<AnalyserSuccess> = {}): AnalyserSuccess {
  return {
    ok: true,
    quality_ok: true,
    quality_reason: null,
    ...top,
    figures: {
      gross_annual_income: 43295,
      net_annual_income: 22513,
      long_let_annual_income: 18000,
      avg_nightly_rate: 157,
      occupancy_rate: 63,
      platform_fee_pct: 15,
      cleaning_fee_pct: 18,
      management_fee_annual: 6494,
      monthly_revenue_profile: Array.from({ length: 12 }, (_, i) => 1800 + i),
      ...overrides,
    },
  };
}

describe("buildOutcomeFromAnalyserResponse", () => {
  it("produces a parsed outcome carrying the bytes for the storage layer", () => {
    const o = buildOutcomeFromAnalyserResponse(reply(), PDF);
    expect(o.status).toBe("parsed");
    expect(o.grossAnnualIncome).toBe(43295);
    expect(o.occupancyRate).toBe(63);
    expect(o.avgNightlyRate).toBe(157);
    expect(o.monthlyRevenueProfile).toHaveLength(12);
    expect(o.assetId).toBeNull();
    expect(o.bytes).toBe(PDF);
  });

  /**
   * ── The market block (0113) ──────────────────────────────────────────
   *
   * The analyser is deployed separately, so a build of it that predates these
   * fields must go on producing perfectly good leads. Absent means "the
   * analysis did not say", exactly as a missing figure in a PDF does.
   */
  it("produces a lead with no market figures when the analyser sends none", () => {
    const o = buildOutcomeFromAnalyserResponse(reply(), PDF);
    expect(o.status).toBe("parsed");
    expect(o.grossAnnualIncome).toBe(43295);
    expect(o.riskScore).toBeNull();
    expect(o.compAvgRating).toBeNull();
    expect(o.directBookingScore).toBeNull();
  });

  it("carries the market block when the analyser sends it", () => {
    const o = buildOutcomeFromAnalyserResponse(
      reply({
        market_occupancy_rate: 62,
        comp_set_size: 48,
        comp_set_radius_km: 1.5,
        comp_avg_rating: 4.8,
        comp_avg_review_count: 42,
        risk_score: 38,
        risk_label: "Low-Medium Risk",
        direct_booking_score: 72,
      }),
      PDF
    );
    expect(o.marketOccupancyRate).toBe(62);
    expect(o.compSetSize).toBe(48);
    expect(o.compSetRadiusKm).toBe(1.5);
    expect(o.compAvgRating).toBe(4.8);
    expect(o.compAvgReviewCount).toBe(42);
    expect(o.riskScore).toBe(38);
    expect(o.riskLabel).toBe("Low-Medium Risk");
    expect(o.directBookingScore).toBe(72);
  });

  /**
   * The receiving CHECK constraints abort the WHOLE lead update, so one
   * out-of-range score would cost the gross beside it. Out of range is dropped.
   */
  it("drops a market figure the receiving constraint would reject", () => {
    const o = buildOutcomeFromAnalyserResponse(
      reply({ comp_avg_rating: 48, risk_score: 380, direct_booking_score: -4 }),
      PDF
    );
    expect(o.status).toBe("parsed");
    expect(o.grossAnnualIncome).toBe(43295);
    expect(o.compAvgRating).toBeNull();
    expect(o.riskScore).toBeNull();
    expect(o.directBookingScore).toBeNull();
  });

  it("keeps the comp set and the risk verdict paired", () => {
    const noRadius = buildOutcomeFromAnalyserResponse(reply({ comp_set_size: 48 }), PDF);
    expect(noRadius.compSetSize).toBeNull();

    const noWording = buildOutcomeFromAnalyserResponse(reply({ risk_score: 38 }), PDF);
    expect(noWording.riskScore).toBeNull();
    expect(noWording.riskLabel).toBeNull();
  });

  it("refuses an occupancy that is still a fraction", () => {
    // The receiving CHECK is 0..100, so 0.63 would be stored without complaint
    // and the only symptom would be a silently reworded caption.
    const o = buildOutcomeFromAnalyserResponse(reply({ occupancy_rate: 0.63 }), PDF);
    expect(o.status).toBe("parsed");
    expect(o.occupancyRate).toBeNull();
    expect(o.avgNightlyRate).toBeNull();
  });

  it("drops the nightly rate with the occupancy, never one alone", () => {
    const o = buildOutcomeFromAnalyserResponse(reply({ occupancy_rate: null }), PDF);
    expect(o.occupancyRate).toBeNull();
    expect(o.avgNightlyRate).toBeNull();
    expect(o.grossAnnualIncome).toBe(43295);
  });

  it("refuses a forecast that is not twelve months", () => {
    // A short array does not fail one column — the cardinality CHECK aborts the
    // whole lead update.
    const o = buildOutcomeFromAnalyserResponse(reply({ monthly_revenue_profile: [1, 2, 3] }), PDF);
    expect(o.status).toBe("unparsed");
    expect(o.error).toMatch(/twelve/i);
  });

  it("refuses synthetic figures", () => {
    const o = buildOutcomeFromAnalyserResponse(
      reply({}, { quality_ok: false, quality_reason: "no_str_data: no comparables found" }),
      PDF
    );
    expect(o.status).toBe("unparsed");
    expect(o.error).toMatch(/no_str_data/);
    expect(o.grossAnnualIncome).toBeNull();
  });

  it("refuses a zero gross", () => {
    expect(buildOutcomeFromAnalyserResponse(reply({ gross_annual_income: 0 }), PDF).status).toBe(
      "unparsed"
    );
  });

  it("refuses an empty or missing document", () => {
    // A previous version of this app stored 159 zero-byte PDFs, each recorded
    // as a report an operator could open.
    expect(buildOutcomeFromAnalyserResponse(reply(), new Uint8Array(0)).status).toBe("unparsed");
    expect(buildOutcomeFromAnalyserResponse(reply(), null).status).toBe("unparsed");
  });

  it("carries no stale figures on any refusal", () => {
    const o = buildOutcomeFromAnalyserResponse(reply(), null);
    expect(o.grossAnnualIncome).toBeNull();
    expect(o.netAnnualIncome).toBeNull();
    expect(o.monthlyRevenueProfile).toBeNull();
    expect(o.bytes).toBeNull();
  });

  it("agrees with the app's own management-fee derivation", () => {
    const o = buildOutcomeFromAnalyserResponse(reply(), PDF);
    const ours = Math.round((o.grossAnnualIncome as number) / 6.667);
    expect(Math.abs(ours - reply().figures.management_fee_annual)).toBeLessThanOrEqual(1);
  });
});
