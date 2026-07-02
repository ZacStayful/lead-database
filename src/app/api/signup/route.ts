import { NextResponse, type NextRequest } from "next/server";
import { getStripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { APP_URL } from "@/lib/env";
import { isOwnerEmail } from "@/lib/owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Create a Supabase user + customer record, a Stripe customer, and a Checkout
 * Session for the monthly subscription. Returns the Stripe Checkout URL for the
 * client to redirect to.
 */
export async function POST(request: NextRequest) {
  let body: {
    business_name?: string;
    contact_name?: string;
    email?: string;
    phone?: string;
    password?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { business_name, contact_name, email, phone, password } = body;
  if (!business_name || !contact_name || !email || !password) {
    return NextResponse.json(
      { error: "business_name, contact_name, email and password are required" },
      { status: 400 }
    );
  }

  const admin = createAdminClient();
  const owner = isOwnerEmail(email);

  // 1. Create the auth user (confirmed so they can log in immediately).
  // Owner accounts are provisioned as admin; app_metadata.role is not editable
  // from the browser client, so it's the trustworthy place to grant admin.
  const { data: created, error: userError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: owner ? { role: "admin" } : { role: "customer" },
    user_metadata: {
      role: owner ? "admin" : "customer",
      business_name,
      contact_name,
    },
  });

  if (userError || !created.user) {
    const msg = userError?.message ?? "Could not create account";
    const status = /already/i.test(msg) ? 409 : 400;
    return NextResponse.json({ error: msg }, { status });
  }

  const userId = created.user.id;

  // Owner override: skip the payment wall. Provision an active customer record
  // (no Stripe) so both the customer portal and the admin panel are usable.
  if (owner) {
    const { error: ownerError } = await admin.from("customers").insert({
      user_id: userId,
      business_name,
      contact_name,
      email,
      phone: phone ?? null,
      subscription_status: "active",
    });
    if (ownerError) {
      await admin.auth.admin.deleteUser(userId).catch(() => {});
      return NextResponse.json({ error: ownerError.message }, { status: 500 });
    }
    return NextResponse.json({ url: "/admin" });
  }

  try {
    // 2. Create the Stripe customer.
    const stripe = getStripe();
    const stripeCustomer = await stripe.customers.create({
      email,
      name: business_name,
      phone: phone || undefined,
      metadata: { supabase_user_id: userId },
    });

    // 3. Create (or upsert) the customer row.
    const { error: customerError } = await admin.from("customers").insert({
      user_id: userId,
      business_name,
      contact_name,
      email,
      phone: phone ?? null,
      stripe_customer_id: stripeCustomer.id,
      subscription_status: "inactive",
    });

    if (customerError) {
      throw new Error(customerError.message);
    }

    // 4. Create a Checkout Session for the monthly subscription.
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: stripeCustomer.id,
      line_items: [{ price: process.env.STRIPE_MONTHLY_PRICE_ID!, quantity: 1 }],
      success_url: `${APP_URL}/dashboard?checkout=success`,
      cancel_url: `${APP_URL}/signup?checkout=cancelled`,
      subscription_data: {
        metadata: { supabase_user_id: userId },
      },
    });

    return NextResponse.json({ url: session.url });
  } catch (err) {
    // Roll back the auth user if downstream setup failed, so retry is clean.
    await admin.auth.admin.deleteUser(userId).catch(() => {});
    const message = err instanceof Error ? err.message : "Signup failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
