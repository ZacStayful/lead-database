/**
 * Cadence, including the two Sundays a year the naive version gets wrong.
 *
 * Adding `days * 86_400_000` is right for 51 weeks and wrong across a DST
 * transition, where it shifts the whole remaining ladder by an hour. A five-step
 * sequence that starts as a 9am message would end as an 8am one — and 8am is
 * outside sending hours, so quiet hours would silently defer the last step
 * rather than send it when it was meant to go.
 *
 * These are the boundary dates for Europe/London: 29 March 2026 (BST begins) and
 * 25 October 2026 (BST ends).
 */
import { describe, it, expect } from "vitest";
import {
  addCalendarDaysLondon,
  dueAtForStep,
  nextStepNumber,
  daysToClear,
} from "../cadence";

/** The London wall clock, as a comparable string. */
function london(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
}

describe("addCalendarDaysLondon", () => {
  it("returns the same instant for zero days", () => {
    const at = new Date("2026-09-02T09:00:00Z");
    expect(addCalendarDaysLondon(at, 0).getTime()).toBe(at.getTime());
  });

  it("adds plain days inside one offset", () => {
    // 10:00 BST on 2 September.
    const at = new Date("2026-09-02T09:00:00Z");
    expect(london(addCalendarDaysLondon(at, 3))).toBe("05/09/2026, 10:00");
  });

  it("KEEPS THE WALL CLOCK across the spring transition", () => {
    // 09:00 GMT on Friday 27 March 2026. BST begins on Sunday the 29th.
    const at = new Date("2026-03-27T09:00:00Z");
    const due = addCalendarDaysLondon(at, 3);
    expect(london(due)).toBe("30/03/2026, 09:00");
    // Naive arithmetic would have landed on 10:00, an hour late every step.
    expect(due.getTime()).not.toBe(at.getTime() + 3 * 86_400_000);
    expect(due.getTime()).toBe(at.getTime() + 3 * 86_400_000 - 3_600_000);
  });

  it("KEEPS THE WALL CLOCK across the autumn transition", () => {
    // 09:00 BST on Friday 23 October 2026. BST ends on Sunday the 25th.
    const at = new Date("2026-10-23T08:00:00Z");
    const due = addCalendarDaysLondon(at, 3);
    expect(london(due)).toBe("26/10/2026, 09:00");
    expect(due.getTime()).toBe(at.getTime() + 3 * 86_400_000 + 3_600_000);
  });

  it("rolls over a month end without a month-length table", () => {
    const at = new Date("2026-01-31T09:00:00Z");
    expect(london(addCalendarDaysLondon(at, 1))).toBe("01/02/2026, 09:00");
  });

  it("rolls over a leap day", () => {
    const at = new Date("2028-02-28T09:00:00Z");
    expect(london(addCalendarDaysLondon(at, 1))).toBe("29/02/2028, 09:00");
  });

  it("rolls over a year end", () => {
    const at = new Date("2026-12-30T09:00:00Z");
    expect(london(addCalendarDaysLondon(at, 3))).toBe("02/01/2027, 09:00");
  });

  it("survives a 365-day step, the schema's ceiling", () => {
    const at = new Date("2026-09-02T09:00:00Z");
    expect(london(addCalendarDaysLondon(at, 365))).toBe("02/09/2027, 10:00");
  });
});

describe("dueAtForStep", () => {
  const steps = [
    { step_number: 1, delay_days: 0 },
    { step_number: 2, delay_days: 3 },
    { step_number: 3, delay_days: 5 },
  ];

  it("makes step 1 with no delay due immediately — the 'on assignment' case", () => {
    const at = new Date("2026-09-02T09:00:00Z");
    expect(dueAtForStep(at, steps, 1)!.getTime()).toBe(at.getTime());
  });

  it("measures from what it is given, which is the previous SEND", () => {
    // Step 2 held overnight and sent at 09:00 rather than its scheduled 20:30
    // pushes step 3 along with it, instead of firing hours later.
    const sentAt = new Date("2026-09-05T08:00:00Z");
    expect(london(dueAtForStep(sentAt, steps, 3)!)).toBe("10/09/2026, 09:00");
  });

  it("returns null for a step that is not in the ladder", () => {
    expect(dueAtForStep(new Date(), steps, 9)).toBeNull();
  });
});

describe("nextStepNumber", () => {
  const steps = [
    { step_number: 1, delay_days: 0 },
    { step_number: 2, delay_days: 3 },
    { step_number: 4, delay_days: 5 },
  ];

  it("starts at the lowest step", () => {
    expect(nextStepNumber(steps, 0)).toBe(1);
  });

  it("skips a gap left by a deleted step rather than stalling", () => {
    expect(nextStepNumber(steps, 2)).toBe(4);
  });

  it("returns null when the ladder is finished", () => {
    expect(nextStepNumber(steps, 4)).toBeNull();
  });

  it("returns null for an empty ladder", () => {
    expect(nextStepNumber([], 0)).toBeNull();
  });
});

describe("daysToClear — what the enrolment confirmation must say", () => {
  it("is fifteen days for two hundred leads on three steps at the default cap", () => {
    expect(daysToClear(200, 3, 40)).toBe(15);
  });

  it("is one day for a backlog that fits inside the cap", () => {
    expect(daysToClear(10, 2, 40)).toBe(1);
  });

  it("is zero for nothing to send", () => {
    expect(daysToClear(0, 3, 40)).toBe(0);
    expect(daysToClear(5, 0, 40)).toBe(0);
  });

  it("falls back to the default cap rather than dividing by zero", () => {
    expect(daysToClear(40, 1, 0)).toBe(1);
  });
});
