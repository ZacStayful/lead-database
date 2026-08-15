import { NextResponse, type NextRequest } from "next/server";
import { getStripe } from "@/lib/stripe";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendSubscriptionPausedEmail } from "@/lib/emails";
import {
  PAUSE_MONTHS_OPTIONS,
  PAUSE_NOTE_MAX_LENGTH,
  PAUSE_REASONS,
  isPauseMonths,
  isPauseReason,
} from "@/lib/pauseOptions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Pause the authenticated customer's MANAGEMENT subscription for a duration they
 * choose (1, 2 or 3 months), recording why.
 *
 * Guardrails:
 *   - management subscription must be active (account_status='active' AND
 *     subscription_status='active' AND a stripe_subscription_id on file). This
 *     also rejects GR-only customers, who have no active management subscription.
 *   - not already paused.
 *   - at least one reason, and a note when "other" is chosen.
 *
 * Pausing is repeatable: a customer may pause again after a previous pause has
 * ended. `pause_count` tracks how many times, for reporting only — nothing
 * enforces a cap. (0038's header claims a one-time allowance is enforced here;
 * it never has been. 0077 corrects that comment rather than changing behaviour.)
 * A customer who wants to come back early does so by resuming payment on the
 * Stripe side — the webhook detects that and clears the pause automatically.
 *
 * On success: stamp paused_at/pause_resumes_at and increment pause_count, pause
 * Stripe collection with invoices voided (customer owes nothing during the
 * pause), record the episode in subscription_pauses, and email a confirmation
 * stating the exact resume date. account_status is deliberately left 'active' so
 * the routing slot is reserved; lead_balance is left untouched so credits carry
 * forward to the resume.
 *
 * TWO THINGS TO KNOW ABOUT THE RESUME DATE
 *
 * 1. `setMonth` rolls over on short months: 31 January + 1 month lands on 3
 *    March. The confirmation email states the exact computed date, so the
 *    customer is never told a date we then miss — but it is not always the same
 *    day-of-month they paused on.
 *
 * 2. Stripe's billing cycle keeps running underneath a `behavior: "void"` pause.
 *    Invoices are generated and voided; resuming does not create a charge, it
 *    stops voiding future ones. So the first real charge after a resume lands at
 *    the next natural cycle boundary, not on the resume date — a gap that is a
 *    fixed fraction of a cycle and therefore proportionally larger the shorter
 *    the pause.
 */
export async function POST(req: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Validate the body before touching either system, so a bad request costs
  // nothing and can never half-pause an account.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "A pause duration and at least one reason are required." },
      { status: 400 }
    );
  }

  const { months, reasons, note } = (body ?? {}) as {
    months?: unknown;
    reasons?: unknown;
    note?: unknown;
  };

  if (!isPauseMonths(months)) {
    return NextResponse.json(
      { error: `months must be one of: ${PAUSE_MONTHS_OPTIONS.join(", ")}` },
      { status: 400 }
    );
  }

  if (!Array.isArray(reasons) || reasons.length === 0) {
    return NextResponse.json(
      { error: "Please tell us why you are pausing — select at least one reason." },
      { status: 400 }
    );
  }
  if (!reasons.every(isPauseReason)) {
    return NextResponse.json(
      { error: `reason must be one of: ${Object.keys(PAUSE_REASONS).join(", ")}` },
      { status: 400 }
    );
  }
  // A CHECK constraint cannot express array-element uniqueness (subqueries are
  // not allowed in CHECK), so duplicates are collapsed here or not at all.
  const cleanReasons = Array.from(new Set(reasons));

  const trimmedNote =
    typeof note === "string" && note.trim().length > 0 ? note.trim() : null;
  if (trimmedNote && trimmedNote.length > PAUSE_NOTE_MAX_LENGTH) {
    return NextResponse.json(
      { error: `Please keep your note under ${PAUSE_NOTE_MAX_LENGTH} characters.` },
      { status: 400 }
    );
  }
  // Enforced here as well as in the constraint so the customer gets a usable
  // message rather than a constraint violation.
  if (cleanReasons.includes("other") && !trimmedNote) {
    return NextResponse.json(
      { error: "Please tell us a little more about why you are pausing." },
      { status: 400 }
    );
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

  const now = new Date();
  const resumesAt = new Date(now);
  resumesAt.setMonth(resumesAt.getMonth() + months);

  // Guarded, race-safe write: only stamps the pause if the row is still an
  // active, unpaused management subscription. A double-submit therefore updates
  // at most one row.
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

  // Record the episode AFTER Stripe has agreed, and treat a failure as
  // best-effort.
  //
  // Ordering is deliberate. Inserting before the Stripe call and deleting on
  // rollback would risk a PHANTOM pause if the delete itself failed — silently
  // wrong, in the one table whose entire job is to be right about why people
  // pause. Inserting after risks a MISSING row, which shows as "—" in admin and
  // can be put back by hand. Failing the request here would be worse still: the
  // pause has already happened in both systems, so an error would tell the
  // customer it did not work when it did.
  const { error: episodeError } = await admin.from("subscription_pauses").insert({
    customer_id: customer.id,
    paused_at: now.toISOString(),
    resumes_at: resumesAt.toISOString(),
    months,
    reasons: cleanReasons,
    note: trimmedNote,
  });
  if (episodeError) {
    console.error("[subscription/pause] episode insert failed", {
      customer: customer.id,
      error: episodeError.message,
    });
  }

  // Confirmation email (best effort — the pause has already succeeded).
  const { error: emailError } = await sendSubscriptionPausedEmail({
    to: customer.email,
    contactName: customer.contact_name ?? customer.email,
    resumeDateIso: resumesAt.toISOString(),
    months,
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
    pause_months: months,
    pause_reasons: cleanReasons,
  });
}
