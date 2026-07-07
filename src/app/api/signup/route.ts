import { NextResponse, type NextRequest } from "next/server";
import { getStripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { APP_URL } from "@/lib/env";
import { isOwnerEmail } from "@/lib/owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Create a Supabase user + customer record.
 *
 * - Owner emails skip Stripe and are provisioned as an active admin account;
 *   the response asks the client to sign in and go to /admin.
 * - Everyone else gets a Stripe Checkout session URL for the £300 subscription.
 *
 * Every failure path returns a descriptive JSON error so the signup form can
 * show what actually went wrong (e.g. a missing environment variable) instead
 * of an opaque 500.
 */
export async function POST(request: NextRequest) {
  let body: {
    business_name?: string;
    contact_name?: string;
    email?: string;
    phone?: string;
    password?: string;
    product?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { business_name, contact_name, email, phone, password, product } = body;
  if (!business_name || !contact_name || !email || !password) {
    return NextResponse.json(
      { error: "business_name, contact_name, email and password are required" },
      { status: 400 }
    );
  }

  // Product routing: ?product=guaranteed-rent signs the customer up for the GR
  // subscription; anything else is the default management subscription.
  const isGuaranteedRent =
    product === "guaranteed-rent" || product === "guaranteed_rent";

  const owner = isOwnerEmail(email);

  // Self-serve signup is retired — all new customers come through the enquiry
  // form (/enquiry → /api/enquiry) and are activated by an admin. This route is
  // kept only to bootstrap owner/admin accounts.
  if (!owner) {
    return NextResponse.json(
      {
        error:
          "Please enquire via our contact form and we'll get you set up.",
        redirect: "/enquiry",
      },
      { status: 403 }
    );
  }

  // Fail fast with a clear message if the server isn't configured. The build
  // succeeds without these, so this is the most common cause of a runtime 500.
  const missing: string[] = [];
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!owner || isGuaranteedRent) {
    if (!process.env.STRIPE_SECRET_KEY) missing.push("STRIPE_SECRET_KEY");
    if (isGuaranteedRent) {
      if (!process.env.STRIPE_GR_MONTHLY_PRICE_ID)
        missing.push("STRIPE_GR_MONTHLY_PRICE_ID");
    } else if (!process.env.STRIPE_MONTHLY_PRICE_ID) {
      missing.push("STRIPE_MONTHLY_PRICE_ID");
    }
  }
  if (missing.length > 0) {
    return NextResponse.json(
      {
        error: `Server is not configured. Missing environment variable${
          missing.length === 1 ? "" : "s"
        }: ${missing.join(", ")}. Set these in Vercel → Project → Settings → Environment Variables and redeploy.`,
      },
      { status: 500 }
    );
  }

  try {
    const admin = createAdminClient();

    // ── Guaranteed Rent product ───────────────────────────────────────────
    // GR is an independent subscription that can be added alongside an existing
    // management subscription without affecting it. If the customer already has
    // an active GR subscription, block a duplicate. New customers are created
    // (no capacity gate — GR has its own allocation); existing customers reuse
    // their row and Stripe customer.
    //
    // Owners are excluded here so an owner using the GR link still falls through
    // to the owner override below (admin account, both products active, no
    // Stripe), rather than being provisioned as a plain non-admin customer.
    if (isGuaranteedRent && !owner) {
      const stripe = getStripe();
      const grPriceId = process.env.STRIPE_GR_MONTHLY_PRICE_ID!;

      const { data: existing } = await admin
        .from("customers")
        .select("id, stripe_customer_id, gr_subscription_status, user_id")
        .eq("email", email)
        .maybeSingle();

      const createGrCheckout = async (
        customerId: string,
        stripeCustomerId: string,
        userId: string | null
      ) => {
        const session = await stripe.checkout.sessions.create({
          mode: "subscription",
          customer: stripeCustomerId,
          line_items: [{ price: grPriceId, quantity: 1 }],
          success_url: `${APP_URL}/dashboard?checkout=success&product=guaranteed-rent`,
          cancel_url: `${APP_URL}/signup?product=guaranteed-rent&checkout=cancelled`,
          subscription_data: {
            metadata: {
              product_type: "guaranteed_rent",
              ...(userId ? { supabase_user_id: userId } : {}),
            },
          },
          metadata: { product_type: "guaranteed_rent" },
        });
        return session;
      };

      if (existing) {
        if (existing.gr_subscription_status === "active") {
          return NextResponse.json(
            { error: "You already have an active Guaranteed Rent subscription." },
            { status: 409 }
          );
        }

        // Ensure the customer has a Stripe customer id to bill against.
        let stripeCustomerId = existing.stripe_customer_id;
        if (!stripeCustomerId) {
          const stripeCustomer = await stripe.customers.create({
            email,
            name: business_name,
            phone: phone || undefined,
            metadata: existing.user_id
              ? { supabase_user_id: existing.user_id }
              : {},
          });
          stripeCustomerId = stripeCustomer.id;
          await admin
            .from("customers")
            .update({ stripe_customer_id: stripeCustomerId })
            .eq("id", existing.id);
        }

        const session = await createGrCheckout(
          existing.id,
          stripeCustomerId,
          existing.user_id
        );
        return NextResponse.json({ mode: "checkout", url: session.url });
      }

      // Brand-new GR customer: create the auth user + customer row, then open
      // GR Checkout. GR provisioning (status/credit/anchor) happens in the
      // Stripe webhook on invoice.paid.
      const { data: created, error: userError } =
        await admin.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          app_metadata: { role: "customer" },
          user_metadata: { role: "customer", business_name, contact_name },
        });

      if (userError || !created.user) {
        const msg = userError?.message ?? "Could not create account";
        const status = /already|exists|registered/i.test(msg) ? 409 : 400;
        return NextResponse.json({ error: msg }, { status });
      }

      const userId = created.user.id;

      const { data: grCustomer, error: grCustomerError } = await admin
        .from("customers")
        .insert({
          user_id: userId,
          business_name,
          contact_name,
          email,
          phone: phone ?? null,
          subscription_status: "inactive",
        })
        .select("id")
        .single();

      if (grCustomerError || !grCustomer) {
        await admin.auth.admin.deleteUser(userId).catch(() => {});
        return NextResponse.json(
          {
            error: `Could not create customer record: ${
              grCustomerError?.message ?? "insert failed"
            }`,
          },
          { status: 500 }
        );
      }

      const stripeCustomer = await stripe.customers.create({
        email,
        name: business_name,
        phone: phone || undefined,
        metadata: { supabase_user_id: userId },
      });

      await admin
        .from("customers")
        .update({ stripe_customer_id: stripeCustomer.id })
        .eq("id", grCustomer.id);

      const session = await createGrCheckout(
        grCustomer.id,
        stripeCustomer.id,
        userId
      );
      return NextResponse.json({ mode: "checkout", url: session.url });
    }

    // 1. Create the auth user (confirmed so they can log in immediately).
    // app_metadata.role can't be set from the browser, so it's where we grant
    // admin for owner accounts.
    const { data: created, error: userError } =
      await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        app_metadata: { role: owner ? "admin" : "customer" },
        user_metadata: {
          role: owner ? "admin" : "customer",
          business_name,
          contact_name,
        },
      });

    if (userError || !created.user) {
      const msg = userError?.message ?? "Could not create account";
      const status = /already|exists|registered/i.test(msg) ? 409 : 400;
      return NextResponse.json({ error: msg }, { status });
    }

    const userId = created.user.id;

    // 2. Owner override: skip payment, provision an active customer row so both
    // the portal and admin panel work. Ask the client to sign in and go to /admin.
    if (owner) {
      const { error: ownerError } = await admin.from("customers").insert({
        user_id: userId,
        business_name,
        contact_name,
        email,
        phone: phone ?? null,
        subscription_status: "active",
        account_status: "active",
        // Owner accounts get both products active for preview/testing.
        gr_subscription_status: "active",
        gr_monthly_allocation: 10,
        gr_lead_balance: 10,
      });
      if (ownerError) {
        await admin.auth.admin.deleteUser(userId).catch(() => {});
        return NextResponse.json(
          { error: `Could not create customer record: ${ownerError.message}` },
          { status: 500 }
        );
      }
      return NextResponse.json({ mode: "login", redirect: "/admin" });
    }

    // 3. Standard flow: create the customer row (waitlisted by default), then
    // gate on capacity. Room available → mark invited and send them to Stripe
    // Checkout; full → hold on the waitlist with no Stripe session created.
    const { data: newCustomer, error: customerError } = await admin
      .from("customers")
      .insert({
        user_id: userId,
        business_name,
        contact_name,
        email,
        phone: phone ?? null,
        subscription_status: "inactive",
      })
      .select("id")
      .single();

    if (customerError || !newCustomer) {
      await admin.auth.admin.deleteUser(userId).catch(() => {});
      return NextResponse.json(
        {
          error: `Could not create customer record: ${
            customerError?.message ?? "insert failed"
          }`,
        },
        { status: 500 }
      );
    }

    // Capacity check: how many customers are currently active vs the cap?
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
      // No capacity — leave account_status as 'waitlisted', create no Stripe
      // session. The client redirects to the waitlist confirmation page.
      return NextResponse.json({ mode: "waitlisted", redirect: "/waitlisted" });
    }

    // Capacity available — provision Stripe, mark invited, and open Checkout.
    const stripe = getStripe();
    const stripeCustomer = await stripe.customers.create({
      email,
      name: business_name,
      phone: phone || undefined,
      metadata: { supabase_user_id: userId },
    });

    await admin
      .from("customers")
      .update({
        stripe_customer_id: stripeCustomer.id,
        account_status: "invited",
      })
      .eq("id", newCustomer.id);

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: stripeCustomer.id,
      line_items: [{ price: process.env.STRIPE_MONTHLY_PRICE_ID!, quantity: 1 }],
      success_url: `${APP_URL}/dashboard?checkout=success`,
      cancel_url: `${APP_URL}/signup?checkout=cancelled`,
      subscription_data: { metadata: { supabase_user_id: userId } },
    });

    return NextResponse.json({ mode: "checkout", url: session.url });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Signup failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
