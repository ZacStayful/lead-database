import { NextResponse, type NextRequest } from "next/server";
import type Stripe from "stripe";
import { getStripe, subscriptionPeriodEnd } from "@/lib/stripe";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  sendSubscriptionCancelledEmail,
  sendSubscriptionKeptEmail,
} from "@/lib/emails";
import { syncCustomerMondayStatus } from "@/lib/mondayStatus";
import { holdsProduct, PRODUCT_COPY, toLeadType } from "@/lib/products";
import {
  CANCEL_NOTE_MAX_LENGTH,
  CANCEL_REASONS,
  cancelColumns,
  composeCancellationComment,
  isCancelReason,
  stripeFeedbackFor,
  type CancelReason,
} from "@/lib/cancelOptions";
import {
  closeOpenCancellation,
  recordCancellationRequested,
  recordConfirmationEmail,
} from "@/lib/cancellations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SOURCE = "subscription/cancel";

/**
 * Cancel the authenticated customer's subscription at period end — or withdraw
 * a pending cancellation. One route for both directions (§24's rule: reverting
 * is the same request, so the undo can never diverge from the do).
 *
 * Body: { product, action?: "cancel" | "keep", reasons?, note? }.
 *
 * WHAT A CANCELLATION IS HERE. `cancel_at_period_end: true` on the Stripe
 * subscription — never an immediate deletion. The customer paid for the current
 * period and keeps it (invariant 4: no refunds); billing simply never happens
 * again. This matches the billing portal's `at_period_end` mode, so the webhook
 * sees one shape whichever door the customer leaves through.
 *
 * WHO MAY CANCEL. Anyone holding the product with a Stripe subscription on
 * file, per product (invariant 6: the GR path reads only gr_ columns, which
 * holdsProduct already guarantees). DELIBERATELY NO paused_at GUARD — a paused
 * customer deciding not to return is the single most important caller of this
 * route: without it they are re-billed automatically when the pause ends, which
 * is the complaint this feature exists to prevent. §21's "third case" already
 * handles the eventual deletion clearing the pause. `past_due` may also cancel:
 * someone whose card is failing and who wants out must not be trapped by the
 * failure.
 *
 * ORDERING: STRIPE FIRST, AND NO STRIPE ROLLBACK ON A DB FAILURE. This
 * deliberately differs from the plan route's swap-back. Once Stripe has
 * accepted the customer's instruction to cancel, undoing it because OUR cache
 * write failed would manufacture exactly the "I cancelled but you kept billing
 * me" incident. The row write here is UI freshness only; the webhook event our
 * own update fires is the source of truth and converges the row seconds later.
 *
 * The route writes only the pending flag and effective date. cancelled_at,
 * account_status and cancellation_feedback are webhook-owned — our update
 * carries cancellation_details, so the existing capture (0084) stores the
 * reason with no new webhook code.
 */
export async function POST(req: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Validate the body before touching either system (pause-route pattern).
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "A product and at least one reason are required." },
      { status: 400 }
    );
  }

  const { product, action, reasons, note } = (body ?? {}) as {
    product?: unknown;
    action?: unknown;
    reasons?: unknown;
    note?: unknown;
  };

  const leadType = toLeadType(product);
  if (!leadType) {
    return NextResponse.json(
      { error: "product must be management or guaranteed_rent" },
      { status: 400 }
    );
  }

  const requestedAction = action === undefined ? "cancel" : action;
  if (requestedAction !== "cancel" && requestedAction !== "keep") {
    return NextResponse.json(
      { error: "action must be cancel or keep" },
      { status: 400 }
    );
  }

  // Reason capture, required for a cancellation only. "keep" needs no reason —
  // asking for one would put a form between a customer and staying.
  let cleanReasons: CancelReason[] = [];
  let trimmedNote: string | null = null;
  if (requestedAction === "cancel") {
    if (!Array.isArray(reasons) || reasons.length === 0) {
      return NextResponse.json(
        {
          error:
            "Please tell us why you are cancelling — select at least one reason.",
        },
        { status: 400 }
      );
    }
    if (!reasons.every(isCancelReason)) {
      return NextResponse.json(
        { error: `reason must be one of: ${Object.keys(CANCEL_REASONS).join(", ")}` },
        { status: 400 }
      );
    }
    // Duplicates are collapsed here or not at all — the CHECK cannot express
    // array-element uniqueness (0084's note).
    cleanReasons = Array.from(new Set(reasons));

    trimmedNote =
      typeof note === "string" && note.trim().length > 0 ? note.trim() : null;
    if (trimmedNote && trimmedNote.length > CANCEL_NOTE_MAX_LENGTH) {
      return NextResponse.json(
        { error: `Please keep your note under ${CANCEL_NOTE_MAX_LENGTH} characters.` },
        { status: 400 }
      );
    }
    if (cleanReasons.includes("other") && !trimmedNote) {
      return NextResponse.json(
        { error: "Please tell us a little more about why you are cancelling." },
        { status: 400 }
      );
    }
  }

  const admin = createAdminClient();
  const { data: customer, error: fetchError } = await admin
    .from("customers")
    .select(
      "id, email, contact_name, account_status, subscription_status, gr_subscription_status, stripe_subscription_id, gr_stripe_subscription_id, cancel_at_period_end, gr_cancel_at_period_end"
    )
    .eq("user_id", user.id)
    .maybeSingle<{
      id: string;
      email: string;
      contact_name: string | null;
      account_status: string;
      subscription_status: string;
      gr_subscription_status: string;
      stripe_subscription_id: string | null;
      gr_stripe_subscription_id: string | null;
      cancel_at_period_end: boolean;
      gr_cancel_at_period_end: boolean;
    }>();

  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 });
  }
  if (!customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  if (!holdsProduct(customer, leadType)) {
    return NextResponse.json(
      { error: "You don't have this subscription." },
      { status: 403 }
    );
  }

  const cols = cancelColumns(leadType);
  const subscriptionId = customer[cols.subscriptionId] as string | null;
  if (!subscriptionId) {
    // Comped and hand-provisioned accounts genuinely have nothing to cancel
    // through Stripe — the same 409 the plan route returns.
    return NextResponse.json(
      {
        error:
          "Your subscription is set up in a way we can't change automatically. Please contact support and we'll sort it straight away.",
      },
      { status: 409 }
    );
  }

  const pendingHere = Boolean(customer[cols.flag]);
  if (requestedAction === "cancel" && pendingHere) {
    return NextResponse.json(
      { error: "Your cancellation is already scheduled." },
      { status: 409 }
    );
  }
  if (requestedAction === "keep" && !pendingHere) {
    return NextResponse.json(
      { error: "There is no pending cancellation to withdraw." },
      { status: 409 }
    );
  }

  const stripe = getStripe();
  let updated: Stripe.Subscription;
  try {
    if (requestedAction === "cancel") {
      updated = await stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: true,
        // Riding cancellation_details on the update is what lets the webhook's
        // existing capture (0084) store the reason — no new webhook code, and
        // the same downstream shape as a billing-portal cancellation.
        cancellation_details: {
          feedback: stripeFeedbackFor(cleanReasons),
          comment: composeCancellationComment(cleanReasons, trimmedNote),
        },
      });
    } else {
      updated = await stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: false,
      });
    }
  } catch (err) {
    console.error(`[${SOURCE}] Stripe update failed`, {
      customer: customer.id,
      action: requestedAction,
      error: err instanceof Error ? err.message : err,
    });
    return NextResponse.json(
      {
        error:
          requestedAction === "cancel"
            ? "Could not cancel with our payment provider. Please try again, or contact support and we will cancel it for you."
            : "Could not update your subscription. Please try again.",
      },
      { status: 502 }
    );
  }

  // The REAL end of service: Stripe's cancel_at, falling back to the current
  // period end — the same fallback order the webhook uses for Monday's end date.
  const effectiveSeconds =
    requestedAction === "cancel"
      ? updated.cancel_at ?? subscriptionPeriodEnd(updated)
      : null;
  const effectiveIso =
    effectiveSeconds != null
      ? new Date(effectiveSeconds * 1000).toISOString()
      : null;

  // Mirror the flag onto the row for immediate UI freshness. The webhook event
  // our own update just fired is the source of truth and re-writes both columns
  // (plus cancellation_feedback and the rest) seconds later — so a failure here
  // is logged and the request still SUCCEEDS. Stripe has accepted the
  // customer's instruction; telling them it failed would be false, and rolling
  // Stripe back would be worse (see the header).
  const { error: updateError } = await admin
    .from("customers")
    .update({
      [cols.flag]: requestedAction === "cancel",
      [cols.effectiveAt]: effectiveIso,
      updated_at: new Date().toISOString(),
    })
    .eq("id", customer.id);
  if (updateError) {
    console.error(`[${SOURCE}] row update failed (webhook will converge)`, {
      customer: customer.id,
      error: updateError.message,
    });
  }

  // Everything from here is best-effort: the cancellation (or withdrawal) has
  // already happened in Stripe and nothing below may un-succeed it.

  const productName = PRODUCT_COPY[leadType].name;
  if (requestedAction === "cancel") {
    const auditId = await recordCancellationRequested(admin, {
      customerId: customer.id,
      leadType,
      reasons: cleanReasons,
      note: trimmedNote,
      stripeFeedback: stripeFeedbackFor(cleanReasons),
      stripeSubscriptionId: subscriptionId,
      effectiveAtIso: effectiveIso,
      source: SOURCE,
    });

    const { id: emailId, error: emailError } = await sendSubscriptionCancelledEmail({
      to: customer.email,
      contactName: customer.contact_name ?? customer.email,
      productName,
      endDateIso: effectiveIso,
    });
    if (emailError) {
      console.error(`[${SOURCE}] confirmation email failed`, {
        customer: customer.id,
        error: emailError,
      });
    }
    if (auditId && emailId) {
      await recordConfirmationEmail(admin, auditId, emailId, SOURCE);
    }
  } else {
    await closeOpenCancellation(admin, customer.id, leadType, SOURCE);
    const { error: emailError } = await sendSubscriptionKeptEmail({
      to: customer.email,
      contactName: customer.contact_name ?? customer.email,
      productName,
    });
    if (emailError) {
      console.error(`[${SOURCE}] kept email failed`, {
        customer: customer.id,
        error: emailError,
      });
    }
  }

  // Push the new state to the Monday sales board now rather than waiting for
  // the webhook's own sync — the label rule reads the stored flags (0087), so
  // it already sees the row this route just wrote. The webhook's later push is
  // a no-op via the monday_status_label cache. endDate: a date sets the board's
  // Customer end date cell, null clears it (the change-of-mind case), matching
  // the webhook's own rule.
  try {
    const push = await syncCustomerMondayStatus(admin, customer.id, {
      endDate:
        requestedAction === "cancel" ? effectiveIso?.slice(0, 10) ?? undefined : null,
      reason: SOURCE,
    });
    if (push.error || push.skipped === "board_unreadable" || push.skipped === "unlinked") {
      console.error(`[${SOURCE}] Monday status push did not land`, {
        customer: customer.id,
        skipped: push.skipped,
        error: push.error,
      });
    }
  } catch (err) {
    console.error(`[${SOURCE}] Monday status push threw`, err);
  }

  return NextResponse.json({
    ok: true,
    product: leadType,
    cancel_at_period_end: requestedAction === "cancel",
    effective_at: effectiveIso,
  });
}
