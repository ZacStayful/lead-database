/**
 * ⚠️ THE DAILY PROMPT MUST NOT CHASE THE BACKFILL (§42).
 *
 * The 2026-09-01 backfill put a plan on every open lead so the timeline reads
 * the same everywhere — 357 runs, 356 open attempts, most of them on landlords
 * who enquired months ago. All of those attempts are `pending` with a
 * `send_after` in the past, so the obvious "what is due today" query returns
 * every one of them: a first email of 326 attempts across 23 customers.
 *
 * There is no recovering from that. A daily prompt that arrives once as a wall
 * of text is filtered to trash and never read again, which costs the whole
 * feature rather than one send. So the scan is bounded by `contact_notify_from`
 * and fails CLOSED when it cannot read one.
 *
 * Asserted against the route's own source rather than a query written here —
 * the lesson of sendingPhaseGuard.test.ts in this directory, where a hand-
 * written equivalent passed for days while the live query had no such clause.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROUTE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../app/api/cron/contact-followups/route.ts"
);
const src = readFileSync(ROUTE, "utf8");

/** The due-attempt scan, isolated so a match elsewhere in the file cannot pass. */
function scanChain(): string {
  const start = src.indexOf('.from("message_sequence_drafts")');
  expect(start).toBeGreaterThan(-1);
  return src.slice(start, start + 1200);
}

describe("the due-attempt scan is bounded by the cutoff", () => {
  it("filters on the assignment's own assigned_at, not on send_after alone", () => {
    expect(scanChain()).toContain(
      '.gte("message_sequence_runs.lead_assignments.assigned_at", cutoff)'
    );
  });

  it("uses !inner on both embeds — a left join returns every draft with the run nulled (§27.8)", () => {
    const chain = scanChain();
    expect(chain).toContain("message_sequence_runs!inner");
    expect(chain).toContain("lead_assignments!inner");
    // A non-inner embed reads `message_sequence_runs(` with no bang.
    expect(chain).not.toMatch(/message_sequence_runs\(customer_id/);
  });

  it("only considers attempts that are actually outstanding", () => {
    const chain = scanChain();
    expect(chain).toContain('.eq("state", "pending")');
    expect(chain).toContain('.eq("message_sequence_runs.status", "active")');
    expect(chain).toContain('.lte("send_after"');
  });
});

describe("it fails closed rather than prompting about everything", () => {
  it("returns before the scan when no cutoff is stored", () => {
    expect(src).toContain('skipped: "no_notify_cutoff"');
    // The bail must come BEFORE the scan, or the filter has nothing to use.
    expect(src.indexOf('skipped: "no_notify_cutoff"')).toBeLessThan(
      src.indexOf('.from("message_sequence_drafts")')
    );
  });

  it("reads the cutoff from the settings key the migration seeds", () => {
    expect(src).toContain('.eq("key", "contact_notify_from")');
  });

  it("refuses to run at all while the switch is off", () => {
    expect(src).toContain('skipped: "contact_plans_disabled"');
    expect(src.indexOf('skipped: "contact_plans_disabled"')).toBeLessThan(
      src.indexOf('.from("message_sequence_drafts")')
    );
  });
});

describe("nobody is emailed who asked not to be", () => {
  it("checks the opt-out before either send", () => {
    expect(src).toContain('wantsNotification(c, "contact_followups")');
    expect(src.indexOf('wantsNotification(c, "contact_followups")')).toBeLessThan(
      src.indexOf("sendDailyFollowUpsEmail({")
    );
  });
});
