import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "crypto";
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

  try {
    // Enquiry-form accounts have no auth login yet (user_id is null). Create one
    // now (random password — set via the link below) so the customer can access
    // their dashboard after paying.
    let userId = customer.user_id as string | null;
    if (!userId) {
      const { data: created, error: createErr } =
        await admin.auth.admin.createUser({
          email: customer.email,
          password: `${randomUUID()}${randomUUID()}`,
          email_confirm: true,
          app_metadata: { role: "customer" },
          user_metadata: { role: "customer", contact_name: customer.contact_name },
        });
      if (created?.user) {
        userId = created.user.id;
      } else {
        // Most likely a pre-existing auth user — its id is resolved from the
        // generateLink call below.
        console.error("invite: createUser (may already exist)", createErr);
      }
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
    // stripePriceIdFor throws if the plan's price env var is missing — caught
    // below and surfaced as a descriptive error instead of an opaque 500.
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
    if (!session.url) {
      throw new Error("Stripe did not return a checkout URL");
    }

    // Set-password link. For a pre-existing auth user this also yields the user
    // id we couldn't get from createUser.
    let setPasswordUrl: string | null = null;
    try {
      const { data: link } = await admin.auth.admin.generateLink({
        type: "recovery",
        email: customer.email,
        options: { redirectTo: `${APP_URL}/login` },
      });
      setPasswordUrl = link?.properties?.action_link ?? null;
      if (!userId) userId = link?.user?.id ?? null;
    } catch (err) {
      console.error("generateLink (set password) failed", err);
    }

    // Backfill user_id if we resolved one (enquiry rows start with none).
    if (userId && userId !== customer.user_id) {
      await admin
        .from("customers")
        .update({ user_id: userId })
        .eq("id", customer.id);
    }

    // Send the email first — only flip to 'invited' (which consumes a capacity
    // slot) once the customer has actually received their activation link.
    await sendActivationEmail({
      to: customer.email,
      contactName: customer.contact_name,
      checkoutUrl: session.url,
      leads: plan.leads,
      priceGbp: plan.priceGbp,
      setPasswordUrl,
    });

    await admin
      .from("customers")
      .update({ account_status: "invited" })
      .eq("id", customer.id);

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invite failed";
    console.error("invite route error", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
