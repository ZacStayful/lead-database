/**
 * Three measures of what an operator has left unfinished, computed from
 * lead_assignments rows the dashboard already loads.
 *
 * No new telemetry and no new migration: every column used here
 * (due_to_call_date, last_status_change_at, pipeline_stage, closed_at) has been
 * on the table for some time and is simply never counted anywhere. The
 * dashboard already selects "*", so this is arithmetic on data in hand.
 *
 * WHY THESE THREE
 * ---------------
 * Win rate cannot carry a personal metric yet — 3 wins across 308 assignments.
 * These three are populated enough to mean something today:
 *
 *   overdue callbacks   16 of the 17 callbacks ever set are overdue
 *   stalled leads       70 assignments contacted then untouched for 14+ days
 *   meeting rate        20 meetings across 9 operators, ~7x the win volume
 *
 * The first two point at a specific lead the operator can act on this
 * afternoon, which is the whole reason they beat another rate.
 */
import type { AssignmentWithLead } from "@/lib/types";
import { meetingStagesForLeadType } from "@/components/dashboard/pipelineStage";

/**
 * A lead is "settled" when there is nothing left for the operator to do with
 * it. Both terminal statuses count, and so does an explicit close (0067) —
 * chasing somebody about a lead they have already reported as dead is exactly
 * the kind of nagging that gets a dashboard ignored.
 *
 * 'in_discussion' is deliberately NOT settled: an active conversation still
 * goes stale, and that is precisely when a reminder is worth having.
 */
function isSettled(a: AssignmentWithLead): boolean {
  return (
    ["won", "rejected", "not_relevant"].includes(a.status) ||
    a.closed_at !== null
  );
}

/** Days a lead has sat at its current status before it counts as stalled. */
export const STALLED_AFTER_DAYS = 14;

export type WorkSummary = {
  /** Callbacks the operator scheduled and the date has passed. */
  overdueCallbacks: number;
  /** Of those, the earliest date still outstanding — null when none. */
  oldestCallbackDate: string | null;
  /** Contacted, unsettled, and no status change for STALLED_AFTER_DAYS. */
  stalledLeads: number;
  /** Leads that reached a meeting/viewing stage. */
  meetings: number;
  /** Leads the operator actually went after (the honest denominator). */
  attempted: number;
  /**
   * meetings / attempted, or null below the sample floor. Measured against
   * attempted rather than delivered for the reason 0067 gives: a rate over
   * everything delivered mostly measures whether the operator bothered, which
   * is already reported separately.
   */
  meetingRate: number | null;
};

/**
 * Below this many attempted leads a rate is noise — one meeting out of two
 * reads as 50% and means nothing. Matches the spirit of c_min_attempts in 0047.
 */
export const MIN_ATTEMPTED_FOR_RATE = 5;

export function computeWorkSummary(
  assignments: AssignmentWithLead[],
  now: Date = new Date()
): WorkSummary {
  const today = now.toISOString().slice(0, 10);
  const stalledBefore = new Date(
    now.getTime() - STALLED_AFTER_DAYS * 24 * 60 * 60 * 1000
  );

  let overdueCallbacks = 0;
  let oldestCallbackDate: string | null = null;
  let stalledLeads = 0;
  let meetings = 0;
  let attempted = 0;

  for (const a of assignments) {
    const settled = isSettled(a);

    // Compare as ISO date strings: due_to_call_date is a DATE column with no
    // time or zone, so parsing it into a Date would drag the server's timezone
    // into a question that has none.
    if (!settled && a.due_to_call_date && a.due_to_call_date < today) {
      overdueCallbacks += 1;
      if (
        oldestCallbackDate === null ||
        a.due_to_call_date < oldestCallbackDate
      ) {
        oldestCallbackDate = a.due_to_call_date;
      }
    }

    if (
      !settled &&
      a.status === "contacted" &&
      new Date(a.last_status_change_at) < stalledBefore
    ) {
      stalledLeads += 1;
    }

    if (a.first_contacted_at) attempted += 1;
    if (meetingStagesForLeadType(a.lead?.lead_type).includes(a.pipeline_stage)) {
      meetings += 1;
    }
  }

  return {
    overdueCallbacks,
    oldestCallbackDate,
    stalledLeads,
    meetings,
    attempted,
    meetingRate:
      attempted >= MIN_ATTEMPTED_FOR_RATE ? meetings / attempted : null,
  };
}
