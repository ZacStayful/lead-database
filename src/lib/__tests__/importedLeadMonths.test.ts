import { describe, it, expect } from "vitest";
import {
  formatAdminDate,
  londonMonthRange,
  londonMonthStartIso,
  londonOffsetMs,
  monthLabel,
  nextMonth,
} from "../importedLeadMonths";

/**
 * These have to agree with the SQL in 0106 exactly. The counts are cut in
 * Europe/London; if the window the page fetches is cut in UTC instead, the
 * month you click and the rows you get differ by an hour's worth of leads at
 * each end — and the totals disagree with the list beside them.
 */

describe("londonOffsetMs", () => {
  it("is zero in winter and an hour in summer", () => {
    expect(londonOffsetMs(new Date("2026-01-15T12:00:00Z"))).toBe(0);
    expect(londonOffsetMs(new Date("2026-07-15T12:00:00Z"))).toBe(3_600_000);
  });

  it("knows both transitions", () => {
    // BST began 29 March 2026 and ends 25 October 2026.
    expect(londonOffsetMs(new Date("2026-03-28T12:00:00Z"))).toBe(0);
    expect(londonOffsetMs(new Date("2026-03-30T12:00:00Z"))).toBe(3_600_000);
    expect(londonOffsetMs(new Date("2026-10-24T12:00:00Z"))).toBe(3_600_000);
    expect(londonOffsetMs(new Date("2026-10-26T12:00:00Z"))).toBe(0);
  });
});

describe("londonMonthStartIso", () => {
  it("gives plain midnight for a winter month", () => {
    expect(londonMonthStartIso("2026-01-01")).toBe("2026-01-01T00:00:00.000Z");
  });

  it("gives 23:00 the previous day for a summer month", () => {
    // Midnight BST on 1 August is 23:00 UTC on 31 July. This is the whole
    // reason the helper exists.
    expect(londonMonthStartIso("2026-08-01")).toBe("2026-07-31T23:00:00.000Z");
  });

  it("handles the months the clocks change in", () => {
    // March starts in GMT even though the month ends in BST.
    expect(londonMonthStartIso("2026-03-01")).toBe("2026-03-01T00:00:00.000Z");
    // October starts in BST even though the month ends in GMT.
    expect(londonMonthStartIso("2026-10-01")).toBe("2026-09-30T23:00:00.000Z");
  });
});

describe("nextMonth", () => {
  it("rolls the year over", () => {
    expect(nextMonth("2026-12-01")).toBe("2027-01-01");
    expect(nextMonth("2026-08-01")).toBe("2026-09-01");
    expect(nextMonth("2026-01-01")).toBe("2026-02-01");
  });
});

describe("londonMonthRange", () => {
  it("is half-open, so a lead belongs to exactly one month", () => {
    const aug = londonMonthRange("2026-08-01");
    const sep = londonMonthRange("2026-09-01");
    // August ends exactly where September begins — no gap, no overlap.
    expect(aug.endIso).toBe(sep.startIso);
  });

  it("puts a lead added just after midnight BST in the right month", () => {
    // 23:30 UTC on 31 July is 00:30 BST on 1 August. The SQL counts it in
    // August; the window must fetch it in August too.
    const added = new Date("2026-07-31T23:30:00Z");
    const aug = londonMonthRange("2026-08-01");
    const jul = londonMonthRange("2026-07-01");

    expect(added >= new Date(aug.startIso) && added < new Date(aug.endIso)).toBe(true);
    expect(added >= new Date(jul.startIso) && added < new Date(jul.endIso)).toBe(false);
  });

  it("covers a whole month across a clock change without gaps", () => {
    // October 2026 contains the end of BST. Every hour of it must fall inside
    // the window exactly once.
    const { startIso, endIso } = londonMonthRange("2026-10-01");
    const start = new Date(startIso).getTime();
    const end = new Date(endIso).getTime();
    const hours = (end - start) / 3_600_000;
    // 31 days, plus the repeated hour when the clocks go back.
    expect(hours).toBe(31 * 24 + 1);
  });

  it("covers a spring month one hour short, for the same reason", () => {
    const { startIso, endIso } = londonMonthRange("2026-03-01");
    const hours =
      (new Date(endIso).getTime() - new Date(startIso).getTime()) / 3_600_000;
    expect(hours).toBe(31 * 24 - 1);
  });
});

describe("labels", () => {
  it("names the month the counts were cut in", () => {
    expect(monthLabel("2026-08-01")).toBe("August 2026");
    expect(monthLabel("2026-01-01")).toBe("January 2026");
  });

  it("prints a date the way the rest of admin does", () => {
    expect(formatAdminDate("2026-08-25T10:15:51Z")).toBe("25 Aug 2026");
    // And in local time, so a late-evening import does not read as the next day.
    expect(formatAdminDate("2026-07-31T23:30:00Z")).toBe("1 Aug 2026");
  });
});
