import { isLabelKey, monthLine, type LabelKey } from "@/lib/leadBrief/labelCopy";

/**
 * The dashboard's "This month: x top · y strong · z first pick · w nearby"
 * line (Lead Brief Phase 5). Pure: the home page already holds every
 * assignment, so this counts in memory and adds no query.
 *
 * "This month" is the customer's billing cycle, from `currentCycleStart`
 * (replacementEntitlement.ts), the same boundary leads_received_this_month
 * resets on. Only labelled assignments count, and only a brief customer's
 * deliveries are ever labelled, so an existing customer gets null and the line
 * never renders for them.
 */
export function countLabelsSince(
  assignments: { match_label?: string | null; assigned_at: string }[],
  cycleStartIso: string | null
): Record<LabelKey, number> | null {
  if (!cycleStartIso) return null;
  const since = Date.parse(`${cycleStartIso}T00:00:00Z`);
  if (!Number.isFinite(since)) return null;

  const counts: Record<LabelKey, number> = {
    top_match: 0,
    strong_match: 0,
    first_pick: 0,
    nearby_opportunity: 0,
  };
  let any = false;
  for (const a of assignments) {
    if (!isLabelKey(a.match_label)) continue;
    const at = Date.parse(a.assigned_at);
    if (!Number.isFinite(at) || at < since) continue;
    counts[a.match_label] += 1;
    any = true;
  }
  return any ? counts : null;
}

/** The rendered line, or null when there is nothing to say. */
export function thisMonthLine(
  assignments: { match_label?: string | null; assigned_at: string }[],
  cycleStartIso: string | null
): string | null {
  const counts = countLabelsSince(assignments, cycleStartIso);
  return counts ? monthLine(counts) : null;
}
