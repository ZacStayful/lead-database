import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CLAIM_WINDOW_DAYS,
  shouldPromptDeadLead,
} from "@/lib/quality/deadLeadPolicy";
import { CONTACT_EVENT_TYPES, isContactEvent } from "@/lib/contact/leadEvents";

/**
 * How many of this assignment's events to look at. The prompt only needs to
 * know whether there are three opens and any contact attempt, so the scan is
 * bounded rather than unbounded — 600 events an hour are possible per customer
 * (`/api/customer/events`), and this runs on every lead page load.
 */
const EVENT_SCAN_LIMIT = 50;

/**
 * Whether this assignment can be reported as dead on arrival, whether it
 * already has been, and whether to say so prominently.
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
  assignmentId: string,
): Promise<{
  claimable: boolean;
  claimStatus: string | null;
  /**
   * ⚠️ A BOOLEAN, never the count. An operator who knows the trigger is three
   * opens can produce three opens — the same instinct as §51.3's hidden
   * allowance one level down. The threshold stays server-side and out of the
   * browser bundle entirely.
   */
  prompt: boolean;
}> {
  const { data: existing } = await admin
    .from("lead_quality_claims")
    .select("status")
    .eq("lead_assignment_id", assignmentId)
    .maybeSingle();

  const claimStatus = (existing as { status?: string } | null)?.status ?? null;
  if (claimStatus) return { claimable: false, claimStatus, prompt: false };

  const { data, error } = await admin.rpc("claimable_dead_lead_assignments", {
    p_customer_id: customerId,
    p_window_days: CLAIM_WINDOW_DAYS,
  });

  if (error) {
    console.error("[deadLeadClaimState] eligibility read failed", error);
    return { claimable: false, claimStatus: null, prompt: false };
  }

  const rows = (data ?? []) as { assignment_id: string }[];
  const claimable = rows.some((r) => r.assignment_id === assignmentId);

  // ⚠️ Short-circuited. An ineligible or already-settled lead cannot be
  // prompted about, so it costs no second query — which is most page loads.
  if (!claimable) return { claimable, claimStatus: null, prompt: false };

  // Served by idx_lead_events_assignment_type_created on its
  // (assignment_id, event_type) prefix.
  const { data: events, error: eventsError } = await admin
    .from("lead_events")
    .select("event_type")
    .eq("assignment_id", assignmentId)
    .in("event_type", [...CONTACT_EVENT_TYPES, "detail_opened"])
    .limit(EVENT_SCAN_LIMIT);

  if (eventsError) {
    console.error("[deadLeadClaimState] event scan failed", eventsError);
    return { claimable, claimStatus: null, prompt: false };
  }

  const seen = (events ?? []) as { event_type: string }[];
  return {
    claimable,
    claimStatus: null,
    prompt: shouldPromptDeadLead({
      claimable,
      claimStatus: null,
      priorOpens: seen.filter((e) => e.event_type === "detail_opened").length,
      hasContactEvent: seen.some((e) => isContactEvent(e.event_type)),
    }),
  };
}
