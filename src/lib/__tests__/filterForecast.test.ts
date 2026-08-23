import { describe, it, expect } from "vitest";
import {
  forecastVolume,
  deliverableAtConfidence,
  recommendedDowngrade,
  FORECAST_CONFIDENCE,
  HIGH_COST_PER_LEAD_PENCE,
} from "@/lib/filterForecast";
import { WEEKS_PER_MONTH, type VolumePrediction } from "@/lib/filterPrediction";

/** The observation window every fixture is measured over (~today's history). */
const W = 7.43;

/** A prediction for a filter matching `m` leads over W weeks. */
function pred(m: number, over: Partial<VolumePrediction> = {}): VolumePrediction {
  const monthlyRate = (m / W) * WEEKS_PER_MONTH;
  return {
    matchingLeads: m,
    monthlyRate,
    displayRate: Math.round(monthlyRate),
    reliable: m >= 5,
    weeksElapsed: W,
    ...over,
  };
}

describe("the worked example the pricing was agreed on", () => {
  // 9 matches over the window reads as ~5 a month, which is the estimate the
  // £50 figure was agreed against.
  it("an estimate of 5 a month forecasts 3, at £50 a lead", () => {
    const q = forecastVolume(pred(9), 10, "management");
    expect(q.estimate).toBe(5);
    expect(q.expected).toBe(3);
    expect(q.costPerLeadPence).toBe(5000);
    expect(q.likelihoodPct).toBe(85);
    expect(q.reducesVolume).toBe(true);
    expect(q.offerable).toBe(true);
  });
});

describe("forecasts across the range (10-lead plan)", () => {
  // Cross-checked against an independent evaluation of the same negative
  // binomial in SQL, on these exact integer counts — not against this
  // implementation. [matches, expected, likelihoodPct]
  it.each([
    [5, 1, 91],
    [7, 2, 87],
    [9, 3, 85],
    [13, 5, 83],
    [16, 6, 86],
    [20, 8, 85],
    [25, 10, 87],
    [82, 10, 99],
  ])("%i matches -> at least %i at %i%%", (m, expected, pct) => {
    const q = forecastVolume(pred(m), 10, "management");
    expect(q.expected).toBe(expected);
    expect(q.likelihoodPct).toBe(pct);
  });
});

describe("the likelihood", () => {
  it("never drops below the confidence the forecast is struck at", () => {
    for (let m = 0; m <= 250; m++) {
      for (const allocation of [10, 20]) {
        const q = forecastVolume(pred(m), allocation, "management");
        if (q.offerable) {
          expect(q.likelihoodPct).toBeGreaterThanOrEqual(
            Math.floor(FORECAST_CONFIDENCE * 100)
          );
        }
      }
    }
  });

  it("climbs towards certainty once the forecast caps at the plan", () => {
    const capped = forecastVolume(pred(82), 10, "management");
    expect(capped.expected).toBe(10);
    expect(capped.reducesVolume).toBe(false);
    expect(capped.likelihoodPct).toBeGreaterThanOrEqual(99);
  });

  // Reading the likelihood off an UNCAPPED figure shows the confidence of a
  // promise nobody made: this filter reads "38 leads, 79%" that way.
  it("is measured against the capped figure, not the raw one", () => {
    const q = forecastVolume(pred(82), 10, "management");
    expect(q.expected).toBe(10);
    expect(q.likelihoodPct).not.toBe(79);
  });

  it("is null when nothing is offered", () => {
    expect(forecastVolume(pred(2), 10, "management").likelihoodPct).toBeNull();
  });
});

// The property the whole fixed-confidence design exists to provide, and the
// regression that would catch a reversion to a fixed-sigma margin.
describe("widening a filter is always a win", () => {
  it.each([10, 20])(
    "forecast never falls and cost per lead never rises (allocation %i)",
    (allocation) => {
      let lastExpected = -1;
      let lastCost = Number.POSITIVE_INFINITY;
      for (let m = 0; m <= 300; m++) {
        const q = forecastVolume(pred(m), allocation, "management");
        if (!q.offerable) continue;
        expect(q.expected).toBeGreaterThanOrEqual(lastExpected);
        expect(q.costPerLeadPence!).toBeLessThanOrEqual(lastCost);
        lastExpected = q.expected;
        lastCost = q.costPerLeadPence!;
      }
    }
  );
});

describe("the allocation cap", () => {
  it("never forecasts more leads than the plan sells", () => {
    for (const allocation of [10, 20]) {
      for (let m = 0; m <= 300; m += 7) {
        expect(
          forecastVolume(pred(m), allocation, "management").expected
        ).toBeLessThanOrEqual(allocation);
      }
    }
  });

  it("a filter comfortably above the plan keeps the full allocation at list price", () => {
    const q = forecastVolume(pred(132), 10, "management");
    expect(q.expected).toBe(10);
    expect(q.costPerLeadPence).toBe(1500); // £15, unchanged
    expect(q.reducesVolume).toBe(false);
  });
});

describe("cost per lead", () => {
  it("rounds up, so the forecast can never be worth less than the plan price", () => {
    for (const allocation of [10, 20]) {
      for (let m = 1; m <= 200; m++) {
        const q = forecastVolume(pred(m), allocation, "management");
        if (!q.offerable) continue;
        expect(q.expected * q.costPerLeadPence!).toBeGreaterThanOrEqual(
          q.planPricePence
        );
      }
    }
  });

  it("flags an offer above the confirmation ceiling", () => {
    const poor = forecastVolume(pred(5), 10, "management");
    expect(poor.expected).toBe(1);
    expect(poor.costPerLeadPence).toBe(15000); // £150 a lead
    expect(poor.requiresExtraConfirm).toBe(true);

    const fine = forecastVolume(pred(16), 10, "management");
    expect(fine.costPerLeadPence).toBeLessThanOrEqual(
      HIGH_COST_PER_LEAD_PENCE
    );
    expect(fine.requiresExtraConfirm).toBe(false);
  });
});

// The panel gates its apply button on both flags, and only renders the
// extra-confirm caveat inside the reduced-volume block. If a forecast could
// ever require the caveat without reducing the volume, that caveat
// would have nowhere to appear and the customer would be locked out.
describe("requiresExtraConfirm is always reachable in the UI", () => {
  it("never requires the caveat without also reducing the volume", () => {
    for (const allocation of [10, 20]) {
      for (let m = 0; m <= 300; m++) {
        const q = forecastVolume(pred(m), allocation, "management");
        if (q.requiresExtraConfirm) {
          expect(q.offerable).toBe(true);
          expect(q.reducesVolume).toBe(true);
        }
      }
    }
  });

  it("never sets the flag when nothing is offerable", () => {
    expect(forecastVolume(pred(2), 10, "management").requiresExtraConfirm).toBe(false);
    expect(forecastVolume(pred(50), 0, "management").requiresExtraConfirm).toBe(false);
  });
});

describe("when no forecast can be offered", () => {
  it("refuses to promise off a sample too thin to predict", () => {
    const q = forecastVolume(pred(4), 10, "management");
    expect(q.offerable).toBe(false);
    expect(q.reason).toBe("unreliable");
    expect(q.expected).toBe(0);
    expect(q.costPerLeadPence).toBeNull();
  });

  it("handles a customer with no allocation on this product", () => {
    const q = forecastVolume(pred(50), 0, "management");
    expect(q.offerable).toBe(false);
    expect(q.reason).toBe("no_plan");
  });

  it("handles a reliable sample that still supports nothing", () => {
    // Reliable by raw count, but spread so thin the confident floor is zero.
    const q = forecastVolume(pred(5, { reliable: true, weeksElapsed: 400 }), 10, "management");
    expect(q.expected).toBe(0);
    expect(q.reason).toBe("zero_volume");
    expect(q.costPerLeadPence).toBeNull();
  });
});

describe("deliverableAtConfidence", () => {
  it("is monotone in the observed count", () => {
    let last = -1;
    for (let m = 0; m <= 200; m++) {
      const g = deliverableAtConfidence(m, W, 20).expected;
      expect(g).toBeGreaterThanOrEqual(last);
      last = g;
    }
  });

  it("tightens as history accumulates, for the same monthly rate", () => {
    // Same rate (10/month), measured over 4 weeks vs 52.
    const thin = deliverableAtConfidence(Math.round((10 * 4) / WEEKS_PER_MONTH), 4, 20);
    const thick = deliverableAtConfidence(Math.round((10 * 52) / WEEKS_PER_MONTH), 52, 20);
    expect(thick.expected).toBeGreaterThan(thin.expected);
  });
});

describe("recommendedDowngrade", () => {
  it("moves a 20-plan customer whose forecast fits a 10-plan", () => {
    const plan = recommendedDowngrade(6, 20, "management");
    expect(plan?.leads).toBe(10);
    expect(plan?.priceGbp).toBe(150);
  });

  it("leaves a customer alone when the smaller plan would not cover them", () => {
    expect(recommendedDowngrade(14, 20, "management")).toBeNull();
  });

  it("leaves a customer alone when already on the cheapest plan", () => {
    expect(recommendedDowngrade(3, 10, "management")).toBeNull();
  });

  it("never recommends a plan that would cut the forecast", () => {
    for (let g = 1; g <= 20; g++) {
      for (const allocation of [10, 20]) {
        const plan = recommendedDowngrade(g, allocation, "management");
        if (plan) expect(plan.leads).toBeGreaterThanOrEqual(g);
      }
    }
  });

  it("works for Guaranteed Rent too (invariant 6)", () => {
    const plan = recommendedDowngrade(6, 20, "guaranteed_rent");
    expect(plan?.leads).toBe(10);
  });
});

describe("both products price identically today", () => {
  it("quotes the same forecast and price for either lead type", () => {
    const m = 16;
    const mgmt = forecastVolume(pred(m), 10, "management");
    const gr = forecastVolume(pred(m), 10, "guaranteed_rent");
    expect(gr.expected).toBe(mgmt.expected);
    expect(gr.costPerLeadPence).toBe(mgmt.costPerLeadPence);
    expect(gr.planPricePence).toBe(mgmt.planPricePence);
  });
});
