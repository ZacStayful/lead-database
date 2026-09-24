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

/**
 * The write-off's cancellation date is undone on recovery.
 *
 * clearWriteOffCancellation() decides on `lapsed_at === cancelled_at`, and that
 * test is only exact because of two properties of OTHER files. Neither is
 * reachable from a unit test of the helper, and if either drifts the fix stops
 * working SILENTLY — a recovered customer goes back to being recorded as churned
 * for ever, with no error anywhere.
 */
describe("recovery undoes the write-off's cancellation date", () => {
  it("the cron stamps lapsed_at and cancelled_at from ONE timestamp", () => {
    // Two separate new Date() calls would differ by milliseconds and the
    // equality test would never match again. Both branches must reuse `nowIso`.
    const c = code(route);
    expect(c).toMatch(/lapsed_at:\s*nowIso/);
    expect(c).toMatch(/gr_lapsed_at:\s*nowIso/);
    expect(c).toMatch(/cancelled_at:\s*nowIso/);
    expect(c).toMatch(/gr_cancelled_at:\s*nowIso/);
    // And it never derives either from a fresh clock.
    expect(c).not.toMatch(/(?:gr_)?(?:lapsed|cancelled)_at:\s*new Date\(\)/);
  });

  it("the cron stamps the cancellation date only when it is still null", () => {
    // That guard is what makes an EARLIER date mean "a real cancellation", which
    // is the whole basis for the helper leaving it alone.
    const c = code(route);
    expect(c).toContain("if (!written.cancelled_at)");
    expect(c).toContain("if (!written.gr_cancelled_at)");
    expect(c).toContain('.is("cancelled_at", null)');
    expect(c).toContain('.is("gr_cancelled_at", null)');
  });

  it("both recovery branches call the helper, each on its OWN update object", () => {
    // Asserted on the call SHAPE rather than a count of the identifier: a count
    // is satisfied by a call that has been commented out or neutered, and
    // passing the wrong branch's update object would put a management column in
    // the GR update (invariant 6) while a count still read 2.
    const c = code(webhook);
    expect(c).toMatch(/clearWriteOffCancellation\(\s*grUpdate,/);
    expect(c).toMatch(/clearWriteOffCancellation\(\s*renewalUpdate,/);
    expect(c.match(/clearWriteOffCancellation\(/g)?.length).toBe(2);
    // Both must be STATEMENTS, not sub-expressions: `void 0 &&
    // clearWriteOffCancellation(...)` satisfies a count and a shape check while
    // doing nothing. Requiring the call to open its own line rules that out.
    expect(c.match(/^\s*clearWriteOffCancellation\(/gm)?.length).toBe(2);
  });

  it("EVERY recovery lookup selects the columns the helper needs", () => {
    // ⚠️ COUNTED, NOT MERELY PRESENT. Each product has TWO selects feeding the
    // same `customer` — the primary lookup and the re-lookup after provisioning —
    // and which one runs depends on the path. Absent from either, both arguments
    // arrive undefined, the helper no-ops, and the bug is back with every other
    // test still green. A "appears at least once" guard misses exactly that.
    const c = code(webhook);
    expect(c.match(/stripe_subscription_id, lapsed_at, cancelled_at"/g)?.length).toBe(2);
    expect(
      c.match(/gr_stripe_subscription_id, gr_lapsed_at, gr_cancelled_at"/g)?.length
    ).toBe(2);
  });

  it("neither branch nulls a cancellation date unconditionally", () => {
    // The mirror-image corruption, and the worse one: it would erase the date of
    // every real cancellation on that customer's next payment (§18E, §32.1).
    const c = code(webhook);
    expect(c).not.toMatch(/^\s*cancelled_at:\s*null,?\s*$/m);
    expect(c).not.toMatch(/^\s*gr_cancelled_at:\s*null,?\s*$/m);
  });
});
