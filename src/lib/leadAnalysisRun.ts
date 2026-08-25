/**
 * Processing one row of a paid analysis job.
 *
 * The database work here is deliberately small, because the write path already
 * exists. A lead's figures and its stored PDF are governed by exactly two
 * things — `incomeReportPatch()` and `syncStoredReport()` — and they are the
 * only two things that touch them, whether the report came from a Monday item
 * or (now) from the analyser directly. Building an `IncomeReportOutcome` and
 * handing it to those two is the whole job.
 *
 * That is what makes an owned lead render identically to a marketplace one with
 * no display code at all: it is not "like" a parsed lead, it IS one.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { runLeadAnalysis } from "./analyserClient";
import { incomeReportPatch } from "./incomeReport";
import { syncStoredReport } from "./incomeReportStorage";
import { analysability, buildOutcomeFromAnalyserResponse } from "./leadAnalysis";
import { autoAssignLead } from "./ingest";
import type { Lead } from "./types";

/** A claimed row, joined to the lead it is about. */
export interface ClaimedAnalysisRow {
  id: string;
  job_id: string;
  lead_id: string;
  attempts: number;
  max_attempts: number;
}

export type RowResult =
  | { kind: "succeeded" }
  /** Terminal for this row. It is chargeable, so the finaliser will refund it. */
  | { kind: "failed"; errorCode: string; message: string }
  /** Put back for another attempt; the attempt is already spent. */
  | { kind: "retry"; errorCode: string; message: string }
  /**
   * Never reached the analyser. The attempt is REFUNDED to the row and the
   * caller should stop the run — marching the rest of a paid batch into the
   * same wall would burn every attempt on a problem that is ours to fix.
   */
  | { kind: "blocked"; errorCode: string; message: string };

interface LeadRow {
  id: string;
  lead_type: "management" | "guaranteed_rent";
  address: string | null;
  postcode: string | null;
  bedrooms: string | null;
  gross_annual_income: number | null;
  income_report_path: string | null;
}

export async function processAnalysisRow(
  admin: SupabaseClient,
  row: ClaimedAnalysisRow,
  opts: { timeoutMs?: number } = {}
): Promise<RowResult> {
  const { data: lead } = await admin
    .from("leads")
    .select(
      "id, lead_type, address, postcode, bedrooms, gross_annual_income, income_report_path"
    )
    .eq("id", row.lead_id)
    .maybeSingle();

  // The lead cascaded away — the customer deleted it between paying and this
  // row being claimed. One lead lost from a batch is not a reason to fail the
  // batch, and there is nothing left to refund into.
  if (!lead) {
    return { kind: "failed", errorCode: "lead_deleted", message: "The lead no longer exists." };
  }

  const typed = lead as LeadRow;

  // Re-checked here and not merely at purchase time: an address can be edited
  // between the two, and sending an unanalysable property costs a real report.
  // `already_analysed` is deliberately NOT a refusal at this point — a re-run
  // is a thing a customer can buy, and by now they have.
  const verdict = analysability(typed);
  if (!verdict.input) {
    return {
      kind: "failed",
      errorCode: verdict.code,
      message: "This lead no longer has what the analyser needs.",
    };
  }

  const outcome = await runLeadAnalysis(
    {
      requestId: row.id,
      address: verdict.input.address,
      postcode: verdict.input.postcode,
      bedrooms: verdict.input.bedrooms,
    },
    { timeoutMs: opts.timeoutMs }
  );

  if (outcome.kind === "blocked") {
    return { kind: "blocked", errorCode: outcome.errorCode, message: outcome.message };
  }
  if (outcome.kind === "retryable") {
    return { kind: "retry", errorCode: outcome.errorCode, message: outcome.message };
  }
  if (outcome.kind === "row_failed") {
    return { kind: "failed", errorCode: outcome.errorCode, message: outcome.message };
  }

  const report = buildOutcomeFromAnalyserResponse(outcome.payload, outcome.pdfBytes);

  if (report.status !== "parsed") {
    // Untrustworthy figures. Worth one more attempt — the quality gate is
    // exactly what an upstream blip looks like from here — and a refundable
    // failure once the attempts are gone.
    const spent = row.attempts >= row.max_attempts;
    const detail = report.error ?? "The analyser could not produce trustworthy figures.";
    return spent
      ? { kind: "failed", errorCode: "no_str_data", message: detail }
      : { kind: "retry", errorCode: "no_str_data", message: detail };
  }

  // ── The existing seam, used exactly as the Monday sweep uses it ────
  // The file and the figures land in ONE update, so a lead can never end up
  // showing numbers attributed to a document that was not stored.
  const stored = await syncStoredReport({
    admin,
    leadId: typed.id,
    outcome: report,
    currentPath: typed.income_report_path,
  });

  const { error: writeError } = await admin
    .from("leads")
    .update({ ...incomeReportPatch(report), ...stored })
    .eq("id", typed.id);

  if (writeError) {
    // We have the figures and have already paid for them; only the write
    // failed. Retry rather than refund — the analyser's own 24-hour cache means
    // the next attempt re-reads the same report for free.
    console.error("leadAnalysisRun: write failed", typed.id, writeError);
    return { kind: "retry", errorCode: "write_failed", message: writeError.message };
  }

  // ── The lead is now analysed, which is what makes it sellable ─────
  //
  // A customer's own lead goes to exactly one other operator once a PAID
  // analysis has returned figures we trust (§32). Everything above is that
  // condition: a `quality_ok = false` run — the analyser's tell-tale for a
  // synthetic estimate — and every other failure returned long before here, so
  // reaching this line IS the qualification.
  //
  // NEITHER OF THE TWO STEPS MAY FAIL THE ROW. The customer paid for figures
  // and has them; the row is a success whatever happens next. A missed
  // qualification costs a resale we were never owed, and the RPC is idempotent
  // so a later re-run picks it up.
  await qualifyAndRoute(admin, typed.id);

  return { kind: "succeeded" };
}

/**
 * Mark an analysed owned lead sellable, then offer it — immediately.
 *
 * "Immediately" is the design: there is no head-start window, so the moment the
 * figures land the lead enters ordinary routing for its single further operator.
 * This is the only automatic driver of that. `assign-pending` is an admin
 * button and is not in `vercel.json`, and the two `autoAssignLead` calls in
 * `ingest.ts` are both inside `ingestLead`, which never sees an owned lead —
 * they have no Monday item by construction (0102's CHECK).
 *
 * Best-effort throughout, and deliberately so: see the caller.
 */
async function qualifyAndRoute(admin: SupabaseClient, leadId: string): Promise<void> {
  const { data: qualified, error } = await admin.rpc(
    "qualify_owned_lead_for_resale",
    { p_lead_id: leadId }
  );

  if (error) {
    console.error("leadAnalysisRun: qualify failed", leadId, error);
    return;
  }

  // False is the ordinary case, not a fault: every marketplace lead read off
  // Monday comes through here too, and so does a paid RE-RUN of a lead already
  // qualified. The RPC's own predicates decide, and it is idempotent.
  if (!qualified) return;

  const { data: lead, error: readError } = await admin
    .from("leads")
    .select("*")
    .eq("id", leadId)
    .maybeSingle();

  if (readError || !lead) {
    console.error("leadAnalysisRun: could not re-read qualified lead", leadId, readError);
    return;
  }

  try {
    await autoAssignLead(admin, lead as Lead);
  } catch (err) {
    // A lead that finds no candidate today is not an error — every subscriber
    // may be at quota, and banked leads are inventory rather than a backlog
    // (§4). A thrown error is, but not one worth failing a paid row over.
    console.error("leadAnalysisRun: routing a qualified lead threw", leadId, err);
  }
}
