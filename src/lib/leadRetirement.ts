/**
 * Why a lead is not offered — the one place the database's verdict becomes
 * something an admin can read.
 *
 * `lead_retirement_reason()` (0144) carries the arms of invariant 11's
 * predicate and returns the basis as a short key. This maps those keys onto
 * what an admin sees in the swap picker, where such a lead now appears greyed
 * rather than absent (§53.10): §52.4's rule that a control which silently
 * disappears reads as broken and teaches nobody the rule.
 *
 * ⚠️ THIS FILE MUST STAY IMPORT-FREE. `SwapLeadControl` is a "use client"
 * component, so anything this reaches is bundled into the browser — the same
 * split `featureRequest.ts` makes from `announcements.ts` (§21.8) and
 * `deadLeadCopy.ts` from `deadLeadPolicy.ts` (§51.6).
 *
 * ⚠️ THE KEYS ARE A CONTRACT WITH THE SQL, character for character.
 * `leadRetirement.test.ts` reads the migration and asserts the two vocabularies
 * are the same set — the arrangement §29 uses for `cancelOptions.ts`. A basis
 * added in SQL and not here would render as its raw key; one renamed here and
 * not there would render as nothing.
 */

/** The basis, exactly as `lead_retirement_reason()` spells it. */
export const LEAD_RETIREMENT_REASONS = {
  /**
   * Somebody claimed it out of the expired pool. The only basis with no admin
   * escape hatch, and none should exist: the lead belongs to whoever claimed
   * it and §19.6 is explicit the slot never reopens.
   */
  claimed_from_pool: "claimed from the expired pool",
  /** 90 days from first entering the pool (§19.2). Reversible from /admin/pool. */
  pool_expired: "expired in the leads pool",
  /** Pooled after nobody worked it, which retires it (§19.1). Reversible. */
  pooled_ignored: "in the expired leads pool",
  /**
   * A customer's own lead that has not been through a paid analysis (§32.4).
   * Not reachable from the swap picker, which withholds owned leads outright —
   * carried here so the vocabulary is complete and a later caller renders it.
   */
  owner_unqualified: "added by a customer and not resaleable",
  /** Contact details we judged unusable (§36). Reversible on the lead page. */
  quality_failed: "contact details failed the quality check",
} as const;

export type LeadRetirementReason = keyof typeof LEAD_RETIREMENT_REASONS;

export function isLeadRetirementReason(
  value: unknown
): value is LeadRetirementReason {
  return (
    typeof value === "string" && value in LEAD_RETIREMENT_REASONS
  );
}

/**
 * What to put beside the lead.
 *
 * An unrecognised key renders verbatim rather than blank — `cancelReasonLabel`
 * does the same, and for the same reason: a value the database holds and this
 * file does not know about is still better shown than swallowed.
 */
export function leadRetirementLabel(reason: string): string {
  return isLeadRetirementReason(reason)
    ? LEAD_RETIREMENT_REASONS[reason]
    : reason;
}

/**
 * The line under the picker whenever any greyed leads are shown.
 *
 * It names both escape hatches, because the useful half of telling an admin why
 * a lead is unavailable is telling them whether they can do anything about it.
 * Neither is a per-swap override: each un-retires the lead everywhere, which is
 * why 0143 gave the swap no flag of its own.
 */
export const LEAD_RETIREMENT_EXPLAINER =
  "Greyed leads cannot be swapped in — ordinary routing has already retired " +
  "them, so nothing is selling them to anyone. A pooled lead can be forced " +
  "back out from Expired leads, and a quality-blocked one can be overridden " +
  "on its own lead page; a lead claimed out of the pool belongs to whoever " +
  "claimed it and cannot be recovered.";
