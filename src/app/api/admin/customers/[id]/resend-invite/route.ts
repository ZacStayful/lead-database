import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/stripe";
import { isAdminUser } from "@/lib/auth";
import { APP_URL } from "@/lib/env";
import { sendActivationEmail } from "@/lib/emails/activation";
import { planForAllocation, stripePriceIdFor } from "@/lib/plans";

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

  try {
    // Generate a fresh Checkout session (the previous one has expired).
    // stripePriceIdFor throws if the plan's price env var is missing — caught
    // below and surfaced as a descriptive error instead of an opaque 500.
    const stripe = getStripe();
    const plan = planForAllocation(customer.monthly_allocation ?? 20);
    const session = await stripe.checkout.sessions.create({
      customer: customer.stripe_customer_id,
      mode: "subscription",
      line_items: [
        { price: stripePriceIdFor(customer.monthly_allocation ?? 20), quantity: 1 },
      ],
      success_url: `${APP_URL}/dashboard?checkout=success`,
      cancel_url: `${APP_URL}/signup?checkout=cancelled`,
      metadata: { supabase_customer_id: customer.id },
    });
    if (!session.url) {
      throw new Error("Stripe did not return a checkout URL");
    }

    let setPasswordUrl: string | null = null;
    try {
      const { data: link } = await admin.auth.admin.generateLink({
        type: "recovery",
        email: customer.email,
        options: { redirectTo: `${APP_URL}/login` },
      });
      setPasswordUrl = link?.properties?.action_link ?? null;
    } catch (err) {
      console.error("generateLink (set password) failed", err);
    }

    await sendActivationEmail({
      to: customer.email,
      contactName: customer.contact_name,
      checkoutUrl: session.url,
      leads: plan.leads,
      priceGbp: plan.priceGbp,
      setPasswordUrl,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Resend failed";
    console.error("resend-invite route error", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
