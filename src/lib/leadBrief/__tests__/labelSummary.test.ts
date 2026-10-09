import { describe, expect, it } from "vitest";
import { countLabelsSince, thisMonthLine } from "@/lib/leadBrief/labelSummary";

/** The home page's "This month" line (Lead Brief Phase 5). */
const a = (match_label: string | null, assigned_at: string) => ({ match_label, assigned_at });

describe("thisMonthLine", () => {
  const rows = [
    a("top_match", "2026-10-08T09:00:00Z"),
    a("top_match", "2026-10-03T00:00:00Z"), // the cycle's first instant counts
    a("strong_match", "2026-10-05T10:00:00Z"),
    a("nearby_opportunity", "2026-10-06T10:00:00Z"),
    a("top_match", "2026-10-02T23:59:59Z"), // last cycle
    a(null, "2026-10-07T10:00:00Z"), // unlabelled
    a("best_match", "2026-10-07T10:00:00Z"), // not a label
  ];

  it("counts this cycle's labelled leads only", () => {
    expect(countLabelsSince(rows, "2026-10-03")).toEqual({
      top_match: 2,
      strong_match: 1,
      first_pick: 0,
      nearby_opportunity: 1,
    });
    expect(thisMonthLine(rows, "2026-10-03")).toBe("This month: 2 top · 1 strong · 0 first pick · 1 nearby");
  });

  it("says nothing for a customer with no labelled leads this cycle, which is every existing customer", () => {
    expect(thisMonthLine([a(null, "2026-10-07T10:00:00Z")], "2026-10-03")).toBeNull();
    expect(thisMonthLine([a("top_match", "2026-09-30T10:00:00Z")], "2026-10-03")).toBeNull();
    expect(thisMonthLine([], "2026-10-03")).toBeNull();
  });

  it("says nothing without a cycle to count from", () => {
    expect(thisMonthLine(rows, null)).toBeNull();
    expect(thisMonthLine(rows, "not a date")).toBeNull();
  });
});
