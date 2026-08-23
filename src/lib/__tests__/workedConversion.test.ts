import { describe, expect, it } from "vitest";
import {
  MATURITY_DAYS,
  WORKED_CONVERSION_FLOORS,
  isCohortMature,
  isThinSample,
  isWorkedPastCold,
  rate,
} from "@/lib/workedConversion";
import {
  GR_PIPELINE_STAGES,
  PIPELINE_STAGES,
} from "@/components/dashboard/pipelineStage";

/**
 * These assert the TypeScript half of a definition written twice (see the
 * header of workedConversion.ts and migration 0097). They CANNOT see the SQL,
 * so a drift between the two still ships silently — what they protect is this
 * side staying self-consistent and matching the semantics the migration
 * documents in words.
 */

const DAY = 86_400_000;

describe("isWorkedPastCold", () => {
  it("is false for cold, blank and absent stages", () => {
    for (const v of [null, undefined, "", "   ", "cold"]) {
      expect(isWorkedPastCold(v)).toBe(false);
    }
  });

  it("is true for every non-cold stage in both products", () => {
    const stages = [...PIPELINE_STAGES, ...GR_PIPELINE_STAGES]
      .map((s) => s.value)
      .filter((v) => v !== "cold");
    // Guards against the stage lists being emptied or renamed out from under us.
    expect(stages.length).toBeGreaterThan(5);
    for (const s of stages) expect(isWorkedPastCold(s)).toBe(true);
  });

  it("does not treat a stage merely containing 'cold' as cold", () => {
    expect(isWorkedPastCold("cold_call_booked")).toBe(true);
  });
});

describe("isCohortMature", () => {
  const now = new Date("2026-08-23T12:00:00.000Z");

  it("is open one day short of the window and mature exactly on it", () => {
    const at = (days: number) => new Date(now.getTime() - days * DAY);
    expect(isCohortMature(at(MATURITY_DAYS - 1), now)).toBe(false);
    // Inclusive at the boundary, matching 0097's `<=`. A strict comparison
    // would mature every cohort a day late.
    expect(isCohortMature(at(MATURITY_DAYS), now)).toBe(true);
    expect(isCohortMature(at(MATURITY_DAYS + 1), now)).toBe(true);
  });

  it("accepts an ISO string as well as a Date", () => {
    expect(isCohortMature("2026-07-01T00:00:00.000Z", now)).toBe(true);
    expect(isCohortMature("2026-08-20T00:00:00.000Z", now)).toBe(false);
  });

  it("is false for a missing or unparseable timestamp rather than throwing", () => {
    expect(isCohortMature(null, now)).toBe(false);
    expect(isCohortMature(undefined, now)).toBe(false);
    expect(isCohortMature("not a date", now)).toBe(false);
  });
});

describe("isThinSample", () => {
  const ok = { workedPastCold: 20, won: 3, operators: 3 };

  it("clears exactly at the floors", () => {
    expect(isThinSample(ok)).toBe(false);
  });

  it("trips on each floor independently", () => {
    expect(isThinSample({ ...ok, workedPastCold: 19 })).toBe(true);
    expect(isThinSample({ ...ok, won: 2 })).toBe(true);
    expect(isThinSample({ ...ok, operators: 2 })).toBe(true);
  });

  it("trips on an empty sample", () => {
    expect(isThinSample({ workedPastCold: 0, won: 0, operators: 0 })).toBe(true);
  });

  it("keeps the floors that 0097 encodes", () => {
    // Duplicated deliberately rather than read from the export: a test that
    // derives its expectation from the source under test passes whatever
    // changed. Same reasoning as serialize.test.ts's field list.
    expect(WORKED_CONVERSION_FLOORS).toEqual({
      minWorked: 20,
      minWins: 3,
      minOperators: 3,
    });
  });
});

describe("rate", () => {
  it("returns a one-decimal percentage", () => {
    expect(rate(5, 38)).toBe(13.2);
    expect(rate(5, 311)).toBe(1.6);
    expect(rate(4, 21)).toBe(19);
  });

  it("returns null on a zero denominator rather than NaN or Infinity", () => {
    expect(rate(0, 0)).toBeNull();
    expect(rate(3, 0)).toBeNull();
  });

  it("returns null for a negative denominator", () => {
    expect(rate(1, -5)).toBeNull();
  });

  it("returns null rather than 0 for non-finite input", () => {
    expect(rate(Number.NaN, 10)).toBeNull();
    expect(rate(1, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("never returns 0 as a stand-in for 'no data'", () => {
    // The distinction §10 relies on: a genuine zero is a real reading, an
    // absent one must stay absent.
    expect(rate(0, 10)).toBe(0);
    expect(rate(0, 0)).toBeNull();
  });
});
