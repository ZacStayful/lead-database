import { describe, it, expect } from "vitest";
import { filterCriteriaPhrase } from "@/lib/home/filterCaption";

describe("filterCriteriaPhrase", () => {
  it("⚠️ is byte-identical to the pre-§69 sentence when no floor is set", () => {
    // The regression that would be read by every filtered customer.
    expect(filterCriteriaPhrase("Bristol, Bath", "3+ bedrooms", null)).toBe(
      "Bristol, Bath and 3+ bedrooms"
    );
  });

  it("names the floor as a third criterion", () => {
    expect(filterCriteriaPhrase("Bristol", "3+ bedrooms", 50000)).toBe(
      "Bristol, 3+ bedrooms and a projected gross of at least £50k a year"
    );
  });

  it("uses the shared threshold formatter for every threshold", () => {
    for (const [gross, label] of [
      [25000, "£25k"],
      [30000, "£30k"],
      [40000, "£40k"],
      [50000, "£50k"],
      [75000, "£75k"],
    ] as const) {
      expect(filterCriteriaPhrase("BS", "Any", gross)).toContain(
        `at least ${label} a year`
      );
    }
  });

  it("never emits a dangling comma before 'and'", () => {
    for (const floor of [null, 50000]) {
      expect(filterCriteriaPhrase("BS", "Any", floor)).not.toContain(", and ");
    }
  });

  it("handles the anywhere / any-size defaults the page passes", () => {
    expect(filterCriteriaPhrase("any location", "any bedroom size", null)).toBe(
      "any location and any bedroom size"
    );
  });
});
