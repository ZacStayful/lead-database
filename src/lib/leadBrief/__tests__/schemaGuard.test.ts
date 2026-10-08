import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GROSS_THRESHOLDS } from "@/lib/filterPrediction";
import { MILES_TO_KM } from "@/components/filtering/format";
import { KM_PER_MILE, OUTCODE_PATTERN_SOURCE } from "@/lib/leadBrief/geo";
import {
  BRIEF_PLANS,
  PLAN_MAX_MILES,
  TRAVEL_LIMIT_OPTIONS,
  operatingModeFor,
} from "@/lib/leadBrief/plans";
import { MATCH_LABELS, PRIORITY_KEYS } from "@/lib/leadBrief/types";

/**
 * The engine's constants are also written into the database (0161, 0162). If
 * the two disagree, the engine computes a brief the database refuses to store
 * — or, worse for the outcode, the engine and routing put one lead in two
 * different outcodes. These read the real migration files (§42.8: anchor a
 * guard on the real file, never a restatement of it).
 */
const root = join(__dirname, "..", "..", "..", "..");
const m0161 = readFileSync(join(root, "supabase/migrations/0161_lead_outcode.sql"), "utf8");
const m0162 = readFileSync(join(root, "supabase/migrations/0162_lead_brief_schema.sql"), "utf8");

describe("0161 — the outcode pattern", () => {
  it("is the same pattern the generated column uses, character for character", () => {
    expect(m0161).toContain(`'${OUTCODE_PATTERN_SOURCE}'`);
  });

  it("and the outcode check in 0162 accepts exactly what it extracts", () => {
    const outward = OUTCODE_PATTERN_SOURCE.match(/^\^\((.*?)\)/)![1];
    expect(m0162).toContain(`'^${outward}$'`);
  });
});

describe("0162 — the plan caps (A3)", () => {
  it("are 40 and 75 miles in both places", () => {
    expect(PLAN_MAX_MILES).toEqual({ 10: 40, 20: 75 });
    expect(m0162).toContain(
      `case when allocation <= 10 then ${PLAN_MAX_MILES[10]} else ${PLAN_MAX_MILES[20]} end`
    );
  });

  it("cover exactly the two plans", () => {
    expect([...BRIEF_PLANS]).toEqual([10, 20]);
  });
});

describe("0162 — travel limit and mode (A8)", () => {
  it("offers 10, 25 and 50 miles", () => {
    expect([...TRAVEL_LIMIT_OPTIONS]).toEqual([10, 25, 50]);
  });

  it("derives the mode the CHECK expects for every option", () => {
    expect(operatingModeFor(10)).toBe("local");
    expect(m0162).toContain("when 'local'    then coalesce(travel_limit_miles = 10, false)");
    expect(operatingModeFor(25)).toBe("growing");
    expect(operatingModeFor(50)).toBe("growing");
    expect(m0162).toContain("when 'growing'  then coalesce(travel_limit_miles in (25, 50), false)");
    expect(operatingModeFor(null)).toBe("anywhere");
    expect(m0162).toContain("when 'anywhere' then travel_limit_miles is null");
  });
});

describe("0162 — vocabularies", () => {
  it("min_gross is the GROSS_THRESHOLDS list", () => {
    expect(m0162).toContain(`check (min_gross in (${GROSS_THRESHOLDS.join(", ")}))`);
  });

  it("priority keys match the priorities validator", () => {
    expect(m0162).toContain(
      `not in (${PRIORITY_KEYS.map((k) => `'${k}'`).join(", ")}) then true`
    );
  });

  it("match labels match the assignment CHECK and the mix validator", () => {
    const list = MATCH_LABELS.map((l) => `'${l}'`).join(", ");
    expect(m0162).toContain(`or match_label in (${list})`);
    expect(m0162).toContain(`when m.k not in (${list}) then true`);
  });
});

describe("geometry units", () => {
  it("uses the filter page's mile", () => {
    expect(KM_PER_MILE).toBe(MILES_TO_KM);
  });
});
