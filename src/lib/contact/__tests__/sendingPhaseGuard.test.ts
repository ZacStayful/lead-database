/**
 * ⚠️ THE REGRESSION THAT COST 91 RUNS ON PRODUCTION (§42).
 *
 * A contact plan is `delivery = 'manual'`: the operator makes the attempt from
 * their own phone. If the sending phase of /api/cron/poll-whatsapp-status ever
 * picks one up, it hands it to `sendOneMessage`, which returns `not_connected`
 * — there are zero connected TimelinesAI workspaces — and SEQUENCE_STOP_CODES
 * maps that to `stopRun("no_connection")`, sweeping every remaining attempt to
 * `skipped`. The plan is destroyed within five minutes of being created.
 *
 * This filter was in the design, asserted in the pull request as "the safety
 * boundary", and never written. What let it through is instructive: the scratch
 * seam test checked the query SHAPE by hand-writing the equivalent SQL, and the
 * unit test asserted the filter on `completeAttempt` — the COMPLETION path, not
 * the SENDING path. Both passed while the live query had no such clause.
 *
 * So this asserts the exported constant the route actually selects with, and
 * the route actually filtering on it — not a query written here.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DUE_DRAFT_COLUMNS } from "@/lib/messaging/sequences";

const ROUTE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../app/api/cron/poll-whatsapp-status/route.ts"
);

describe("the sending phase must never see a manual contact plan", () => {
  it("embeds the sequence's delivery mode, so it can be filtered on at all", () => {
    expect(DUE_DRAFT_COLUMNS).toContain("message_sequences!inner(delivery)");
  });

  it("uses !inner on BOTH embeds — a left join returns manual drafts with the sequence nulled (§27.8)", () => {
    expect(DUE_DRAFT_COLUMNS).toContain("message_sequence_runs!inner");
    expect(DUE_DRAFT_COLUMNS).toContain("message_sequences!inner");
    // A non-inner embed would read `message_sequences(delivery)`.
    expect(DUE_DRAFT_COLUMNS).not.toMatch(/message_sequences\(delivery\)/);
  });

  it("and the route restricts the scan to delivery = 'auto'", () => {
    const src = readFileSync(ROUTE, "utf8");
    expect(src).toContain(
      '.eq("message_sequence_runs.message_sequences.delivery", "auto")'
    );
  });

  it("that filter sits on the DUE-DRAFT scan, not somewhere else in the file", () => {
    const src = readFileSync(ROUTE, "utf8");
    // Anchored on the SELECT, not the import at the top of the file.
    const scanStart = src.indexOf(".select(DUE_DRAFT_COLUMNS)");
    expect(scanStart).toBeGreaterThan(-1);
    // The filter must appear within the same query chain, before it is awaited.
    const chain = src.slice(scanStart, scanStart + 900);
    expect(chain).toContain('"message_sequence_runs.message_sequences.delivery"');
  });
});
