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
