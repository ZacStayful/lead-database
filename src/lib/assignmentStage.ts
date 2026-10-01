/**
 * Moving a lead through a customer's pipeline, server-side.
 *
 * Two writers share this: `PATCH /api/customer/assignments/[id]` (one lead, from
 * the lead page) and the monthly batch review (§73, many leads at once). One
 * definition means a stage moved by a survey leaves exactly the trace a stage
 * moved by hand leaves.
 *
 * ⚠️ `stage_changed` is written HERE, after the update succeeded, and NEVER
 * accepted from the browser (CLIENT_LEAD_EVENT_TYPES, §3, §40.7). A customer
 * able to post it could shield every lead they hold from escalation. It counts
 * as engagement from §56.4 onwards.
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** Best effort: the stage moved; the history row is reporting. Losing it must never fail the edit. */
export async function recordStageChanged(
  admin: Admin,
  assignmentId: string,
  from: string | null,
  to: string
): Promise<void> {
  if (from === to) return;
  const { error } = await admin.from("lead_events").insert({
    assignment_id: assignmentId,
    event_type: "stage_changed",
    metadata: { from, to },
  });
  if (error) {
    console.error("[assignments] stage_changed event failed", error);
  }
}

export interface PipelineWrite {
  markContacted: boolean;
  pipeline_stage?: string;
}

/**
 * Apply a pipeline change to one assignment that the caller has ALREADY proved
 * belongs to the customer.
 *
 * The same stamps the PATCH route makes: `first_contacted_at` once (coalesce,
 * first touch wins, §6) and `last_status_change_at` whenever status moves.
 * Moving off `cold` also flips status through the 0043 trigger; reaching a
 * winning stage sets `won` through 0050. Neither needs writing here.
 *
 * ⚠️ The `.neq("status", "rejected")` is the second stop behind the caller's
 * read-only check: a rejected lead is settled (0019, §6A) and nothing here may
 * move it, even if the status changed between the read and this write.
 */
export async function applyPipelineWrite(
  admin: Admin,
  assignment: { id: string; pipeline_stage: string | null; first_contacted_at: string | null },
  write: PipelineWrite
): Promise<{ ok: boolean }> {
  const now = new Date().toISOString();
  const update: Record<string, unknown> = {};
  if (write.markContacted) {
    update.status = "contacted";
    update.last_status_change_at = now;
    if (!assignment.first_contacted_at) update.first_contacted_at = now;
  }
  if (write.pipeline_stage !== undefined) update.pipeline_stage = write.pipeline_stage;
  if (Object.keys(update).length === 0) return { ok: true };

  let query = admin
    .from("lead_assignments")
    .update(update)
    .eq("id", assignment.id)
    .neq("status", "rejected")
    .is("closed_at", null);
  // Only a still-new lead is marked contacted; a lead that has moved on keeps
  // the status it earned.
  if (write.markContacted && write.pipeline_stage === undefined) {
    query = query.eq("status", "new");
  }
  const { data, error } = await query.select("id");
  if (error) {
    console.error("[assignments] pipeline write failed", assignment.id, error);
    return { ok: false };
  }
  // Nothing matched: the lead was settled or moved on between the read and
  // this write. No change, so no history row claiming one.
  if (!data || data.length === 0) return { ok: true };
  if (write.pipeline_stage !== undefined) {
    await recordStageChanged(admin, assignment.id, assignment.pipeline_stage, write.pipeline_stage);
  }
  return { ok: true };
}
