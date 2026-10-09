/**
 * Guards on the REAL funnel route files (batch 02 Phase 2).
 *
 * vitest.config.mts is PURE UNITS ONLY, so a route handler is never run here.
 * These read the files themselves (§42.8: a test that writes its own copy of a
 * query is not testing the query), with comments stripped, because every file
 * here explains its own rules and a naive substring check would pass on the
 * explanation.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FUNNEL_STEPS } from "@/lib/funnel/session";

function source(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1")
    .replace(/\{\s*\}/g, "{}");
}

const SESSION = source("src/app/api/funnel/session/route.ts");
const PREVIEW = source("src/app/api/funnel/[token]/preview/route.ts");
const START = source("src/app/start/[token]/page.tsx");
const LOGIN = source("src/app/login/page.tsx");
const MIGRATION = readFileSync("supabase/migrations/0165_funnel.sql", "utf8");

const at = (src: string, needle: string) => {
  const i = src.indexOf(needle);
  expect(i, `missing: ${needle}`).toBeGreaterThanOrEqual(0);
  return i;
};

describe("POST /api/funnel/session", () => {
  it("is n8n's bearer, failing closed when the secret is unset", () => {
    expect(SESSION).toContain("!process.env.N8N_WEBHOOK_SECRET || auth !== expected");
  });

  it("refuses with no token secret rather than minting a link it cannot reopen", () => {
    expect(at(SESSION, "funnelTokenSecret()")).toBeLessThan(at(SESSION, '.from("funnel_sessions").insert'));
    expect(SESSION).toContain('"not_configured" }, { status: 503 }');
  });

  it("checks the switch and 'already a customer' BEFORE creating anything", () => {
    const insert = at(SESSION, '.from("funnel_sessions").insert');
    expect(at(SESSION, "readFunnelEnabled(admin)")).toBeLessThan(insert);
    expect(at(SESSION, "customers.customers.some(isAlreadySetUp)")).toBeLessThan(insert);
    expect(at(SESSION, "openSessionFor(admin, req.email)")).toBeLessThan(insert);
  });

  it("an unreadable customer list is a refusal, never a link", () => {
    const block = SESSION.slice(at(SESSION, "if (!customers.ok)"), at(SESSION, "customers.customers.some"));
    expect(block).toContain("status: 503");
  });

  it("stores the hash of the token, never the token", () => {
    const insert = SESSION.slice(at(SESSION, '.from("funnel_sessions").insert'), at(SESSION, "if (error)"));
    expect(insert).toContain("token_hash: hashFunnelToken(token)");
    expect(insert).not.toMatch(/\btoken:/);
  });

  it("returns the existing row's link on a 23505 race", () => {
    expect(SESSION).toContain('error.code === "23505"');
  });

  it("fills blanks on an existing session and never overwrites a stored value", () => {
    expect(SESSION).toContain("if (!session.monday_item_id && req.mondayItemId)");
    expect(SESSION).toContain("if (!session.phone && req.phone)");
  });
});

describe("POST /api/funnel/[token]/preview", () => {
  it("answers with funnelPreviewBody and nothing else (02 locked decision 7)", () => {
    expect(PREVIEW).toContain("const response = funnelPreviewBody(result);");
    expect(PREVIEW).toContain("NextResponse.json(response, { headers: NO_STORE })");
    // The server preview never reaches a response.
    expect(PREVIEW).not.toMatch(/NextResponse\.json\(\s*result/);
    expect(PREVIEW).not.toMatch(/previews\[(10|20)\]\s*[,}]/);
  });

  it("refuses an unknown session, a switched-off funnel and somebody already set up", () => {
    const limiter = at(PREVIEW, 'admin.rpc("consume_funnel_preview"');
    expect(at(PREVIEW, "readFunnelEnabled(admin)")).toBeLessThan(limiter);
    expect(at(PREVIEW, "alreadySetUpRefusal(admin, session)")).toBeLessThan(limiter);
    expect(PREVIEW).toContain('if (session.step === "paid") return refuse();');
  });

  it("judges the input and the postcode lock BEFORE spending a preview", () => {
    const limiter = at(PREVIEW, 'admin.rpc("consume_funnel_preview"');
    expect(at(PREVIEW, "normaliseBriefInput(parsed.input)")).toBeLessThan(limiter);
    expect(at(PREVIEW, "lockPostcode(admin, session, postcode)")).toBeLessThan(limiter);
  });

  it("spends the limit BEFORE loading the supply it exists to protect", () => {
    expect(at(PREVIEW, 'admin.rpc("consume_funnel_preview"')).toBeLessThan(at(PREVIEW, "loadBriefSupply("));
    expect(PREVIEW).toContain("if (!previewAllowed(count))");
    expect(PREVIEW).toContain('"rate_limited" }, { status: 429');
  });

  it("the limiter fails closed", () => {
    const block = PREVIEW.slice(at(PREVIEW, "if (budgetError)"), at(PREVIEW, "const count"));
    expect(block).toContain("status: 503");
  });

  it("reads supply with no customer to exclude: nobody has paid yet", () => {
    expect(PREVIEW).toContain("loadBriefSupply(admin, { excludeCustomerId: null })");
  });

  it("refuses a second postcode on the same token", () => {
    expect(PREVIEW).toContain('"postcode_locked"');
    expect(PREVIEW).toContain('.is("base_postcode_locked", null)');
  });

  it("refuses Guaranteed Rent", () => {
    expect(PREVIEW).toContain("if (namesOtherProduct(body))");
  });

  it("saves the answers through funnelAnswers, never the body, and never moves a paid session", () => {
    expect(PREVIEW).toContain("answers: funnelAnswers(result.previews[10].brief)");
    expect(PREVIEW).toContain('step: advanceStep(session.step, "previewed")');
    expect(PREVIEW).toContain('.neq("step", "paid")');
  });

  it("is never cached", () => {
    expect(PREVIEW.match(/NextResponse\.json\(/g)?.length).toBe(PREVIEW.match(/headers: NO_STORE/g)?.length);
  });
});

describe("GET /start/[token]", () => {
  it("sends a paid session and an existing customer to log in", () => {
    expect(START).toContain('if (session.step === "paid") redirect(ALREADY_SET_UP_LOGIN_PATH);');
    expect(START).toContain("customers.customers.some(isAlreadySetUp)) redirect(ALREADY_SET_UP_LOGIN_PATH)");
  });

  it("an unknown token is a 404", () => {
    expect(START).toContain("if (!session) notFound();");
  });

  it("sends no referrer, because the token is in the path", () => {
    expect(START).toContain('referrer: "no-referrer"');
  });

  it("the login page shows the notice the redirect names", () => {
    expect(LOGIN).toContain('params.get("notice") === "already_set_up"');
    expect(LOGIN).toContain("FUNNEL_COPY.alreadySetUp");
  });
});

describe("0165 agrees with the code", () => {
  it("the step list is the CHECK's, in order", () => {
    const check = MIGRATION.match(/step in \(([^)]+)\)/);
    expect(check).not.toBeNull();
    const steps = check![1].split(",").map((s) => s.trim().replace(/'/g, ""));
    expect(steps).toEqual([...FUNNEL_STEPS]);
  });
});
