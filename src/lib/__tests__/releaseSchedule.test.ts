import { describe, expect, it } from "vitest";
import type { Customer } from "@/lib/types";
import {
  DEFAULT_RELEASE_SETTINGS,
  addDays,
  isWorkingDay,
  londonDate,
  releaseSchedule,
  releaseSettingsFrom,
  workingDaysBetween,
  type ReleaseSettings,
} from "../pacing";

const ON: ReleaseSettings = { enabled: true, maxPerDay: 2, cycleDays: 30 };

/** A management customer on a 20-lead plan, anchored on Monday 7 Sep 2026. */
function customer(over: Partial<Customer> = {}): Customer {
  return {
    id: "c1",
    created_at: "2026-06-01T09:00:00Z",
    monthly_allocation: 20,
    lead_balance: 20,
    leads_received_this_month: 0,
    billing_cycle_anchor: "2026-09-07",
    gr_monthly_allocation: 10,
    gr_lead_balance: 0,
    gr_leads_received_this_month: 0,
    gr_billing_cycle_anchor: null,
    release_mode: "daily",
    release_hold_until: null,
    gr_release_hold_until: null,
    ...over,
  } as unknown as Customer;
}

/** Noon UTC on a London date — unambiguous in both GMT and BST. */
function at(ymd: string): Date {
  return new Date(`${ymd}T12:00:00Z`);
}

describe("working-day arithmetic mirrors the SQL", () => {
  it("counts Mon–Fri inclusive and ignores weekends", () => {
    expect(workingDaysBetween("2026-09-07", "2026-09-11")).toBe(5);
    expect(workingDaysBetween("2026-09-07", "2026-09-13")).toBe(5);
    expect(workingDaysBetween("2026-09-12", "2026-09-13")).toBe(0);
    expect(workingDaysBetween("2026-09-07", "2026-10-06")).toBe(22);
  });
  it("is 0 when reversed or missing", () => {
    expect(workingDaysBetween("2026-09-11", "2026-09-07")).toBe(0);
    expect(workingDaysBetween(null, "2026-09-07")).toBe(0);
  });
  it("addDays and isWorkingDay", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(isWorkingDay("2026-09-12")).toBe(false); // Saturday
    expect(isWorkingDay("2026-09-14")).toBe(true); // Monday
  });
});

describe("londonDate", () => {
  it("is the London date, not the UTC one, across the BST boundary", () => {
    // 23:30 UTC on a Friday in September is 00:30 Saturday in London.
    expect(londonDate(new Date("2026-09-11T23:30:00Z"))).toBe("2026-09-12");
    // The same clock time in January is still Friday.
    expect(londonDate(new Date("2026-01-09T23:30:00Z"))).toBe("2026-01-09");
  });
});

describe("releaseSchedule — one lead a working day", () => {
  it("a 20-lead plan gets one on working day 1 and is then done for the day", () => {
    const s = releaseSchedule(customer(), "management", 0, ON, at("2026-09-07"));
    expect(s.enabled).toBe(true);
    expect(s.workingDaysElapsed).toBe(1);
    expect(s.workingDaysInCycle).toBe(22);
    expect(s.entitlement).toBe(20);
    expect(s.allowance).toBe(1);
    expect(s.dueToday).toBe(true);
    expect(s.nextReleaseDate).toBe("2026-09-07");

    const after = releaseSchedule(
      customer({ leads_received_this_month: 1, lead_balance: 19 }),
      "management",
      1,
      ON,
      at("2026-09-07")
    );
    expect(after.dueToday).toBe(false);
    expect(after.nextReleaseDate).toBe("2026-09-08");
  });

  it("spreads 20 over 22 working days: day 22 owes all 20", () => {
    const s = releaseSchedule(
      customer({ leads_received_this_month: 19, lead_balance: 1 }),
      "management",
      0,
      ON,
      at("2026-10-06") // working day 22
    );
    expect(s.workingDaysElapsed).toBe(22);
    expect(s.allowance).toBe(20);
    expect(s.dueToday).toBe(true);
  });

  it("a 10-lead plan gets one every other working day", () => {
    const ten = (received: number, day: string, today = 0) =>
      releaseSchedule(
        customer({
          monthly_allocation: 10,
          lead_balance: 10 - received,
          leads_received_this_month: received,
        }),
        "management",
        today,
        ON,
        at(day)
      );
    expect(ten(0, "2026-09-07").dueToday).toBe(true); // day 1: ceil(10/22) = 1
    expect(ten(1, "2026-09-08").dueToday).toBe(false); // day 2: still 1
    expect(ten(1, "2026-09-08").nextReleaseDate).toBe("2026-09-09");
    expect(ten(1, "2026-09-09").dueToday).toBe(true); // day 3: ceil(30/22) = 2
  });

  it("a Saturday renewal owes nothing until Monday", () => {
    const sat = customer({ billing_cycle_anchor: "2026-09-12" });
    const s = releaseSchedule(sat, "management", 0, ON, at("2026-09-12"));
    expect(s.workingDaysElapsed).toBe(0);
    expect(s.allowance).toBe(0);
    expect(s.dueToday).toBe(false);
    expect(s.nextReleaseDate).toBe("2026-09-14");
  });

  it("nextReleaseDate skips the weekend", () => {
    // Friday, day 5, has had its 5th lead (ceil(5*20/22) = 5).
    const s = releaseSchedule(
      customer({ leads_received_this_month: 5, lead_balance: 15 }),
      "management",
      1,
      ON,
      at("2026-09-11")
    );
    expect(s.dueToday).toBe(false);
    expect(s.nextReleaseDate).toBe("2026-09-14");
  });

  it("the daily cap bounds catch-up", () => {
    // Day 6 with 1 received: the curve owes ceil(6*20/22) = 6, but two have
    // already landed today.
    const behind = customer({ leads_received_this_month: 3, lead_balance: 17 });
    expect(releaseSchedule(behind, "management", 2, ON, at("2026-09-14")).dueToday).toBe(false);
    expect(releaseSchedule(behind, "management", 1, ON, at("2026-09-14")).dueToday).toBe(true);
    expect(
      releaseSchedule(behind, "management", 2, { ...ON, maxPerDay: 5 }, at("2026-09-14")).dueToday
    ).toBe(true);
  });

  it("the curve is on the entitlement, so a top-up raises it", () => {
    // Day 2 of a 10-lead plan with 1 received: E=10 → allowance 1, refused.
    const base = customer({
      monthly_allocation: 10,
      leads_received_this_month: 1,
      lead_balance: 9,
    });
    expect(releaseSchedule(base, "management", 0, ON, at("2026-09-08")).dueToday).toBe(false);
    // +5 top-up: E=15 → ceil(2*15/22) = 2, allowed.
    const topped = customer({ ...base, lead_balance: 14 });
    const s = releaseSchedule(topped, "management", 0, ON, at("2026-09-08"));
    expect(s.entitlement).toBe(15);
    expect(s.dueToday).toBe(true);
  });

  it("exhausted when everything this cycle owes has landed", () => {
    const s = releaseSchedule(
      customer({ leads_received_this_month: 20, lead_balance: 0 }),
      "management",
      0,
      ON,
      at("2026-09-30")
    );
    expect(s.exhausted).toBe(true);
    expect(s.dueToday).toBe(false);
    expect(s.nextReleaseDate).toBeNull();
  });

  it("a hold refuses until the date it names, and next lead is on that date", () => {
    const held = customer({ release_hold_until: "2026-09-16" });
    const s = releaseSchedule(held, "management", 0, ON, at("2026-09-14"));
    expect(s.onHoldUntil).toBe("2026-09-16");
    expect(s.dueToday).toBe(false);
    expect(s.nextReleaseDate).toBe("2026-09-16");
    // The day it names is the day leads resume.
    expect(releaseSchedule(held, "management", 0, ON, at("2026-09-16")).dueToday).toBe(true);
  });

  it("a management hold does not touch GR (invariant 6)", () => {
    const grOnly = customer({
      release_hold_until: "2026-12-01",
      gr_lead_balance: 10,
      gr_billing_cycle_anchor: "2026-09-07",
    });
    const s = releaseSchedule(grOnly, "guaranteed_rent", 0, ON, at("2026-09-07"));
    expect(s.onHoldUntil).toBeNull();
    expect(s.dueToday).toBe(true);
    expect(s.entitlement).toBe(10);
  });

  it("immediate mode is exempt and simply due while credit remains", () => {
    const s = releaseSchedule(
      customer({ release_mode: "immediate", leads_received_this_month: 20, lead_balance: 5 }),
      "management",
      3,
      ON,
      at("2026-09-07")
    );
    expect(s.mode).toBe("immediate");
    expect(s.dueToday).toBe(true);
    expect(s.nextReleaseDate).toBe("2026-09-07");
  });

  it("with the switch off nothing is a schedule", () => {
    const s = releaseSchedule(customer(), "management", 0, DEFAULT_RELEASE_SETTINGS, at("2026-09-07"));
    expect(s.enabled).toBe(false);
    expect(s.nextReleaseDate).toBeNull();
    expect(s.dueToday).toBe(true); // credit remains; today's behaviour
  });

  it("falls back to created_at when there is no anchor", () => {
    const s = releaseSchedule(
      customer({ billing_cycle_anchor: null, created_at: "2026-09-07T15:00:00Z" }),
      "management",
      0,
      ON,
      at("2026-09-07")
    );
    expect(s.workingDaysElapsed).toBe(1);
  });
});

describe("releaseSettingsFrom", () => {
  it("reads the three keys and fails towards the defaults", () => {
    expect(releaseSettingsFrom(null)).toEqual(DEFAULT_RELEASE_SETTINGS);
    expect(
      releaseSettingsFrom([
        { key: "release_enabled", value: "true" },
        { key: "release_max_per_day", value: "3" },
        { key: "release_cycle_days", value: "junk" },
      ])
    ).toEqual({ enabled: true, maxPerDay: 3, cycleDays: 30 });
    // Only the literal "true" enables, and a zero cap is refused.
    expect(releaseSettingsFrom([{ key: "release_enabled", value: "1" }]).enabled).toBe(false);
    expect(releaseSettingsFrom([{ key: "release_max_per_day", value: "0" }]).maxPerDay).toBe(2);
  });
});
