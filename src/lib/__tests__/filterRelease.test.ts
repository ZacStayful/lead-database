import { describe, expect, it } from "vitest";
import { canSpendRefund, releaseCount } from "../filterRelease";

const base = {
  choice: "discard" as const,
  releasableCount: 5,
  balance: 0,
  forecastExpected: 3,
  forecastOfferable: true,
  blocked: false,
};

describe("releaseCount — discard", () => {
  it("gives back everything releasable", () => {
    expect(releaseCount({ ...base, choice: "discard" })).toEqual({
      count: 5,
      mode: "discard",
    });
  });

  it("gives back everything even when the balance is healthy", () => {
    // Discard is the customer's explicit instruction, not a sizing exercise.
    expect(releaseCount({ ...base, choice: "discard", balance: 20 }).count).toBe(5);
  });

  it("ignores the forecast entirely", () => {
    expect(
      releaseCount({
        ...base,
        choice: "discard",
        forecastOfferable: false,
        forecastExpected: null,
      }).count
    ).toBe(5);
  });
});

describe("releaseCount — keep", () => {
  const keep = { ...base, choice: "keep" as const };

  it("frees the forecast when no credits remain", () => {
    expect(releaseCount({ ...keep, balance: 0, forecastExpected: 3 })).toEqual({
      count: 3,
      mode: "quota_refill",
    });
  });

  it("frees only the shortfall when some credits remain", () => {
    expect(releaseCount({ ...keep, balance: 2, forecastExpected: 3 }).count).toBe(1);
  });

  it("frees nothing when the balance already covers the forecast", () => {
    // Nothing is in the way of the filter delivering, so nothing is taken.
    expect(releaseCount({ ...keep, balance: 10, forecastExpected: 3 }).count).toBe(0);
  });

  it("never exceeds what is actually releasable", () => {
    expect(
      releaseCount({ ...keep, releasableCount: 2, forecastExpected: 9 }).count
    ).toBe(2);
  });

  it("frees nothing when no forecast could be offered", () => {
    // The guard against `null - balance` becoming NaN. Too little history
    // through the selection means there is no number to size a release with.
    expect(
      releaseCount({ ...keep, forecastOfferable: false, forecastExpected: null }).count
    ).toBe(0);
  });

  it("frees nothing when the forecast is offerable but absent", () => {
    expect(
      releaseCount({ ...keep, forecastOfferable: true, forecastExpected: null }).count
    ).toBe(0);
  });

  it("frees nothing when the forecast is zero", () => {
    expect(releaseCount({ ...keep, forecastExpected: 0 }).count).toBe(0);
  });
});

describe("releaseCount — guards", () => {
  it("frees nothing when nothing is releasable", () => {
    expect(releaseCount({ ...base, releasableCount: 0 }).count).toBe(0);
    expect(releaseCount({ ...base, choice: "keep", releasableCount: 0 }).count).toBe(0);
  });

  it("frees nothing for an account that cannot spend the refund", () => {
    expect(releaseCount({ ...base, blocked: true }).count).toBe(0);
    expect(releaseCount({ ...base, choice: "keep", blocked: true }).count).toBe(0);
  });

  it("is never negative and never exceeds the releasable count", () => {
    for (const balance of [0, 1, 5, 50]) {
      for (const expected of [0, 1, 3, 40]) {
        for (const releasable of [0, 1, 4]) {
          for (const choice of ["keep", "discard"] as const) {
            const { count } = releaseCount({
              ...base,
              choice,
              balance,
              forecastExpected: expected,
              releasableCount: releasable,
            });
            expect(count).toBeGreaterThanOrEqual(0);
            expect(count).toBeLessThanOrEqual(releasable);
          }
        }
      }
    }
  });

  it("labels the mode from the choice, not the count", () => {
    expect(releaseCount({ ...base, choice: "keep", releasableCount: 0 }).mode).toBe(
      "quota_refill"
    );
    expect(releaseCount({ ...base, choice: "discard", blocked: true }).mode).toBe(
      "discard"
    );
  });
});

describe("canSpendRefund", () => {
  const live = {
    is_active: true,
    paused_at: null,
    cancel_effective_at: null,
    gr_cancel_effective_at: null,
  };

  it("allows a live customer on both products", () => {
    expect(canSpendRefund(live, "management")).toBe(true);
    expect(canSpendRefund(live, "guaranteed_rent")).toBe(true);
  });

  it("refuses an archived customer on both products", () => {
    const archived = { ...live, is_active: false };
    expect(canSpendRefund(archived, "management")).toBe(false);
    expect(canSpendRefund(archived, "guaranteed_rent")).toBe(false);
  });

  it("refuses a paused customer for management only", () => {
    // paused_at is management-only (invariant 6) and must never gate GR.
    const paused = { ...live, paused_at: "2026-08-01T00:00:00Z" };
    expect(canSpendRefund(paused, "management")).toBe(false);
    expect(canSpendRefund(paused, "guaranteed_rent")).toBe(true);
  });

  it("refuses a customer who has scheduled a cancellation, per product", () => {
    const mgmt = { ...live, cancel_effective_at: "2026-09-01T00:00:00Z" };
    expect(canSpendRefund(mgmt, "management")).toBe(false);
    expect(canSpendRefund(mgmt, "guaranteed_rent")).toBe(true);

    const gr = { ...live, gr_cancel_effective_at: "2026-09-01T00:00:00Z" };
    expect(canSpendRefund(gr, "guaranteed_rent")).toBe(false);
    expect(canSpendRefund(gr, "management")).toBe(true);
  });
});
