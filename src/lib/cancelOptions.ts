import type { LeadType } from "@/lib/types";

/**
 * The reasons a customer may give when cancelling, and the mapping onto
 * Stripe's fixed cancellation-feedback enum.
 *
 * Kept in lib rather than beside the route for the reason pauseOptions.ts
 * gives: a Next.js route file may only export route handlers and config. The
 * UI and the route both read this file, so the list and its copy cannot drift.
 *
 * The keys deliberately reuse pauseOptions' where the meaning overlaps
 * (too_expensive, not_enough_leads, lead_quality, at_capacity), so pause and
 * cancellation churn signals can be counted together — §21 calls pause "the
 * best churn signal the business has", and cancellation is the same question
 * asked harder.
 *
 * ⚠️ These values must match the CHECK constraint in
 * supabase/migrations/0101_self_serve_cancellation.sql character-for-character.
 * Nothing enforces that mechanically; a mismatch shows up as a 500 on submit,
 * not as a build error.
 */

export const CANCEL_REASONS = {
  too_expensive: "Too expensive",
  not_enough_leads: "Not receiving enough leads",
  lead_quality: "The leads weren't the right fit",
  at_capacity: "Too busy — at capacity right now",
  switched_provider: "Using a different lead source",
  closing_business: "No longer operating / changing direction",
  other: "Something else",
} as const;

export type CancelReason = keyof typeof CANCEL_REASONS;

/** Narrow untrusted input to a valid, customer-selectable cancel reason. */
export function isCancelReason(value: unknown): value is CancelReason {
  return typeof value === "string" && value in CANCEL_REASONS;
}

/** Narrow an untrusted array to a non-empty list of valid reasons. */
export function isCancelReasonList(value: unknown): value is CancelReason[] {
  return Array.isArray(value) && value.length > 0 && value.every(isCancelReason);
}

/** Human label for a stored reason (admin surfaces render stored strings). */
export function cancelReasonLabel(value: string): string {
  return isCancelReason(value) ? CANCEL_REASONS[value] : value;
}

export const CANCEL_NOTE_MAX_LENGTH = 500;

/**
 * Stripe's cancellation_details.feedback enum, as pinned by the stripe SDK.
 * Listed here so the mapping below can be asserted against it in tests without
 * importing the SDK's types into a browser bundle.
 */
export const STRIPE_CANCELLATION_FEEDBACK = [
  "customer_service",
  "low_quality",
  "missing_features",
  "other",
  "switched_service",
  "too_complex",
  "too_expensive",
  "unused",
] as const;

export type StripeCancellationFeedback =
  (typeof STRIPE_CANCELLATION_FEEDBACK)[number];

/**
 * Our reasons → Stripe's enum. Stripe accepts ONE feedback value, so multi-
 * reason requests are collapsed by stripeFeedbackFor below; the full list is
 * preserved in subscription_cancellations.reasons and in the composed comment.
 *
 * Mapping onto Stripe's own vocabulary is what lets the webhook's existing
 * cancellation_details capture (0084) handle an in-app cancellation and a
 * billing-portal one identically — one downstream shape, whichever door the
 * customer left through.
 */
export const CANCEL_REASON_TO_STRIPE_FEEDBACK: Record<
  CancelReason,
  StripeCancellationFeedback
> = {
  too_expensive: "too_expensive",
  not_enough_leads: "low_quality",
  lead_quality: "low_quality",
  at_capacity: "unused",
  switched_provider: "switched_service",
  closing_business: "unused",
  other: "other",
};

/**
 * Fixed priority for collapsing several reasons into Stripe's single value, so
 * the choice is deterministic rather than an accident of selection order.
 * Specific verdicts about us outrank circumstances about them.
 */
const STRIPE_FEEDBACK_PRIORITY: StripeCancellationFeedback[] = [
  "switched_service",
  "too_expensive",
  "low_quality",
  "unused",
  "other",
];

export function stripeFeedbackFor(
  reasons: CancelReason[]
): StripeCancellationFeedback {
  const mapped = new Set(
    reasons.map((r) => CANCEL_REASON_TO_STRIPE_FEEDBACK[r])
  );
  for (const candidate of STRIPE_FEEDBACK_PRIORITY) {
    if (mapped.has(candidate)) return candidate;
  }
  return "other";
}

/**
 * The free-text comment sent to Stripe beside the enum — the full multi-reason
 * truth in words, plus the customer's note. Truncated defensively: Stripe caps
 * the comment (undocumented; treated as our own note limit) and an over-long
 * comment must never fail the cancellation it describes.
 */
export function composeCancellationComment(
  reasons: CancelReason[],
  note: string | null
): string {
  const labels = reasons.map((r) => CANCEL_REASONS[r]).join("; ");
  const composed = note ? `${labels}. Note: ${note}` : labels;
  return composed.length > CANCEL_NOTE_MAX_LENGTH
    ? `${composed.slice(0, CANCEL_NOTE_MAX_LENGTH - 1)}…`
    : composed;
}

export interface CancelColumns {
  subscriptionId: "stripe_subscription_id" | "gr_stripe_subscription_id";
  flag: "cancel_at_period_end" | "gr_cancel_at_period_end";
  effectiveAt: "cancel_effective_at" | "gr_cancel_effective_at";
}

/**
 * The per-product column triple, mirroring planChangeColumns (0088): resolving
 * columns in one place is what keeps the GR path structurally unable to touch
 * a management column (invariant 6).
 */
export function cancelColumns(leadType: LeadType): CancelColumns {
  return leadType === "guaranteed_rent"
    ? {
        subscriptionId: "gr_stripe_subscription_id",
        flag: "gr_cancel_at_period_end",
        effectiveAt: "gr_cancel_effective_at",
      }
    : {
        subscriptionId: "stripe_subscription_id",
        flag: "cancel_at_period_end",
        effectiveAt: "cancel_effective_at",
      };
}
