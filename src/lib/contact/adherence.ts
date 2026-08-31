/**
 * Is the customer actually doing the work? (§42)
 *
 * ONE READER of `get_customer_followup_adherence`, shared by the admin panel,
 * the customer's own figures and the weekly notice. Three separate readings of
 * "are they keeping up" would eventually disagree, and the customer-facing one
 * disagreeing with the admin one is the version of that failure that costs a
 * support argument nobody can win.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

type Admin = SupabaseClient;

export interface AdherenceRow {
  customer_id: string;
  business_name: string | null;
  due: number;
  done: number;
  done_by_click: number;
  done_manually: number;
  skipped: number;
  overdue: number;
  oldest_overdue_days: number;
  adherence_pct: number | null;
  last_action_at: string | null;
}

/**
 * Read adherence for every customer over a window.
 *
 * ⚠️ FAILS TO AN EMPTY LIST, never throws. This feeds a reporting panel and a
 * nudge; an unapplied migration must cost one block rather than the page — the
 * posture `getOutcomeOverview` already takes on /admin/outcomes.
 */
export async function fetchAdherence(
  admin: Admin,
  sinceDays = 14
): Promise<{ rows: AdherenceRow[]; unavailable: boolean }> {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  const { data, error } = await admin.rpc("get_customer_followup_adherence", {
    p_since: since,
  });

  if (error) {
    console.error("[contact] adherence read failed", error.message);
    return { rows: [], unavailable: true };
  }

  const rows = ((data ?? []) as AdherenceRow[]).slice();
  // Worst first: this panel exists to answer "who is not doing the work", and
  // an alphabetical list buries exactly the people it is for. Ties break on the
  // bigger backlog, then the older one.
  rows.sort((a, b) => {
    const pa = a.adherence_pct ?? 100;
    const pb = b.adherence_pct ?? 100;
    if (pa !== pb) return pa - pb;
    if (a.overdue !== b.overdue) return b.overdue - a.overdue;
    return b.oldest_overdue_days - a.oldest_overdue_days;
  });
  return { rows, unavailable: false };
}

/**
 * Whether this customer is far enough behind to be told.
 *
 * ⚠️ BOTH CONDITIONS, NOT EITHER. A customer with two attempts due and one done
 * is at 50% and has done nothing wrong — they may simply have joined this week.
 * The minimum-overdue floor is what stops the notice firing at somebody whose
 * plan has barely started, which is the fastest way to make it ignored.
 */
export function shouldNotify(
  row: Pick<AdherenceRow, "adherence_pct" | "overdue">,
  limits: { noticePct: number; noticeMinOverdue: number }
): boolean {
  if (row.adherence_pct === null) return false;
  return (
    row.adherence_pct < limits.noticePct && row.overdue >= limits.noticeMinOverdue
  );
}

/**
 * What the notice says.
 *
 * ⚠️ FACTS, THEN THE COMPARISON, THEN ONE BUTTON. No scolding and no ranking —
 * §20 refuses to rank for a reason that applies doubly here: the operators most
 * likely to drift are exactly the ones a league table punishes. It states what
 * is outstanding, what the difference has been worth, and where to go.
 */
export function noticeLines(row: AdherenceRow, bookedRatePct: number): string[] {
  const lines = [
    `You have ${row.due} follow-up${row.due === 1 ? "" : "s"} due in the last fortnight and have made ${row.done}.`,
  ];
  if (row.overdue > 0) {
    lines.push(
      `${row.overdue} landlord${row.overdue === 1 ? " is" : "s are"} waiting on an attempt that is already past its date.`
    );
  }
  lines.push(
    `Leads worked through the full five-attempt sequence have booked a meeting about ${bookedRatePct}% of the time in our own pipeline.`
  );
  return lines;
}
