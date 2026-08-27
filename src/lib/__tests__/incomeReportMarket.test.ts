import { describe, expect, it } from "vitest";
import { parseMarketFigures } from "@/lib/incomeReport";

/**
 * The market anchors (0113).
 *
 * The strings below are the report's own, in the shape the text layer flattens
 * them to. They come from the generator's source rather than being invented —
 * `Page3Comparables` prints the comp-set line and the benchmark bar,
 * `Page4LocalRisk` the direct-booking callout and the risk line — which is what
 * makes these a test of the anchors rather than of themselves.
 */
const REPORT =
  "Comparable Properties 48 active Airbnb listings within 1.50 km · " +
  "Median-aggregated · Data sourced from Airbnb via Airbtics " +
  "Avg Nightly Rate £157 Avg Occupancy 62% Avg Annual Revenue £34,120 " +
  "Avg Rating 4.8 ★ Avg Reviews 42 " +
  "Property Distance Nightly Occ Annual Rating Tier " +
  "Direct Booking Potential Score: 72/100 — GOOD " +
  "By Year 3, properties in this area typically achieve 30–50% direct bookings. " +
  "Risk Profile Investment risk score based on revenue consistency, seasonal " +
  "variance and long-term let comparison (0 = Low Risk, 100 = High Risk). " +
  "Low-Medium Risk · 38/100";

/** The headline block, which is where the market occupancy is stated. */
const HEADLINE = "AVG N I G H T LY R AT E £157 ADR across comp set O C C U PA N C Y R AT E 63% Market average 62%";

describe("parseMarketFigures", () => {
  it("reads everything a current report states", () => {
    const m = parseMarketFigures(`${HEADLINE} ${REPORT}`);
    expect(m).toEqual({
      marketOccupancyRate: 62,
      compSetSize: 48,
      compSetRadiusKm: 1.5,
      compAvgRating: 4.8,
      compAvgReviewCount: 42,
      riskScore: 38,
      riskLabel: "Low-Medium Risk",
      directBookingScore: 72,
    });
  });

  /**
   * The explanatory sentence contains "Low Risk, 100 = High Risk" and sits
   * ABOVE the verdict. Reading it as the verdict would report every property in
   * the book as high risk, plausibly and silently.
   */
  it("does not mistake the scale's explanation for the verdict", () => {
    const m = parseMarketFigures(
      "Investment risk score (0 = Low Risk, 100 = High Risk). High Risk · 81/100"
    );
    expect(m.riskScore).toBe(81);
    expect(m.riskLabel).toBe("High Risk");
  });

  it("survives a rating whose star did not make it into the text layer", () => {
    expect(parseMarketFigures("Avg Rating 4.9 Avg Reviews 7").compAvgRating).toBe(4.9);
  });

  /** `formatRating` prints an em dash when no comp has a rating. */
  it("reports nothing rather than zero for an unrated comp set", () => {
    const m = parseMarketFigures("Avg Rating — Avg Reviews 0");
    expect(m.compAvgRating).toBeNull();
    // Zero reviews is a fact about the market; absent is not the same thing.
    expect(m.compAvgReviewCount).toBe(0);
  });

  it("returns nulls, never throws, on a document that says none of it", () => {
    expect(parseMarketFigures("Gross Revenue £36,112 £3,009")).toEqual({
      marketOccupancyRate: null,
      compSetSize: null,
      compSetRadiusKm: null,
      compAvgRating: null,
      compAvgReviewCount: null,
      riskScore: null,
      riskLabel: null,
      directBookingScore: null,
    });
  });

  it("keeps a market occupancy of 0, which means no comparables nearby", () => {
    const m = parseMarketFigures("63% Market average 0%");
    expect(m.marketOccupancyRate).toBe(0);
  });

  /** Both or neither: a count without the radius does not say how far it looked. */
  it("drops a comp-set count whose radius is out of range", () => {
    const m = parseMarketFigures("48 active Airbnb listings within 900.00 km");
    expect(m.compSetSize).toBeNull();
    expect(m.compSetRadiusKm).toBeNull();
  });

  /** Both or neither again: a bare score is a number a landlord cannot read. */
  it("drops a risk score whose wording is out of range", () => {
    expect(parseMarketFigures("Low-Medium Risk · 380/100").riskScore).toBeNull();
    expect(parseMarketFigures("Low-Medium Risk · 380/100").riskLabel).toBeNull();
  });

  it("refuses a rating or score outside its own scale", () => {
    expect(parseMarketFigures("Avg Rating 48.0").compAvgRating).toBeNull();
    expect(
      parseMarketFigures("Direct Booking Potential Score: 720/100").directBookingScore
    ).toBeNull();
  });

  /**
   * ⚠️ The two scores run in OPPOSITE directions and are stored as printed.
   * A report where both are stated must not have either normalised toward the
   * other.
   */
  it("keeps risk and direct-booking on their own scales", () => {
    const m = parseMarketFigures(
      "Direct Booking Potential Score: 30/100 — MODERATE Low Risk · 12/100"
    );
    expect(m.directBookingScore).toBe(30);
    expect(m.riskScore).toBe(12);
  });
});
