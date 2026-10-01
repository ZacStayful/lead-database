/**
 * Which leads in a monthly review were replaced, and with what (§73.8).
 *
 * Pure and import-free, because the review page renders from it and vitest is
 * pure units only.
 *
 * ⚠️ ONLY THE CUSTOMER'S OWN REPORTS ARE SHOWN: lead_quality_claims, from
 * §51/§52/§53. Two other swaps are deliberately left out:
 *   - A Stayful-pipeline withdrawal (§64) is "swapped without notification" by
 *     decision. Naming it here would be the notice that decision ruled out.
 *     Those replacements carry replacement_depth > 0 too, which is why an item
 *     is never tagged "replacement" from depth alone.
 *   - A plain admin swap (§34) writes no claim, so there is nothing to link
 *     the old lead to the new one.
 *
 * ⚠️ EACH CLAIM APPEARS IN EXACTLY ONE REVIEW:
 *   1. the review whose batch holds the reported lead, otherwise
 *   2. the review whose window contains the date of the report.
 * Rule 2 catches a lead swapped BEFORE month end: its assignment was deleted
 * before the capture, so it is not an item anywhere. Without rule 1, a report
 * made in the week after month end would land in next month's review, beside
 * a batch it has nothing to do with.
 */

export type ReplacementOutcome = "swapped" | "credited" | "under_review" | "declined";

export interface ClaimRow {
  id: string;
  lead_id: string;
  status: string;
  resolution: string;
  reason: string;
  created_at: string;
  replacement_lead_id: string | null;
  review_note: string | null;
}

export function replacementOutcome(status: string, resolution: string): ReplacementOutcome {
  if (status === "declined") return "declined";
  if (status === "under_review") return "under_review";
  if (resolution === "swap" || resolution === "self_swap") return "swapped";
  return "credited";
}

/**
 * ⚠️ No wording here may name the allowance (§51.3): words like "allowance",
 * "quota", "budget", "limit" or "remaining" are banned. A credit returned is a
 * lead credit, carried forward like any other (invariant 2).
 */
export const OUTCOME_LABEL: Record<ReplacementOutcome, string> = {
  swapped: "Replaced",
  credited: "Lead credit returned, carried forward",
  under_review: "Reported, we're reviewing it",
  declined: "Reported, not upheld",
};

export function claimsForReview<T extends ClaimRow>(
  claims: T[],
  opts: {
    itemLeadIds: ReadonlySet<string>;
    /** Lead ids in this customer's OTHER reviews for the same product. */
    otherReviewLeadIds: ReadonlySet<string>;
    cycleStart: string;
    cycleEnd: string;
  }
): T[] {
  return claims
    .filter((c) => {
      if (opts.itemLeadIds.has(c.lead_id)) return true;
      if (opts.otherReviewLeadIds.has(c.lead_id)) return false;
      const day = c.created_at.slice(0, 10);
      return day >= opts.cycleStart && day < opts.cycleEnd;
    })
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** Which items in the batch arrived as a replacement, keyed by the replacement lead id. */
export function replacementLeadIds<T extends ClaimRow>(claims: T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const c of claims) {
    if (c.replacement_lead_id && replacementOutcome(c.status, c.resolution) === "swapped") {
      out.set(c.replacement_lead_id, c);
    }
  }
  return out;
}
