import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The Phase 4 wiring, pinned on the real files (§42.8: a test that restates a
 * query proves nothing about the one that runs). Comments are stripped first
 * so an explanation can never satisfy a guard.
 */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\s+/g, " ");
}

/** One SQL function body from a migration file, comments stripped, whitespace collapsed. */
function sqlFunction(path: string, name: string): string {
  const text = readFileSync(path, "utf8");
  const start = text.indexOf(`create or replace function public.${name}(`);
  expect(start).toBeGreaterThan(-1);
  const bodyOpen = text.indexOf("$$", start);
  const bodyClose = text.indexOf("$$;", bodyOpen + 2);
  return text
    .slice(start, bodyClose + 3)
    .replace(/--[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const INGEST = code("src/lib/ingest.ts");
const RELEASE = code("src/lib/releaseLeads.ts");
const BRIEF_RELEASE = code("src/lib/leadBrief/briefRelease.ts");
const ROUTING = code("src/lib/leadBrief/routing.ts");
const ESCALATE = code("src/app/api/cron/escalate-leads/route.ts");
const M0163 = "supabase/migrations/0163_lead_brief_routing.sql";

describe("0163 — the legacy pools change by one predicate and nothing else", () => {
  const ADDED = " and not c.lead_brief_required";

  it("get_filtered_candidates_for_lead is 0159's body plus the one predicate", () => {
    const live = sqlFunction("supabase/migrations/0159_filter_min_gross_predicates.sql", "get_filtered_candidates_for_lead");
    const next = sqlFunction(M0163, "get_filtered_candidates_for_lead");
    expect(next.split(ADDED).length - 1).toBe(1);
    expect(next.replace(ADDED, "")).toBe(live);
  });

  it("get_unfiltered_candidates_for_lead is 0154's body plus the one predicate", () => {
    const live = sqlFunction("supabase/migrations/0154_fresh_lead_release.sql", "get_unfiltered_candidates_for_lead");
    const next = sqlFunction(M0163, "get_unfiltered_candidates_for_lead");
    expect(next.split(ADDED).length - 1).toBe(1);
    expect(next.replace(ADDED, "")).toBe(live);
  });

  it("adds it in the management arm, never the GR arm (invariant 6)", () => {
    for (const name of ["get_filtered_candidates_for_lead", "get_unfiltered_candidates_for_lead"]) {
      const body = sqlFunction(M0163, name);
      const mgmt = body.indexOf("p_lead_type = 'management'");
      const gr = body.indexOf("p_lead_type = 'guaranteed_rent'", mgmt);
      const at = body.indexOf(ADDED);
      expect(mgmt).toBeGreaterThan(-1);
      expect(at).toBeGreaterThan(mgmt);
      expect(at).toBeLessThan(gr);
    }
  });

  it("the brief pool takes no defaults and is service-role only", () => {
    const text = readFileSync(M0163, "utf8");
    const sig = sqlFunction(M0163, "get_brief_candidates_for_lead");
    expect(sig).toContain("p_lead_id uuid, p_max integer, p_include_pace boolean )");
    expect(sig.slice(0, sig.indexOf("returns"))).not.toContain("default");
    expect(text).toContain(
      "revoke execute on function public.get_brief_candidates_for_lead(uuid, integer, boolean) from public, anon, authenticated;"
    );
    expect(text).toContain(
      "grant execute on function public.get_brief_candidates_for_lead(uuid, integer, boolean) to service_role;"
    );
  });

  it("the brief pool applies the release curve and every legacy gate", () => {
    const body = sqlFunction(M0163, "get_brief_candidates_for_lead");
    for (const gate of [
      "not public.lead_retired_from_allocation(p_lead_id)",
      "c.is_active = true",
      "c.account_status = 'active'",
      "c.subscription_status = 'active'",
      "c.lead_balance > 0",
      "c.paused_at is null",
      "c.lead_brief_completed_at is not null",
      "public.customer_release_allows(c.id, 'management', l.created_at)",
      "b.status = 'active'",
    ]) {
      expect(body).toContain(gate);
    }
  });

  it("reads the pace percentage with the same pattern as the pacing.ts mirror", () => {
    const sql = readFileSync(M0163, "utf8");
    const pacing = readFileSync("src/lib/pacing.ts", "utf8");
    expect(sql).toContain("trim(value) ~ '^[0-9]+(\\.[0-9]+)?$'");
    expect(pacing).toContain("/^[0-9]+(\\.[0-9]+)?$/");
    expect(sql).toContain("deficit >= ceil(cand.monthly_allocation * pace_pct.pct / 100.0)");
    expect(code("src/lib/pacing.ts")).toContain(
      "Math.ceil((customer.monthly_allocation * pct) / 100)"
    );
  });
});

describe("autoAssignLead — brief customers last, and only behind the switch", () => {
  it("reads the brief pool only for a Management lead, with legacy slots left, while the switch is on", () => {
    const at = INGEST.indexOf("brief = await fetchRankedBriefCandidates(");
    const guard = INGEST.slice(INGEST.lastIndexOf("if (", at), at);
    expect(guard).toContain('briefMode !== "exclude"');
    expect(guard).toContain('leadType === "management"');
    expect(guard).toContain("selectCombinedCandidates(filtered, unfiltered, slots).length < slots");
    expect(guard).toContain("await briefRoutingEnabled(supabase)");
  });

  it("hands the brief list to the merge as its fourth argument", () => {
    expect(INGEST).toContain(
      "const customerIds = selectCombinedCandidates(filtered, unfiltered, slots, brief);"
    );
  });

  it("skips the legacy pools only in a brief-only pass", () => {
    const at = INGEST.indexOf('supabase.rpc("get_filtered_candidates_for_lead"');
    expect(INGEST.slice(INGEST.lastIndexOf("if (", at), at)).toContain('briefMode !== "only"');
  });

  it("escalation still merges the two legacy pools only (C14)", () => {
    const at = ESCALATE.indexOf("selectCombinedCandidates(");
    const call = ESCALATE.slice(at, ESCALATE.indexOf(");", at));
    expect(call.split(",").length).toBe(3);
  });

  it("labels a delivery in completeAssignment, right after the customer is loaded", () => {
    const loaded = INGEST.indexOf("if (!typedCustomer) return;");
    const label = INGEST.indexOf("await recordBriefMatch(supabase, typedCustomer, lead, assignmentId);");
    const alerts = INGEST.indexOf("const wantsNewLead = wantsNotification(");
    expect(loaded).toBeGreaterThan(-1);
    expect(label).toBeGreaterThan(loaded);
    expect(alerts).toBeGreaterThan(label);
  });
});

describe("the morning release", () => {
  it("runs its ordinary pass with brief customers left out", () => {
    expect(RELEASE).toContain('await autoAssignLead(admin, lead, { brief: "exclude" });');
    expect(RELEASE).not.toMatch(/autoAssignLead\(admin, lead\)/);
  });

  it("runs the brief passes after a complete ordinary pass, Management only", () => {
    const loopEnd = RELEASE.indexOf('await autoAssignLead(admin, lead, { brief: "exclude" });');
    const brief = RELEASE.indexOf("await releaseToBriefCustomers(admin,");
    expect(brief).toBeGreaterThan(loopEnd);
    const guard = RELEASE.slice(RELEASE.lastIndexOf("if (", brief), brief);
    expect(guard).toContain("!truncated");
    expect(guard).toContain('opts.leadType !== "guaranteed_rent"');
  });

  it("brief passes do nothing while the switch is off", () => {
    const start = BRIEF_RELEASE.indexOf("export async function releaseToBriefCustomers(");
    const firstRead = BRIEF_RELEASE.indexOf(".from(", start);
    const gate = BRIEF_RELEASE.indexOf("if (!(await briefRoutingEnabled(admin)))", start);
    expect(gate).toBeGreaterThan(start);
    expect(gate).toBeLessThan(firstRead);
  });

  it("pass 2 offers first sales first and never the pace tier", () => {
    expect(BRIEF_RELEASE).toContain(".sort(firstSaleOrder)");
    expect(BRIEF_RELEASE).toContain('brief: "only", includePace: false,');
  });

  it("pass 3 re-checks every pace lead in SQL and assigns only that customer", () => {
    const at = BRIEF_RELEASE.indexOf('admin.rpc( "assign_lead_to_customer"');
    const before = BRIEF_RELEASE.slice(0, at);
    expect(before.lastIndexOf('admin.rpc("get_brief_candidates_for_lead"')).toBeGreaterThan(-1);
    expect(before.slice(before.lastIndexOf('admin.rpc("get_brief_candidates_for_lead"'))).toContain(
      "p_include_pace: true"
    );
    expect(before).toContain("if (!admitted) continue;");
    expect(BRIEF_RELEASE.slice(at, at + 200)).toContain("p_customer_id: b.customer_id");
  });
});

describe("routing.ts — the switch and the label", () => {
  it("the switch fails closed and never caches a failed read", () => {
    const start = ROUTING.indexOf("export async function briefRoutingEnabled(");
    const errAt = ROUTING.indexOf("if (error) {", start);
    const cacheAt = ROUTING.indexOf("switchCache = {", start);
    expect(ROUTING.slice(errAt, ROUTING.indexOf("}", errAt))).toContain("return false;");
    expect(cacheAt).toBeGreaterThan(errAt);
    expect(ROUTING).toContain(`.trim() === "true"`);
  });

  it("labels brief customers' Management leads only", () => {
    expect(ROUTING).toContain(
      'if (!isBriefCustomer(customer) || lead.lead_type !== "management") return null;'
    );
  });

  it("calls a sale first only when no other assignment row exists, and a failed count is not first", () => {
    expect(ROUTING).toContain('.eq("lead_id", lead.id) .neq("id", assignmentId);');
    expect(ROUTING).toContain("const isFirstSale = !others.error && others.count === 0;");
  });

  it("never relabels, and reads the active brief only", () => {
    expect(ROUTING).toContain('.eq("id", assignmentId) .is("match_label", null);');
    expect(ROUTING).toContain('.eq("status", "active")');
  });

  it("a brief pool failure is an empty list, never a stopped placement", () => {
    const start = ROUTING.indexOf("export async function fetchRankedBriefCandidates(");
    const errAt = ROUTING.indexOf("if (error) {", start);
    expect(ROUTING.slice(errAt, ROUTING.indexOf("}", ROUTING.indexOf("});", errAt) + 3))).toContain(
      "return [];"
    );
  });
});
