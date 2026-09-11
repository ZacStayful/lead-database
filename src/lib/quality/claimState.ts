import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CLAIM_WINDOW_DAYS,
  reasonAvailability,
  shouldPromptDeadLead,
  unavailableSummary,
  type DeadLeadReason,
  type ReasonAvailability,
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
   * ⚠️ The AGE, not the open count. Publishable: the window is a stated rule
   * and the form greys a reason against it (§51). The prompt threshold stays
   * server-side for the opposite reason — see `prompt` below.
   */
  ageDays: number | null;
  /** Which reasons this lead can be reported under, and why not for the rest. */
  reasons: Record<DeadLeadReason, ReasonAvailability>;
  /** The one sentence to show when none of them can be used. */
  unavailableBecause: string | null;
  /**
   * ⚠️ A BOOLEAN, never the count. An operator who knows the trigger is three
   * opens can produce three opens — the same instinct as §51.3's hidden
   * allowance one level down. The threshold stays server-side and out of the
   * browser bundle entirely.
   */
  prompt: boolean;
}> {
  /**
   * Every exit from this function goes through here, so a new field cannot be
   * added to the shape and forgotten on the fail-closed path — which is the
   * path nobody exercises by hand.
   */
  const state = (
    claimable: boolean,
    claimStatus: string | null,
    ageDays: number | null,
    prompt: boolean,
  ) => {
    const reasons = reasonAvailability({ claimable, claimStatus, ageDays });
    return {
      claimable,
      claimStatus,
      ageDays,
      prompt,
      reasons,
      unavailableBecause: unavailableSummary(reasons),
    };
  };

  const { data: existing } = await admin
    .from("lead_quality_claims")
    .select("status")
    .eq("lead_assignment_id", assignmentId)
    .maybeSingle();

  const claimStatus = (existing as { status?: string } | null)?.status ?? null;
  if (claimStatus) return state(false, claimStatus, null, false);

  const { data, error } = await admin.rpc("claimable_dead_lead_assignments", {
    p_customer_id: customerId,
    p_window_days: CLAIM_WINDOW_DAYS,
  });

  if (error) {
    console.error("[deadLeadClaimState] eligibility read failed", error);
    return state(false, null, null, false);
  }

  const rows = (data ?? []) as { assignment_id: string; assigned_at: string }[];
  const row = rows.find((r) => r.assignment_id === assignmentId);
  const claimable = row != null;

  // ⚠️ The age comes from the SAME row the predicate returned, not a separate
  // read. `claimable_dead_lead_assignments` has returned `assigned_at` since
  // 0137, which is why 0139 needed no new function to support the per-reason
  // windows — the answer was already on the wire.
  const ageDays = row ? daysSince(row.assigned_at) : null;

  // ⚠️ Short-circuited. An ineligible or already-settled lead cannot be
  // prompted about, so it costs no second query — which is most page loads.
  if (!claimable) return state(false, null, await ageOf(admin, assignmentId), false);

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
    return state(claimable, null, ageDays, false);
  }

  const seen = (events ?? []) as { event_type: string }[];
  return state(
    claimable,
    null,
    ageDays,
    shouldPromptDeadLead({
      claimable,
      claimStatus: null,
      priorOpens: seen.filter((e) => e.event_type === "detail_opened").length,
      hasContactEvent: seen.some((e) => isContactEvent(e.event_type)),
    }),
  );
}

/** Whole days since a timestamp, floored. */
function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

/**
 * The age of an assignment the eligibility predicate did NOT return.
 *
 * ⚠️ This is what lets an out-of-window lead say so rather than falling back to
 * "you haven't worked it", which would be a lie on exactly the leads an
 * operator worked hardest and came back to late. One indexed primary-key read,
 * and only on the ineligible path.
 */
async function ageOf(
  admin: SupabaseClient,
  assignmentId: string,
): Promise<number | null> {
  const { data, error } = await admin
    .from("lead_assignments")
    .select("assigned_at")
    .eq("id", assignmentId)
    .maybeSingle();
  if (error || !data) return null;
  return daysSince((data as { assigned_at: string }).assigned_at);
}
