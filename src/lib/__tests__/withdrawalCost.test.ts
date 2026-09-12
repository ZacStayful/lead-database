import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { withdrawalBasisOf } from "@/lib/serviceHealth";

/**
 * 0145 / §53.11 — what a swap destroys on the other side.
 *
 * The behaviour lives in SQL and is asserted there
 * (`supabase/tests/0145_withdrawal_cost_test.sql`). What is pinned here is the
 * pair of decisions that only exist in TypeScript: which way the basis fails,
 * and that the panel presents the figure as ALREADY COUNTED rather than as a
 * further deduction from the ceiling.
 */

const ROOT = join(__dirname, "..", "..", "..");

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

/**
 * ⚠️ Comments are stripped before matching. Every file below EXPLAINS the rule
 * it obeys, and an explanation naming the forbidden shape fails a naive scan —
 * which trains the next person to delete the explanation. §51.11 records
 * exactly that, and adds the other half: prettier wraps this prose at 80
 * columns, so a phrase is routinely split across a newline and an indent.
 * Whitespace is collapsed for the same reason.
 */
function code(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ")
    .replace(/\s+/g, " ");
}

function sql(path: string): string {
  return read(path)
    .replace(/^\s*--.*$/gm, " ")
    .replace(/\s+/g, " ");
}

describe("withdrawalBasisOf", () => {
  it("reads a real observation as one", () => {
    expect(withdrawalBasisOf("observed")).toBe("observed");
  });

  // ⚠️ The direction is the guard. A missing column means we are not
  // measuring, and §18.2's rule is that an estimate is never read as a count —
  // so anything that is not literally the observed marker is an estimate.
  it.each<[string, unknown]>([
    ["the estimated marker itself", "estimated"],
    ["a value nobody has seen", "a value nobody has seen"],
    ["null", null],
    ["a missing column", undefined],
    ["the wrong case", "Observed"],
    ["a number", 0],
    ["a boolean", true],
  ])("falls back to estimated for %s", (_label, value) => {
    expect(withdrawalBasisOf(value)).toBe("estimated");
  });
});

describe("the figure is reported, never charged twice", () => {
  const migration = sql("supabase/migrations/0145_withdrawal_cost.sql");

  // ⚠️ slots_per_month is a sum of caps over a trailing window and the swap's
  // clamp lowers it the instant a swap runs, so the cost is ALREADY inside the
  // serviceable total. The SQL suite proves this behaviourally; this pins the
  // two expressions it could be smuggled into.
  it("serviceable supply is still exactly its two documented parts", () => {
    expect(migration).toContain("round(s.slots_pm + s.recycled_pm, 1),");
  });

  it("and the withdrawal never appears in the swap-inflated divisor", () => {
    const divisor = migration.match(/avg_alloc_with_swaps[^,]*/g) ?? [];
    expect(divisor.length).toBeGreaterThan(0);
    for (const expr of divisor) {
      expect(expr).not.toContain("withdraw");
      expect(expr).not.toContain("slots_lost");
    }
  });
});

describe("the admin panel", () => {
  const panel = code("src/components/admin/ServiceHealthPanel.tsx");

  it("states the observed figure as already counted in the supply above", () => {
    expect(panel).toContain("already counted in the supply above");
  });

  // §18.2 again, one layer up: an estimate shown in the same words as an
  // observation is an estimate being read as a count.
  it("and words an estimate differently from an observation", () => {
    expect(panel).toContain('c.withdrawalBasis === "observed"');
    expect(panel).toContain("Nothing has been withdrawn yet");
  });
});
