import { describe, expect, it } from "vitest";
import { activityWhen, londonDayHeading, londonHHMM, londonYmd, shortWhen } from "../londonTime";

describe("londonTime", () => {
  const now = new Date("2026-09-14T12:00:00Z"); // BST: 13:00 London
  it("formats in London, not UTC", () => {
    expect(londonHHMM("2026-09-14T07:32:00Z")).toBe("08:32");
    expect(londonHHMM("2026-12-14T07:32:00Z")).toBe("07:32");
    expect(londonYmd("2026-09-13T23:30:00Z")).toBe("2026-09-14");
  });
  it("short labels: time today, weekday this week, date beyond", () => {
    expect(shortWhen("2026-09-14T07:32:00Z", now)).toBe("08:32");
    expect(shortWhen("2026-09-12T10:00:00Z", now)).toBe("Sat");
    expect(shortWhen("2026-09-01T10:00:00Z", now)).toBe("1 Sep");
    expect(shortWhen("2025-09-01T10:00:00Z", now)).toBe("1 Sep 2025");
  });
  it("day headings and activity stamps", () => {
    expect(londonDayHeading("2026-09-14T07:32:00Z", now)).toBe("Today");
    expect(londonDayHeading("2026-09-13T07:32:00Z", now)).toBe("Yesterday");
    expect(londonDayHeading("2026-09-10T07:32:00Z", now)).toBe("Thu 10 Sep");
    expect(activityWhen("2026-09-14T07:32:00Z", now)).toBe("Today 08:32");
    expect(activityWhen("2026-09-11T13:20:00Z", now)).toBe("11 Sep 14:20");
  });
});
