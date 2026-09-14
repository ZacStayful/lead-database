import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildFunnel, formatMinutes, medianResponseMinutes, MIN_BAR_PCT } from "../pipelineFunnel";
import { firstNameOf, greeting, greetingSubtitle, londonHour } from "../greeting";
import { buildLeadSources } from "../leadSources";
import { buildIncomeAcrossWon, compactGbp } from "../incomeAcrossWon";
import { buildGoalCard } from "../goalCard";

const a = (over: Partial<{
  status: string;
  pipeline_stage: string;
  first_contacted_at: string | null;
  assigned_at: string;
  lead_type: string;
  gross: number | null;
  area: string | null;
}> = {}) => ({
  status: over.status ?? "new",
  pipeline_stage: over.pipeline_stage ?? "cold",
  first_contacted_at: over.first_contacted_at ?? null,
  assigned_at: over.assigned_at ?? "2026-09-10T09:00:00Z",
  lead: {
    lead_type: over.lead_type ?? "management",
    gross_annual_income: over.gross ?? null,
    postcode_area: over.area ?? null,
  },
});

describe("buildFunnel", () => {
  const book = [
    a(),
    a({ status: "contacted" }),
    a({ status: "new", first_contacted_at: "2026-09-10T10:00:00Z" }),
    a({ status: "contacted", pipeline_stage: "web_meeting_booked" }),
    a({ status: "contacted", pipeline_stage: "web_meeting_attended" }),
    a({ status: "won", pipeline_stage: "won" }),
    a({ lead_type: "guaranteed_rent", status: "contacted", pipeline_stage: "viewing_booked" }),
  ];

  it("has no In discussion row and walks Received → Contacted → meeting stages → Won", () => {
    const f = buildFunnel(book, "management");
    expect(f.rows.map((r) => r.key)).toEqual([
      "received",
      "contacted",
      "web_meeting_booked",
      "web_meeting_no_show",
      "web_meeting_attended",
      "won",
    ]);
    expect(f.rows.map((r) => r.key)).not.toContain("in_discussion");
  });

  it("counts a first_contacted_at stamp as contacted and a stage as at-or-beyond", () => {
    const f = buildFunnel(book, "management");
    const by = Object.fromEntries(f.rows.map((r) => [r.key, r.count]));
    expect(by.received).toBe(6);
    expect(by.contacted).toBe(5);
    expect(by.web_meeting_booked).toBe(3); // booked, attended, won
    expect(by.web_meeting_attended).toBe(2); // attended, won
    expect(by.won).toBe(1);
    expect(f.signedPct).toBe(17);
  });

  it("cumulative is monotone non-increasing and next step is null on the last row", () => {
    const f = buildFunnel(book, "management");
    for (let i = 1; i < f.rows.length; i++) {
      expect(f.rows[i].cumulativePct).toBeLessThanOrEqual(f.rows[i - 1].cumulativePct);
    }
    expect(f.rows[f.rows.length - 1].nextStepPct).toBeNull();
    expect(f.rows[0].nextStepPct).toBe(83);
  });

  it("floors the bar width so a label fits, and uses GR stages for GR", () => {
    const thin = [...Array.from({ length: 9 }, () => a()), a({ status: "won", pipeline_stage: "won" })];
    const f = buildFunnel(thin, "management");
    expect(f.rows.find((r) => r.key === "won")!.widthPct).toBe(MIN_BAR_PCT);
    expect(f.rows.find((r) => r.key === "won")!.cumulativePct).toBe(10);
    const g = buildFunnel(book, "guaranteed_rent");
    expect(g.rows.map((r) => r.key)).toEqual([
      "received",
      "contacted",
      "viewing_booked",
      "contract_sent",
      "contract_signed",
      "won",
    ]);
    expect(g.received).toBe(1);
  });

  it("median response uses only non-negative gaps and formats", () => {
    expect(medianResponseMinutes([])).toBeNull();
    expect(
      medianResponseMinutes([
        { assigned_at: "2026-09-10T09:00:00Z", first_contacted_at: "2026-09-10T09:42:00Z" },
        { assigned_at: "2026-09-10T09:00:00Z", first_contacted_at: "2026-09-10T08:00:00Z" },
        { assigned_at: "2026-09-10T09:00:00Z", first_contacted_at: "2026-09-10T11:00:00Z" },
      ])
    ).toBe(81);
    expect(formatMinutes(42)).toBe("42 min");
    expect(formatMinutes(0.4)).toBe("under a minute");
    expect(formatMinutes(125)).toBe("2h 5m");
  });
});

describe("greeting", () => {
  it("reads the London hour, in BST as well as GMT", () => {
    expect(londonHour(new Date("2026-06-14T11:30:00Z"))).toBe(12); // BST
    expect(londonHour(new Date("2026-12-14T11:30:00Z"))).toBe(11); // GMT
    expect(greeting(new Date("2026-06-14T11:30:00Z"), "Michael")).toBe("Good afternoon, Michael");
    expect(greeting(new Date("2026-12-14T11:30:00Z"), "Michael")).toBe("Good morning, Michael");
    expect(greeting(new Date("2026-12-14T18:30:00Z"), null)).toBe("Good evening");
  });

  it("composes the subtitle from the two Today lines only", () => {
    const s = greetingSubtitle("2026-09-14", [
      { key: "new_leads", text: "2 new leads arrived today." },
      { key: "followups", text: "3 follow-ups due" },
      { key: "next_lead", text: "Your next lead is due tomorrow (Tue 15 Sep)." },
    ]);
    expect(s).toBe("Mon 14 Sep · 2 new leads arrived today · Your next lead is due tomorrow (Tue 15 Sep).");
    expect(greetingSubtitle("2026-09-14", [])).toBe("Mon 14 Sep");
    expect(firstNameOf("  Michael Brown ")).toBe("Michael");
    expect(firstNameOf("")).toBeNull();
  });
});

describe("buildLeadSources", () => {
  it("is areas over the last 30 days, top five, never towns", () => {
    const now = new Date("2026-09-14T12:00:00Z");
    const rows = buildLeadSources(
      [
        a({ area: "BS" }),
        a({ area: "bs " }),
        a({ area: "NE" }),
        a({ area: "NE", assigned_at: "2026-07-01T00:00:00Z" }),
        a({ area: null }),
        ...["DH", "TS", "YO", "LS", "M"].map((area) => a({ area })),
      ],
      now
    );
    expect(rows[0]).toMatchObject({ area: "BS", count: 2, pct: 100 });
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.label.startsWith(r.area + " "))).toBe(true);
    const code = readFileSync(path.resolve(__dirname, "../leadSources.ts"), "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
    expect(code.includes("extractCity")).toBe(false);
  });
});

describe("buildIncomeAcrossWon", () => {
  it("sums Stayful's gross over won management leads and never reads income_estimate", () => {
    const r = buildIncomeAcrossWon([
      a({ status: "won", gross: 40_000 }),
      a({ status: "won", gross: 60_000 }),
      a({ status: "won", gross: null }),
      a({ status: "won", gross: 90_000, lead_type: "guaranteed_rent" }),
      a({ status: "contacted", gross: 90_000 }),
    ])!;
    expect(r.signed).toBe(3);
    expect(r.withFigures).toBe(2);
    expect(r.projection.grossAnnualLow).toBe(90_000);
    expect(r.projection.grossAnnualHigh).toBe(110_000);
    expect(buildIncomeAcrossWon([a({ status: "won", gross: null })])).toBeNull();
    const src = readFileSync(path.resolve(__dirname, "../incomeAcrossWon.ts"), "utf8");
    expect(/income_estimate\b(?!.*never)/.test(src.split("\n").filter((l) => !l.trim().startsWith("*")).join("\n"))).toBe(false);
    expect(compactGbp(94_000)).toBe("£94k");
    expect(compactGbp(115_200)).toBe("£115k");
    expect(compactGbp(14_100)).toBe("£14.1k");
    expect(compactGbp(1_200)).toBe("£1,200");
  });
});

describe("buildGoalCard", () => {
  it("counts days left from the London date and says when the goal is met", () => {
    expect(buildGoalCard(null, null, 2, "2026-09-14")).toBeNull();
    const g = buildGoalCard(6, "2026-09-30", 4, "2026-09-14")!;
    expect(g.pct).toBe(67);
    expect(g.daysLeft).toBe(16);
    expect(g.subtitle).toBe("Sign 6 landlords by 30 Sep");
    expect(g.caption).toBe("16 days left · 2 to go");
    expect(buildGoalCard(2, null, 2, "2026-09-14")!.caption).toBe("Goal reached.");
    expect(buildGoalCard(3, "2026-09-10", 1, "2026-09-14")!.caption).toBe("4 days past the date · 2 to go");
  });
});
