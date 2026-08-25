/**
 * Resuming a paused management subscription — one implementation, two callers.
 *
 * The daily cron (`/api/cron/resume-paused-subscriptions`) resumes a pause that
 * has elapsed; the customer route (`POST /api/customer/subscription/resume`)
 * resumes one early because they pressed a button. Everything that happens
 * after that decision is identical, and every step of it is load-bearing:
 *
 *   - Stripe FIRST, then the database. If Stripe fails the row is left paused so
 *     the next run retries; we never clear a pause while the customer is still
 *     un-billed in Stripe.
 *   - The clear is GUARDED on paused_at still being set, so only the writer that
 *     actually flips the column sends the email. The Stripe update above can
 *     trigger the webhook's own resume-detection block (§21), and without the
 *     guard both writers would email "you're back".
 *   - Pacing is re-baselined (anchor today, monthly counter zero). A stale
 *     months-old anchor with a zeroed counter reads as a maximal deficit and
 *     would dump a flood of leads on the customer the instant they return.
 *   - lead_balance is deliberately untouched: credits carry forward
 *     (invariant 2).
 *   - The episode stamp, the email and the Monday push all sit inside the
 *     `cleared` branch so each fires exactly once per pause.
 *
 * Two copies of that would eventually disagree, and the failure is silent in
 * both directions — a double email, or a customer resumed in Stripe and still
 * paused with us.
 */

import type { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/stripe";
import { sendSubscriptionResumedEmail } from "@/lib/emails";
import { stampEpisodeEnded } from "@/lib/pauseEpisodes";
import { syncCustomerMondayStatus } from "@/lib/mondayStatus";

type Admin = ReturnType<typeof createAdminClient>;

/** The columns a resume reads. */
export type ResumableCustomer = {
  id: string;
  email: string;
  contact_name: string | null;
  stripe_subscription_id: string | null;
};

export type ResumeOutcome =
  | "resumed"
  /** Somebody else (the webhook) cleared the pause first. Not an error. */
  | "already_resumed"
  | "stripe_failed"
  | "db_failed";

export interface ResumeResult {
  outcome: ResumeOutcome;
  error?: string;
}

/** Customer columns `resumeRefusalReason` reads. */
export type ResumeEligibilityFields = {
  paused_at: string | null;
  cancel_at_period_end: boolean | null;
};

/**
 * Why this customer may not resume on demand, or null if they may.
 *
 * Pure, so the route and its tests can agree without a database.
 *
 * A PENDING CANCELLATION IS REFUSED rather than silently resumed, and the
 * reason differs from the cron's. The cron skips because un-pausing somebody
 * behind their back would email "billing has restarted" to a person who asked
 * to leave. Here they are asking for it — but their subscription is still on
 * record as ending, so "resume" would restart collection for a period they have
 * already closed, and one route would be doing two contradictory things (§24's
 * rule that a route does one thing, and its undo is the same route). Pointing
 * them at "Keep my subscription" is self-healing: that clears the flag, and the
 * next daily run resumes them normally.
 */
export function resumeRefusalReason(
  customer: ResumeEligibilityFields
): string | null {
  if (!customer.paused_at) {
    return "Your subscription isn't paused.";
  }
  if (customer.cancel_at_period_end) {
    return "Your subscription is scheduled to cancel. Choose “Keep my subscription” first, and your leads will start again from there.";
  }
  return null;
}

/**
 * Resume one paused customer. Never throws.
 *
 * `source` is for logging only, so a line in the console names which caller
 * produced it.
 */
export async function resumePausedCustomer(
  admin: Admin,
  customer: ResumableCustomer,
  { source }: { source: string }
): Promise<ResumeResult> {
  // Resume Stripe collection first. An empty pause_collection unpauses the
  // subscription (per Stripe: set pause_collection to empty to resume).
  if (customer.stripe_subscription_id) {
    try {
      const stripe = getStripe();
      await stripe.subscriptions.update(customer.stripe_subscription_id, {
        pause_collection: "",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "stripe error";
      console.error(`[${source}] Stripe resume failed`, {
        customer: customer.id,
        error: message,
      });
      // Leave the row paused so the next run retries.
      return { outcome: "stripe_failed", error: message };
    }
  }

  // Guarded clear: only the writer that actually flips paused_at → null sends
  // the email. If the Stripe resume above already triggered the webhook and it
  // cleared the pause first, this returns no row and we skip the email — so a
  // customer never gets two "you're back" emails.
  //
  // Re-baseline pacing on resume (anchor = today, monthly counter = 0), the
  // same reset execute_filter_lift does when a customer re-enters the
  // guarantee system. Without it, the stale (months-old) billing_cycle_anchor
  // plus a zeroed monthly counter would read as a maximal deficit and dump a
  // flood of leads on the customer the instant they resume. lead_balance is
  // deliberately NOT touched — credits carry forward.
  const { data: cleared, error: clearError } = await admin
    .from("customers")
    .update({
      paused_at: null,
      pause_resumes_at: null,
      // The notice stamp belongs to the pause it was sent for (0101).
      pause_ending_notice_sent_at: null,
      billing_cycle_anchor: new Date().toISOString().slice(0, 10),
      leads_received_this_month: 0,
      updated_at: new Date().toISOString(),
    })
    .eq("id", customer.id)
    .not("paused_at", "is", null)
    .select("id")
    .maybeSingle();

  if (clearError) {
    console.error(`[${source}] clear pause failed`, {
      customer: customer.id,
      error: clearError.message,
    });
    return { outcome: "db_failed", error: clearError.message };
  }

  if (!cleared) {
    // Already resumed elsewhere (webhook) — Stripe is unpaused, DB is clear,
    // and the email was sent there. Nothing more to do.
    return { outcome: "already_resumed" };
  }

  // Close the pause episode (0077). Best-effort and deliberately not retried:
  // this stamp is REPORTING ONLY. Nothing reads ended_at to decide whether a
  // customer is paused — customers.paused_at is the authority, and it has just
  // been cleared above — so a missed stamp is a gap in the churn history, not
  // a stuck pause. Placed inside the `cleared` branch so it fires exactly once
  // per pause, for the same reason the email does.
  //
  // Stamps the LATEST open episode by id rather than every open one. Because
  // the stamp is allowed to fail, a customer can carry an older un-stamped
  // episode from a previous pause; a blanket update would then close it with
  // today's date and give get_pause_outcomes a window that never happened.
  await stampEpisodeEnded(admin, customer.id, source);

  const { error: emailError } = await sendSubscriptionResumedEmail({
    to: customer.email,
    contactName: customer.contact_name ?? customer.email,
  });
  if (emailError) {
    console.error(`[${source}] email failed`, {
      customer: customer.id,
      error: emailError,
    });
  }

  // Take the customer back off "Paused" on the Monday sales board. Inside the
  // `cleared` branch so it fires exactly once per pause, like the email and the
  // episode stamp — the webhook's early-resume path pushes from its own hook.
  //
  // Their Customer start date is NOT re-stamped by this: the sync only writes
  // that cell when it is empty. The board automation that used to set it on
  // every entry into Management Customer is what made that rule necessary.
  try {
    const push = await syncCustomerMondayStatus(admin, customer.id, {
      reason: source,
    });
    // Skip codes are logged too — see the same note in the pause route.
    if (
      push.error ||
      push.skipped === "board_unreadable" ||
      push.skipped === "unlinked"
    ) {
      console.error(`[${source}] Monday push did not land`, {
        customer: customer.id,
        skipped: push.skipped,
        error: push.error,
      });
    }
  } catch (err) {
    console.error(`[${source}] Monday push threw`, err);
  }

  return { outcome: "resumed" };
}
