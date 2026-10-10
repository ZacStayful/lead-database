import { describe, expect, it } from "vitest";
import { pauseEpisodeLengthLabel } from "@/lib/pauseOptions";

/**
 * 0167 (batch 04 C6) lets a Lead Brief customer's pause carry no month count,
 * so the admin pause detail has to say how long it runs another way. Counted
 * in London dates, the same count subscription_pauses_hold_area_length uses
 * for the 28-day rule.
 */
describe("pauseEpisodeLengthLabel", () => {
  it("keeps the month wording for an ordinary pause", () => {
    expect(
      pauseEpisodeLengthLabel({
        months: 1,
        paused_at: "2026-10-10T09:00:00Z",
        resumes_at: "2026-11-10T09:00:00Z",
      }),
    ).toBe("1 month");
    expect(
      pauseEpisodeLengthLabel({
        months: 3,
        paused_at: "2026-10-10T09:00:00Z",
        resumes_at: "2027-01-10T09:00:00Z",
      }),
    ).toBe("3 months");
  });

  it("counts a brief pause in days", () => {
    expect(
      pauseEpisodeLengthLabel({
        months: null,
        paused_at: "2026-10-10T09:00:00Z",
        resumes_at: "2026-11-07T09:00:00Z",
      }),
    ).toBe("28 days");
  });

  // 23:30 UTC on 10 Oct is 11 Oct in London (BST); 08:00 UTC on 8 Nov is
  // 8 Nov (GMT). 28 London days, where UTC dates would say 29 — the case the
  // 0167 suite pins for the CHECK, so the label and the rule agree.
  it("counts in London dates, across the clock change", () => {
    expect(
      pauseEpisodeLengthLabel({
        months: null,
        paused_at: "2026-10-10T23:30:00Z",
        resumes_at: "2026-11-08T08:00:00Z",
      }),
    ).toBe("28 days");
  });

  // ⚠️ Paused at 21:00 London on 10 Oct, back at 06:00 on 7 Nov: 27 days and
  // 10 hours elapsed, so counting hours (rounded or floored) says 27. By
  // London dates it is 28 — a short pause, which is what the 28-day rule says.
  it("does not count hours", () => {
    expect(
      pauseEpisodeLengthLabel({
        months: null,
        paused_at: "2026-10-10T20:00:00Z",
        resumes_at: "2026-11-07T06:00:00Z",
      }),
    ).toBe("28 days");
  });

  it("says one day, not 1 days", () => {
    expect(
      pauseEpisodeLengthLabel({
        months: null,
        paused_at: "2026-10-10T09:00:00Z",
        resumes_at: "2026-10-11T09:00:00Z",
      }),
    ).toBe("1 day");
  });

  it("never prints NaN for a timestamp it cannot read", () => {
    expect(
      pauseEpisodeLengthLabel({ months: null, paused_at: "nonsense", resumes_at: "2026-10-11" }),
    ).toBe("Paused");
  });
});
