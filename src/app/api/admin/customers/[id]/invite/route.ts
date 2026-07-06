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

/** Mark a waitlisted customer as invited and send the activation email. */
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

  if (customer.account_status !== "waitlisted") {
    return NextResponse.json({ error: "Customer is not waitlisted" }, { status: 400 });
  }

  // Confirm capacity still has room before inviting.
  const { data: setting } = await admin
    .from("system_settings")
    .select("value")
    .eq("key", "max_active_customers")
    .single();
  const maxActive = parseInt(setting?.value ?? "10", 10);
  const { count: activeCount } = await admin
    .from("customers")
    .select("*", { count: "exact", head: true })
    .eq("account_status", "active");

  if ((activeCount ?? 0) >= maxActive) {
    return NextResponse.json(
      { error: "No capacity available — increase the limit before inviting" },
      { status: 409 }
    );
  }

  const stripe = getStripe();

  // Create or reuse the Stripe customer.
  let stripeCustomerId = customer.stripe_customer_id as string | null;
  if (!stripeCustomerId) {
    const stripeCustomer = await stripe.customers.create({
      email: customer.email,
      name: customer.contact_name,
      metadata: { supabase_customer_id: customer.id },
    });
    stripeCustomerId = stripeCustomer.id;
    await admin
      .from("customers")
      .update({ stripe_customer_id: stripeCustomerId })
      .eq("id", customer.id);
  }

  // Fresh Checkout session for this customer's plan (10 or 20 leads).
  const plan = planForAllocation(customer.monthly_allocation ?? 20);
  const session = await stripe.checkout.sessions.create({
    customer: stripeCustomerId,
    mode: "subscription",
    line_items: [
      { price: stripePriceIdFor(customer.monthly_allocation ?? 20), quantity: 1 },
    ],
    success_url: `${APP_URL}/dashboard?checkout=success`,
    cancel_url: `${APP_URL}/signup?checkout=cancelled`,
    metadata: { supabase_customer_id: customer.id },
  });

  // Enquiry-form accounts never chose a password. Generate a set-password link
  // so they can access their dashboard after paying. Best-effort — if it fails
  // (e.g. no auth user), the customer can still use "forgot password".
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

  // Mark invited, then send the activation email with the checkout link.
  await admin
    .from("customers")
    .update({ account_status: "invited" })
    .eq("id", customer.id);

  await sendActivationEmail({
    to: customer.email,
    contactName: customer.contact_name,
    checkoutUrl: session.url!,
    leads: plan.leads,
    priceGbp: plan.priceGbp,
    setPasswordUrl,
  });

  return NextResponse.json({ ok: true });
}
