import { NextResponse, type NextRequest } from "next/server";
import { getStripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendSubscriptionResumedEmail } from "@/lib/emails";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type PausedCustomer = {
  id: string;
  email: string;
  contact_name: string | null;
  stripe_subscription_id: string | null;
};

/**
 * Daily cron: resume management subscriptions whose 3-month pause has elapsed.
 * Auth: CRON_SECRET bearer only (a pure scheduled job, matching the
 * inactivity-nudge cron — no admin-session path).
 *
 * For each customer with paused_at set and pause_resumes_at <= now: resume
 * Stripe collection, clear the pause columns, and send a "you're back" email.
 * account_status was never changed on pause (the slot was reserved), so nothing
 * needs restoring there; lead_balance was preserved and is ready to spend.
 *
 * Ordering: resume Stripe FIRST, then clear the DB pause. If Stripe fails, the
 * row is left paused so the next daily run retries — we never clear the pause
 * while the customer is still un-billed in Stripe.
 */
async function handle(request: NextRequest) {
  const auth = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const nowIso = new Date().toISOString();

  const { data: rows, error } = await admin
    .from("customers")
    .select("id, email, contact_name, stripe_subscription_id")
    .not("paused_at", "is", null)
    .lte("pause_resumes_at", nowIso);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  let resumed = 0;
  let alreadyResumed = 0;
  let stripeErrors = 0;
  const errors: string[] = [];

  for (const customer of (rows ?? []) as PausedCustomer[]) {
    // Resume Stripe collection first. An empty pause_collection unpauses the
    // subscription (per Stripe: set pause_collection to empty to resume).
    if (customer.stripe_subscription_id) {
      try {
        const stripe = getStripe();
        await stripe.subscriptions.update(customer.stripe_subscription_id, {
          pause_collection: "",
        });
      } catch (err) {
        stripeErrors += 1;
        const message = err instanceof Error ? err.message : "stripe error";
        errors.push(`${customer.id}: ${message}`);
        console.error("[resume-paused-subscriptions] Stripe resume failed", {
          customer: customer.id,
          error: message,
        });
        // Leave the row paused so the next daily run retries.
        continue;
      }
    }

    // Guarded clear: only the writer that actually flips paused_at → null sends
    // the email. If the Stripe resume above already triggered the webhook and it
    // cleared the pause first, this returns no row and we skip the email — so a
    // customer never gets two "you're back" emails.
    //
    // Re-baseline pacing on resume (anchor = today, monthly counter = 0), the
    // same reset execute_filter_lift does when a customer re-enters the
    // guarantee system. Without it, the stale (3-month-old) billing_cycle_anchor
    // plus a zeroed monthly counter would read as a maximal deficit and dump a
    // flood of leads on the customer the instant they resume. lead_balance is
    // deliberately NOT touched — credits carry forward.
    const { data: cleared, error: clearError } = await admin
      .from("customers")
      .update({
        paused_at: null,
        pause_resumes_at: null,
        billing_cycle_anchor: new Date().toISOString().slice(0, 10),
        leads_received_this_month: 0,
        updated_at: new Date().toISOString(),
      })
      .eq("id", customer.id)
      .not("paused_at", "is", null)
      .select("id")
      .maybeSingle();

    if (clearError) {
      errors.push(`${customer.id}: ${clearError.message}`);
      console.error("[resume-paused-subscriptions] clear pause failed", {
        customer: customer.id,
        error: clearError.message,
      });
      continue;
    }

    if (!cleared) {
      // Already resumed elsewhere (webhook) — Stripe is unpaused, DB is clear,
      // and the email was sent there. Nothing more to do.
      alreadyResumed += 1;
      continue;
    }

    const { error: emailError } = await sendSubscriptionResumedEmail({
      to: customer.email,
      contactName: customer.contact_name ?? customer.email,
    });
    if (emailError) {
      console.error("[resume-paused-subscriptions] email failed", {
        customer: customer.id,
        error: emailError,
      });
    }

    resumed += 1;
  }

  return NextResponse.json({
    status: "ok",
    resumed,
    already_resumed: alreadyResumed,
    stripe_errors: stripeErrors,
    errors,
  });
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
