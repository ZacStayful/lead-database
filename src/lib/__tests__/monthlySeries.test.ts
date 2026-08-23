import { describe, expect, it } from "vitest";
import {
  COVERAGE_FLOOR,
  delta,
  deltaAvailable,
  isMonthCovered,
} from "@/lib/monthlySeries";
import { monthStartIso } from "@/lib/commercialCapture";

describe("monthStartIso", () => {
  it("returns the first of the month in UTC", () => {
    expect(monthStartIso(new Date("2026-08-23T17:00:00Z"))).toBe("2026-08-01");
    expect(monthStartIso(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01");
    expect(monthStartIso(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12-01");
  });

  it("zero-pads single-digit months", () => {
    expect(monthStartIso(new Date("2026-03-15T00:00:00Z"))).toBe("2026-03-01");
  });

  it("uses UTC, not local time, so the cron cannot straddle a month boundary", () => {
    // 23:30 on the last day of a month in UTC is still that month. A local-time
    // implementation would land in the next month for anyone east of UTC and
    // silently split one month's capture across two rows.
    expect(monthStartIso(new Date("2026-07-31T23:30:00Z"))).toBe("2026-07-01");
  });
});

describe("isMonthCovered", () => {
  it("accepts a month at or above the coverage floor", () => {
    expect(isMonthCovered({ activityDaysCovered: 31, daysInMonth: 31 })).toBe(true);
    expect(isMonthCovered({ activityDaysCovered: 25, daysInMonth: 31 })).toBe(true);
  });

  it("rejects the real July case — telemetry started on the 27th", () => {
    // 5 covered days of 31. This is the month that would otherwise make August
    // look like a 3.4x improvement in opens when much of it is just telemetry
    // beginning.
    expect(isMonthCovered({ activityDaysCovered: 5, daysInMonth: 31 })).toBe(false);
  });

  it("is inclusive exactly at the floor", () => {
    const days = 30;
    const atFloor = Math.ceil(days * COVERAGE_FLOOR);
    expect(isMonthCovered({ activityDaysCovered: atFloor, daysInMonth: days })).toBe(true);
    expect(isMonthCovered({ activityDaysCovered: atFloor - 1, daysInMonth: days })).toBe(false);
  });

  it("returns false rather than dividing by zero", () => {
    expect(isMonthCovered({ activityDaysCovered: 0, daysInMonth: 0 })).toBe(false);
  });
});

describe("deltaAvailable", () => {
  it("needs two comparable months — one reading is not a trend", () => {
    expect(deltaAvailable(0)).toBe(false);
    expect(deltaAvailable(1)).toBe(false);
    expect(deltaAvailable(2)).toBe(true);
    expect(deltaAvailable(9)).toBe(true);
  });
});

describe("delta", () => {
  it("subtracts when both figures exist", () => {
    expect(delta(150, 100)).toBe(50);
    expect(delta(100, 150)).toBe(-50);
  });

  it("returns null rather than 0 when either side is missing", () => {
    // Null, never zero: a missing comparison rendered as "no change" is the
    // failure §10 named — it reads as a measurement when nothing was measured.
    expect(delta(150, null)).toBeNull();
    expect(delta(null, 100)).toBeNull();
    expect(delta(null, null)).toBeNull();
  });

  it("reports a genuine zero as zero, not as missing", () => {
    expect(delta(100, 100)).toBe(0);
  });
});
