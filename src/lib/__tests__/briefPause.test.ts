import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  BRIEF_PAUSE_COPY,
  BRIEF_PAUSE_MAX_MONTHS,
  BRIEF_RECALIBRATE_DAYS_BEFORE,
  BRIEF_SHORT_PAUSE_DAYS,
  RETURN_DATE_MESSAGES,
  addDaysYmd,
  addMonthsClampedYmd,
  areaChanged,
  briefPauseWindow,
  checkReturnDate,
  daysBetweenYmd,
  firstNameOf,
  holdsArea,
  londonMidnightIso,
  londonToday,
  longDate,
  onLongBriefPause,
  recalibrationDue,
  restartLine,
  returnDecision,
} from "@/lib/briefPause";
import { checkPauseReasons } from "@/lib/pauseOptions";
import { n8nClaimLimit, N8N_CLAIM_DEFAULT_LIMIT, N8N_CLAIM_MAX_LIMIT } from "@/lib/n8nEvents";

/**
 * A Lead Brief customer's pause (batch 04 Phase 2). Locked decisions 2 and 3,
 * counted in London dates exactly as 0167's CHECKs count them.
 */

describe("dates", () => {
  it("adds months the Postgres way, clamped to the month's end (never setMonth's roll-over)", () => {
    expect(addMonthsClampedYmd("2026-11-30", 3)).toBe("2027-02-28");
    expect(addMonthsClampedYmd("2027-11-30", 3)).toBe("2028-02-29");
    expect(addMonthsClampedYmd("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsClampedYmd("2026-10-10", 3)).toBe("2027-01-10");
    expect(addMonthsClampedYmd("2026-12-15", 3)).toBe("2027-03-15");
  });

  it("adds and counts calendar days", () => {
    expect(addDaysYmd("2026-10-10", 28)).toBe("2026-11-07");
    expect(addDaysYmd("2026-12-31", 1)).toBe("2027-01-01");
    expect(daysBetweenYmd("2026-10-10", "2026-11-07")).toBe(28);
    expect(daysBetweenYmd("2026-03-28", "2026-03-30")).toBe(2);
  });

  it("refuses a date that does not exist", () => {
    expect(() => addDaysYmd("2026-02-30", 1)).toThrow();
    expect(() => daysBetweenYmd("2026-13-01", "2026-01-01")).toThrow();
  });

  it("London midnight is 23:00 UTC the day before in summer, 00:00 UTC in winter", () => {
    expect(londonMidnightIso("2026-10-20")).toBe("2026-10-19T23:00:00.000Z");
    expect(londonMidnightIso("2026-11-07")).toBe("2026-11-07T00:00:00.000Z");
    // The clock-change days themselves.
    expect(londonMidnightIso("2026-10-25")).toBe("2026-10-24T23:00:00.000Z");
    expect(londonMidnightIso("2026-03-29")).toBe("2026-03-29T00:00:00.000Z");
  });

  it("today is London's date, not UTC's", () => {
    // 23:30 UTC on 10 Oct is 00:30 on 11 Oct in London (BST).
    expect(londonToday(new Date("2026-10-10T23:30:00Z"))).toBe("2026-10-11");
    expect(londonToday(new Date("2026-12-10T23:30:00Z"))).toBe("2026-12-10");
  });
});

describe("the pause window and the 28-day line", () => {
  const NOW = new Date("2026-10-10T09:00:00Z");

  it("runs from tomorrow to 3 months away, with 4 weeks in between", () => {
    expect(briefPauseWindow(NOW)).toEqual({
      today: "2026-10-10",
      earliest: "2026-10-11",
      fourWeeks: "2026-11-07",
      latest: "2027-01-10",
    });
    expect(BRIEF_SHORT_PAUSE_DAYS).toBe(28);
    expect(BRIEF_PAUSE_MAX_MONTHS).toBe(3);
  });

  it("locked decision 2: 28 days or fewer keeps the area; 29 releases it", () => {
    expect(holdsArea(1)).toBe(true);
    expect(holdsArea(28)).toBe(true);
    expect(holdsArea(29)).toBe(false);
    expect(holdsArea(92)).toBe(false);
  });

  it("checks a return date against the server's clock", () => {
    const four = checkReturnDate("2026-11-07", NOW);
    expect(four).toEqual({
      ok: true,
      returnDate: "2026-11-07",
      days: 28,
      holdArea: true,
      resumesAtIso: "2026-11-07T00:00:00.000Z",
    });
    const longer = checkReturnDate("2026-11-08", NOW);
    expect(longer.ok && longer.holdArea).toBe(false);
    expect(longer.ok && longer.days).toBe(29);
    expect(checkReturnDate(" 2026-10-24 ", NOW)).toMatchObject({ ok: true, holdArea: true, days: 14 });
    expect(checkReturnDate("2027-01-10", NOW)).toMatchObject({ ok: true, holdArea: false });
  });

  it("refuses a date outside the window, or that is not a date", () => {
    expect(checkReturnDate("2026-10-10", NOW)).toEqual({ ok: false, code: "return_date_too_soon" });
    expect(checkReturnDate("2027-01-11", NOW)).toEqual({ ok: false, code: "return_date_too_late" });
    expect(checkReturnDate("2026-02-30", NOW)).toEqual({ ok: false, code: "return_date_invalid" });
    expect(checkReturnDate(28, NOW)).toEqual({ ok: false, code: "return_date_invalid" });
    expect(checkReturnDate(undefined, NOW)).toEqual({ ok: false, code: "return_date_invalid" });
    for (const code of ["return_date_invalid", "return_date_too_soon", "return_date_too_late"] as const) {
      expect(RETURN_DATE_MESSAGES[code]).toMatch(/\w/);
    }
  });

  it("⚠️ counts from LONDON's today: a pause taken at 00:30 BST is from that London date", () => {
    // 23:30 UTC on 10 Oct is 11 Oct in London, so 4 weeks is 8 Nov.
    const late = new Date("2026-10-10T23:30:00Z");
    expect(briefPauseWindow(late).fourWeeks).toBe("2026-11-08");
    expect(checkReturnDate("2026-11-08", late)).toMatchObject({ ok: true, days: 28, holdArea: true });
  });

  it("the stored dates satisfy 0167's CHECK: hold_area agrees with the London-date length", () => {
    // The CHECK: (resumes_at in London)::date − (paused_at in London)::date <= 28.
    for (const [now, date] of [
      [new Date("2026-10-10T09:00:00Z"), "2026-11-07"],
      [new Date("2026-10-10T23:30:00Z"), "2026-11-08"],
      [new Date("2026-03-01T09:00:00Z"), "2026-03-29"],
    ] as const) {
      const r = checkReturnDate(date, now);
      if (!r.ok) throw new Error("expected ok");
      const london = (iso: string) => londonToday(new Date(iso));
      const days = daysBetweenYmd(london(now.toISOString()), london(r.resumesAtIso));
      expect(days <= 28).toBe(r.holdArea);
      expect(london(r.resumesAtIso)).toBe(date);
    }
  });
});

describe("long brief pause", () => {
  it("is a pause whose area flag is false, and only while paused", () => {
    expect(onLongBriefPause({ paused_at: "2026-10-10", pause_holds_area: false })).toBe(true);
    expect(onLongBriefPause({ paused_at: "2026-10-10", pause_holds_area: true })).toBe(false);
    expect(onLongBriefPause({ paused_at: "2026-10-10", pause_holds_area: null })).toBe(false);
    expect(onLongBriefPause({ paused_at: null, pause_holds_area: false })).toBe(false);
  });

  it("locked decision 3: recalculated from 7 days before return", () => {
    const resumes = "2026-12-10T00:00:00.000Z";
    expect(BRIEF_RECALIBRATE_DAYS_BEFORE).toBe(7);
    expect(recalibrationDue(resumes, new Date("2026-12-02T23:59:59Z"))).toBe(false);
    expect(recalibrationDue(resumes, new Date("2026-12-03T00:00:00Z"))).toBe(true);
    expect(recalibrationDue(resumes, new Date("2026-12-11T00:00:00Z"))).toBe(true);
    expect(recalibrationDue("not a date", new Date())).toBe(false);
  });

  it("the area changed when the radius or the outcodes moved, or the answers did", () => {
    const now = { service_radius_miles: 20, service_outcodes: ["LS1", "LS2"] };
    expect(areaChanged(now, { service_radius_miles: 20, service_outcodes: ["LS2", "LS1"] }, false)).toBe(false);
    expect(areaChanged(now, { service_radius_miles: 25, service_outcodes: ["LS1", "LS2"] }, false)).toBe(true);
    expect(areaChanged(now, { service_radius_miles: 20, service_outcodes: ["LS1", "LS3"] }, false)).toBe(true);
    expect(areaChanged(now, { service_radius_miles: 20, service_outcodes: ["LS1"] }, false)).toBe(true);
    expect(areaChanged(now, { service_radius_miles: 20, service_outcodes: ["LS1", "LS2"] }, true)).toBe(true);
  });

  it("C4: the return waits only for a pending version still awaiting confirmation", () => {
    const base = { recalibrated_at: "2026-12-03T08:00:00Z", pending_brief_id: "b1" };
    expect(returnDecision({ recalibrated_at: null, pending_brief_id: null, pending_status: null })).toBe("recalibrate");
    expect(returnDecision({ ...base, pending_brief_id: null, pending_status: null })).toBe("resume");
    expect(returnDecision({ ...base, pending_status: "pending_confirmation" })).toBe("await_confirmation");
    expect(returnDecision({ ...base, pending_status: "active" })).toBe("resume");
    // The customer's own area save replaced it (0164: their newer choice).
    expect(returnDecision({ ...base, pending_status: "superseded" })).toBe("resume");
    // The version was deleted (pending_brief_id is set null on delete): resume.
    expect(returnDecision({ ...base, pending_status: null })).toBe("resume");
  });

  it("names the customer by their first name, falling back to their email", () => {
    expect(firstNameOf("Lin Long", "l@x.com")).toBe("Lin");
    expect(firstNameOf("  ", "l@x.com")).toBe("l@x.com");
    expect(firstNameOf(null, "l@x.com")).toBe("l@x.com");
  });
});

describe("copy", () => {
  const DOC = readFileSync("docs/build/04-area-changes-pause-topups.md", "utf8").replace(/\s+/g, " ");

  it("the pause screen is the batch's words, verbatim", () => {
    for (const key of ["title", "intro", "short", "long", "slower", "pauseFourWeeks", "chooseLonger", "switchTo10"] as const) {
      expect(DOC, key).toContain(BRIEF_PAUSE_COPY[key]);
    }
  });

  it("the area-updated line is the batch's email wording", () => {
    expect(DOC).toContain("Your area has been updated. Review it before your leads restart on [date].");
    expect(BRIEF_PAUSE_COPY.areaToReview).toBe("Your area has been updated. Review it before your leads restart.");
  });

  it("dates read as a UK long date", () => {
    expect(longDate("2026-11-07")).toBe("7 November 2026");
    expect(restartLine("2027-01-10")).toBe("Your leads restart on 10 January 2027.");
  });
});

describe("checkPauseReasons", () => {
  it("uses the existing pause route's rules and words", () => {
    expect(checkPauseReasons([], null)).toEqual({
      ok: false,
      error: "Please tell us why you are pausing — select at least one reason.",
    });
    expect(checkPauseReasons(["nope"], null).ok).toBe(false);
    expect(checkPauseReasons(["other"], "  ")).toEqual({
      ok: false,
      error: "Please tell us a little more about why you are pausing.",
    });
    expect(checkPauseReasons(["seasonal", "seasonal", "other"], " busy ")).toEqual({
      ok: true,
      reasons: ["seasonal", "other"],
      note: "busy",
    });
    expect(checkPauseReasons(["seasonal"], "x".repeat(501)).ok).toBe(false);
  });

  it("the existing route's inline checks say the same", () => {
    const route = readFileSync("src/app/api/customer/subscription/pause/route.ts", "utf8");
    expect(route).toContain("Please tell us why you are pausing — select at least one reason.");
    expect(route).toContain("Please tell us a little more about why you are pausing.");
  });
});

describe("n8nClaimLimit", () => {
  it("defaults, and bounds what 0168 bounds", () => {
    expect(n8nClaimLimit(null)).toBe(N8N_CLAIM_DEFAULT_LIMIT);
    expect(n8nClaimLimit({})).toBe(N8N_CLAIM_DEFAULT_LIMIT);
    expect(n8nClaimLimit({ limit: 1 })).toBe(1);
    expect(n8nClaimLimit({ limit: 100 })).toBe(100);
    expect(n8nClaimLimit({ limit: 0 })).toBeNull();
    expect(n8nClaimLimit({ limit: 101 })).toBeNull();
    expect(n8nClaimLimit({ limit: 2.5 })).toBeNull();
    expect(n8nClaimLimit({ limit: "5" })).toBeNull();
    expect(n8nClaimLimit([])).toBeNull();
    const sql = readFileSync("supabase/migrations/0168_brief_pause_recalibration.sql", "utf8");
    expect(sql).toContain(`p_limit > ${N8N_CLAIM_MAX_LIMIT}`);
  });
});
