import { describe, it, expect } from "vitest";

/**
 * The re-apply balance clamp, extracted so its arithmetic is testable without
 * standing up the route. Mirrors src/app/api/customer/filter/route.ts — if one
 * changes, so must the other.
 */
function clampedBalance(balance: number, allocation: number, owed: number): number {
  const excess = Math.max(balance - allocation, 0);
  const spared = Math.min(owed, excess);
  return Math.min(balance, allocation) + spared;
}

describe("the re-apply balance clamp", () => {
  it("forfeits ordinary carried surplus, as it always did", () => {
    expect(clampedBalance(14, 10, 0)).toBe(10);
  });

  it("leaves a balance at or under the allocation alone", () => {
    expect(clampedBalance(7, 10, 0)).toBe(7);
    expect(clampedBalance(10, 10, 0)).toBe(10);
  });

  it("spares compensation we owed", () => {
    // 10 of plan + 4 owed: the 4 survives.
    expect(clampedBalance(14, 10, 4)).toBe(14);
  });

  it("spares only the part actually at risk", () => {
    // Under the allocation, nothing was at risk, so nothing is handed back.
    expect(clampedBalance(6, 10, 4)).toBe(6);
  });

  // filter_guarantee_credit counts up forever and does not decrement as credits
  // are spent, so it can exceed the whole balance. Treating it as "how much of
  // today's balance is owed" would invent leads out of nothing.
  it("never returns more than the customer already had", () => {
    expect(clampedBalance(12, 10, 99)).toBe(12);
    expect(clampedBalance(3, 10, 99)).toBe(3);
    for (let balance = 0; balance <= 40; balance++) {
      for (const owed of [0, 1, 5, 50, 999]) {
        expect(clampedBalance(balance, 10, owed)).toBeLessThanOrEqual(balance);
      }
    }
  });

  it("never returns less than the plain clamp would", () => {
    for (let balance = 0; balance <= 40; balance++) {
      for (const owed of [0, 1, 5, 50]) {
        expect(clampedBalance(balance, 10, owed)).toBeGreaterThanOrEqual(
          Math.min(balance, 10)
        );
      }
    }
  });
});
