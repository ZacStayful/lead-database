/**
 * The three reasons, their wording, and the length floor — the only parts of
 * §51 a browser needs.
 *
 * ⚠️ THIS FILE MUST STAY IMPORT-FREE. `DeadLeadClaimCard` is a "use client"
 * component, and `deadLeadPolicy.ts` reaches `plans.ts` through `products.ts`
 * for the allowance arithmetic — server-side reasoning that has no business in
 * a client bundle. `featureRequest.ts` is split from `announcements.ts` for
 * exactly this reason (§21.8).
 *
 * `deadLeadPolicy.ts` re-exports all of it, so there is still one definition
 * and the form, the route and the CHECK on `lead_quality_claims.reason` cannot
 * drift apart.
 */

/** Mirrors the CHECK on `lead_quality_claims.reason`. */
export const DEAD_LEAD_REASONS = [
  "already_with_operator",
  "no_longer_interested",
  "unreachable",
] as const;
export type DeadLeadReason = (typeof DEAD_LEAD_REASONS)[number];

export const DEAD_LEAD_REASON_LABELS: Record<DeadLeadReason, string> = {
  already_with_operator: "They had already appointed another operator",
  no_longer_interested: "They are no longer letting the property",
  unreachable: "The contact details do not reach them",
};

/**
 * The shortest useful account of what the landlord said. Enforced again inside
 * `apply_dead_lead_claim`, because the detail is the entire basis for tracing a
 * dead lead back to where it came from — which is the half of this feature that
 * improves the leads rather than merely refunding them.
 */
export const MIN_DETAIL_LENGTH = 20;

/**
 * The control's own label. §51.6 fixes this wording — it is a REPORT, never
 * "reject with a reason" — and it is now needed in two places (the prompt and
 * the outcome panel), so it is one constant rather than two literals.
 */
export const DEAD_LEAD_CONTROL_LABEL = "This landlord was already gone";

/**
 * The prompt at the top of a lead the operator keeps coming back to.
 *
 * ⚠️ IT NAMES NO CREDIT. The split matters and must be maintained: the prompt
 * is unsolicited, so leading with a credit turns discovery into an inducement
 * to fish, which is what §51's hidden allowance exists to prevent. The
 * confirmation below MAY name it, because by then the operator has chosen to
 * report and has written what the landlord said — stating the outcome there is
 * informed consent rather than an offer.
 *
 * ⚠️ IT NEVER NAMES THE TRIGGER. "You have been back to this a few times"
 * hands over the recipe for summoning it, which is the same mistake as
 * publishing the allowance one level down.
 */
export const DEAD_LEAD_PROMPT_HEADING = "Was this landlord already gone?";
export const DEAD_LEAD_PROMPT_BODY =
  "If they had already appointed someone, or had stopped letting, before you got through — tell us what they said. We trace it back to the source it came from.";
export const DEAD_LEAD_PROMPT_DISMISS = "Not this one";

/**
 * Shown immediately above the submit button, so nobody consents without being
 * told the outcome. Before this, the credit was first named in the success
 * message — after the fact.
 *
 * ⚠️ It must read the same whether the claim will auto-uphold or go to review.
 * Those two paths are deliberately worded so the operator cannot tell them
 * apart, and a confirmation that promised an immediate credit would leak which
 * one fired.
 *
 * ⚠️ "your next lead comes through as usual" is the honest form of "replace".
 * Neither refund route sends a replacement (§39.1, §51.5): the credit returns
 * and ordinary routing delivers. Copy that promised a swap would be false.
 */
export const DEAD_LEAD_CONFIRM_CONSEQUENCE =
  "We'll look into this one. If it stands up, the credit goes back on your account and your next lead comes through as usual.";
