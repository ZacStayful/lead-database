import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * File-text guards for the confirm-on-login screen (batch 04 Phase 3). Read
 * from the real files rather than a restatement of them (§42.8), comments
 * stripped first, because the wiring here (a gate in the layout, a cron in
 * vercel.json, what a client component is handed) is exactly what a
 * behavioural unit test cannot reach.
 */
function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
const read = (p: string) => strip(readFileSync(p, "utf8"));

const LAYOUT = read("src/app/dashboard/layout.tsx");
const PAGE = read("src/app/onboarding/area/page.tsx");
const SCREEN = read("src/components/leadBrief/AreaConfirmScreen.tsx");
const MAP = read("src/components/leadBrief/AreaChangeMap.tsx");
const CRON = read("src/app/api/cron/accept-lead-brief-areas/route.ts");
const LIB = read("src/lib/briefAreaConfirm.ts");
const COPY = read("src/lib/leadBrief/areaConfirmCopy.ts");
const MIGRATION = readFileSync("supabase/migrations/0169_brief_area_confirm.sql", "utf8");
const VERCEL = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons: { path: string; schedule: string }[] };

describe("the gate in the dashboard layout", () => {
  it("sits after the Lead Brief gate and sends a waiting customer to the screen", () => {
    const brief = LAYOUT.indexOf('redirect("/onboarding/brief")');
    const area = LAYOUT.indexOf("redirect(AREA_CONFIRM_PATH)");
    expect(brief).toBeGreaterThan(-1);
    expect(area).toBeGreaterThan(brief);
  });

  it("is skipped while an admin views the customer (§62), and reads only for brief customers", () => {
    const block = LAYOUT.slice(LAYOUT.indexOf('redirect("/onboarding/brief")'), LAYOUT.indexOf("redirect(AREA_CONFIRM_PATH)"));
    expect(block).toMatch(/!viewAs\s*&&\s*canEditLeadBrief\(customer\)\s*&&\s*needsAreaConfirmation\(/);
    // The read sits inside the condition, after canEditLeadBrief: an existing
    // customer never pays the query.
    expect(block.indexOf("canEditLeadBrief(customer)")).toBeLessThan(block.indexOf("pendingAreaRead("));
  });

  it("the layout loads only the small read module, never the confirm library", () => {
    expect(LAYOUT).toContain('from "@/lib/leadBrief/pendingArea"');
    expect(LAYOUT).not.toContain("@/lib/briefAreaConfirm");
  });
});

describe("the screen is given no outcode list (A4)", () => {
  it("the page hands the client component radii, a point, dates and ids only", () => {
    expect(PAGE).not.toMatch(/service_outcodes|first_pick_outcodes|pace_outcodes|serviceOutcodes|firstPickOutcodes/);
    expect(SCREEN).not.toMatch(/service_outcodes|first_pick_outcodes|pace_outcodes|serviceOutcodes|firstPickOutcodes|Outcodes/);
    expect(MAP).not.toMatch(/Outcodes|outcodes/);
  });

  it("the view the page renders from has no outcode field", () => {
    const view = LIB.slice(LIB.indexOf("export interface AreaConfirmView"), LIB.indexOf("export type AreaConfirmLoad"));
    expect(view).not.toMatch(/outcode/i);
  });

  it("the client files import nothing server-side", () => {
    for (const src of [SCREEN, MAP]) {
      expect(src).not.toMatch(/@\/lib\/supabase|@\/lib\/briefAreaConfirm|@\/lib\/outcodes|@\/lib\/emails/);
    }
    expect(COPY).not.toMatch(/^import /m);
  });
});

describe("the 72-hour auto-accept", () => {
  it("is registered daily in vercel.json, after the 08:00 resume cron", () => {
    const entry = VERCEL.crons.find((c) => c.path === "/api/cron/accept-lead-brief-areas");
    expect(entry?.schedule).toBe("35 8 * * *");
    expect(VERCEL.crons.find((c) => c.path === "/api/cron/resume-paused-subscriptions")?.schedule).toBe("0 8 * * *");
  });

  it("selects pending versions 72 hours past their effective date and confirms them as auto", () => {
    expect(CRON).toContain("const AUTO_ACCEPT_AFTER_HOURS = 72;");
    expect(CRON).toMatch(/\.eq\("status", "pending_confirmation"\)\s*\.lte\("effective_at", dueBefore\)/);
    expect(CRON).toMatch(/auto: true/);
    expect(CRON).toContain("sendAutoAcceptEmail(");
  });

  it("a failed due-list read is a 500, never a quiet 'nothing due'", () => {
    expect(CRON).toMatch(/if \(dueError\)[\s\S]{0,200}status: 500/);
  });

  it("uses the cron auth pattern that fails closed when the secret is unset", () => {
    expect(CRON).toContain("Boolean(cronSecret) && auth === `Bearer ${cronSecret}`");
  });
});

describe("0169", () => {
  it("adds two new functions and replaces no existing one (C10)", () => {
    const names = Array.from(MIGRATION.matchAll(/create or replace function public\.(\w+)/g)).map((m) => m[1]);
    expect(names).toEqual(["confirm_pending_lead_brief", "extend_brief_pause"]);
  });

  it("contains no delete statement (the Supabase apply tool hangs on one)", () => {
    expect(MIGRATION.replace(/^\s*--.*$/gm, "")).not.toMatch(/\bdelete\s+from\b/i);
  });

  it("supersedes the active row before making the pending one active", () => {
    const fn = MIGRATION.slice(MIGRATION.indexOf("function public.confirm_pending_lead_brief"));
    const supersede = fn.indexOf("set status = 'superseded'");
    const activate = fn.indexOf("set status = 'active'");
    expect(supersede).toBeGreaterThan(-1);
    expect(activate).toBeGreaterThan(supersede);
  });

  it("both functions take the brief's advisory lock", () => {
    expect(MIGRATION.match(/pg_advisory_xact_lock\(hashtextextended\('lead_brief:' \|\| p_customer_id::text, 0\)\)/g)).toHaveLength(2);
  });
});

describe("confirming restarts only what it should", () => {
  it("the restart runs after the confirm RPC, and only when the timing says so", () => {
    const fn = LIB.slice(LIB.indexOf("export async function confirmPendingArea"), LIB.indexOf("export async function sendAutoAcceptEmail"));
    const rpc = fn.indexOf('rpc("confirm_pending_lead_brief"');
    const restart = fn.indexOf("resumePausedCustomer(");
    expect(rpc).toBeGreaterThan(-1);
    expect(restart).toBeGreaterThan(rpc);
    expect(fn).toMatch(/if \(timing\.resumeNow\)/);
    // A pending cancellation is never restarted (the cron's own rule).
    expect(fn.indexOf("resumeRefusalReason(customer)")).toBeLessThan(restart);
  });
});
