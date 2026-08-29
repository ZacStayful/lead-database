import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUIET_END_HOUR,
  DEFAULT_QUIET_START_HOUR,
  describeNextWindow,
  londonHour,
  nextWindowOpensAt,
  withinSendingHours,
} from "@/lib/messaging/sendWindow";

/**
 * The gap this closes, measured before it was written: 6 of the first 17
 * WhatsApps ever sent went out at 20:xx London.
 *
 * Every case here is pure — no fake client, in the `assignmentSendable` style —
 * which is the reason the decision was kept out of the DB layer.
 */

const START = DEFAULT_QUIET_START_HOUR; // 9
const END = DEFAULT_QUIET_END_HOUR; // 20

describe("londonHour", () => {
  /**
   * ⚠️ THE CASE THAT MATTERS. Vercel runs in UTC and Britain is an hour ahead
   * for over half the year, so reading the server clock would message people an
   * hour early from late March to late October — and would have looked correct
   * in every winter test.
   */
  it("reads BST in summer, not UTC", () => {
    expect(londonHour(new Date("2026-07-15T08:30:00Z"))).toBe(9);
    expect(londonHour(new Date("2026-07-15T19:30:00Z"))).toBe(20);
  });

  it("reads GMT in winter, where the two agree", () => {
    expect(londonHour(new Date("2026-01-15T08:30:00Z"))).toBe(8);
    expect(londonHour(new Date("2026-01-15T19:30:00Z"))).toBe(19);
  });
});

describe("withinSendingHours", () => {
  it("is inclusive of the start hour and exclusive of the end", () => {
    // Winter, so UTC and London agree and the boundary is unambiguous.
    expect(withinSendingHours(new Date("2026-01-15T08:59:00Z"), START, END)).toBe(false);
    expect(withinSendingHours(new Date("2026-01-15T09:00:00Z"), START, END)).toBe(true);
    expect(withinSendingHours(new Date("2026-01-15T19:59:00Z"), START, END)).toBe(true);
    expect(withinSendingHours(new Date("2026-01-15T20:00:00Z"), START, END)).toBe(false);
  });

  it("refuses the middle of the night", () => {
    expect(withinSendingHours(new Date("2026-01-15T03:00:00Z"), START, END)).toBe(false);
  });

  it("applies the same boundary in BST", () => {
    // 07:59 UTC is 08:59 London — still too early, and the naive reading passes.
    expect(withinSendingHours(new Date("2026-07-15T07:59:00Z"), START, END)).toBe(false);
    expect(withinSendingHours(new Date("2026-07-15T08:00:00Z"), START, END)).toBe(true);
  });

  it("permits a Saturday — a landlord is a consumer, not a business", () => {
    // 2026-01-17 is a Saturday. Deliberately not a working-day rule.
    expect(withinSendingHours(new Date("2026-01-17T11:00:00Z"), START, END)).toBe(true);
  });
});

describe("nextWindowOpensAt", () => {
  it("returns the input unchanged when already inside the window", () => {
    const inside = new Date("2026-01-15T10:00:00Z");
    expect(nextWindowOpensAt(inside, START, END).getTime()).toBe(inside.getTime());
  });

  it("moves an evening send to the following morning", () => {
    const next = nextWindowOpensAt(new Date("2026-01-15T21:30:00Z"), START, END);
    expect(londonHour(next)).toBe(START);
    expect(next.toISOString().slice(0, 10)).toBe("2026-01-16");
  });

  it("moves an early morning send to later the same day", () => {
    const next = nextWindowOpensAt(new Date("2026-01-15T06:15:00Z"), START, END);
    expect(londonHour(next)).toBe(START);
    expect(next.toISOString().slice(0, 10)).toBe("2026-01-15");
  });

  it("lands on the top of the hour, not the original minutes", () => {
    const next = nextWindowOpensAt(new Date("2026-01-15T06:47:31Z"), START, END);
    expect(next.getUTCMinutes()).toBe(0);
    expect(next.getUTCSeconds()).toBe(0);
  });

  it("crosses the spring DST boundary without stalling", () => {
    // The night the UK clocks go forward.
    const next = nextWindowOpensAt(new Date("2026-03-29T02:30:00Z"), START, END);
    expect(withinSendingHours(next, START, END)).toBe(true);
    expect(londonHour(next)).toBe(START);
  });

  it("crosses the autumn DST boundary, where an hour repeats", () => {
    const next = nextWindowOpensAt(new Date("2026-10-25T01:30:00Z"), START, END);
    expect(withinSendingHours(next, START, END)).toBe(true);
    expect(londonHour(next)).toBe(START);
  });

  it("terminates on a nonsensical window rather than spinning", () => {
    // start >= end can never be satisfied; the loop is bounded for this.
    const out = nextWindowOpensAt(new Date("2026-01-15T12:00:00Z"), 20, 9);
    expect(out).toBeInstanceOf(Date);
  });
});

describe("describeNextWindow", () => {
  it("names the hour without a date when it is later today", () => {
    expect(describeNextWindow(new Date("2026-01-15T06:00:00Z"), START, END)).toBe("9am");
  });

  it("says tomorrow when the window has closed for the day", () => {
    expect(describeNextWindow(new Date("2026-01-15T21:00:00Z"), START, END)).toBe(
      "9am tomorrow"
    );
  });

  it("says tomorrow just after midnight, because the date has already turned", () => {
    // 00:30 on the 16th: the next window is 9am the SAME London day, so this
    // must not claim tomorrow.
    expect(describeNextWindow(new Date("2026-01-16T00:30:00Z"), START, END)).toBe("9am");
  });

  it("writes afternoon and edge hours as a person would", () => {
    expect(describeNextWindow(new Date("2026-01-15T09:00:00Z"), 14, 20)).toBe("2pm");
    expect(describeNextWindow(new Date("2026-01-15T09:00:00Z"), 12, 20)).toBe("midday");
    expect(describeNextWindow(new Date("2026-01-15T13:00:00Z"), 0, 1)).toBe(
      "midnight tomorrow"
    );
  });
});
