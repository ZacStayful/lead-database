import { createAdminClient } from "@/lib/supabase/admin";

/**
 * The month-over-month series (0099 / 0101).
 *
 * ⚠️ TWO SEPARATE READERS, NEVER ONE COMBINED ROW — and that is the whole
 * design, not an accident of layout.
 *
 * A month has two kinds of figure and they are keyed differently:
 *
 *   COHORT   keyed on the month a lead was DELIVERED, state read NOW. It DRIFTS
 *            UPWARD forever: a July lead worked in September moves July's
 *            number (§28.2).
 *   ACTIVITY keyed on when the activity HAPPENED. It settles when the month
 *            ends and never moves again.
 *
 * On live data the two halves tell OPPOSITE STORIES for the same months — the
 * cohort half looks like a collapse (immaturity) while the activity half shows
 * engagement climbing steeply. Fusing them into one row is how a reader
 * averages the two into a single wrong impression, so they are fetched
 * separately, rendered under separate headings, and each carries a `basis`
 * string from SQL saying which it is.
 *
 * Separate exports rather than one Promise.all, following getPauseInsight and
 * getWorkedConversion in outcomes.ts: an all-or-nothing fetch makes every panel
 * unavailable when one migration has not been applied to an environment.
 */

const n = (v: unknown): number => Number(v ?? 0);
const nOrNull = (v: unknown): number | null => (v == null ? null : Number(v));
const sOrNull = (v: unknown): string | null => (v == null ? null : String(v));

/** Committed revenue, captured monthly. Not derivable — see 0099. */
export interface CommercialMonth {
  monthStart: string;
  managementMrrPence: number;
  grMrrPence: number;
  totalMrrPence: number;
  /** Reported beside the total and never added to it (§21). */
  pausedMrrPence: number;
  customersBilled: number;
  pausedCustomers: number;
  capturedDays: number;
  lastCapturedOn: string | null;
  /** The month is over AND a capture landed on its final day. */
  complete: boolean;
}

/** What operators actually did, in the month they did it. Derived — see 0101. */
export interface ActivityMonth {
  monthStart: string;
  opens: number;
  leadsOpened: number;
  contactClicks: number;
  notesAdded: number;
  stageChanges: number;
  customersActive: number;
  /** Days of the month for which telemetry could exist at all. */
  activityDaysCovered: number;
  daysInMonth: number;
  /** False before the 0098 trigger existed — a zero then is "not recording". */
  stageEventsAvailable: boolean;
  basis: string;
}

export interface CommercialSeries {
  unavailable: boolean;
  months: CommercialMonth[];
}

export interface ActivitySeries {
  unavailable: boolean;
  months: ActivityMonth[];
}

export async function getCommercialSeries(): Promise<CommercialSeries> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("get_monthly_commercial");
  if (error) {
    console.error("[monthlySeries] commercial unavailable", error);
    return { unavailable: true, months: [] };
  }
  return {
    unavailable: false,
    months: ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      monthStart: String(r.month_start),
      managementMrrPence: n(r.management_mrr_pence),
      grMrrPence: n(r.gr_mrr_pence),
      totalMrrPence: n(r.total_mrr_pence),
      pausedMrrPence: n(r.paused_mrr_pence),
      customersBilled: n(r.customers_billed),
      pausedCustomers: n(r.paused_customers),
      capturedDays: n(r.captured_days),
      lastCapturedOn: sOrNull(r.last_captured_on),
      complete: Boolean(r.complete),
    })),
  };
}

export async function getActivitySeries(): Promise<ActivitySeries> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("get_monthly_activity", {
    p_lead_type: "management",
  });
  if (error) {
    console.error("[monthlySeries] activity unavailable", error);
    return { unavailable: true, months: [] };
  }
  return {
    unavailable: false,
    months: ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      monthStart: String(r.month_start),
      opens: n(r.opens),
      leadsOpened: n(r.leads_opened),
      contactClicks: n(r.contact_clicks),
      notesAdded: n(r.notes_added),
      stageChanges: n(r.stage_changes),
      customersActive: n(r.customers_active),
      activityDaysCovered: n(r.activity_days_covered),
      daysInMonth: n(r.days_in_month),
      stageEventsAvailable: Boolean(r.stage_events_available),
      basis: String(r.basis ?? "activity_in_month"),
    })),
  };
}

/**
 * Below this share of a month's days, an activity figure is a partial count and
 * must not be compared with a full month.
 *
 * lead_events begins 27 July 2026, so July carries FIVE covered days against 31
 * — much of August's apparent 3.4x rise in opens is simply telemetry starting.
 */
export const COVERAGE_FLOOR = 0.8;

export function isMonthCovered(m: {
  activityDaysCovered: number;
  daysInMonth: number;
}): boolean {
  if (m.daysInMonth <= 0) return false;
  return m.activityDaysCovered / m.daysInMonth >= COVERAGE_FLOOR;
}

/**
 * Is a month-on-month delta meaningful yet?
 *
 * Needs TWO fully comparable months. One reading is not a trend, and a
 * two-point line on this data is exactly the §28.2 failure — July 19.0% to
 * August 5.9% reads as a collapse that was entirely August being three weeks
 * old. Until this returns true the delta renders as an em dash with the reason
 * in words, never as a zero or a flat arrow.
 */
export function deltaAvailable(comparableMonths: number): boolean {
  return comparableMonths >= 2;
}

/** A signed change between two figures, or null when there is nothing to compare. */
export function delta(
  current: number | null,
  previous: number | null
): number | null {
  if (current == null || previous == null) return null;
  return current - previous;
}

export { nOrNull };
