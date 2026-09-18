import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STAYFUL_PIPELINE_CONFLICT_GROUPS } from "@/lib/monday";
import { MESSAGING_SETTINGS } from "@/lib/messaging/adminSettings";
import { STAYFUL_INDEX_TTL_MS, STAYFUL_CONFLICT_SETTING } from "@/lib/stayfulConflictIndex";
import { STAYFUL_SWEEP_BUDGET_MS } from "@/lib/stayfulConflictSweep";

/**
 * Guards on the Stayful-pipeline conflict feature (§64). The flag, the sweep
 * and the fulfilment all reach Monday and the database, so what §64 argues
 * for is pinned on the real files (§42.8), comments stripped so a guard
 * cannot be satisfied by its own explanation:
 *
 *   - the sweep is scheduled every fifteen minutes, parsed not matched;
 *   - maxDuration is 60; the wall clock and the cache TTL are LITERALS;
 *   - a failed settings read is a 500 ABOVE the kill switch (§18.3), and a
 *     dry run is allowed for an admin while the switch is off;
 *   - the sweep never flags anything on a failed board read, while ingest
 *     fails OPEN — two deliberately different directions;
 *   - autoAssignLead refuses a flagged lead BEFORE the contention write, and
 *     serves owed replacements BEFORE ordinary routing;
 *   - the insert path stamps the flag BEFORE the insert (0111's argument);
 *   - every replacement delivery goes through completeAssignment with
 *     threshold warnings OFF (no credit moved);
 *   - the morning release and the volume forecast both exclude flagged leads;
 *   - the pipeline read uses a GROUP rule over exactly nine groups, re-checks
 *     the group client-side, and treats an empty result as a failure;
 *   - 0155 seeds the switch OFF, puts the arm FIRST, adds the pool clause, and
 *     gives the fulfilment NO filter override;
 *   - the admin-swap uphold email deep-links the LEAD id, not the assignment.
 */
const route = readFileSync("src/app/api/cron/stayful-conflict-sweep/route.ts", "utf8");
const sweep = readFileSync("src/lib/stayfulConflictSweep.ts", "utf8");
const indexLib = readFileSync("src/lib/stayfulConflictIndex.ts", "utf8");
const owed = readFileSync("src/lib/owedReplacements.ts", "utf8");
const ingest = readFileSync("src/lib/ingest.ts", "utf8");
const monday = readFileSync("src/lib/monday.ts", "utf8");
const release = readFileSync("src/lib/releaseLeads.ts", "utf8");
const prediction = readFileSync("src/lib/filterPrediction.ts", "utf8");
const allocation = readFileSync("src/app/admin/allocation/page.tsx", "utf8");
const assignRoute = readFileSync("src/app/api/admin/assign/route.ts", "utf8");
const bulkRoute = readFileSync("src/app/api/admin/assign/bulk/route.ts", "utf8");
const claimsRoute = readFileSync("src/app/api/admin/quality-claims/[id]/route.ts", "utf8");
const panel = readFileSync("src/components/admin/StayfulConflictPanel.tsx", "utf8");
const migration = readFileSync("supabase/migrations/0155_stayful_pipeline_conflict.sql", "utf8");
const vercel = readFileSync("vercel.json", "utf8");

const code = (src: string) => src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const sql = (src: string) => src.replace(/^\s*--.*$/gm, "");

function slice(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  expect(a, `marker not found: ${from}`).toBeGreaterThan(-1);
  const b = text.indexOf(to, a + from.length);
  expect(b, `marker not found: ${to}`).toBeGreaterThan(-1);
  return text.slice(a, b);
}

describe("the sweep route", () => {
  it("is scheduled every fifteen minutes", () => {
    const crons = JSON.parse(vercel).crons as { path: string; schedule: string }[];
    const entry = crons.find((c) => c.path === "/api/cron/stayful-conflict-sweep");
    expect(entry).toBeDefined();
    expect(entry?.schedule).toBe("*/15 * * * *");
  });

  it("keeps a 60-second ceiling", () => {
    expect(code(route)).toMatch(/export const maxDuration = 60;/);
  });

  it("reads its switch through the settings gate and aborts with a 500 above the kill switch", () => {
    const c = code(route);
    const gate = c.indexOf("resolveSettingsGate(");
    const failed = c.indexOf('gate.reason === "read_failed"', gate);
    const abort = c.indexOf("status: 500", failed);
    const kill = c.indexOf("config.get(STAYFUL_CONFLICT_SETTING)", abort);
    expect(gate).toBeGreaterThan(-1);
    expect(failed).toBeGreaterThan(gate);
    expect(abort).toBeGreaterThan(failed);
    expect(kill).toBeGreaterThan(abort);
  });

  it("lets an admin dry-run while the switch is off, and nobody else", () => {
    expect(code(route)).toContain("!(dryRun && !viaCron)");
  });

  it("reads the same key the ingest cache reads", () => {
    expect(STAYFUL_CONFLICT_SETTING).toBe("stayful_conflict_enabled");
    expect(code(route)).toContain("SETTING_KEYS = [STAYFUL_CONFLICT_SETTING]");
  });
});

describe("the two literals are pinned, not derived (§57's lesson)", () => {
  it("caches the pipeline index for ten minutes", () => {
    expect(STAYFUL_INDEX_TTL_MS).toBe(600_000);
    expect(code(indexLib)).toMatch(/STAYFUL_INDEX_TTL_MS = 600_000;/);
  });

  it("gives the sweep a 45-second wall clock inside the 60-second ceiling", () => {
    expect(STAYFUL_SWEEP_BUDGET_MS).toBe(45_000);
    expect(code(sweep)).toMatch(/STAYFUL_SWEEP_BUDGET_MS = 45_000;/);
    expect(STAYFUL_SWEEP_BUDGET_MS).toBeLessThan(60_000);
  });
});

describe("the sweep and ingest fail in opposite directions, on purpose", () => {
  it("the sweep flags NOTHING on a failed board read", () => {
    // ⚠️ Anchored on the BLOCK, not on "a return somewhere after the check":
    // the dry-run branch also returns result before any flag, so a guard
    // written as indexOf("return result;", bad) passed with the early return
    // deleted — §50.9's shape, found by the mutation run.
    const c = code(sweep);
    expect(c).toMatch(
      /if \(!board\.ok\) \{\s*result\.ok = false;\s*result\.errors\.push\(board\.error\);\s*return result;\s*\}/
    );
    const bad = c.indexOf("if (!board.ok)");
    const flag = c.indexOf("flagStayfulConflictLead(");
    expect(bad).toBeGreaterThan(-1);
    expect(flag).toBeGreaterThan(bad);
  });

  it("the sweep examines only unflagged, marketplace, management leads", () => {
    const c = code(sweep);
    expect(c).toContain('.eq("lead_type", "management")');
    expect(c).toContain('.is("stayful_conflict_at", null)');
    expect(c).toContain('.is("owner_customer_id", null)');
  });

  it("ingest proceeds unchecked when the settings or the board cannot be read", () => {
    const c = code(indexLib);
    expect(c).toContain("enabled: false, index: null, error: \"settings_read_failed\"");
    expect(c).toContain("enabled: true, index: null, error: fetched.error");
    // And a failure is cached, so one outage is not 250 failed reads.
    expect(c).toMatch(/cache = \{ at: now, value \};/);
  });

  it("owed fulfilment on an arriving lead fails OPEN on a failed read", () => {
    const c = code(owed);
    const fn = slice(c, "export async function fulfilOwedReplacementsForLead", "export async function fulfilOpenOwedFromStock");
    const err = fn.indexOf("if (error)");
    expect(err).toBeGreaterThan(-1);
    expect(fn.indexOf("return 0;", err)).toBeGreaterThan(err);
    expect(fn).not.toContain("throw");
  });
});

describe("autoAssignLead", () => {
  const fn = slice(code(ingest), "export async function autoAssignLead", "export async function completeAssignment");

  it("refuses a flagged lead BEFORE the contention write reaches PostgREST", () => {
    const refuse = fn.indexOf("if (isStayfulConflicted(lead)) return 0;");
    const contention = fn.indexOf("max_assignments: CONTENDED_FILTERED_CUSTOMERS");
    expect(refuse).toBeGreaterThan(-1);
    expect(contention).toBeGreaterThan(refuse);
  });

  it("serves owed replacements after the closed check and BEFORE ordinary routing", () => {
    const closed = fn.indexOf('"lead_is_closed"');
    const owedCall = fn.indexOf("fulfilOwedReplacementsForLead(");
    const routing = fn.indexOf('"get_filtered_candidates_for_lead"');
    expect(closed).toBeGreaterThan(-1);
    expect(owedCall).toBeGreaterThan(closed);
    expect(routing).toBeGreaterThan(owedCall);
    expect(fn).toContain("remaining -= owedPlaced;");
    expect(fn).toContain("if (remaining <= 0) return owedPlaced;");
  });
});

describe("ingestLead", () => {
  const c = code(ingest);

  it("stamps the flag on the insert payload BEFORE the insert, and never routes it", () => {
    const stamp = c.indexOf("insertPayload.stayful_conflict_at = ");
    const insert = c.indexOf(".insert(insertPayload)");
    const skip = c.indexOf("if (stayfulConflict) {", insert);
    const route = c.indexOf("autoAssignLead(supabase, typedLead)", insert);
    expect(stamp).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(stamp);
    expect(skip).toBeGreaterThan(insert);
    expect(route).toBeGreaterThan(skip);
  });

  it("re-screens an already-ingested management lead on every sync, and withholds it on a flag failure", () => {
    const dup = slice(c, "if (existingLead.lead_type === \"management\" && !isStayfulConflicted(existingLead))", "const assignmentsMade = await autoAssignLead(supabase, existingLead);");
    expect(dup).toContain("flagStayfulConflictLead(");
    expect(dup).toContain("stayful_conflict: true");
    expect(dup).toContain("assignments_made: 0, stayful_conflict: true");
  });
});

describe("a replacement is a delivery with threshold warnings off", () => {
  it("every owed-path completeAssignment in ingest passes false", () => {
    const calls = code(ingest).match(/=> completeAssignment\([^)]*\)/g) ?? [];
    expect(calls.length).toBe(2);
    for (const call of calls) expect(call).toMatch(/, false\)$/);
  });

  it("the sweep's onAssigned passes false", () => {
    const calls = code(sweep).match(/completeAssignment\([^)]*\)/g) ?? [];
    expect(calls.length).toBe(1);
    expect(calls[0]).toMatch(/, false\)$/);
  });

  it("the owed module never calls completeAssignment itself — it is handed in", () => {
    expect(code(owed)).not.toContain("completeAssignment(");
    expect(code(owed)).not.toContain("@/lib/ingest");
  });
});

describe("flagged leads are out of every supply reading", () => {
  it("the morning release skips them", () => {
    expect(code(release)).toContain('.is("stayful_conflict_at", null)');
  });

  it("the volume forecast selects the stamp and reads it as retired first", () => {
    const c = code(prediction);
    expect(c).toMatch(/pool_entry_basis, stayful_conflict_at"/);
    const fn = slice(c, "function isRetired(", "return claimedLeadIds.has(row.id);");
    const stayful = fn.indexOf("row.stayful_conflict_at != null");
    const expired = fn.indexOf("row.pool_expired_at != null");
    expect(stayful).toBeGreaterThan(-1);
    expect(expired).toBeGreaterThan(stayful);
  });

  it("both admin assign routes refuse a flagged lead, because admin_assign_lead consults no retirement predicate", () => {
    expect(code(assignRoute)).toContain("isStayfulConflicted(");
    expect(code(assignRoute)).toContain('code: "stayful_conflict"');
    expect(code(bulkRoute)).toContain("conflictedLeads");
    expect(code(bulkRoute)).toContain("!isStayfulConflicted(lead)");
  });
});

describe("the pipeline read", () => {
  const fn = slice(code(monday), "export async function fetchStayfulPipelineIndex", "export async function fetchEnquiryItem");

  it("filters on a GROUP rule, not a status rule (§63.2)", () => {
    expect(fn).toContain('column_id: "group"');
    expect(fn).toContain("operator: any_of");
  });

  it("names exactly nine groups, and re-checks the group client-side", () => {
    expect(Object.keys(STAYFUL_PIPELINE_CONFLICT_GROUPS)).toHaveLength(9);
    for (const id of Object.keys(STAYFUL_PIPELINE_CONFLICT_GROUPS)) {
      expect(id).toMatch(/^group_[a-z0-9]+$/);
    }
    expect(fn).toContain("if (!groupSet.has(groupId)) continue;");
  });

  it("treats an empty result as a failure, never an empty index", () => {
    const empty = fn.indexOf("items.length === 0");
    expect(empty).toBeGreaterThan(-1);
    expect(fn.indexOf("ok: false", empty)).toBeGreaterThan(empty);
  });

  it("never throws", () => {
    expect(fn).toContain("catch (err)");
    expect(fn).not.toMatch(/\bthrow\b/);
  });
});

describe("the switch", () => {
  it("is in the closed allow-list, boolean, shipping off", () => {
    const entry = MESSAGING_SETTINGS.find((s) => s.key === "stayful_conflict_enabled");
    expect(entry).toBeDefined();
    expect(entry?.kind).toBe("boolean");
    expect(entry?.fallback).toBe("false");
  });

  it("is rendered on /admin/allocation", () => {
    expect(code(allocation)).toContain('s.key === "stayful_conflict_enabled"');
    expect(code(allocation)).toContain("owed_lead_replacements");
  });
});

describe("migration 0155", () => {
  const s = sql(migration);

  it("seeds the switch OFF", () => {
    expect(s).toMatch(/values \('stayful_conflict_enabled', 'false'\)/);
  });

  it("puts the conflict arm FIRST in lead_retirement_reason and does not touch lead_retired_from_allocation", () => {
    const body = slice(s, "create or replace function public.lead_retirement_reason", "$$;");
    const firstArm = body.match(/then '([a-z_]+)'/);
    expect(firstArm?.[1]).toBe("stayful_conflict");
    expect(s).not.toContain("function public.lead_retired_from_allocation");
  });

  it("adds the pool clause to lead_pool_barred", () => {
    const body = slice(s, "create or replace function public.lead_pool_barred", "$$;");
    expect(body).toContain("l.stayful_conflict_at is not null");
  });

  it("gives the fulfilment NO filter override, and the flag no customer money write", () => {
    const sig = slice(s, "create or replace function public.fulfil_owed_replacement(", "returns uuid");
    expect(sig).not.toContain("mismatch");
    const flag = slice(s, "create or replace function public.flag_stayful_conflict(", "create or replace function public.fulfil_owed_replacement(");
    expect(flag).not.toContain("update public.customers");
    expect(flag).not.toContain("lead_balance");
    expect(flag).not.toContain("replacement_balance");
    for (const f of ["fulfil_owed_replacement(", "fulfil_owed_from_stock("]) {
      const body = slice(s, `create or replace function public.${f}`, "$$;");
      expect(body).not.toContain("update public.customers");
      expect(body).not.toContain("lead_balance");
    }
  });

  it("force-outs a flagged lead from the pool, because customer_can_see_pool_lead never asks lead_pool_barred", () => {
    const flag = slice(s, "create or replace function public.flag_stayful_conflict(", "$$;").replace(/\s+/g, " ");
    expect(flag).toContain("pool_entered_at = null");
    expect(flag).toContain("pool_excluded_at = now()");
    expect(flag).toContain("max_assignments = assignment_count");
  });

  it("keeps the new table deny-all", () => {
    expect(s).toContain("alter table public.owed_lead_replacements enable row level security");
    expect(s).not.toMatch(/create policy[^;]*owed_lead_replacements/);
  });
});

describe("what an admin sees", () => {
  it("the conflict panel is display only — no button, no clear, by decision 7", () => {
    const p = code(panel);
    expect(p).not.toContain("<button");
    expect(p).not.toContain("onClick");
    expect(p.toLowerCase()).not.toContain("override");
  });

  it("the admin-swap uphold email deep-links the LEAD id, not the assignment id", () => {
    const c = code(claimsRoute);
    expect(c).not.toContain("leadId: newAssignmentId");
    expect(c).toContain("leadId: replacementLeadId");
  });
});
