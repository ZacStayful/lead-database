/**
 * Guards on /admin/retention's wiring, not its arithmetic.
 *
 * WHY THESE READ THE REAL FILES
 * -----------------------------
 * Each claim below is a one-token reversion away, and none of them is reachable
 * by a behavioural test: vitest.config.mts is "PURE UNITS ONLY — no network, no
 * database, no React", so neither the page nor the chart can be imported here.
 * CLAUDE.md §42.8 records what the alternative cost — a safety boundary asserted
 * in a pull request, checked by a test that hand-wrote its own copy of the query,
 * that did not actually exist in the code, and 91 follow-up runs destroyed six
 * minutes after deploy.
 *
 * ⚠️ EVERY ASSERTION STRIPS COMMENTS FIRST. The files deliberately EXPLAIN these
 * rules, so they name the very tokens being banned — `created_at`,
 * `formatDate`, "stacked area". A naive substring check fails on the
 * explanation, which trains the next person to delete the explanation (§46).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../../..");

function source(relative: string): string {
  return readFileSync(path.join(root, relative), "utf8");
}

/** Source with every // line comment and /* block comment *​/ removed. */
function code(relative: string): string {
  return source(relative)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const DATA = "src/lib/retentionData.ts";
const PAGE = "src/app/admin/retention/page.tsx";
const CHART = "src/components/admin/RetentionChart.tsx";
const LAYOUT = "src/app/admin/layout.tsx";
const LIB = "src/lib/retention.ts";

describe("the reads", () => {
  it("goes through createAdminClient, which forces cache: no-store", () => {
    // §27.4: Next's patched fetch silently served stale privileged reads and
    // skipped side-effecting RPCs entirely. A bare createClient here would read
    // a cached book and quietly report last week's retention.
    const text = code(DATA);
    expect(text).toContain("createAdminClient()");
    expect(text).not.toMatch(/createClient\s*\(/);
  });

  it("reads subscription payments ONLY, never top-ups or lead analysis", () => {
    // A top-up counted as a subscription invoice fakes a renewal, and counted as
    // the price rewrites MRR to £75.
    const text = code(DATA);
    expect(text).toContain('.in("payment_type", ["subscription", "gr_subscription"])');
    expect(text).toContain('.eq("status", "paid")');
  });

  it("orders support tickets on submitted_at and never on created_at", () => {
    // Nine of the ten rows in production are backfilled to one identical
    // created_at, which makes a customer look like they filed tickets AFTER they
    // cancelled.
    //
    // ⚠️ Scoped to the support_tickets read. `payments` orders on created_at
    // legitimately — that column IS a payment's clock, there being no paid_at —
    // so a file-wide ban on the token would fail on correct code, which is how a
    // guard ends up deleted.
    const text = code(DATA);
    const tickets = text.slice(text.indexOf('from("support_tickets")'));
    const block = tickets.slice(0, tickets.indexOf("),"));
    expect(block).toContain('.order("submitted_at"');
    expect(block).not.toContain("created_at");
    expect(text).toContain("submittedAt: t.submitted_at");
    expect(text).not.toContain("submittedAt: t.created_at");
  });

  it("names its customer columns rather than selecting everything", () => {
    const text = code(DATA);
    expect(text).toContain("CUSTOMER_COLUMNS");
    expect(text).not.toContain('select("*")');
  });

  it("degrades instead of throwing when a core read fails", () => {
    const text = code(DATA);
    expect(text).toContain("unavailable: true");
    expect(text).toMatch(/if \(customersRes\.error \|\| paymentsRes\.error\)/);
    expect(text).not.toMatch(/throw new Error/);
  });

  it("bounds the snapshot read, the one table that grows without limit", () => {
    const text = code(DATA);
    expect(text).toContain("ENGAGEMENT_CHURN_LOOKBACK_DAYS");
    expect(text).toMatch(/\.gte\("captured_on"/);
  });
});

describe("the page", () => {
  it("formats dates with the London-safe helper, not utils' formatDate", () => {
    // formatDate in src/lib/utils.ts passes no timeZone, so it renders a payment
    // at 00:30 BST under the previous day.
    const text = code(PAGE);
    expect(text).toContain("formatAdminDate");
    expect(text).not.toMatch(/\bformatDate\b/);
  });

  it("renders the bands from TENURE_BANDS rather than its own labels", () => {
    // Every band label and bound has one home; a hard-coded "6-12mo" here would
    // drift from the chart and the arithmetic the first time a band moves.
    const text = code(PAGE);
    expect(text).toContain("TENURE_BANDS");
    expect(text).not.toMatch(/"0–1mo"|"6–12mo"|"12mo\+"/);
  });

  it("prints the eligible denominator beside every retention percentage", () => {
    const text = code(PAGE);
    expect(text).toContain("result.renewed} of {result.eligible}");
    expect(text).toContain("result.measurableFrom");
  });

  it("keeps the paused figure out of the revenue total", () => {
    // §21's "always two numbers, never one". Summing it into totalMrr would show
    // revenue nobody is collecting.
    const text = code(PAGE);
    expect(text).toMatch(/totalMrr\s*=\s*perProduct\.reduce\(\(sum, p\) => sum \+ p\.mrr\.totalPence, 0\)/);
    expect(text).not.toMatch(/totalMrr[^\n]*pausedPence/);
  });

  it("ships the relief channel the chart's light end obligates", () => {
    // The lightest ramp step sits at 2.07:1. The banded tiles and the retention
    // table are what make the chart legible without relying on that contrast, so
    // they cannot be removed and leave the chart behind.
    const text = code(PAGE);
    expect(text).toContain("bandedMrr");
    expect(text).toContain("renewalRetention");
    expect(text).toContain("RetentionChart");
  });

  it("is dynamic, so an admin never reads a cached book", () => {
    expect(code(PAGE)).toContain('export const dynamic = "force-dynamic"');
  });
});

describe("the chart", () => {
  it("has exactly ONE y-axis", () => {
    // Two y-scales on one chart is the single most misleading thing a chart can
    // do: where the lines cross is an artefact of the scales, not a fact. The
    // obvious request is the stable-share percentage on a right-hand axis — it
    // belongs in a stat tile.
    const text = code(CHART);
    expect(text.match(/<YAxis/g) ?? []).toHaveLength(1);
    expect(text).not.toContain("yAxisId");
    expect(text).not.toContain('orientation="right"');
  });

  it("draws lines, not a stacked area", () => {
    // A stacked area makes any middle band unreadable — you would be measuring
    // the 3-6 band by eye against a moving floor.
    const text = code(CHART);
    expect(text).toContain("<LineChart");
    expect(text).not.toContain("<Area");
    expect(text).not.toMatch(/stackId/);
  });

  it("colours the bands from an ordinal ramp of ONE hue", () => {
    // Tenure bands are ordered — swapping them changes the meaning — so they
    // take one hue with monotone lightness, not five categorical hues. The five
    // steps were validated: monotone L, adjacent ΔL ≥ 0.06, 3° hue spread, and
    // every step ≥ 2:1 on the page surface.
    const text = code(CHART);
    for (const hex of ["#9cba93", "#74996b", "#52774b", "#365132", "#1e3119"]) {
      expect(text).toContain(hex);
    }
  });

  it("carries one colour per band and no more", () => {
    const text = code(CHART);
    const declared = text.match(/#[0-9a-f]{6}/g) ?? [];
    // Five band steps, plus the axis ink, the milestone marker and the tooltip
    // inks. A sixth band colour would mean a band was added without a validated
    // ramp step.
    const bandSteps = declared.filter((h) =>
      ["#9cba93", "#74996b", "#52774b", "#365132", "#1e3119"].includes(h)
    );
    expect(new Set(bandSteps).size).toBe(5);
  });

  it("disables animation and per-point dots", () => {
    const text = code(CHART);
    expect(text).toContain("isAnimationActive={false}");
    expect(text).toContain("dot={false}");
  });

  it("always shows a legend, because five series is past direct labelling", () => {
    expect(code(CHART)).toContain("<Legend");
  });

  it("computes nothing — it receives its series as a prop", () => {
    const text = code(CHART);
    expect(text).toContain("series: MrrPoint[]");
    expect(text).not.toContain("mrrInForceDaily");
    expect(text).not.toContain("monthsBetween");
  });
});

describe("the nav", () => {
  it("lists Retention under Insights", () => {
    const text = code(LAYOUT);
    expect(text).toContain('{ href: "/admin/retention", label: "Retention" }');
    // Under Insights, beside Outcomes — not appended to another group.
    const insights = text.slice(text.indexOf('label: "Insights"'));
    expect(insights.slice(0, insights.indexOf("]")))
      .toContain('href: "/admin/retention"');
  });
});

describe("the library", () => {
  it("resolves the product from payment_type, never from lead_type", () => {
    // payments.lead_type is null on 37 of 39 paid subscription rows in
    // production: 0041's backfill covered the two rows that existed and the
    // Stripe webhook has never set it since.
    const text = code(LIB);
    expect(text).toContain('paymentType === "subscription"');
    expect(text).not.toMatch(/\bp\.lead_type\b/);
  });

  it("checks BOTH spellings of cancelled", () => {
    const text = code(LIB);
    expect(text).toContain('"cancelled"');
    expect(text).toContain('"canceled"');
  });

  it("never reads paused_at on the GR side", () => {
    // invariant 6: pause is management-only, and paused_at must never gate GR.
    expect(code(LIB)).toContain("management ? c.paused_at : null");
  });
});
