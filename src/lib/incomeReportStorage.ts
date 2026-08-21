import type { createAdminClient } from "@/lib/supabase/admin";
import type { IncomeReportOutcome } from "@/lib/incomeReport";

/**
 * Keeping a lead's property-analysis PDF (0092).
 *
 * THE ONE PLACE ANYTHING IS WRITTEN TO THE lead-reports BUCKET. Both writers —
 * ingest for a brand-new lead, the daily sweep for everything else — go through
 * `syncStoredReport`, so the file and the figures can never be governed by two
 * different rules.
 *
 * This is the first server-side upload in the codebase. Training media uses a
 * signed upload URL because the BROWSER holds the bytes and a Vercel function
 * caps its request body at 4.5 MB; here the server already has ~25 KB in hand
 * from the parse it just did, so a direct service-role upload is both simpler
 * and one fewer round trip.
 */

export const LEAD_REPORTS_BUCKET = "lead-reports";

/**
 * ONE FIXED PATH PER LEAD, and that is what implements "keep only the current
 * report". Replacement is an overwrite, so there is no second object to delete,
 * no window in which two reports exist, and nothing to garbage-collect if a
 * write fails half way. The asset id is deliberately NOT in the path: it
 * changes when sales re-run the analyser, and a path that moved would leave the
 * old file orphaned in the bucket for ever.
 */
export function reportObjectPath(leadId: string): string {
  return `${leadId}/analysis.pdf`;
}

/**
 * What a `leads` row should say about its stored report, given what just
 * happened to the parse.
 *
 * Returns a PATCH FRAGMENT for the caller to merge into the update it is
 * already doing, rather than writing itself — one write per lead, and the file
 * and the figures land together or not at all.
 *
 * THE FOUR OUTCOMES ARE NOT SYMMETRICAL, and the asymmetry is the point:
 *
 *   parsed     upload and record it.
 *   no_report  the Monday item no longer carries an analysis — remove ours.
 *   unparsed   we read a document and could not trust it. No figures are shown
 *              for this lead, so a lone "read the analysis" link would be an
 *              orphan. Remove.
 *   failed     LEAVE EVERYTHING ALONE.
 *
 * That last one is why these columns are not in `incomeReportPatch()`. That
 * function clears every figure on every outcome so a replaced report cannot
 * leave stale numbers attributed to a document that no longer states them —
 * exactly right for a figure we can recompute tomorrow, and exactly wrong for a
 * file. `failed` means Monday was unreachable or the download broke; treating
 * it the same way would delete a perfectly good PDF, and the operator's link to
 * it, because of a network blip.
 *
 * NEVER THROWS, and never costs the figures. A storage error returns an empty
 * fragment and logs: the gross, rate and occupancy publish regardless. Losing a
 * working income figure because a bucket was briefly unavailable would trade
 * something that works for something that does not — the same "they fail alone"
 * rule the rate and occupancy already follow.
 */
export async function syncStoredReport({
  admin,
  leadId,
  outcome,
  currentPath,
}: {
  admin: ReturnType<typeof createAdminClient>;
  leadId: string;
  outcome: IncomeReportOutcome;
  /** What the row says today. Null on ingest, which only ever creates. */
  currentPath: string | null;
}): Promise<Record<string, unknown>> {
  try {
    if (outcome.status === "failed") return {};

    if (outcome.status === "parsed" && outcome.bytes) {
      const path = reportObjectPath(leadId);
      const { error } = await admin.storage
        .from(LEAD_REPORTS_BUCKET)
        .upload(path, outcome.bytes, {
          contentType: "application/pdf",
          // The whole retention rule in one option. Without it a second parse
          // of the same lead errors on an occupied path and the stored report
          // silently stops tracking the figures beside it.
          upsert: true,
        });
      if (error) {
        console.error("syncStoredReport: upload failed", leadId, error);
        return {};
      }
      return {
        income_report_path: path,
        income_report_size_bytes: outcome.bytes.byteLength,
      };
    }

    // no_report / unparsed, or a parsed outcome that somehow carried no bytes.
    if (!currentPath) return {};

    const { error } = await admin.storage
      .from(LEAD_REPORTS_BUCKET)
      .remove([currentPath]);
    if (error) {
      // Clearing the columns anyway would leave a file nothing points at;
      // leaving them alone means tomorrow's run tries the removal again.
      console.error("syncStoredReport: remove failed", leadId, error);
      return {};
    }
    return { income_report_path: null, income_report_size_bytes: null };
  } catch (err) {
    console.error("syncStoredReport: unexpected failure", leadId, err);
    return {};
  }
}
