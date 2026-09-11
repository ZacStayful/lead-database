import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FIT_REASONS,
  FIT_REASON_KEYS,
  OUTCOME_DETAIL_MAX,
  isFitReason,
  normaliseOutcomeDetail,
} from "@/lib/outcomeReasons";
import { CLOSE_REASONS } from "@/lib/closeReasons";
import { DEAD_LEAD_REASONS } from "@/lib/quality/deadLeadCopy";

/**
 * Every migration, concatenated in apply order.
 *
 * ⚠️ This used to read 0138 by name, and 0139 broke it the moment it widened
 * the report branch to six reasons: the test read the old file, found three,
 * and failed on a mismatch that did not exist. Reading only the NEWEST defining
 * migration is no better — it then misses the detail cap, which 0139 never
 * restates.
 *
 * So the chain is read as a whole and each clause is taken at its LAST
 * definition, which is what a rebuild from empty actually ends up with. Nothing
 * needs repointing when the vocabulary moves again.
 */
const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "..", "supabase", "migrations");

const migration = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(resolve(MIGRATIONS_DIR, f), "utf8"))
  .join("\n");

describe("the vocabulary and the CHECK are one list", () => {
  /**
   * The arrangement §29 uses for `cancelOptions.ts`: a reason the CHECK refuses
   * is a 400 on an outcome the customer expects to work, and nothing in the
   * type system connects a TypeScript literal to a SQL constraint. So it is
   * asserted mechanically instead.
   */
  function checkList(outcomeClause: string): string[] {
    // ⚠️ lastIndexOf, not indexOf. 0138 defines these and 0139 redefines them;
    // the first occurrence is the superseded one.
    const i = migration.lastIndexOf(outcomeClause);
    expect(i).toBeGreaterThan(-1);
    const open = migration.indexOf("(", migration.indexOf("reason in", i));
    const close = migration.indexOf(")", open);
    return migration
      .slice(open + 1, close)
      .split(",")
      .map((s) => s.trim().replace(/^'|'$/g, ""))
      .filter(Boolean)
      .sort();
  }

  it("reject and discard offer exactly what the CHECK admits", () => {
    expect(checkList("outcome in ('reject', 'discard')")).toEqual(
      [...FIT_REASON_KEYS].sort(),
    );
  });

  it("close offers exactly what the CHECK admits", () => {
    expect(checkList("outcome = 'close'")).toEqual(
      Object.keys(CLOSE_REASONS).sort(),
    );
  });

  it("the report offers exactly what the CHECK admits", () => {
    expect(checkList("outcome = 'report'")).toEqual(
      [...DEAD_LEAD_REASONS].sort(),
    );
  });

  it("caps detail at the same length the CHECK does", () => {
    expect(migration).toContain(
      `length(detail) between 1 and ${OUTCOME_DETAIL_MAX}`,
    );
  });
});

describe("⚠️ the two halves never overlap", () => {
  /**
   * Reject and discard describe the OPERATOR'S OWN FIT. Close and report
   * describe THE LANDLORD. A reject reason resembling "the landlord had already
   * gone" would be a no-refund path to the refundable sentence (§51), which
   * makes the data ambiguous exactly where it should be sharpest and teaches
   * operators that the same words pay differently by button.
   */
  it("shares no key between the fit list and the landlord lists", () => {
    const landlord = new Set<string>([
      ...Object.keys(CLOSE_REASONS),
      ...DEAD_LEAD_REASONS,
    ]);
    for (const key of FIT_REASON_KEYS) expect(landlord.has(key)).toBe(false);
  });

  it("never describes the landlord's own state in a fit reason", () => {
    for (const label of Object.values(FIT_REASONS)) {
      expect(label.toLowerCase()).not.toMatch(
        /landlord|already|appointed|gone|interested|no longer|unreachable/,
      );
    }
  });
});

describe("narrowing untrusted input", () => {
  it("accepts every listed reason and nothing else", () => {
    for (const key of FIT_REASON_KEYS) expect(isFitReason(key)).toBe(true);
    for (const bad of ["", "made_up", "not_interested", null, 7, {}])
      expect(isFitReason(bad)).toBe(false);
  });

  it("turns an absent or blank detail into null rather than an empty string", () => {
    // The CHECK refuses a zero-length detail, so a blank textarea must not be
    // sent as "" — that would fail an outcome the customer expects to work.
    for (const blank of [undefined, null, "", "   ", "\n", 12])
      expect(normaliseOutcomeDetail(blank)).toBeNull();
  });

  it("trims, and clamps to what the CHECK accepts", () => {
    expect(normaliseOutcomeDetail("  hello  ")).toBe("hello");
    expect(
      normaliseOutcomeDetail("x".repeat(OUTCOME_DETAIL_MAX + 50)),
    ).toHaveLength(OUTCOME_DETAIL_MAX);
  });
});
