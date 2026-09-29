/**
 * What a customer's cancellation reason becomes on the Monday enquiries board
 * (§72): the "Cancel reason" status cell and the "Cancel comment" long-text cell.
 *
 * ⚠️ IMPORT-FREE AND PURE, so the map is unit-testable under vitest's
 * pure-units rule and cannot drift between the two callers (the in-app cancel
 * route and the Stripe webhook).
 *
 * The keys are BOTH vocabularies: ours (cancelOptions.ts) and Stripe's
 * cancellation_details.feedback enum. A portal cancellation only ever gives us
 * Stripe's word, an in-app one gives us ours — and ours is the more precise of
 * the two, which is why cancellationMondaySync.ts prefers it when both exist.
 */

/**
 * The five labels on status column color_mm7n8j39. They must match the board
 * character-for-character: the write passes create_labels_if_missing: false, so
 * a mis-spelling fails loudly rather than adding a sixth label (§23.1).
 */
export const MONDAY_CANCEL_LABELS = [
  "Lead quality",
  "At capacity",
  "Too expensive",
  "Switched provider",
  "Other",
] as const;

export type MondayCancelLabel = (typeof MONDAY_CANCEL_LABELS)[number];

const LABEL_FOR_KEY: Record<string, MondayCancelLabel> = {
  lead_quality: "Lead quality",
  low_quality: "Lead quality",
  at_capacity: "At capacity",
  unused: "At capacity",
  too_expensive: "Too expensive",
  switched_provider: "Switched provider",
  switched_service: "Switched provider",
};

/**
 * One stored reason key → the board label. Anything not in the map is "Other",
 * deliberately including not_enough_leads and closing_business: Stripe collapses
 * those into low_quality and unused, which is exactly why the in-app row wins.
 */
export function mondayCancelReasonLabel(key: string | null | undefined): MondayCancelLabel {
  if (!key) return "Other";
  return Object.prototype.hasOwnProperty.call(LABEL_FOR_KEY, key)
    ? LABEL_FOR_KEY[key]
    : "Other";
}

export const GUARANTEED_RENT_SUFFIX = "(Guaranteed Rent)";

export interface CancelPush {
  label: MondayCancelLabel;
  comment: string;
}

/**
 * The two cell values for one cancellation. Several reasons → the FIRST, which
 * is the customer's own selection order (the route dedupes with a Set, which
 * keeps it). A Guaranteed Rent cancellation says so in the comment, because the
 * board item represents the customer, not the product.
 */
export function buildCancelPush(input: {
  reasons: readonly string[];
  comment: string | null | undefined;
  leadType: "management" | "guaranteed_rent";
}): CancelPush {
  const text = (input.comment ?? "").trim();
  const comment =
    input.leadType === "guaranteed_rent"
      ? text
        ? `${text} ${GUARANTEED_RENT_SUFFIX}`
        : GUARANTEED_RENT_SUFFIX
      : text;
  return { label: mondayCancelReasonLabel(input.reasons[0]), comment };
}

/**
 * Which record says why they left, and what it says.
 *
 * ⚠️ OUR ROW OUTRANKS STRIPE'S, AND THAT ORDER IS WHAT MAKES THE TWO PUSHES
 * CONVERGE. An in-app cancellation writes a subscription_cancellations row AND
 * fires the webhook, which captures Stripe's single feedback value — and Stripe
 * files both lead_quality and not_enough_leads as low_quality, and
 * closing_business as unused. Whichever push runs last re-reads and finds our
 * row, so the board ends on what the customer actually picked.
 *
 * The Stripe fields are management-only (the webhook's GR branch captures no
 * feedback, invariant 6), so a GR caller never falls back to them.
 *
 * `note` from our row, never the Stripe comment: that one only exists once the
 * webhook has landed, so using it would make the value depend on which push ran
 * first. With no note, the reasons' own labels joined by "; " — which is exactly
 * what composeCancellationComment sends Stripe, so the board reads the same
 * whichever record it came from, and still deterministic. `labelFor` is passed
 * in (cancelReasonLabel) to keep this file import-free.
 */
export function resolveCancelSource(input: {
  leadType: "management" | "guaranteed_rent";
  auditRow: { reasons: readonly string[] | null; note: string | null } | null;
  customer: {
    cancellation_feedback: string | null;
    cancellation_comment: string | null;
  } | null;
  labelFor: (key: string) => string;
}): { reasons: string[]; comment: string | null; from: "audit" | "stripe" } | null {
  if (input.auditRow && (input.auditRow.reasons?.length ?? 0) > 0) {
    const reasons = [...(input.auditRow.reasons ?? [])];
    const note = input.auditRow.note?.trim();
    return {
      reasons,
      comment: note ? note : reasons.map(input.labelFor).join("; "),
      from: "audit",
    };
  }
  if (input.leadType !== "management" || !input.customer) return null;
  const { cancellation_feedback: feedback, cancellation_comment: comment } =
    input.customer;
  if (!feedback && !comment) return null;
  return { reasons: feedback ? [feedback] : [], comment, from: "stripe" };
}

/**
 * Which board item a customer's cancellation lands on, found by email.
 *
 * ⚠️ NEVER CREATES, AND NEVER GUESSES.
 *   - one email match → that item;
 *   - several (a repeat enquiry makes a new item per submission, §23.10) → the
 *     one already linked in customers.monday_item_id, else null — writing onto
 *     the wrong item is worse than writing none;
 *   - none → the linked item, else null.
 *
 * The no-match fallback exists because the email on the account and the email
 * on the board genuinely differ for some customers (§23.5 resolves them by
 * name). Measured on 2026-09-29: 3 of the 10 cancellations on record would
 * have been skipped without it. `linkedItemId` must only be passed when the
 * link is on the enquiries board — the caller checks monday_board_id.
 */
export function pickCancelItem(
  email: string | null | undefined,
  linkedItemId: string | null | undefined,
  items: readonly { id: string; emails: readonly string[] }[]
): { itemId: string } | { itemId: null; reason: "no_email" | "no_match" | "ambiguous" } {
  const wanted = (email ?? "").trim().toLowerCase();
  if (!wanted) {
    return linkedItemId ? { itemId: linkedItemId } : { itemId: null, reason: "no_email" };
  }
  const hits = items.filter((i) => i.emails.includes(wanted));
  if (hits.length === 0) {
    return linkedItemId ? { itemId: linkedItemId } : { itemId: null, reason: "no_match" };
  }
  if (hits.length === 1) return { itemId: hits[0].id };
  const linked = linkedItemId ? hits.find((i) => i.id === linkedItemId) : undefined;
  return linked ? { itemId: linked.id } : { itemId: null, reason: "ambiguous" };
}
