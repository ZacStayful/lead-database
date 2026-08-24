import { NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { APP_URL } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Create a Stripe billing portal session for the authenticated customer. */
export async function POST() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: customer } = await admin
    .from("customers")
    .select("stripe_customer_id, gr_stripe_customer_id")
    .eq("user_id", user.id)
    .maybeSingle();

  // A GR-only customer who bought through a Payment Link has no
  // stripe_customer_id at all — their Stripe customer is gr_stripe_customer_id
  // (0062). Before this fallback they could not open billing management at all.
  const stripeCustomerId =
    customer?.stripe_customer_id ?? customer?.gr_stripe_customer_id ?? null;

  if (!stripeCustomerId) {
    return NextResponse.json(
      { error: "No Stripe customer on file" },
      { status: 404 }
    );
  }

  const stripe = getStripe();
  const session = await stripe.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: `${APP_URL}/dashboard/settings`,
    // Pin the portal configuration that has subscription cancellation enabled
    // (mode at_period_end, matching the webhook's documented assumption).
    // Unset, the session falls back to the account's dashboard default exactly
    // as before — so a missing env var degrades, never breaks.
    ...(process.env.STRIPE_PORTAL_CONFIGURATION_ID
      ? { configuration: process.env.STRIPE_PORTAL_CONFIGURATION_ID }
      : {}),
  });

  return NextResponse.json({ url: session.url });
}
