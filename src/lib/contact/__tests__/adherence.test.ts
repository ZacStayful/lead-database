import { describe, expect, it } from "vitest";
import { noticeLines, shouldNotify, type AdherenceRow } from "@/lib/contact/adherence";
import { BOOKED_MEETING_RATE_PCT } from "@/lib/contact/contactStrategy";

const row = (over: Partial<AdherenceRow> = {}): AdherenceRow => ({
  customer_id: "c1",
  business_name: "Test Op",
  due: 20,
  done: 4,
  done_by_click: 4,
  done_manually: 0,
  skipped: 0,
  overdue: 16,
  oldest_overdue_days: 9,
  adherence_pct: 20,
  last_action_at: null,
  ...over,
});

describe("shouldNotify", () => {
  const limits = { noticePct: 50, noticeMinOverdue: 5 };

  it("fires when they are well behind with a real backlog", () => {
    expect(shouldNotify(row(), limits)).toBe(true);
  });

  it("⚠️ needs BOTH conditions — a new customer at 50% of two is not behind", () => {
    expect(shouldNotify(row({ adherence_pct: 50, overdue: 1 }), limits)).toBe(false);
    expect(shouldNotify(row({ adherence_pct: 20, overdue: 4 }), limits)).toBe(false);
  });

  it("does not fire at exactly the threshold percentage", () => {
    expect(shouldNotify(row({ adherence_pct: 50, overdue: 20 }), limits)).toBe(false);
  });

  it("fires at exactly the overdue floor, once below the percentage", () => {
    expect(shouldNotify(row({ adherence_pct: 49, overdue: 5 }), limits)).toBe(true);
  });

  it("never fires when nothing was due — no plan is not neglect", () => {
    expect(shouldNotify(row({ adherence_pct: null, overdue: 0 }), limits)).toBe(false);
  });

  it("never fires at full adherence", () => {
    expect(shouldNotify(row({ adherence_pct: 100, overdue: 0 }), limits)).toBe(false);
  });
});

describe("noticeLines", () => {
  it("leads with the facts and closes with the comparison", () => {
    const lines = noticeLines(row(), BOOKED_MEETING_RATE_PCT);
    expect(lines[0]).toContain("20 follow-ups due");
    expect(lines[0]).toContain("have made 4");
    expect(lines[lines.length - 1]).toContain("77%");
  });

  it("says nothing about arrears when there are none", () => {
    const lines = noticeLines(row({ overdue: 0 }), BOOKED_MEETING_RATE_PCT);
    expect(lines.join(" ")).not.toContain("past its date");
  });

  it("⚠️ never scolds, never ranks and never names another operator", () => {
    const copy = noticeLines(row(), BOOKED_MEETING_RATE_PCT).join(" ").toLowerCase();
    expect(copy).not.toMatch(/should|must|fail|worst|bottom|rank|behind others|other operators are/);
    // §19.7 / §40.12: nothing about who else holds or works a landlord.
    expect(copy).not.toMatch(/another operator|someone else|competitor/);
  });

  it("gets the singular right", () => {
    const lines = noticeLines(row({ due: 1, done: 0, overdue: 1 }), 77);
    expect(lines[0]).toContain("1 follow-up due");
    expect(lines[1]).toContain("1 landlord is waiting");
  });
});
