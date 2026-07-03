import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/stripe";
import { isAdminUser } from "@/lib/auth";
import { APP_URL } from "@/lib/env";
import { sendActivationEmail } from "@/lib/emails/activation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function isAdminRequest(req: NextRequest): Promise<boolean> {
  const key = req.headers.get("x-admin-key");
  if (key && process.env.ADMIN_SECRET_KEY && key === process.env.ADMIN_SECRET_KEY) {
    return true;
  }
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return isAdminUser(user);
}

/**
 * Regenerate a fresh Stripe checkout link and resend the activation email to an
 * already-invited customer whose original link expired.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const admin = createAdminClient();

  const { data: customer, error: fetchError } = await admin
    .from("customers")
    .select("*")
    .eq("id", params.id)
    .single();

  if (fetchError || !customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  // Only resend to invited customers — not waitlisted, active, or cancelled.
  if (customer.account_status !== "invited") {
    return NextResponse.json(
      { error: "Customer is not in invited status — use the invite action instead" },
      { status: 400 }
    );
  }

  // The Stripe customer must already exist from the original invite.
  if (!customer.stripe_customer_id) {
    return NextResponse.json(
      { error: "No Stripe customer ID found — re-run the original invite action" },
      { status: 400 }
    );
  }

  // Generate a fresh Checkout session (the previous one has expired).
  const stripe = getStripe();
  const session = await stripe.checkout.sessions.create({
    customer: customer.stripe_customer_id,
    mode: "subscription",
    line_items: [{ price: process.env.STRIPE_MONTHLY_PRICE_ID!, quantity: 1 }],
    success_url: `${APP_URL}/dashboard?checkout=success`,
    cancel_url: `${APP_URL}/signup?checkout=cancelled`,
    metadata: { supabase_customer_id: customer.id },
  });

  await sendActivationEmail({
    to: customer.email,
    contactName: customer.contact_name,
    checkoutUrl: session.url!,
  });

  return NextResponse.json({ ok: true });
}
