import { describe, expect, it } from "vitest";
import type { ReleaseSchedule } from "@/lib/pacing";
import { summariseDay } from "@/lib/contact/followUpSummary";
import { buildTodayLines, dayLabel, nextLeadLine, workingDayStreak } from "../todaySummary";

function schedule(over: Partial<ReleaseSchedule> = {}): ReleaseSchedule {
  return {
    enabled: true,
    mode: "daily",
    workingDaysElapsed: 3,
    workingDaysInCycle: 22,
    entitlement: 20,
    allowance: 3,
    received: 3,
    receivedToday: 1,
    dueToday: false,
    exhausted: false,
    onHoldUntil: null,
    nextReleaseDate: "2026-09-10",
    ...over,
  };
}

describe("nextLeadLine", () => {
  const today = "2026-09-09"; // Wednesday
  it("says nothing when the rule is off or the customer is exempt", () => {
    expect(nextLeadLine(schedule({ enabled: false }), today)).toBeNull();
    expect(nextLeadLine(schedule({ mode: "immediate" }), today)).toBeNull();
  });
  it("tomorrow, a later date, today, in, hold, exhausted", () => {
    expect(nextLeadLine(schedule(), today)).toBe("Your next lead is due tomorrow (Thu 10 Sep).");
    expect(nextLeadLine(schedule({ nextReleaseDate: "2026-09-14" }), today)).toBe(
      "Your next lead is due on Mon 14 Sep."
    );
    expect(nextLeadLine(schedule({ dueToday: true, receivedToday: 0 }), today)).toBe(
      "Your next lead is due today."
    );
    expect(nextLeadLine(schedule({ dueToday: true, receivedToday: 1 }), today)).toMatch(/Today's lead is in/);
    expect(nextLeadLine(schedule({ onHoldUntil: "2026-09-16" }), today)).toContain("on hold until Wed 16 Sep");
    expect(nextLeadLine(schedule({ exhausted: true }), today)).toContain("next batch starts at your renewal");
  });
  it("never names the daily cap or the allowance", () => {
    for (const s of [schedule(), schedule({ dueToday: true }), schedule({ exhausted: true })]) {
      const line = nextLeadLine(s, today) ?? "";
      expect(line).not.toMatch(/cap|allowance|quota|limit/i);
    }
  });
});

describe("dayLabel", () => {
  it("is the date named, whatever zone the server runs in", () => {
    expect(dayLabel("2026-09-14")).toBe("Mon 14 Sep");
    expect(dayLabel("2026-01-02")).toBe("Fri 2 Jan");
  });
});

describe("workingDayStreak", () => {
  it("counts consecutive working days and skips weekends", () => {
    // Mon 7 .. Fri 11 active, Mon 14 is today and active.
    const days = ["2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-14"];
    expect(workingDayStreak(days, "2026-09-14")).toBe(6);
  });
  it("a quiet today does not end the run", () => {
    expect(workingDayStreak(["2026-09-10", "2026-09-11"], "2026-09-14")).toBe(2);
  });
  it("a quiet working day breaks it", () => {
    expect(workingDayStreak(["2026-09-08", "2026-09-10", "2026-09-11"], "2026-09-11")).toBe(2);
  });
  it("is 0 with nothing recent", () => {
    expect(workingDayStreak([], "2026-09-11")).toBe(0);
    expect(workingDayStreak(["2026-09-01"], "2026-09-11")).toBe(0);
  });
  it("a Saturday run reads the week just gone", () => {
    expect(workingDayStreak(["2026-09-10", "2026-09-11"], "2026-09-12")).toBe(2);
  });
});

describe("buildTodayLines", () => {
  const base = {
    today: "2026-09-09",
    newLeadsToday: 0,
    schedules: [],
    dueFollowUps: summariseDay([]),
    dueTodayCallbacks: 0,
    overdueCallbacks: 0,
    unreadReplies: 0,
    poolLeads: 0,
    streakDays: 0,
  };
  it("is empty on a genuinely empty day", () => {
    expect(buildTodayLines(base)).toEqual([]);
  });
  it("names things, in the order the day goes", () => {
    const lines = buildTodayLines({
      ...base,
      newLeadsToday: 1,
      schedules: [{ label: null, schedule: schedule() }],
      dueFollowUps: summariseDay([
        { assignmentId: "a", leadId: "l", leadName: "X", channel: "call", stepNumber: 2, overdueDays: 0 },
      ]),
      dueTodayCallbacks: 1,
      unreadReplies: 2,
      poolLeads: 4,
      streakDays: 3,
    });
    expect(lines.map((l) => l.key)).toEqual([
      "new_leads",
      "next_lead",
      "followups",
      "callbacks",
      "replies",
      "pool",
      "streak",
    ]);
    expect(lines[0].text).toBe("1 new lead arrived today");
    expect(lines[2].text).toBe("1 follow-up due today — about 2 minutes");
    expect(lines[4].text).toBe("2 landlords have replied");
    expect(lines[5].href).toBe("/dashboard/leads/expired");
  });
  it("shows a streak only from two days", () => {
    expect(buildTodayLines({ ...base, streakDays: 1 })).toEqual([]);
    expect(buildTodayLines({ ...base, streakDays: 2 })[0].key).toBe("streak");
  });
  it("labels the product when the customer holds both", () => {
    const lines = buildTodayLines({
      ...base,
      schedules: [
        { label: "Management", schedule: schedule() },
        { label: "Guaranteed Rent", schedule: schedule({ nextReleaseDate: "2026-09-14" }) },
      ],
    });
    expect(lines[0].text).toMatch(/^Management: Your next lead/);
    expect(lines[1].text).toMatch(/^Guaranteed Rent: Your next lead/);
  });
});
