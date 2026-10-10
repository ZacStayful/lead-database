import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

/**
 * Batch 04 Phase 4 (0170), pinned on the real files (§42.8: a test that
 * restates a query proves nothing about the one that runs). Comments are
 * stripped first so an explanation can never satisfy a guard.
 */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\s+/g, " ");
}

/** One SQL function from a migration file, comments stripped, whitespace collapsed. */
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

const M0170 = "supabase/migrations/0170_brief_topups.sql";
const M0170_TEXT = readFileSync(M0170, "utf8");
const BRIEF_RELEASE = code("src/lib/leadBrief/briefRelease.ts");

describe("0170 — the two replaced functions change by one thing each", () => {
  it("get_brief_candidates_for_lead is 0163's body with plan credits in place of any credit", () => {
    const live = sqlFunction("supabase/migrations/0163_lead_brief_routing.sql", "get_brief_candidates_for_lead");
    const next = sqlFunction(M0170, "get_brief_candidates_for_lead");
    const gate = " and c.lead_balance > c.brief_topup_credits ";
    expect(next.split(gate).length - 1).toBe(1);
    expect(next.replace(gate, " and c.lead_balance > 0 ")).toBe(live);
  });

  it("record_lead_topup_success is 0153's body plus one line, on the management branch", () => {
    const live = sqlFunction("supabase/migrations/0153_replacement_balance.sql", "record_lead_topup_success");
    const next = sqlFunction(M0170, "record_lead_topup_success");
    const added =
      " brief_topup_credits = brief_topup_credits + case when coalesce(lead_brief_required, false) then v_tok.credits else 0 end,";
    expect(next.split(added).length - 1).toBe(1);
    expect(next.replace(added, "")).toBe(live);

    // After the management balance, and never touching the GR branch (invariant 6).
    const mgmt = next.indexOf("set lead_balance = lead_balance + v_tok.credits");
    const at = next.indexOf(added);
    expect(mgmt).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(mgmt);
    expect(next.slice(mgmt, at)).not.toContain("gr_");
  });

  it("does not touch assign_lead_to_customer (the build prompt's rule)", () => {
    expect(M0170_TEXT).not.toMatch(/create\s+or\s+replace\s+function\s+public\.assign_lead_to_customer\b/i);
    expect(M0170_TEXT).not.toMatch(/(alter|drop)\s+function\s+public\.assign_lead_to_customer\b/i);
  });
});

describe("0170 — the top-up pool", () => {
  const body = sqlFunction(M0170, "get_brief_topup_candidates_for_lead");

  it("is never inside the service area, and only for somebody with a top-up credit", () => {
    expect(body).toContain("and not (l.outcode = any (coalesce(b.service_outcodes, '{}'::text[])))");
    expect(body).toContain("and c.brief_topup_credits > 0");
    expect(body).toContain("and c.lead_balance > 0");
    expect(body).toContain("least(c.brief_topup_credits, c.lead_balance) as topup_credits");
  });

  it("keeps every other rule: retirement, Management only, essentials, the release rule", () => {
    expect(body).toContain("where not public.lead_retired_from_allocation(p_lead_id)");
    expect(body).toContain("and l.lead_type = 'management'");
    expect(body).toContain("and c.paused_at is null");
    expect(body).toContain("and c.lead_brief_completed_at is not null");
    expect(body).toContain("and c.id is distinct from l.owner_customer_id");
    expect(body).toContain("(b.min_bedrooms is null or (l.bed is not null and l.bed >= b.min_bedrooms))");
    expect(body).toContain("(b.min_gross is null or (l.gross is not null and l.gross >= b.min_gross))");
    expect(body).toContain("and public.customer_release_allows(c.id, 'management', l.created_at)");
  });
});

describe("0170 — spending a top-up credit", () => {
  const body = sqlFunction(M0170, "assign_brief_topup_lead");

  it("assigns through assign_lead_to_customer FIRST, so the lock order is lead then customer", () => {
    const assign = body.indexOf("public.assign_lead_to_customer(");
    const spend = body.indexOf("update public.customers");
    expect(assign).toBeGreaterThan(-1);
    expect(spend).toBeGreaterThan(assign);
  });

  it("re-checks the lead is beyond the area, and spends the credit only while one is left", () => {
    expect(body).toContain("and not (v_outcode = any (coalesce(b.service_outcodes, '{}'::text[])))");
    expect(body).toContain("set brief_topup_credits = brief_topup_credits - 1");
    expect(body).toContain("and brief_topup_credits > 0 returning brief_topup_credits into v_left");
    expect(body).toContain("if v_left is null then raise exception");
  });
});

describe("0170 — applies through the Supabase tool (CLAUDE.md §76)", () => {
  it("no function body carries a semicolon in a comment, or a delete", () => {
    const bodies = M0170_TEXT.split("$$").filter((_, i) => i % 2 === 1);
    expect(bodies.length).toBe(4);
    for (const b of bodies) {
      for (const line of b.split("\n")) {
        const comment = line.indexOf("--");
        if (comment > -1) expect(line.slice(comment)).not.toContain(";");
      }
      expect(b).not.toMatch(/\bdelete\b/i);
    }
  });

  it("every function is service-role only", () => {
    for (const sig of [
      "record_lead_topup_success(uuid, text)",
      "get_brief_candidates_for_lead(uuid, integer, boolean)",
      "get_brief_topup_candidates_for_lead(uuid, integer)",
      "assign_brief_topup_lead(uuid, uuid, numeric)",
    ]) {
      expect(M0170_TEXT).toContain(`revoke execute on function public.${sig}\n  from public, anon, authenticated;`);
      expect(M0170_TEXT).toContain(`grant execute on function public.${sig} to service_role;`);
    }
  });
});

describe("the release's pass 4", () => {
  it("runs after the area passes", () => {
    const area = BRIEF_RELEASE.indexOf("await runAreaPasses(");
    const topup = BRIEF_RELEASE.indexOf('admin.rpc("get_brief_topup_candidates_for_lead"');
    expect(area).toBeGreaterThan(-1);
    expect(topup).toBeGreaterThan(area);
  });

  it("re-checks every lead and assigns only through the wrapper", () => {
    const from = BRIEF_RELEASE.indexOf("topups.sort((a, b) => topupCustomerOrder(a.customer");
    const to = BRIEF_RELEASE.indexOf("async function runAreaPasses(");
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const pass4 = BRIEF_RELEASE.slice(from, to);
    expect(pass4).toContain('admin.rpc("get_brief_topup_candidates_for_lead"');
    expect(pass4).toContain('"assign_brief_topup_lead"');
    expect(pass4).not.toContain('"assign_lead_to_customer"');
    expect(pass4).toContain("topupLeadsFor(pass4, topupReach(b))");
    expect(pass4).toContain("if (!admitted) continue;");
    expect(pass4).toContain('true, "topup")');
  });

  it("the wrapper is called from the release and nowhere else", () => {
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) {
          if (e.name !== "__tests__") walk(p);
        } else if (/\.(ts|tsx)$/.test(e.name) && code(p).includes('"assign_brief_topup_lead"')) {
          callers.push(p);
        }
      }
    };
    walk("src");
    expect(callers).toEqual(["src/lib/leadBrief/briefRelease.ts"]);
  });

  it("passes 2 and 3 consider only customers with a plan credit", () => {
    expect(BRIEF_RELEASE).toContain("briefCustomerLive(c) && briefPlanCredits(c) > 0");
    expect(BRIEF_RELEASE).toContain("briefCustomerLive(c) && briefTopupCredits(c) > 0");
  });
});

describe("the notice reaches both top-up screens", () => {
  it("the dashboard card and the emailed link both pass it", () => {
    expect(code("src/app/dashboard/topup/page.tsx")).toContain("briefNotice: briefTopupApplies(customer, leadType)");
    expect(code("src/app/dashboard/topup/page.tsx")).toContain("briefNotice={card.briefNotice}");
    expect(code("src/app/topup/[token]/page.tsx")).toContain("briefNotice={view.briefNotice}");
  });

  it("the emailed link reads whether the customer is on a brief", () => {
    const lib = code("src/lib/topup.ts");
    expect(lib).toMatch(/\.select\(\s*"[^"]*\blead_brief_required\b[^"]*"\s*\)/);
    expect(lib).toContain("briefNotice: customer ? briefTopupApplies(");
  });

  it("both components render the notice's own words, not a copy", () => {
    for (const p of ["src/components/dashboard/TopupPurchasePanel.tsx", "src/app/topup/[token]/TopupConfirm.tsx"]) {
      const c = code(p);
      expect(c).toContain("BRIEF_TOPUP_NOTICE.title");
      expect(c).toContain("BRIEF_TOPUP_NOTICE.body");
      expect(c).toMatch(/briefNotice\s*&&/);
    }
  });

  it("topupCopy.ts stays import-free (client components read it)", () => {
    expect(readFileSync("src/lib/leadBrief/topupCopy.ts", "utf8")).not.toMatch(/^\s*import\b/m);
  });
});
