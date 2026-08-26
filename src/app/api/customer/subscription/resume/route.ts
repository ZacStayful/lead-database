import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  resumePausedCustomer,
  resumeRefusalReason,
  type ResumableCustomer,
} from "@/lib/resumePause";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SOURCE = "subscription/resume";

/**
 * Start lead delivery again, now, on a paused management subscription.
 *
 * Until this existed there was no in-app way back from a pause: the daily cron
 * resumed you on the date you originally chose, and the only early exit was the
 * Stripe billing portal — which is a billing screen, not somewhere a customer
 * thinks to look for "send me leads again". A customer who paused for three
 * months and got busy after one had to wait out the other two.
 *
 * Everything this does lives in `resumePausedCustomer`, shared verbatim with
 * the cron, so an early resume and a scheduled one cannot drift apart. This
 * route is the guards and the identity check.
 *
 * ⚠️ THE COPY AROUND THIS MUST NOT PROMISE AN IMMEDIATE CHARGE. Pausing sets
 * `pause_collection: { behavior: "void" }`, which keeps Stripe's billing cycle
 * running underneath and voids the invoices it generates. Resuming stops the
 * voiding; it does not create a charge. So the next real charge lands at the
 * next natural cycle boundary, not today (CLAUDE.md §11). Leads, by contrast,
 * do start straight away — the pause columns are what routing reads.
 *
 * Management only, like pause itself. GR has no pause to resume (invariant 6).
 */
export async function POST(req: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Identity from the session, never the body — the §8 pattern. There is no
  // body at all: this route takes no input, so there is nothing to tamper with.
  const admin = createAdminClient();
  const { data: customer } = await admin
    .from("customers")
    .select(
      "id, email, contact_name, stripe_subscription_id, paused_at, cancel_at_period_end"
    )
    .eq("user_id", user.id)
    .maybeSingle();

  if (!customer) {
    return NextResponse.json({ error: "No customer record" }, { status: 404 });
  }

  const refusal = resumeRefusalReason(customer);
  if (refusal) {
    return NextResponse.json({ error: refusal }, { status: 409 });
  }

  const result = await resumePausedCustomer(
    admin,
    customer as ResumableCustomer,
    { source: SOURCE }
  );

  if (result.outcome === "stripe_failed") {
    return NextResponse.json(
      {
        error:
          "We couldn't restart billing with our payment provider. Nothing has changed — please try again in a moment.",
      },
      { status: 502 }
    );
  }

  if (result.outcome === "db_failed") {
    // Stripe is unpaused and our row is not. The next daily run will not pick
    // them up (it filters on pause_resumes_at), so this needs to be loud.
    console.error(`[${SOURCE}] resumed in Stripe but not in the database`, {
      customer: customer.id,
      error: result.error,
    });
    return NextResponse.json(
      {
        error:
          "Your billing has restarted but we couldn't update your account. Please contact support so we can finish this off.",
      },
      { status: 500 }
    );
  }

  // 'already_resumed' is a success: the webhook's resume-detection block got
  // there first, which is the outcome the customer asked for either way.
  return NextResponse.json({ ok: true, outcome: result.outcome });
}
