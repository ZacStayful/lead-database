import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

/**
 * Batch 04 Phase 2 wiring, read from the real files (§42.8: a guard on a
 * restatement of the code guards nothing).
 *
 * The scope rule: "Existing customers' pause, top-up and area behaviour is not
 * changed in any way." The two md5 pins below are the existing pause route's
 * month path and the existing pause card, normalised for the one refusal and
 * the select the brief branch needed, and they equal what was on main before
 * this phase (md5 taken from origin/main @ c7fe11d).
 */

function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
const read = (p: string) => readFileSync(p, "utf8");
const md5 = (s: string) => createHash("md5").update(s).digest("hex");

const PAUSE_ROUTE = read("src/app/api/customer/subscription/pause/route.ts");
const RESUME_ROUTE = read("src/app/api/customer/subscription/resume/route.ts");
const CRON = read("src/app/api/cron/resume-paused-subscriptions/route.ts");
const RESUME_LIB = read("src/lib/resumePause.ts");
const WEBHOOK = read("src/app/api/webhook/stripe/route.ts");
const SETTINGS = read("src/components/dashboard/SettingsPanel.tsx");
const SERVER = read("src/lib/briefPauseServer.ts");
const CLAIM = read("src/app/api/internal/n8n-events/claim/route.ts");
const SUPPLY = read("src/lib/leadBrief/supply.ts");

describe("existing customers are untouched", () => {
  it("the pause route's month path is byte-identical to main, apart from the brief refusal and its select", () => {
    const start = PAUSE_ROUTE.indexOf("  const { months, reasons, note } = (body ?? {}) as {");
    const end = PAUSE_ROUTE.indexOf("\n/**\n * A Lead Brief customer's pause (batch 04 Phase 2)");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const legacy = PAUSE_ROUTE.slice(start, end)
      .replace(/\n {2}\/\/ A Lead Brief customer pauses to a date \(above\)\.[\s\S]*?\n {2}}\n/, "")
      .replace(/\.select\(\n\s*"id, email, contact_name, account_status[^"]*"\n\s*\)/, ".select(<COLUMNS>)");
    expect(md5(legacy)).toBe("2516eefe4af84d957fe6a6335eaf0cba");
  });

  it("the month path still reads every column it read before", () => {
    const select = /"(id, email, contact_name, account_status[^"]*)"/.exec(PAUSE_ROUTE)![1];
    for (const col of [
      "id",
      "email",
      "contact_name",
      "account_status",
      "subscription_status",
      "stripe_subscription_id",
      "paused_at",
      "pause_count",
    ]) {
      expect(select.split(/,\s*/)).toContain(col);
    }
  });

  it("the existing pause card's JSX is byte-identical to main, and renders only for a non-brief customer", () => {
    const start = SETTINGS.indexOf('        <Card id="pause-subscription-card">');
    const end = SETTINGS.indexOf("      <CancelSubscriptionCard");
    expect(md5(SETTINGS.slice(start, end))).toBe("dc41cccb94d88ddbf399c3feabd2b532");
    expect(SETTINGS).toContain('{managementActive && !briefPause && (\n        <Card id="pause-subscription-card">');
    expect(SETTINGS).toContain("{managementActive && briefPause && (\n        <BriefPauseCard");
    expect(SETTINGS).toMatch(/const briefPause = canEditLeadBrief\(customer\);/);
  });

  it("the notice pass still reaches every pause with no area flag", () => {
    const code = strip(CRON);
    expect(code).toContain('.or("pause_holds_area.is.null,pause_holds_area.eq.true")');
  });
});

describe("the pause route", () => {
  it("a return date takes the brief path BEFORE the month path reads anything", () => {
    const code = strip(PAUSE_ROUTE);
    const branch = code.indexOf('"returnDate" in body');
    expect(branch).toBeGreaterThan(0);
    expect(code.indexOf("return pauseBrief(user.id")).toBeGreaterThan(branch);
    expect(branch).toBeLessThan(code.indexOf("const { months, reasons, note }"));
  });

  it("a brief customer is refused a month-based pause before anything is written", () => {
    const code = strip(PAUSE_ROUTE);
    const refusal = code.indexOf("if (canEditLeadBrief(customer))");
    expect(refusal).toBeGreaterThan(0);
    expect(refusal).toBeLessThan(code.indexOf(".from(\"customers\")\n    .update("));
    expect(refusal).toBeLessThan(code.indexOf("pause_collection"));
    expect(code).toContain('code: "return_date_required"');
  });
});

describe("the brief pause writer", () => {
  it("⚠️ inserts the episode before Stripe, and rolls back on either failure", () => {
    const fn = strip(SERVER.slice(SERVER.indexOf("export async function pauseBriefCustomer")));
    const episode = fn.indexOf('.from("subscription_pauses")\n    .insert(');
    const stripe = fn.indexOf("subscriptions.update(");
    expect(episode).toBeGreaterThan(0);
    expect(stripe).toBeGreaterThan(episode);
    expect(fn.slice(episode, stripe)).toContain("await rollBack();");
    expect(fn.slice(stripe)).toContain("await rollBack();");
    expect(fn.slice(stripe)).toContain('.from("subscription_pauses").delete()');
    expect(fn).toContain("pause_holds_area: date.holdArea");
    expect(fn).toContain("months: null");
  });
});

describe("clearing a pause clears its area flag", () => {
  it("resumePausedCustomer and the webhook's resume detection both null pause_holds_area", () => {
    const clear = (src: string, from: string) => src.slice(src.indexOf(from), src.indexOf(from) + 1200);
    expect(clear(RESUME_LIB, "paused_at: null,")).toContain("pause_holds_area: null,");
    expect(clear(WEBHOOK, "paused_at: null,")).toContain("pause_holds_area: null,");
  });
});

describe("the resume paths", () => {
  it("the cron settles a long brief pause before resuming anyone", () => {
    const code = strip(CRON);
    const loop = code.indexOf("for (const customer of (rows ?? []) as PausedCustomer[])");
    const settle = code.indexOf("settleLongPauseReturn(admin, customer", loop);
    const resume = code.indexOf("resumePausedCustomer(admin, customer", loop);
    expect(settle).toBeGreaterThan(loop);
    expect(resume).toBeGreaterThan(settle);
    // The condition itself, not just the call: `if (false && …)` keeps the text.
    expect(code).toContain(
      "    if (onLongBriefPause(customer)) {\n      const settled = await settleLongPauseReturn(admin, customer, {"
    );
    expect(code.slice(settle, resume)).toContain('settled.action === "hold"');
    expect(code.slice(settle, resume)).toContain('settled.action === "retry"');
  });

  it("the 7-day recalculation pass runs before the notice pass, on long pauses that are not cancelling", () => {
    const code = strip(CRON);
    const pass = code.indexOf("recalibrateLongPause(admin, customer");
    const notice = code.indexOf('.is("pause_ending_notice_sent_at", null)');
    expect(pass).toBeGreaterThan(0);
    expect(notice).toBeGreaterThan(pass);
    const query = code.slice(code.indexOf("upcomingRows"), pass);
    expect(query).toContain('.eq("pause_holds_area", false)');
    expect(query).toContain('.eq("cancel_at_period_end", false)');
    expect(query).toContain('.gt("pause_resumes_at", nowIso)');
  });

  it("an early resume settles a long brief pause first", () => {
    const code = strip(RESUME_ROUTE);
    const settle = code.indexOf("settleLongPauseReturn(admin, customer");
    expect(settle).toBeGreaterThan(code.indexOf("if (onLongBriefPause(customer))"));
    expect(code).toContain(
      "  if (onLongBriefPause(customer)) {\n    const settled = await settleLongPauseReturn(admin, customer, {"
    );
    expect(code.indexOf("resumePausedCustomer(", settle)).toBeGreaterThan(settle);
    expect(code).toContain('code: "area_review_required"');
  });
});

describe("the engine releases a long pause", () => {
  it("toOtherBriefs skips a long brief pause and reads the columns it needs", () => {
    const code = strip(SUPPLY);
    expect(code).toContain("if (c.paused_at && c.pause_holds_area === false) continue;");
    expect(code).toMatch(/customers!inner\([^)]*paused_at, pause_holds_area\)/);
  });
});

describe("the n8n claim endpoint", () => {
  it("fails closed without the secret, and hands out events only through the claim function", () => {
    const code = strip(CLAIM);
    expect(code).toContain("process.env.N8N_WEBHOOK_SECRET");
    expect(code).toMatch(/if \(!secret \|\| auth !== `Bearer \$\{secret\}`\)/);
    expect(code).toContain('rpc("claim_n8n_events"');
    expect(code).toContain("p_max_age_hours: N8N_EVENT_MAX_AGE_HOURS");
    expect(code).not.toMatch(/\.from\("n8n_events"\)/);
    expect(code).toContain('"Cache-Control": "no-store"');
  });

  it("the event never carries the WhatsApp wording (Zac approves it in n8n)", () => {
    const payload = SERVER.slice(
      SERVER.indexOf("const payload: BriefAreaUpdatedPayload"),
      SERVER.indexOf('.from("n8n_events").insert')
    );
    expect(payload).not.toMatch(/message|text|body|whatsapp/i);
  });
});
