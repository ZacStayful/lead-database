import type { SupabaseClient } from "@supabase/supabase-js";
import type { LeadType } from "@/lib/types";
import type { CancelReason, StripeCancellationFeedback } from "@/lib/cancelOptions";

/**
 * The subscription_cancellations audit trail (0101).
 *
 * BEST-EFFORT, both directions: these rows are the evidence that a customer
 * asked to cancel and was told the exact end date — they are never read to
 * decide whether a cancellation is pending (that is
 * customers.(gr_)cancel_at_period_end, the §21/§24 split). A failure here logs
 * and returns; it must never fail the cancellation it documents, because by the
 * time these run Stripe has already accepted the instruction.
 */

export async function recordCancellationRequested(
  admin: SupabaseClient,
  params: {
    customerId: string;
    leadType: LeadType;
    reasons: CancelReason[];
    note: string | null;
    stripeFeedback: StripeCancellationFeedback;
    stripeSubscriptionId: string;
    effectiveAtIso: string | null;
    source: string;
  }
): Promise<string | null> {
  const { data, error } = await admin
    .from("subscription_cancellations")
    .insert({
      customer_id: params.customerId,
      lead_type: params.leadType,
      reasons: params.reasons,
      note: params.note,
      stripe_feedback: params.stripeFeedback,
      stripe_subscription_id: params.stripeSubscriptionId,
      effective_at: params.effectiveAtIso,
    })
    .select("id")
    .maybeSingle();

  if (error) {
    console.error(`[${params.source}] cancellation audit insert failed`, {
      customer: params.customerId,
      error: error.message,
    });
    return null;
  }
  return data?.id ?? null;
}

/**
 * Attach the Resend message id of the confirmation email to the audit row —
 * evidence that the end date was communicated, and when.
 */
export async function recordConfirmationEmail(
  admin: SupabaseClient,
  cancellationId: string,
  emailId: string,
  source: string
): Promise<void> {
  const { error } = await admin
    .from("subscription_cancellations")
    .update({ confirmation_email_id: emailId })
    .eq("id", cancellationId);
  if (error) {
    console.error(`[${source}] confirmation email id stamp failed`, {
      cancellation: cancellationId,
      error: error.message,
    });
  }
}

/**
 * Stamp the LATEST open request for this customer and product as reverted.
 *
 * Latest-by-id only, never a blanket update, for stampEpisodeEnded's reason:
 * because these writes are allowed to fail, an older un-stamped row can exist,
 * and closing it with today's date would invent an undo that never happened.
 */
export async function closeOpenCancellation(
  admin: SupabaseClient,
  customerId: string,
  leadType: LeadType,
  source: string
): Promise<void> {
  const { data: open, error: findError } = await admin
    .from("subscription_cancellations")
    .select("id")
    .eq("customer_id", customerId)
    .eq("lead_type", leadType)
    .is("reverted_at", null)
    .order("requested_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (findError) {
    console.error(`[${source}] could not find open cancellation`, {
      customer: customerId,
      error: findError.message,
    });
    return;
  }
  // No open row is normal: a portal cancellation writes no audit row here.
  if (!open) return;

  const { error: stampError } = await admin
    .from("subscription_cancellations")
    .update({ reverted_at: new Date().toISOString() })
    .eq("id", open.id);

  if (stampError) {
    console.error(`[${source}] cancellation revert stamp failed`, {
      customer: customerId,
      cancellation: open.id,
      error: stampError.message,
    });
  }
}
