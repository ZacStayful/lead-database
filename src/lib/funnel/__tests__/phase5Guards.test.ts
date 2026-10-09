/**
 * Guards on the REAL files batch 02 Phase 5 touches that no unit test can run:
 * pages, routes and crons (vitest.config.mts is PURE UNITS ONLY). Comments are
 * stripped, because each file explains its own rules (§42.8).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const PAY = source("src/app/pay/[offerToken]/page.tsx");
const ONBOARDING = source("src/app/onboarding/brief/page.tsx");
const WIZARD = source("src/components/leadBrief/BriefWizard.tsx");
const RULES = readFileSync("src/lib/funnel/confirmationRules.ts", "utf8");
const RESET = source("src/app/reset-password/page.tsx");
const STAMP = source("src/app/api/customer/password-set/route.ts");
const DASHBOARD = source("src/app/dashboard/page.tsx");
const REMINDERS = source("src/app/api/cron/post-call-offer-reminders/route.ts");
const DISCOUNT_CRON = source("src/app/api/cron/funnel-discounts/route.ts");
const EMAILS = source("src/lib/emails.ts");
const ISSUE = source("src/lib/postCallOfferIssue.ts");

describe("the crons (vercel.json)", () => {
  const crons = (JSON.parse(readFileSync("vercel.json", "utf8")) as { crons: { path: string; schedule: string }[] }).crons;
  it("issues funnel codes and sends the 12h/4h/1h reminders every 15 minutes", () => {
    expect(crons).toContainEqual({ path: "/api/cron/funnel-discounts", schedule: "*/15 * * * *" });
    expect(crons).toContainEqual({ path: "/api/cron/post-call-offer-reminders", schedule: "*/15 * * * *" });
  });

  it("the discount cron: a failed settings read is a 500, and it runs only with the funnel on", () => {
    const readFail = DISCOUNT_CRON.indexOf('gate.reason === "read_failed"');
    const off = DISCOUNT_CRON.indexOf('skipped: "funnel_disabled"');
    const run = DISCOUNT_CRON.indexOf("await issueFunnelDiscounts(admin");
    for (const at of [readFail, off, run]) expect(at).toBeGreaterThan(-1);
    expect(readFail).toBeLessThan(off);
    expect(off).toBeLessThan(run);
    expect(DISCOUNT_CRON).toContain('const enabled = gate.ok && funnelEnabledFrom(gate.config.get("funnel_enabled"));');
    expect(DISCOUNT_CRON).toMatch(/if \(!enabled && !\(dryRun && !viaCron\)\) \{\s*return NextResponse\.json\(\{ ok: true, skipped: "funnel_disabled" \}\);/);
    const failedBlock = DISCOUNT_CRON.slice(readFail, DISCOUNT_CRON.indexOf("\n  }", readFail));
    expect(failedBlock).toContain('error: "settings_read_failed" }, { status: 500 }');
  });
});

describe("one code per person (postCallOfferIssue.ts)", () => {
  it("looks for a live code before it mints one", () => {
    const body = ISSUE.slice(ISSUE.indexOf("export async function issuePostCallOffer"));
    const check = body.indexOf('.is("redeemed_at", null)');
    const live = body.indexOf('return { ok: true, status: "existing"');
    const mint = body.indexOf("await createPromoCode(");
    for (const at of [check, live, mint]) expect(at).toBeGreaterThan(-1);
    expect(check).toBeLessThan(mint);
    expect(live).toBeLessThan(mint);
  });
});

describe("a funnel offer's /pay link", () => {
  it("goes through the funnel's own checkout, before the call route's door", () => {
    const switchAt = PAY.indexOf('if (offer.source === "funnel")');
    const lookup = PAY.indexOf("await funnelSessionForOffer(admin, offer.id)");
    const funnel = PAY.indexOf("await startFunnelCheckout(admin, found.session, plan, cancelUrl)");
    const callDoor = PAY.indexOf("await startManagementCheckout(admin, {");
    for (const at of [switchAt, lookup, funnel, callDoor]) expect(at).toBeGreaterThan(-1);
    expect(switchAt).toBeLessThan(lookup);
    expect(lookup).toBeLessThan(funnel);
    expect(funnel).toBeLessThan(callDoor);
    expect(PAY).toContain("source");
  });

  it("an unreadable session is the unavailable page, never a call-route payment", () => {
    const failed = PAY.slice(PAY.indexOf("if (!found.ok) {"), PAY.indexOf("if (found.session) {"));
    expect(failed).toContain("return <Unavailable />;");
  });

  it("still redirects outside any try", () => {
    expect(PAY).not.toMatch(/\btry\s*\{/);
  });

  it("the reminder email does not thank a funnel prospect for a call", () => {
    expect(REMINDERS).toContain('origin: offer.source === "funnel" ? "funnel" : "call"');
    expect(EMAILS).toContain("FUNNEL_COPY.reminderIntro(remaining)");
  });
});

describe("the brief confirmation (C1)", () => {
  it("is read on the server from the customer's own PAID funnel session", () => {
    expect(ONBOARDING).toContain('.from("funnel_sessions")');
    expect(ONBOARDING).toContain('.eq("customer_id", customer.id)');
    expect(ONBOARDING).toContain('.eq("step", "paid")');
    expect(ONBOARDING).toContain("initial={initial}");
  });

  it("the wizard recalculates on arrival and imports only the client-safe half", () => {
    expect(WIZARD).toContain("await requestPreview(initial.similarAreas)");
    expect(WIZARD).toContain("radiusChangedSincePayment(initial, fresh.serviceRadiusMiles)");
    expect(WIZARD).toContain('from "@/lib/funnel/confirmationRules"');
    expect(WIZARD).not.toContain('from "@/lib/funnel/confirmation"');
    // Import-free at runtime: only a type import.
    expect(RULES.match(/^import (?!type )/m)).toBeNull();
  });
});

describe("the password prompt (C2)", () => {
  it("/reset-password stamps password_set_at once the password is saved", () => {
    const saved = RESET.indexOf("await supabase.auth.updateUser({ password })");
    const stamp = RESET.indexOf('await fetch("/api/customer/password-set", { method: "POST" })');
    expect(saved).toBeGreaterThan(-1);
    expect(stamp).toBeGreaterThan(saved);
  });

  it("the stamp is the session's own row, from no request body, first stamp wins", () => {
    expect(STAMP).toContain("supabase.auth.getUser()");
    expect(STAMP).toContain('.eq("user_id", user.id)');
    expect(STAMP).toContain('.is("password_set_at", null)');
    expect(STAMP).not.toContain("request.json");
    expect(STAMP).toMatch(/export async function POST\(\)/);
  });

  it("the card never shows while an admin views a customer", () => {
    expect(DASHBOARD).toContain("{!viewAs && offerSetPassword(customer) && <SetPasswordCard />}");
  });
});
