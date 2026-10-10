import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  BRIEF_EDITOR_HREF,
  EDIT_COPY,
  PRIORITY_LABELS,
  areaLine,
  currentAreaLine,
  levelLabel,
  pendingAreaLine,
  pendingLine,
  summaryLine,
} from "@/lib/leadBrief/editCopy";
import { PRIORITY_NAMES as LABEL_COPY_PRIORITY_NAMES } from "@/lib/leadBrief/labelCopy";
import { PRIORITY_KEYS } from "@/lib/leadBrief/types";

/**
 * The "Your brief" bar and editor copy (Lead Brief Phase 5, Part B). The A9
 * and house-style bans run over this module in briefCopy.test.ts.
 */

describe("editCopy", () => {
  it("stays import-free (the editor and the bar are client components)", () => {
    const src = readFileSync("src/lib/leadBrief/editCopy.ts", "utf8");
    expect(src).not.toMatch(/^\s*import\s/m);
  });

  it("names every priority, the same way the label panel does", () => {
    for (const k of PRIORITY_KEYS) {
      expect(PRIORITY_LABELS[k]).toBeTruthy();
      expect(PRIORITY_LABELS[k]).toBe(LABEL_COPY_PRIORITY_NAMES[k]);
    }
  });

  it("words every level", () => {
    expect(levelLabel("location", 15)).toBe("Within 15 miles of your areas");
    expect(levelLabel("revenue", 40000)).toBe("£40k+ a year");
    expect(levelLabel("bedrooms", 1)).toBe("1+ bedroom");
    expect(levelLabel("bedrooms", 3)).toBe("3+ bedrooms");
    expect(levelLabel("occupancy", 60)).toBe("60%+ occupancy");
  });

  it("the bar's one line", () => {
    expect(
      summaryLine({
        radiusMiles: 35,
        basePostcode: "YO10 5DD",
        otherAreas: 0,
        minBedrooms: 3,
        minGross: null,
        ranking: ["location", "revenue", "bedrooms", "occupancy"],
      })
    ).toBe("Your brief: within 35 miles of YO10 5DD · 3+ bedrooms · Priorities: location, projected revenue, bedrooms, occupancy");
    expect(
      summaryLine({
        radiusMiles: 20,
        basePostcode: "LS1 4AP",
        otherAreas: 2,
        minBedrooms: null,
        minGross: 50000,
        ranking: [],
      })
    ).toBe("Your brief: within 20 miles of LS1 4AP and your other areas · £50k+ projected revenue");
  });

  it("the area lines", () => {
    const args = { radiusMiles: 25, basePostcode: "YO10 5DD", otherAreas: 1, minBedrooms: null, minGross: null };
    expect(areaLine(args)).toBe("within 25 miles of YO10 5DD and your other areas");
    expect(currentAreaLine(args)).toBe("Within 25 miles of YO10 5DD and your other areas.");
    // The editor lists essentials on their own line, so the current line omits them.
    expect(currentAreaLine({ ...args, minBedrooms: 3, minGross: 40000 })).toBe(
      "Within 25 miles of YO10 5DD and your other areas."
    );
    expect(pendingAreaLine({ ...args, minBedrooms: 3 })).toBe(
      "Your new area: Within 25 miles of YO10 5DD and your other areas · 3+ bedrooms."
    );
    expect(pendingAreaLine(args)).toBe("Your new area: Within 25 miles of YO10 5DD and your other areas.");
  });

  it("an area change names its start date, and falls back to 'next renewal' without one", () => {
    expect(pendingLine("2026-11-12")).toBe("Your new area starts on 12 November.");
    expect(pendingLine(null)).toBe("Your new area starts at your next renewal.");
    expect(pendingLine("not a date")).toBe("Your new area starts at your next renewal.");
    expect(EDIT_COPY.area.startsOn("2026-11-12")).toBe("These changes start on 12 November.");
    expect(EDIT_COPY.area.savedOn("2026-11-12")).toBe("Saved. These changes start on 12 November.");
    expect(EDIT_COPY.area.savedOn(null)).toBe("Saved. These changes start at your next renewal.");
  });

  it("says when each kind of change applies, and promises no number of leads", () => {
    expect(EDIT_COPY.pageIntro).toContain("a change to your area starts at your next renewal");
    expect(EDIT_COPY.priorities.intro).toContain("Changes apply to your next leads");
    const all = JSON.stringify(EDIT_COPY);
    expect(all).not.toMatch(/\d+ leads/);
  });

  it("the editor's address", () => {
    expect(BRIEF_EDITOR_HREF).toBe("/dashboard/leads/brief");
  });

  it("the postcode is locked (batch 05): says so, says how to change it, promises no review", () => {
    for (const line of [EDIT_COPY.area.postcodeLocked, EDIT_COPY.errors.postcodeLocked]) {
      expect(line).toContain("can't be changed here");
      expect(line).toContain("get in touch through Support");
      // The request-and-review flow is batch 05's, not built yet.
      expect(line).not.toMatch(/review|request|48 hours|72 hours/i);
    }
    // The area section no longer offers the postcode as something to change.
    expect(EDIT_COPY.area.intro).not.toMatch(/postcode/i);
  });
});
