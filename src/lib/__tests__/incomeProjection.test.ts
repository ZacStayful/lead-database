import { describe, it, expect } from "vitest";
import { MANAGEMENT_FEE_DIVISOR, buildIncomeProjection, incomeBasis } from "../incomeProjection";

/**
 * Guaranteed Rent leads can now carry figures, because paid analysis produces
 * them for either product where the Monday sweep only ever did management.
 * IncomeProjection's early return on lead_type was therefore removed — these
 * pin what must and must not follow from that.
 */

const FIGS = { gross_annual_income: 43295, avg_nightly_rate: 157, occupancy_rate: 63 };

describe("buildIncomeProjection", () => {
  it("does not take the product at all — the component decides what to SHOW", () => {
    // This is the structural reason lifting IncomeProjection's early return is
    // safe: the maths never knew about lead_type, so nothing about the fee
    // computation changes for a GR lead. Only its rendering does.
    const p = buildIncomeProjection({ ...FIGS })!;
    expect(p.feeAnnualLow).toBeGreaterThan(0);
  });

  it("puts the range 10% either side and the fee at the documented divisor", () => {
    const p = buildIncomeProjection({ ...FIGS })!;
    expect(p.grossAnnualLow).toBe(Math.round(43295 * 0.9));
    expect(p.grossAnnualHigh).toBe(Math.round(43295 * 1.1));
    expect(p.feeAnnualLow).toBe(Math.round(p.grossAnnualLow / MANAGEMENT_FEE_DIVISOR));
  });

  it("renders nothing without a gross — a lead with no analysis is not a worthless property", () => {
    expect(
      buildIncomeProjection({ gross_annual_income: null })
    ).toBeNull();
  });
});

describe("incomeBasis", () => {
  it("claims the pair explains the gross when the arithmetic closes", () => {
    // 157 x 365 x 0.63 = 36,102 against a gross of 36,000 — inside tolerance,
    // so the lead reads "Based on £157 a night at 63% occupancy".
    const b = incomeBasis({ gross_annual_income: 36_100, avg_nightly_rate: 157, occupancy_rate: 63 });
    expect(b).toMatchObject({ nightlyRate: 157, occupancyPct: 63, reconciles: true });
  });

  it("falls back to the comp-set wording when it does not", () => {
    const b = incomeBasis({ gross_annual_income: 90_000, avg_nightly_rate: 157, occupancy_rate: 63 });
    expect(b?.reconciles).toBe(false);
  });

  it("says nothing at all without both halves of the pair", () => {
    expect(incomeBasis({ gross_annual_income: 40_000, avg_nightly_rate: 157, occupancy_rate: null })).toBeNull();
    expect(incomeBasis({ gross_annual_income: 40_000, avg_nightly_rate: null, occupancy_rate: 63 })).toBeNull();
  });

  it("would fail to reconcile if occupancy were ever stored as a fraction", () => {
    // The DB CHECK is 0..100, so 0.63 passes it. This is the symptom that
    // would be the only visible sign: the caption quietly changes.
    const wrong = incomeBasis({ gross_annual_income: 36_100, avg_nightly_rate: 157, occupancy_rate: 0.63 });
    expect(wrong?.reconciles).toBe(false);
  });
});
