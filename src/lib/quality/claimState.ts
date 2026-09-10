import type { SupabaseClient } from "@supabase/supabase-js";
import { CLAIM_WINDOW_DAYS } from "@/lib/quality/deadLeadPolicy";

/**
 * Whether this assignment can be reported as dead on arrival, and whether it
 * already has been.
 *
 * Resolved server-side on the admin client for the usual reason: the predicate
 * is `security definer` and `lead_quality_claims` is deny-all to the browser.
 *
 * The point of asking at all is that the control must not offer something the
 * route would then refuse — the rule §35 states for the admin picker, and the
 * reason `AdminLeadControls` groups rather than hides. Here it hides, because
 * the operator has no override to be offered.
 *
 * ⚠️ FAILS CLOSED. An unreadable predicate hides the control rather than
 * showing one whose POST is going to 400. This costs an operator nothing they
 * can see: reject, close and the rest of the page are untouched.
 */
export async function deadLeadClaimState(
  admin: SupabaseClient,
  customerId: string,
  assignmentId: string
): Promise<{ claimable: boolean; claimStatus: string | null }> {
  const { data: existing } = await admin
    .from("lead_quality_claims")
    .select("status")
    .eq("lead_assignment_id", assignmentId)
    .maybeSingle();

  const claimStatus = (existing as { status?: string } | null)?.status ?? null;
  if (claimStatus) return { claimable: false, claimStatus };

  const { data, error } = await admin.rpc("claimable_dead_lead_assignments", {
    p_customer_id: customerId,
    p_window_days: CLAIM_WINDOW_DAYS,
  });

  if (error) {
    console.error("[deadLeadClaimState] eligibility read failed", error);
    return { claimable: false, claimStatus: null };
  }

  const rows = (data ?? []) as { assignment_id: string }[];
  return {
    claimable: rows.some((r) => r.assignment_id === assignmentId),
    claimStatus: null,
  };
}
