import { NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendSubscriptionPausedEmail } from "@/lib/emails";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How many months a pause lasts before the resume cron reactivates it. */
const PAUSE_MONTHS = 3;
/** One-time allowance: a customer who has already paused once cannot re-pause. */
const MAX_PAUSES = 1;

/**
 * Pause the authenticated customer's MANAGEMENT subscription for three months.
 *
 * Guardrails:
 *   - management subscription must be active (account_status='active' AND
 *     subscription_status='active' AND a stripe_subscription_id on file). This
 *     also rejects GR-only customers, who have no active management subscription.
 *   - one-time only (pause_count must be < MAX_PAUSES).
 *   - not already paused.
 *
 * On success: stamp paused_at/pause_resumes_at and increment pause_count, pause
 * Stripe collection with invoices voided (customer owes nothing during the
 * pause), and email a confirmation stating the exact resume date. account_status
 * is deliberately left 'active' so the capacity slot is reserved; lead_balance is
 * left untouched so credits carry forward to the resume.
 */
export async function POST() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: customer, error: fetchError } = await admin
    .from("customers")
    .select(
      "id, email, contact_name, account_status, subscription_status, stripe_subscription_id, paused_at, pause_count"
    )
    .eq("user_id", user.id)
    .maybeSingle();

  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 });
  }
  if (!customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  // Must be an active management subscriber. This rejects GR-only accounts,
  // cancelled/waitlisted/invited accounts, and any management subscription that
  // is not currently paying.
  const isManagementActive =
    customer.account_status === "active" &&
    customer.subscription_status === "active" &&
    Boolean(customer.stripe_subscription_id);
  if (!isManagementActive) {
    return NextResponse.json(
      {
        error:
          "Pausing is only available on an active management subscription.",
      },
      { status: 409 }
    );
  }

  if (customer.paused_at) {
    return NextResponse.json(
      { error: "Your subscription is already paused." },
      { status: 409 }
    );
  }

  if ((customer.pause_count ?? 0) >= MAX_PAUSES) {
    return NextResponse.json(
      {
        error:
          "You have already used your one-time subscription pause and cannot pause again.",
      },
      { status: 409 }
    );
  }

  const now = new Date();
  const resumesAt = new Date(now);
  resumesAt.setMonth(resumesAt.getMonth() + PAUSE_MONTHS);

  // Guarded, race-safe write: only stamps the pause if the row is still an
  // active, unpaused management subscription under its pause allowance. A
  // double-submit therefore updates at most one row.
  const { data: updated, error: updateError } = await admin
    .from("customers")
    .update({
      paused_at: now.toISOString(),
      pause_resumes_at: resumesAt.toISOString(),
      pause_count: (customer.pause_count ?? 0) + 1,
      updated_at: now.toISOString(),
    })
    .eq("id", customer.id)
    .eq("account_status", "active")
    .eq("subscription_status", "active")
    .is("paused_at", null)
    .lt("pause_count", MAX_PAUSES)
    .select("id")
    .maybeSingle();

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }
  if (!updated) {
    // Lost the race (or state changed under us) — nothing was paused.
    return NextResponse.json(
      { error: "Your subscription could not be paused. Please refresh and try again." },
      { status: 409 }
    );
  }

  // Pause Stripe collection with invoices voided so the customer owes nothing
  // during the pause. If this fails, roll the DB pause back so the two stay
  // consistent (we never want a "paused in our DB but still billing" state).
  try {
    const stripe = getStripe();
    await stripe.subscriptions.update(customer.stripe_subscription_id as string, {
      pause_collection: { behavior: "void" },
    });
  } catch (err) {
    await admin
      .from("customers")
      .update({
        paused_at: null,
        pause_resumes_at: null,
        pause_count: customer.pause_count ?? 0,
        updated_at: new Date().toISOString(),
      })
      .eq("id", customer.id);
    console.error("[subscription/pause] Stripe pause failed; rolled back", err);
    return NextResponse.json(
      { error: "Could not pause billing. Please try again." },
      { status: 502 }
    );
  }

  // Confirmation email (best effort — the pause has already succeeded).
  const { error: emailError } = await sendSubscriptionPausedEmail({
    to: customer.email,
    contactName: customer.contact_name ?? customer.email,
    resumeDateIso: resumesAt.toISOString(),
  });
  if (emailError) {
    console.error("[subscription/pause] confirmation email failed", {
      customer: customer.id,
      error: emailError,
    });
  }

  return NextResponse.json({
    ok: true,
    paused_at: now.toISOString(),
    pause_resumes_at: resumesAt.toISOString(),
  });
}
