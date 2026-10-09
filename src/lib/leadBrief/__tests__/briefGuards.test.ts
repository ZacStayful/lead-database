import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The Phase 3 wiring, pinned on the real files (§42.8: a test that restates a
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

const LAYOUT = code("src/app/dashboard/layout.tsx");
const PAGE = code("src/app/onboarding/brief/page.tsx");
const PREVIEW_ROUTE = code("src/app/api/customer/lead-brief/preview/route.ts");
const CONFIRM_ROUTE = code("src/app/api/customer/lead-brief/route.ts");
const SERVER = code("src/lib/leadBrief/briefServer.ts");
const WIZARD = code("src/components/leadBrief/BriefWizard.tsx");
const FILTER_ROUTE = code("src/app/api/customer/filter/route.ts");
const FILTER_PAGE = code("src/app/dashboard/filtering/page.tsx");

describe("the dashboard gate", () => {
  const redirect = 'if (!viewAs && needsLeadBrief(customer)) redirect("/onboarding/brief");';

  it("redirects a customer who still needs a brief, never while an admin views them", () => {
    expect(LAYOUT).toContain(redirect);
  });

  it("runs after the first-login welcome, so that email still goes", () => {
    const welcome = LAYOUT.indexOf("if (!viewAs) await markFirstLoginAndNotify(customer);");
    expect(welcome).toBeGreaterThan(-1);
    expect(LAYOUT.indexOf(redirect)).toBeGreaterThan(welcome);
  });
});

describe("the questionnaire page", () => {
  it("sends anyone who does not need a brief to their dashboard", () => {
    expect(PAGE).toContain('if (!customer || !needsLeadBrief(customer)) redirect("/dashboard");');
  });

  it("an admin viewing the customer gets a notice, never the questions", () => {
    const viewAs = PAGE.indexOf("if (viewAs) {");
    expect(viewAs).toBeGreaterThan(-1);
    expect(PAGE.indexOf("<BriefWizard")).toBeGreaterThan(viewAs);
    const branch = PAGE.slice(viewAs, PAGE.indexOf("const renewalIso"));
    expect(branch).not.toContain("<BriefWizard");
  });

  it("sits outside /dashboard, so the gate cannot redirect to itself", () => {
    expect(readdirSync("src/app/onboarding/brief")).toContain("page.tsx");
  });
});

describe("the preview route", () => {
  it("serves only a customer who still needs a brief", () => {
    expect(PREVIEW_ROUTE).toContain("if (!customer || !needsLeadBrief(customer)) {");
    expect(PREVIEW_ROUTE).toContain("status: 403");
  });

  it("returns previewForClient and nothing else from the server preview (A4)", () => {
    expect(PREVIEW_ROUTE).toContain("preview: previewForClient(result.preview)");
    for (const leak of ["supplyCheck", "serviceOutcodes", "paceOutcodes", "firstPickOutcodes", "preview: result.preview"]) {
      expect(PREVIEW_ROUTE).not.toContain(leak);
    }
  });

  it("an unreadable book is a 503, never an empty preview (§58)", () => {
    const i = PREVIEW_ROUTE.indexOf("err instanceof BriefSupplyUnavailableError");
    expect(i).toBeGreaterThan(-1);
    expect(PREVIEW_ROUTE.slice(i, i + 250)).toContain("status: 503");
  });

  it("pre-ticks the recommended similar area on the first preview only", () => {
    expect(PREVIEW_ROUTE).toContain("autoTickRecommended: true");
    expect(CONFIRM_ROUTE).toContain("autoTickRecommended: false");
    expect(SERVER).toContain("opts.autoTickRecommended && !parsed.similarAreasGiven");
  });
});

describe("the confirm route", () => {
  it("refuses anyone who is not a flagged Management customer, and is idempotent once complete", () => {
    expect(CONFIRM_ROUTE).toContain(
      'if (!customer || !customer.lead_brief_required || !holdsProduct(customer, "management")) {'
    );
    expect(CONFIRM_ROUTE).toContain("if (customer.lead_brief_completed_at) {");
    expect(CONFIRM_ROUTE).toContain("ok: true, alreadyComplete: true");
  });

  it("recomputes and says so when the radius moved since it was shown (A8)", () => {
    expect(CONFIRM_ROUTE).toContain("preview.serviceRadiusMiles !== parsed.shownRadiusMiles");
    const i = CONFIRM_ROUTE.indexOf('code: "radius_changed"');
    expect(i).toBeGreaterThan(-1);
    expect(CONFIRM_ROUTE.slice(i, i + 200)).toContain("preview: previewForClient(preview)");
    expect(CONFIRM_ROUTE.slice(i, i + 300)).toContain("status: 409");
  });

  it("builds the row from the server preview and stamps completion only where it is null", () => {
    expect(CONFIRM_ROUTE).toContain("briefRowFromPreview(preview,");
    expect(CONFIRM_ROUTE).toContain('.is("lead_brief_completed_at", null)');
    const insert = CONFIRM_ROUTE.indexOf('.from("customer_lead_briefs").insert(row)');
    const stamp = CONFIRM_ROUTE.indexOf("lead_brief_completed_at: new Date().toISOString()");
    expect(insert).toBeGreaterThan(-1);
    expect(stamp).toBeGreaterThan(insert);
  });

  it("treats a 23505 as already saved, and checks before declaring success", () => {
    expect(CONFIRM_ROUTE).toContain('insertError.code !== "23505"');
    expect(CONFIRM_ROUTE).toContain('.eq("status", "active")');
  });

  it("an unreadable book is a 503", () => {
    const i = CONFIRM_ROUTE.indexOf("err instanceof BriefSupplyUnavailableError");
    expect(CONFIRM_ROUTE.slice(i, i + 250)).toContain("status: 503");
  });
});

describe("the plan comes from the row (switch to 10, approved 9 Oct)", () => {
  it("the server reads the plan from the customer's row, never the body", () => {
    expect(SERVER).toContain("const plan = briefPlanFor(customer);");
    expect(SERVER).not.toMatch(/body\.plan|parsed\.plan|input\.plan/);
  });

  it("the switch calls the existing §24 route, for Management, to the 10-lead plan", () => {
    expect(WIZARD).toContain('fetch("/api/customer/subscription/plan"');
    expect(WIZARD).toContain('JSON.stringify({ product: "management", plan: "lead_10" })');
  });

  it("no brief file calls Stripe itself", () => {
    const files = [
      ...readdirSync("src/lib/leadBrief").flatMap((f) => (f.endsWith(".ts") ? [join("src/lib/leadBrief", f)] : [])),
      ...readdirSync("src/components/leadBrief").map((f) => join("src/components/leadBrief", f)),
      "src/app/api/customer/lead-brief/route.ts",
      "src/app/api/customer/lead-brief/preview/route.ts",
      "src/app/onboarding/brief/page.tsx",
    ];
    for (const f of files) {
      expect(code(f), f).not.toMatch(/getStripe|from "stripe"|subscriptions\.update/);
    }
  });
});

describe("the legacy area screens (C15)", () => {
  it("the filter route refuses a brief customer's Management changes before any action", () => {
    const refusal = FILTER_ROUTE.indexOf('if (product === "management" && customer.lead_brief_required) {');
    expect(refusal).toBeGreaterThan(-1);
    expect(FILTER_ROUTE.slice(refusal, refusal + 250)).toContain('code: "lead_brief_customer"');
    expect(FILTER_ROUTE.slice(refusal, refusal + 250)).toContain("status: 409");
    expect(refusal).toBeLessThan(FILTER_ROUTE.indexOf('if (body.action === "apply")'));
  });

  it("the filtering page drops the Management panel for a brief customer and leaves GR alone", () => {
    expect(FILTER_PAGE).toContain("!customer.lead_brief_required &&");
    expect(FILTER_PAGE).toContain("{briefCustomer && (");
    expect(FILTER_PAGE).not.toMatch(/lead_brief_required[^;]*guaranteed_rent/);
  });
});
