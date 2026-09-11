/**
 * Why a lead ended, in the operator's own words — the closed vocabulary behind
 * every outcome (§51.10).
 *
 * Reject recorded no reason at all before 0138, discard recorded none, and
 * close recorded one of two coarse options. Only the §51 report captured
 * anything usable, so 55 assignments on the book at the time had ended with no
 * account of why. This is the list that fixes that, and it is the ONE
 * definition: `lead_outcome_reasons_reason_check` in 0138 mirrors it
 * character-for-character and `outcomeReasons.test.ts` asserts the equality
 * mechanically — the arrangement §29 uses for `cancelOptions.ts`.
 *
 * ⚠️ THE TWO HALVES MUST NEVER OVERLAP, and that is the whole design.
 *
 * Reject and discard describe the OPERATOR'S OWN FIT — the area they cover, the
 * properties they take on, the numbers, their capacity. Close and report
 * describe THE LANDLORD. Nothing resembling "the landlord had already gone" may
 * ever appear on the reject list: that sentence is the refundable one (§51),
 * and a no-refund path to it would make the data ambiguous at exactly the point
 * it should be sharpest, while teaching operators that the same words pay
 * differently depending on which button they press.
 *
 * ⚠️ Kept import-free. `LeadOutcomePanel` is a "use client" component and these
 * labels are what it renders, so this file must never reach for `plans.ts` or
 * anything else server-side — the split §21.8 states for `featureRequest.ts`.
 */

/**
 * What an operator says when the lead was never a fit for them.
 *
 * Shared by reject and discard because it is the same judgement made at two
 * different moments: discard is available only before a note or a status
 * change, reject after. Asking two different questions about one judgement
 * would split the data for no reason.
 */
export const FIT_REASONS = {
  wrong_area: "Outside the area I cover",
  wrong_property: "Not the kind of property I take on",
  poor_numbers: "The numbers do not work for me",
  at_capacity: "I have as much as I can take on right now",
  other: "Something else",
} as const;

export type FitReason = keyof typeof FIT_REASONS;

export const FIT_REASON_KEYS = Object.keys(FIT_REASONS) as FitReason[];

/** Narrow untrusted input to a reason reject and discard both accept. */
export function isFitReason(value: unknown): value is FitReason {
  return typeof value === "string" && value in FIT_REASONS;
}

/**
 * Detail is optional everywhere except the report, which has its own 20
 * character floor because the landlord's words are the evidence for a credit
 * (§51). Demanding prose to reject a lead in the wrong county is friction on a
 * one-click action, and at scale it produces "n/a".
 *
 * The cap mirrors `lead_outcome_reasons_detail_check`.
 */
export const OUTCOME_DETAIL_MAX = 2000;

/** Trim to what the CHECK will accept, or null. Never throws. */
export function normaliseOutcomeDetail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, OUTCOME_DETAIL_MAX);
}
