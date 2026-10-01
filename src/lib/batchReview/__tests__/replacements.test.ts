/**
 * The "leads you reported" section of a monthly review (§73.8).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  OUTCOME_LABEL,
  claimsForReview,
  replacementLeadIds,
  replacementOutcome,
  type ClaimRow,
} from "../replacements";

const claim = (over: Partial<ClaimRow>): ClaimRow => ({
  id: "c",
  lead_id: "L",
  status: "auto_upheld",
  resolution: "self_swap",
  reason: "already_with_operator",
  created_at: "2026-09-20T10:00:00Z",
  replacement_lead_id: "R",
  review_note: null,
  ...over,
});

const window = { cycleStart: "2026-09-15", cycleEnd: "2026-10-15" };

describe("outcome", () => {
  it("names each settlement", () => {
    expect(replacementOutcome("auto_upheld", "self_swap")).toBe("swapped");
    expect(replacementOutcome("upheld", "swap")).toBe("swapped");
    expect(replacementOutcome("auto_upheld", "credit")).toBe("credited");
    expect(replacementOutcome("under_review", "none")).toBe("under_review");
    expect(replacementOutcome("declined", "none")).toBe("declined");
  });
  it("never names the allowance (§51.3) or promises money back", () => {
    const text = Object.values(OUTCOME_LABEL).join(" ");
    expect(text).not.toMatch(/allowance|quota|budget|limit|remaining|refund|money back/i);
  });
});

describe("which review a report belongs to", () => {
  it("the review whose batch holds the reported lead, whenever it was reported", () => {
    const late = claim({ id: "late", lead_id: "inBatch", created_at: "2026-10-20T10:00:00Z" });
    const got = claimsForReview([late], {
      itemLeadIds: new Set(["inBatch"]),
      otherReviewLeadIds: new Set(),
      ...window,
    });
    expect(got.map((c) => c.id)).toEqual(["late"]);
  });
  it("a lead swapped before month end (so not an item) by the date it was reported", () => {
    const early = claim({ id: "early", lead_id: "gone", created_at: "2026-09-20T10:00:00Z" });
    const outside = claim({ id: "outside", lead_id: "gone2", created_at: "2026-10-15T00:00:00Z" });
    const got = claimsForReview([early, outside], {
      itemLeadIds: new Set(),
      otherReviewLeadIds: new Set(),
      ...window,
    });
    expect(got.map((c) => c.id)).toEqual(["early"]);
  });
  it("never a report that belongs to another review's batch", () => {
    const other = claim({ id: "other", lead_id: "lastMonth", created_at: "2026-09-20T10:00:00Z" });
    expect(
      claimsForReview([other], {
        itemLeadIds: new Set(),
        otherReviewLeadIds: new Set(["lastMonth"]),
        ...window,
      })
    ).toEqual([]);
  });
});

describe("tagging the replacement lead", () => {
  it("only a swap tags a lead, never a credit or an open report", () => {
    const map = replacementLeadIds([
      claim({ id: "a", replacement_lead_id: "R1" }),
      claim({ id: "b", resolution: "credit", replacement_lead_id: null }),
      claim({ id: "c", status: "under_review", resolution: "none", replacement_lead_id: "R3" }),
    ]);
    expect(Array.from(map.keys())).toEqual(["R1"]);
  });
});

describe("what the review must never show", () => {
  const code = (p: string) =>
    readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  it("a Stayful-pipeline withdrawal (§64): swapped without notice, by decision", () => {
    expect(code("src/lib/batchReview/review.ts")).not.toContain("owed_lead_replacements");
    expect(code("src/lib/batchReview/review.ts")).not.toContain("replacement_depth");
  });
  it("the replacement count, which only Replace a lead states (§53.1)", () => {
    for (const f of ["src/lib/batchReview/review.ts", "src/components/batchReview/BatchReviewView.tsx"]) {
      expect(code(f)).not.toContain("replacement_balance");
      expect(code(f)).not.toMatch(/allowance|quota|budget|remaining/i);
    }
  });
});
