import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * File-text guards for Lead Brief Phase 5's surfaces. vitest here is pure
 * units with no React, so where a rule lives in a component or a route, the
 * real file is read (§42.8), comments stripped first (§46).
 */
function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}
const read = (p: string) => strip(readFileSync(p, "utf8"));
const flat = (p: string) => read(p).replace(/\s+/g, " ");

const CARD = read("src/components/dashboard/LeadCard.tsx");
const PANEL = flat("src/components/lead/ContactPanel.tsx");
const BADGE = read("src/components/leadBrief/MatchLabelBadge.tsx");
const WHY = read("src/components/leadBrief/WhyThisLead.tsx");
const NOT_FOR_ME = read("src/components/leadBrief/NotForMe.tsx");
const FEED = flat("src/components/dashboard/LeadFeed.tsx");
const HOME = flat("src/app/dashboard/page.tsx");
const NEW_CARD = read("src/components/dashboard/NewLeadCard.tsx");
const INGEST = flat("src/lib/ingest.ts");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "__tests__" ? [] : walk(p);
    return /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}

describe("every label surface renders nothing without a label", () => {
  it("the badge and the panel bail out on anything that is not a label", () => {
    expect(BADGE).toContain("if (!isLabelKey(label)) return null;");
    expect(WHY).toContain("if (!isLabelKey(label)) return null;");
    expect(WHY).toContain("if (!reasons) return null;");
    expect(WHY.indexOf("if (!isLabelKey(label)) return null;")).toBeLessThan(WHY.indexOf("return ("));
  });

  it("the panel's tag and tip appear only where they are true", () => {
    // "It's also in one of your first-pick areas" rides on a Top match only;
    // the tip is for a Nearby opportunity only.
    expect(WHY).toContain('const firstPickTag = label === "top_match" && reasons.first_pick;');
    expect(WHY).toContain('const tip = label === "nearby_opportunity" ? nearbyTip(reasons, leadOutcode ?? null) : null;');
  });

  it("the card, the panel and the home card pass the stored label straight through", () => {
    expect(CARD).toContain("<MatchLabelBadge label={assignment.match_label} />");
    expect(CARD).toMatch(/<WhyThisLead\s+label=\{assignment\.match_label\}\s+reasons=\{assignment\.match_reasons\}/);
    expect(PANEL).toContain("<MatchLabelBadge label={assignment.match_label} />");
    expect(PANEL).toContain("<WhyThisLead label={assignment.match_label} reasons={assignment.match_reasons}");
    expect(NEW_CARD).toContain("<MatchLabelBadge label={p.label}");
  });

  it("no component spells a label name itself: the words come from labelCopy.ts", () => {
    for (const src of [CARD, PANEL, BADGE, WHY, NOT_FOR_ME, NEW_CARD]) {
      for (const name of ["Top match", "Strong match", "First pick", "Nearby opportunity", "Why you got this lead"]) {
        expect(src).not.toContain(name);
      }
    }
  });
});

describe("Not for me (D10): on the contact panel only, and only where reject is allowed", () => {
  it("is never on the card, beside the dead-lead report (§51.6, §51.10)", () => {
    expect(CARD).not.toContain("NotForMe");
    expect(read("src/components/lead/WorkThisLead.tsx")).not.toContain("NotForMe");
    expect(read("src/components/dashboard/LeadOutcomePanel.tsx")).not.toContain("NotForMe");
  });

  it("is gated on a Strong or Nearby label AND the existing reject rule", () => {
    expect(PANEL).toContain(
      "offersNotForMe(assignment.match_label) && wf.outcomes.canReject ? ( <NotForMe onReject={wf.handleReject} />"
    );
    const uses = PANEL.split("<NotForMe").length - 1;
    expect(uses).toBe(1);
  });

  it("is the existing reject: it posts nothing itself and offers only the three preset reasons", () => {
    expect(NOT_FOR_ME).not.toMatch(/fetch\(|\/api\//);
    expect(NOT_FOR_ME).toContain("NOT_FOR_ME_REASONS.map(");
    expect(NOT_FOR_ME).toContain('await onReject(reason, "");');
    expect(NOT_FOR_ME.toLowerCase()).not.toContain("replace");
  });
});

describe("the alerts carry the label, and only a routed delivery says it was sent to keep them on track", () => {
  it("only autoAssignLead's loop and the brief release's pace pass call it routed", () => {
    const routed = walk("src")
      .filter((p) => read(p).includes('"routed")'))
      .map((p) => p.replace(/\\/g, "/"))
      .sort();
    expect(routed).toEqual(["src/lib/ingest.ts", "src/lib/leadBrief/briefRelease.ts"]);
    expect(INGEST.split('"routed")').length - 1).toBe(1);
    expect(INGEST).toContain(
      'if (assignError || !assignmentId) continue; assignmentsMade += 1; await completeAssignment(supabase, lead, customerId, assignmentId, true, "routed");'
    );
    expect(INGEST).toContain('delivery: "routed" | "placed" = "placed"');
    expect(INGEST).toContain('routed: delivery === "routed",');
  });

  it("recordBriefMatch stores progress only for a routed delivery", () => {
    const routing = flat("src/lib/leadBrief/routing.ts");
    expect(routing).toContain("progress: opts.routed ? deliveryProgress(customer) : null,");
    expect(routing).toContain("opts: { routed: boolean } = { routed: false }");
  });

  it("the notification, the email and the text all take the stored match", () => {
    expect(INGEST).toContain('message: `New lead${match ? notificationLabel(match.label) : ""}:');
    expect(INGEST).toContain(
      "match: match ? { label: LABEL_NAMES[match.label], reason: reasonLine(match.label, match.reasons) } : undefined"
    );
    expect(INGEST).toContain("label: match ? LABEL_NAMES[match.label] : undefined,");
  });
});

describe("the home page", () => {
  it("shows the month line and the delayed refresh to brief customers only", () => {
    expect(HOME).toContain("const briefCustomer = isBriefCustomer(customer);");
    expect(HOME).toContain(
      "const monthLabelLine = briefCustomer ? thisMonthLine(assignments, currentCycleStart(customer, now)) : null;"
    );
    expect(HOME).toContain("{monthLabelLine && <p>{monthLabelLine}</p>}");
    expect(HOME).toContain("labelsFollow={briefCustomer}");
    expect(HOME).toContain("lead_assignments(id, lead_id, viewed_at, match_label, lead:leads(");
  });

  it("the feed's second refresh is gated on the prop and its timers are cleared", () => {
    expect(FEED).toContain("labelsFollow = false,");
    expect(FEED).toContain("if (labelsFollow) timers.push(setTimeout(() => router.refresh(), LABEL_REFRESH_MS));");
    expect(FEED).toContain("for (const t of timers) clearTimeout(t);");
    expect(FEED).toContain("[customerId, router, labelsFollow]");
  });
});
