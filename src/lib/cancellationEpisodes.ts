import type { SupabaseClient } from "@supabase/supabase-js";
import type { LeadType } from "@/lib/types";

/**
 * Record a cancellation as a durable episode (0100).
 *
 * `customers.cancelled_at` / `gr_cancelled_at` are single columns that the
 * Stripe webhook NULLS when a subscription returns to active — along with the
 * feedback and comment. So a customer who cancels, comes back and cancels again
 * leaves no trace of the first departure and no record of why. That is the one
 * thing a retention series cannot work without, and the one thing that becomes
 * unrecoverable the moment it happens.
 *
 * ⚠️ NOTHING HERE MAY THROW (§23.6). The Stripe webhook deletes its
 * `stripe_events` idempotency claim on any exception, so a throw escaping this
 * would make Stripe redeliver an invoice that has ALREADY BEEN CREDITED. Every
 * path logs and returns. The call site wraps in try/catch as well — belt and
 * braces, exactly as §23.6 requires of setEnquiryStatus and
 * syncCustomerMondayStatus. Do not "simplify" either.
 *
 * REPORTING ONLY. `customers.cancelled_at` remains the live authority, the same
 * rule §21 states for `paused_at` against `subscription_pauses`. A missing
 * episode row is a reporting gap; a thrown exception is a double-credited
 * invoice. §24 draws the identical line for subscription_plan_changes.
 */

export interface CancellationFacts {
  stripeSubscriptionId?: string | null;
  requestedAt?: string | null;
  cancelledAt?: string | null;
  effectiveAt?: string | null;
  feedback?: string | null;
  comment?: string | null;
  mrrAtRequestPence?: number | null;
}

/**
 * Open or update the cancellation episode for one product.
 *
 * Idempotent by the partial unique index on
 * `(customer_id, lead_type) where reinstated_at is null` — a cancellation is a
 * SEQUENCE, not one event, and `customer.subscription.updated` with
 * cancel_at_period_end fires repeatedly before the period ends. Claiming the
 * open episode by write rather than checking-then-writing is the discipline
 * `credit_invoice()` uses against Stripe redelivery (§19.5).
 *
 * First request wins on `requested_at`, matching `cancelled_at`'s documented
 * rule and `first_contacted_at`'s coalesce (§6): later events fill in what they
 * know without overwriting when the customer first said they were leaving.
 */
export async function recordCancellation(
  admin: SupabaseClient,
  customerId: string,
  leadType: LeadType,
  facts: CancellationFacts,
  source: string
): Promise<void> {
  try {
    const { data: open, error: findError } = await admin
      .from("subscription_cancellations")
      .select("id, requested_at, feedback, comment")
      .eq("customer_id", customerId)
      .eq("lead_type", leadType)
      .is("reinstated_at", null)
      .limit(1)
      .maybeSingle();

    if (findError) {
      console.error(`[${source}] could not read cancellation episode`, {
        customer: customerId,
        leadType,
        error: findError.message,
      });
      return;
    }

    if (open) {
      // Fill in what this event knows; never overwrite a first answer with a
      // later null. Stripe sends cancellation_details on the *updated* event at
      // the moment the customer gives it (§21), and the later 'canceled' event
      // does not repeat it.
      const patch: Record<string, unknown> = {};
      if (facts.cancelledAt) patch.cancelled_at = facts.cancelledAt;
      if (facts.effectiveAt) patch.effective_at = facts.effectiveAt;
      if (facts.feedback && !open.feedback) patch.feedback = facts.feedback;
      if (facts.comment && !open.comment) patch.comment = facts.comment;
      if (facts.stripeSubscriptionId)
        patch.stripe_subscription_id = facts.stripeSubscriptionId;
      if (Object.keys(patch).length === 0) return;

      const { error } = await admin
        .from("subscription_cancellations")
        .update(patch)
        .eq("id", open.id);
      if (error) {
        console.error(`[${source}] could not update cancellation episode`, {
          customer: customerId,
          leadType,
          error: error.message,
        });
      }
      return;
    }

    const { error } = await admin.from("subscription_cancellations").insert({
      customer_id: customerId,
      lead_type: leadType,
      stripe_subscription_id: facts.stripeSubscriptionId ?? null,
      requested_at: facts.requestedAt ?? new Date().toISOString(),
      cancelled_at: facts.cancelledAt ?? null,
      effective_at: facts.effectiveAt ?? null,
      feedback: facts.feedback ?? null,
      comment: facts.comment ?? null,
      mrr_at_request_pence: facts.mrrAtRequestPence ?? null,
      source: "stripe_webhook",
    });

    // 23505 is the partial unique index doing its job: a concurrent delivery
    // opened the episode first. That is the mechanism working, not a fault.
    if (error && error.code !== "23505") {
      console.error(`[${source}] could not open cancellation episode`, {
        customer: customerId,
        leadType,
        error: error.message,
      });
    }
  } catch (err) {
    // The outer net. Nothing above is expected to throw, and if it does the
    // webhook must still return 200 — see the header.
    console.error(`[${source}] cancellation episode failed`, err);
  }
}

/**
 * Close the open episode because the customer is billing again.
 *
 * Called from the same branch that clears `cancelled_at`. Stamping
 * `reinstated_at` takes the row out of the partial unique index, so a later
 * cancellation opens a fresh episode cleanly rather than colliding.
 */
export async function reinstateCancellation(
  admin: SupabaseClient,
  customerId: string,
  leadType: LeadType,
  source: string
): Promise<void> {
  try {
    const { error } = await admin
      .from("subscription_cancellations")
      .update({ reinstated_at: new Date().toISOString() })
      .eq("customer_id", customerId)
      .eq("lead_type", leadType)
      .is("reinstated_at", null);
    if (error) {
      console.error(`[${source}] could not reinstate cancellation episode`, {
        customer: customerId,
        leadType,
        error: error.message,
      });
    }
  } catch (err) {
    console.error(`[${source}] reinstate episode failed`, err);
  }
}
