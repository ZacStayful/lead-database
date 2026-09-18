import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Opening a lead marks it seen (§63.5).
 *
 * Two best-effort writes, both guarded on the column still being null so two
 * tabs opening the same lead cannot race each other:
 *
 *   - `lead_assignments.viewed_at`, first open wins. Until 0154 this was set
 *     ONLY by expanding a card in the feed (§11), so a lead reached through the
 *     email or text link read "new" for ever and the Needs-attention count
 *     never came down for it.
 *   - the assignment's unread `new_lead` notification, so the bell count and
 *     the home card clear once the customer has actually looked.
 *
 * `detail_opened` — the telemetry event — is NOT written here. LeadWorkspace
 * records it once from the browser, exactly as before; the two signals are
 * still distinct (a card expand sets viewed_at with no detail_opened).
 *
 * Never throws: a failed stamp costs a stale dot, not the page.
 */
export async function markLeadSeen(
  admin: SupabaseClient,
  params: {
    assignmentId: string;
    customerId: string;
    alreadyViewed: boolean;
    now?: Date;
  }
): Promise<void> {
  const nowIso = (params.now ?? new Date()).toISOString();

  if (!params.alreadyViewed) {
    const { error } = await admin
      .from("lead_assignments")
      .update({ viewed_at: nowIso })
      .eq("id", params.assignmentId)
      .eq("customer_id", params.customerId)
      .is("viewed_at", null);
    if (error) {
      console.error("markLeadSeen: viewed_at stamp failed", { assignmentId: params.assignmentId, error });
    }
  }

  const { error: notifError } = await admin
    .from("notifications")
    .update({ read_at: nowIso })
    .eq("lead_assignment_id", params.assignmentId)
    .eq("customer_id", params.customerId)
    .eq("notification_type", "new_lead")
    .is("read_at", null);
  if (notifError) {
    console.error("markLeadSeen: notification read stamp failed", {
      assignmentId: params.assignmentId,
      error: notifError,
    });
  }
}
