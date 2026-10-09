import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { isColumnsPath } from "@/lib/dashboardNav";

/**
 * Guards for the "Your brief" editor (Lead Brief Phase 5, Part B), read from
 * the real files (§42.8), comments stripped first so an explanation can never
 * satisfy or trip an assertion.
 */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

const EDIT_ROUTE = code("src/app/api/customer/lead-brief/edit/route.ts");
const EDIT_PREVIEW = code("src/app/api/customer/lead-brief/edit/preview/route.ts");
const CRON = code("src/app/api/cron/activate-lead-briefs/route.ts");
const PAGE = code("src/app/dashboard/leads/brief/page.tsx");
const LEADS_PAGE = code("src/app/dashboard/leads/page.tsx");
const PRIORITIES = code("src/components/leadBrief/BriefPrioritiesEditor.tsx");
const AREA = code("src/components/leadBrief/BriefAreaEditor.tsx");
const VIEW = code("src/components/leadBrief/BriefPreviewView.tsx");
const PENDING = code("src/components/leadBrief/BriefPendingChange.tsx");
const WHY = code("src/components/leadBrief/WhyThisLead.tsx");
const FILTER_PAGE = code("src/app/dashboard/filtering/page.tsx");
const VERCEL = JSON.parse(readFileSync("vercel.json", "utf8")) as {
  crons: { path: string; schedule: string }[];
};

describe("the editor routes are the customer's own, session only", () => {
  for (const [name, src] of [
    ["edit", EDIT_ROUTE],
    ["edit/preview", EDIT_PREVIEW],
  ] as const) {
    it(`${name}: identity from the session, gated on canEditLeadBrief before the body is read`, () => {
      expect(src).toContain("await getCurrentCustomer()");
      expect(src).not.toMatch(/resolveCaller|x-admin-key|CRON_SECRET/);
      const gate = src.indexOf("!canEditLeadBrief(customer)");
      expect(gate).toBeGreaterThan(-1);
      expect(gate).toBeLessThan(src.indexOf("await req.json()"));
      expect(src.slice(gate, gate + 160)).toContain("status: 403");
    });

    it(`${name}: never reads a customer id, plan or ranking from the body`, () => {
      expect(src).not.toMatch(/body\.customerId|body\.customer_id|body\.plan\b|parsed\.plan|body\.allocation/);
    });
  }

  it("DELETE (cancel) is gated too, and deletes only this customer's scheduled row", () => {
    const del = EDIT_ROUTE.slice(EDIT_ROUTE.indexOf("export async function DELETE"));
    expect(del).toContain("!canEditLeadBrief(customer)");
    expect(del).toContain('.eq("customer_id", customer.id)');
    expect(del).toContain('.eq("status", "scheduled")');
  });
});

describe("the edit route", () => {
  it("refuses a stale screen before any write (409 conflict)", () => {
    const check = EDIT_ROUTE.indexOf("active.id !== body.expectedActiveId");
    expect(check).toBeGreaterThan(-1);
    expect(EDIT_ROUTE.slice(check, check + 120)).toContain('code: "conflict"');
    expect(check).toBeLessThan(EDIT_ROUTE.indexOf('admin.rpc("promote_lead_brief"'));
    expect(check).toBeLessThan(EDIT_ROUTE.indexOf('admin.rpc("save_scheduled_lead_brief"'));
  });

  it("a conflict from 0164 is a 409, from both kinds", () => {
    expect(EDIT_ROUTE.match(/if \(result === "conflict"\) return NextResponse\.json\(\{ code: "conflict" \}, \{ status: 409 \}\);/g)).toHaveLength(2);
  });

  it("priorities: judged by buildEditedPriorities against the stored brief, 400 when nothing changed, applied now", () => {
    const p = EDIT_ROUTE.slice(EDIT_ROUTE.indexOf('if (body.kind === "priorities")'));
    expect(p).toContain("buildEditedPriorities({");
    expect(p).toContain("essentials: (active.essentials ?? [])");
    expect(p).toContain('if (!built.changed) return NextResponse.json({ code: "nothing_changed" }, { status: 400 });');
    expect(p).toContain("carryEditToScheduled({");
    expect(p).toContain("p_source_id: null,");
    expect(p).toContain("p_locked_until: null,");
  });

  it("area: recomputed against live supply, never trusted from the browser", () => {
    const a = EDIT_ROUTE.slice(EDIT_ROUTE.indexOf("const parsed = parseBriefBody(body.body);"));
    expect(a.length).toBeLessThan(EDIT_ROUTE.length);
    expect(a).toContain("computeBriefForCustomer(");
    expect(a).toContain("{ autoTickRecommended: false }");
    expect(a).toContain("keptForRecompute(stored,");
  });

  it("area: 400 when it is the current brief, before any compute", () => {
    const same = EDIT_ROUTE.indexOf("if (sameAreaAnswers(active, normalised.brief))");
    expect(same).toBeGreaterThan(-1);
    expect(EDIT_ROUTE.slice(same, same + 120)).toContain('code: "nothing_changed"');
    expect(same).toBeLessThan(EDIT_ROUTE.indexOf("computeBriefForCustomer("));
  });

  it("area: 409 radius_changed with a fresh client preview, before the save", () => {
    const r = EDIT_ROUTE.indexOf("if (preview.serviceRadiusMiles !== parsed.shownRadiusMiles)");
    expect(r).toBeGreaterThan(-1);
    const block = EDIT_ROUTE.slice(r, r + 300);
    expect(block).toContain('code: "radius_changed"');
    expect(block).toContain("preview: previewForClient(preview)");
    expect(block).toContain("status: 409");
    expect(r).toBeLessThan(EDIT_ROUTE.indexOf('admin.rpc("save_scheduled_lead_brief"'));
  });

  it("area: saved as the scheduled version, with the customer's chosen levels marked", () => {
    expect(EDIT_ROUTE).toContain('status: "scheduled",');
    expect(EDIT_ROUTE).toContain("chosenKeys: Object.keys(kept.thresholds)");
    expect(EDIT_ROUTE).toContain("startsOn: nextGrantDate(");
  });

  it("a supply or versions failure is a 503, never an empty answer (§58)", () => {
    expect(EDIT_ROUTE).toContain('return NextResponse.json({ code: "supply_unavailable" }, { status: 503 });');
    expect(EDIT_PREVIEW).toContain('return NextResponse.json({ code: "supply_unavailable" }, { status: 503 });');
  });

  it("the outcode lists never reach a response (A4)", () => {
    for (const src of [EDIT_ROUTE, EDIT_PREVIEW]) {
      for (const m of Array.from(src.matchAll(/NextResponse\.json\(([\s\S]*?)\)\s*;/g))) {
        expect(m[1]).not.toMatch(/serviceOutcodes|paceOutcodes|firstPickOutcodes|supplyCheck|service_outcodes|BRIEF_VERSION_COLUMNS/);
      }
    }
    expect(EDIT_PREVIEW).toContain("preview: previewForClient(result.preview)");
  });

  it("the preview takes the ranking and chosen levels from the STORED brief", () => {
    expect(EDIT_PREVIEW).toContain("keptForRecompute(readStoredPriorities(versions.active.priorities)");
    expect(EDIT_PREVIEW).toContain("{ autoTickRecommended: false }");
  });
});

describe("the renewal cron", () => {
  it("is registered for 00:20 UTC, after the 00:05 reset", () => {
    expect(VERCEL.crons).toContainEqual({ path: "/api/cron/activate-lead-briefs", schedule: "20 0 * * *" });
  });

  it("uses the house cron auth pattern, failing closed, with an admin fallback", () => {
    expect(CRON).toContain("const viaCron = Boolean(cronSecret) && auth === `Bearer ${cronSecret}`;");
    expect(CRON).toContain("if (!isAdminUser(user))");
    expect(CRON).toContain("export async function GET");
    expect(CRON).toContain("export async function POST");
  });

  it("a failed due-list read is a 500, never 'nothing due'", () => {
    const read = CRON.indexOf('admin.rpc("due_scheduled_lead_briefs")');
    expect(CRON.slice(read, read + 360)).toContain("status: 500");
  });

  it("skips a change saved for a different plan", () => {
    const skip = CRON.indexOf("if (briefPlanFor(c) !== row.allocation)");
    expect(skip).toBeGreaterThan(-1);
    expect(CRON.slice(skip, skip + 400)).toContain("continue;");
    expect(skip).toBeLessThan(CRON.indexOf('admin.rpc("promote_lead_brief"'));
  });

  it("dryRun writes nothing", () => {
    const dry = CRON.indexOf("if (dryRun) {");
    expect(dry).toBeGreaterThan(-1);
    expect(CRON.slice(dry, dry + 80)).toContain("continue;");
    expect(dry).toBeLessThan(CRON.indexOf('admin.rpc("promote_lead_brief"'));
  });

  it("promotes the due row from its source, locked until the next renewal", () => {
    expect(CRON).toContain("p_source_id: row.brief_id,");
    expect(CRON).toContain("p_locked_until: lockedUntil,");
    expect(CRON).toContain("p_expected_active_id: row.active_id,");
  });

  it("one customer's failure never stops the others", () => {
    const loop = CRON.slice(CRON.indexOf("for (const row of due) {"));
    expect(loop.trimStart().startsWith("for (const row of due) {\n    try {")).toBe(true);
    expect(loop).toContain("} catch (err) {");
    expect(loop).not.toMatch(/\bthrow\b/);
    expect(loop.slice(0, loop.indexOf("} catch (err) {"))).not.toMatch(/return NextResponse/);
  });
});

describe("the page and the bar", () => {
  it("the page is for brief customers only, everyone else goes to their leads", () => {
    const gate = PAGE.indexOf('if (!customer || !canEditLeadBrief(customer)) redirect("/dashboard/leads");');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(PAGE.indexOf("loadBriefVersions("));
  });

  it("viewing as the customer is read-only (§62)", () => {
    expect(PAGE).toContain("const readOnly = Boolean(viewAs);");
    expect(PAGE.match(/readOnly=\{readOnly\}/g)).toHaveLength(3);
  });

  it("the page hands the browser no outcode list (A4)", () => {
    expect(PAGE).not.toMatch(/service_outcodes|pace_outcodes|first_pick_outcodes/);
  });

  it("the plan-changed warning compares the saved plan with the customer's", () => {
    expect(PAGE).toContain("briefPlanFor(customer) !== scheduled.allocation");
  });

  it("the bar renders only for a customer who has confirmed a brief", () => {
    const gate = LEADS_PAGE.indexOf("if (canEditLeadBrief(customer)) {");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(LEADS_PAGE.indexOf("loadBriefVersions("));
    expect(LEADS_PAGE).toContain("{briefBar && <BriefSummaryBar");
  });

  it("a failed read hides the bar rather than breaking the leads page", () => {
    const c = LEADS_PAGE.indexOf("} catch (err) {");
    expect(LEADS_PAGE.slice(c, c + 160)).toContain("BriefVersionsUnavailableError");
  });

  it("every static page under /dashboard/leads is laid out as a page, not a lead's workspace", () => {
    const statics = readdirSync("src/app/dashboard/leads", { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("["))
      .map((e) => e.name);
    expect(statics).toContain("brief");
    for (const name of statics) expect(isColumnsPath(`/dashboard/leads/${name}`)).toBe(false);
  });
});

describe("the components", () => {
  it("the priorities editor sends only the levels the customer changed", () => {
    expect(PRIORITIES).toContain("if (value === stored) delete next[key];");
    expect(PRIORITIES).toContain('JSON.stringify({ kind: "priorities", expectedActiveId: props.activeId, ranking, levels })');
  });

  it("an essential's level is shown, never offered as a select", () => {
    const ess = PRIORITIES.indexOf("{essential ? (");
    expect(ess).toBeGreaterThan(-1);
    const shown = PRIORITIES.slice(ess, PRIORITIES.indexOf(") : (", ess));
    expect(shown).not.toContain("<select");
    expect(shown).toContain("EDIT_COPY.priorities.essentialNote");
  });

  it("the area editor never offers the plan switch", () => {
    expect(AREA).toContain("allowSwitch={false}");
    expect(AREA).not.toContain("/api/customer/subscription/plan");
    expect(VIEW).toContain("p.bottleneck.canSwitchToSmallerPlan && allowSwitch &&");
    expect(VIEW).toContain("{allowSwitch && props.switchOpen && (");
  });

  it("the area editor saves the radius it showed and the areas ticked", () => {
    expect(AREA).toContain('kind: "area",');
    expect(AREA).toContain("shownRadiusMiles: preview.serviceRadiusMiles,");
    expect(AREA).toContain("similarAreas: ticked,");
    expect(AREA).toContain('fetch("/api/customer/lead-brief/edit/preview"');
  });

  it("a change saved for another plan never shows a start date it will not keep", () => {
    const c = PENDING.indexOf("{props.planChanged ? (");
    expect(c).toBeGreaterThan(-1);
    const branch = PENDING.slice(c, PENDING.indexOf(")}", c));
    expect(branch.indexOf("EDIT_COPY.planChanged")).toBeLessThan(branch.indexOf("pendingLine("));
    expect(LEADS_PAGE).toContain("briefPlanFor(customer) !== versions.scheduled.allocation");
    const bar = LEADS_PAGE.indexOf("briefPlanFor(customer) !== versions.scheduled.allocation");
    expect(LEADS_PAGE.slice(bar, bar + 120)).toContain("EDIT_COPY.pendingReview");
  });

  it("cancel calls DELETE on the edit route", () => {
    expect(PENDING).toContain('fetch("/api/customer/lead-brief/edit", { method: "DELETE" })');
  });

  it("the Nearby tip and the filtering notice link to the editor", () => {
    expect(WHY).toContain("<Link href={BRIEF_EDITOR_HREF}");
    const tip = WHY.indexOf("{tip && (");
    expect(WHY.slice(tip, tip + 400)).toContain("BRIEF_EDITOR_HREF");
    expect(FILTER_PAGE).toContain("{canEditLeadBrief(customer) && (");
    expect(FILTER_PAGE).toContain("href={BRIEF_EDITOR_HREF}");
  });
});
