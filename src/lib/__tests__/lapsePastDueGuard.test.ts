import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * File-text guards on /api/cron/lapse-past-due and the webhook's use of the
 * episode helper (0152, §59).
 *
 * The route reaches the database and Monday, so it cannot be driven under
 * vitest.config.mts's pure-units rule. What CAN be pinned is the shape §59
 * argues for, each line of which is a one-token change no behavioural test
 * here could see (§42.8's lesson):
 *
 *   - it never calls Stripe — the subscription is left to keep retrying so a
 *     late payment recovers the customer with no manual step;
 *   - it never writes subscription_status — the row stays honest about what
 *     Stripe reports, and lapsed_at is what the label rule reads;
 *   - a failed settings read is a 500, never "switched off" (§18.3).
 */
const route = readFileSync("src/app/api/cron/lapse-past-due/route.ts", "utf8");
const webhook = readFileSync("src/app/api/webhook/stripe/route.ts", "utf8");
const vercel = readFileSync("vercel.json", "utf8");

/** Strip // comments so a guard cannot be satisfied by its own explanation. */
const code = (src: string) => src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

describe("lapse-past-due: what it must never do", () => {
  it("never imports or calls Stripe", () => {
    const c = code(route);
    expect(c).not.toMatch(/getStripe|from "stripe"|from "@\/lib\/stripe"/);
  });

  it("never writes subscription_status", () => {
    const c = code(route);
    expect(c).not.toMatch(/subscription_status:\s*"/);
    // The GR branch must never touch account_status either (invariant 6): the
    // only account_status write is the management one.
    expect(c.match(/account_status:\s*"cancelled"/g)?.length).toBe(1);
  });

  it("reads its switch through the settings gate and aborts with a 500 on a failed read", () => {
    const c = code(route);
    expect(c).toContain("resolveSettingsGate(");
    const gate = c.indexOf('gate.reason === "read_failed"');
    const abort = c.indexOf("status: 500", gate);
    const kill = c.indexOf('config.get("past_due_lapse_enabled")');
    expect(gate).toBeGreaterThan(-1);
    expect(abort).toBeGreaterThan(gate);
    // The abort sits ABOVE the kill switch, so an unreadable table can never
    // be logged as "past_due_lapse_enabled is not 'true'".
    expect(kill).toBeGreaterThan(abort);
  });

  it("guards both writes on the stamp still being null", () => {
    const c = code(route);
    expect(c).toContain('.is("lapsed_at", null)\n      .select(');
    expect(c).toContain('.is("gr_lapsed_at", null)\n      .select(');
  });

  it("is scheduled", () => {
    // Parsed, never matched as text: Vercel rewrites vercel.json into compact
    // JSON before the build command runs, so a whitespace-sensitive string
    // passes locally and fails on every deploy (§50.9's shape, found the hard
    // way on this PR's first build).
    const crons = JSON.parse(vercel).crons as { path: string; schedule: string }[];
    const entry = crons.find((c) => c.path === "/api/cron/lapse-past-due");
    expect(entry).toBeDefined();
    expect(entry?.schedule).toBe("0 6 * * *");
  });
});

describe("the webhook maintains the episode on every path that can end one", () => {
  it("stamps the episode start on payment_failed only when unset", () => {
    const c = code(webhook);
    expect(c).toContain("if (!customer.gr_past_due_since)");
    expect(c).toContain("if (!customer.past_due_since)");
  });

  it("clears both columns when an invoice is paid, per product", () => {
    const c = code(webhook);
    expect(c).toContain("gr_past_due_since: null,\n              gr_lapsed_at: null,");
    expect(c).toContain("past_due_since: null,\n            lapsed_at: null,");
  });

  it("routes every subscription event through applyPastDueEpisode, once per product", () => {
    const c = code(webhook);
    expect(c.match(/applyPastDueEpisode\(/g)?.length).toBe(2);
    expect(c).not.toMatch(/function mapStatus\(/);
  });
});
