/**
 * File-text guards on the monthly batch review's wiring (§73).
 *
 * These read the REAL files rather than restating them (§42.8: 91 sequence runs
 * were destroyed by a boundary a test asserted in its own hand-written copy of a
 * query). Comments are stripped first, because files that explain a rule name
 * the very tokens the rule is about (§46).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const CRON = "src/app/api/cron/batch-reviews/route.ts";
const MIGRATION = "supabase/migrations/0160_lead_batch_reviews.sql";

describe("the cron", () => {
  const src = code(CRON);

  it("is scheduled daily and has room to send", () => {
    const vercel = JSON.parse(read("vercel.json")) as { crons: { path: string; schedule: string }[] };
    const entry = vercel.crons.find((c) => c.path === "/api/cron/batch-reviews");
    expect(entry?.schedule).toBe("40 9 * * *");
    expect(src).toMatch(/export const maxDuration = 300;/);
  });

  it("uses the §2 auth pattern and fails closed on a missing secret", () => {
    expect(src).toContain("Boolean(cronSecret) && auth === `Bearer ${cronSecret}`");
    expect(src).toContain("isAdminUser(user)");
  });

  it("answers a failed settings read with a 500, never a skip (§18.3)", () => {
    expect(src).toContain("resolveSettingsGate(settingRows, settingsError)");
    const failed = src.indexOf('gate.reason === "read_failed"');
    const disabled = src.indexOf("batch_reviews_disabled");
    expect(failed).toBeGreaterThan(-1);
    expect(src.slice(failed, failed + 300)).toContain("status: 500");
    expect(failed).toBeLessThan(disabled);
  });

  it("claims every send with a guarded update BEFORE the email goes", () => {
    for (const [claim, send] of [
      ['.is("shortfall_email_sent_at", null)', "sendBatchShortfallEmail({"],
      ['.is("survey_sent_at", null)', "reminder: false"],
      ['.is("reminder_sent_at", null)', "reminder: true"],
    ] as const) {
      const c = src.indexOf(claim);
      const s = src.indexOf(send);
      expect(c, claim).toBeGreaterThan(-1);
      expect(s, send).toBeGreaterThan(c);
    }
  });

  it("only sends the survey to a customer still on the product and opted in", () => {
    const survey = src.slice(src.indexOf("surveyDue(r, today, settings)"), src.indexOf("reminder: false"));
    expect(survey).toContain("if (!holds)");
    expect(survey).toContain("wantsReview(c)");
    expect(survey).toContain("if (!secret)");
  });
});

describe("the migration", () => {
  const sql = read(MIGRATION);
  const reset = sql.slice(sql.indexOf("create or replace function public.reset_monthly_counts()"));

  it("captures BEFORE the counters are zeroed, inside its own exception block", () => {
    const capture = reset.indexOf("perform public.capture_lead_batch_reviews(v_today);");
    const zero = reset.indexOf("set leads_received_this_month = 0");
    expect(capture).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(zero);
    expect(reset.slice(capture, zero)).toContain("exception when others then");
  });

  it("keeps the 0153 statements", () => {
    expect(reset).toContain("set gr_leads_received_this_month = 0");
    expect(reset).toContain("set quality_claims_this_cycle = 0");
    expect(reset).toContain("replacement_balance    = c.replacement_balance + public.replacement_monthly_grant(c)");
  });

  it("ships sending off and backfills the opt-out key by merge", () => {
    expect(sql).toContain("('batch_reviews_enabled', 'false')");
    expect(sql).toContain(`notification_preferences || '{"monthly_review": true}'::jsonb`);
  });

  it("the GR capture never reads a management-only column (invariant 6)", () => {
    const gr = sql.slice(sql.indexOf("-- Guaranteed Rent (gr_ columns only"), sql.indexOf("-- delivered = the item count"));
    expect(gr).not.toMatch(/c\.account_status|c\.subscription_status|c\.paused_at|c\.lapsed_at\b/);
  });
});

describe("the submit path", () => {
  it("both doors go through submitReview", () => {
    expect(code("src/app/api/review/[token]/route.ts")).toContain("submitReview(admin, lookup.review, body)");
    expect(code("src/app/api/customer/batch-review/[id]/route.ts")).toContain("submitReview(admin, review, body)");
  });

  it("the dashboard door resolves identity from the session, never the body", () => {
    const src = code("src/app/api/customer/batch-review/[id]/route.ts");
    expect(src).toContain("getCurrentCustomer()");
    expect(src).toContain("reviewForCustomer(admin, params.id, customer.id)");
  });

  it("every row is checked against the review's own customer", () => {
    const src = code("src/lib/batchReview/review.ts");
    expect(src).toContain("row.assignment.customer_id === customerId");
    expect(src).toMatch(/ownedAssignment\(r, review\.customer_id\)/);
    expect(src).toMatch(/\.eq\("review_id", review\.id\)/);
  });

  it("the pipeline write refuses a rejected or closed lead in the database too", () => {
    const src = code("src/lib/assignmentStage.ts");
    expect(src).toContain('.neq("status", "rejected")');
    expect(src).toContain('.is("closed_at", null)');
  });

  it("the PATCH route and the review share one stage-history writer", () => {
    expect(code("src/app/api/customer/assignments/[id]/route.ts")).toContain("recordStageChanged(admin, params.id");
    expect(code("src/lib/assignmentStage.ts")).toContain('event_type: "stage_changed"');
  });

  it("the form will not send until every editable row is answered", () => {
    expect(code("src/components/batchReview/BatchReviewForm.tsx")).toContain("disabled={busy || remaining > 0}");
  });

  it("the client modules stay import-free of server code", () => {
    for (const f of ["src/lib/batchReview/answers.ts", "src/lib/batchReview/pipeline.ts", "src/lib/batchReview/settings.ts"]) {
      const imports = Array.from(code(f).matchAll(/^import .* from "([^"]+)";?$/gm)).map((m) => m[1]);
      for (const i of imports) expect(i.startsWith("./"), `${f} imports ${i}`).toBe(true);
    }
  });
});

describe("the monthly_review opt-out exists in all four places (§21.7)", () => {
  it("the route accepts it and defaults it on", () => {
    const src = read("src/app/api/customer/settings/notifications/route.ts");
    expect(src.slice(src.indexOf("PREFERENCE_KEYS"), src.indexOf("];"))).toContain('"monthly_review"');
    const start = src.indexOf("DEFAULT_PREFERENCES");
    expect(src.slice(start, src.indexOf("};", start))).toContain("monthly_review: true");
  });
  it("the panel has the row and initialises it", () => {
    const src = read("src/components/dashboard/SettingsPanel.tsx");
    expect(src.slice(src.indexOf("PREFERENCE_ROWS"), src.indexOf("];"))).toContain('key: "monthly_review"');
    expect(src).toMatch(/prefOn\(\s*customer\.notification_preferences,\s*"monthly_review"/);
  });
  it("the type carries it", () => {
    expect(read("src/lib/types.ts")).toMatch(/monthly_review: boolean;/);
  });
});

describe("the emails", () => {
  const src = read("src/lib/emails.ts");
  const body = src.slice(src.indexOf("export async function sendBatchShortfallEmail"));
  it("never offer or imply a refund", () => {
    expect(body).not.toMatch(/refund|money back|compensat|reimburs/i);
  });
  it("escape what they render", () => {
    expect(body).toContain("esc(causeSentence)");
    expect(body).toContain("esc(first)");
  });
});
