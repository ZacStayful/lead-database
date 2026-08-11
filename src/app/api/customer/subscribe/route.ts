import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/stripe";
import { APP_URL } from "@/lib/env";
import {
  GR_PLANS,
  PLANS,
  stripeGrPriceIdFor,
  stripePriceIdFor,
  toGrPlanKey,
  toPlanKey,
} from "@/lib/plans";
import { holdsProduct, toLeadType } from "@/lib/products";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Start a Stripe Checkout session for the product this customer does NOT yet
 * hold — the cross-sell on /dashboard/packages.
 *
 * WHY THIS EXISTS ALONGSIDE A CLOSED /api/signup
 * ----------------------------------------------
 * `/api/signup` refuses every non-owner with "please enquire via our contact
 * form": self-serve acquisition is retired, and new operators are vetted and
 * invited by an admin. This route is deliberately NOT that. It only ever serves
 * an authenticated customer who already holds the other product — somebody
 * already vetted, already paying, already on a Stripe customer record. Adding
 * their second product is an upsell to an existing account, not an unvetted
 * stranger buying their way in.
 *
 * That distinction is load-bearing, so the route enforces it: it resolves the
 * customer from the session (never from the body), and a customer who holds
 * neither product cannot use it at all — they are on the waitlist, and letting
 * them check out here would be a way to jump it.
 *
 * ACTIVATION IS THE WEBHOOK'S JOB
 * -------------------------------
 * Nothing here grants a product. The Stripe webhook routes by price id and, on
 * `invoice.paid`, credits the leads and promotes `account_status` out of
 * 'invited'/'waitlisted'. So a customer who pays becomes eligible for routing
 * through exactly the same path as an admin-invited one, and a customer who
 * abandons checkout is left completely unchanged.
 */
export async function POST(req: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let body: { product?: unknown; plan?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const leadType = toLeadType(body.product);
  if (!leadType) {
    return NextResponse.json({ error: "Unknown product" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: customer } = await admin
    .from("customers")
    .select(
      "id, email, business_name, contact_name, phone, stripe_customer_id, account_status, subscription_status, gr_subscription_status"
    )
    .eq("user_id", user.id)
    .maybeSingle();

  if (!customer) {
    return NextResponse.json({ error: "No customer record" }, { status: 404 });
  }

  // Already has it — never send a paying customer to a second checkout for the
  // same product. 'past_due' counts as held (see holdsProduct): that is a
  // billing problem to fix in the portal, not a thing to buy again.
  if (holdsProduct(customer, leadType)) {
    return NextResponse.json(
      { error: "You already have this subscription." },
      { status: 409 }
    );
  }

  // This route is an upsell to an existing customer, not an entry point. A
  // customer holding neither product is waitlisted and must come through the
  // normal invite.
  const otherType = leadType === "management" ? "guaranteed_rent" : "management";
  if (!holdsProduct(customer, otherType)) {
    return NextResponse.json(
      {
        error:
          "Your account isn't active yet, so this can't be added self-serve. Please contact support and we'll get you set up.",
      },
      { status: 403 }
    );
  }

  const stripe = getStripe();
  let priceId: string;
  let allocation: number | null = null;

  if (leadType === "guaranteed_rent") {
    // GR is a two-plan product as of the £300/20 plan. Resolve the chosen plan
    // the same way management does; toGrPlanKey defaults to the £150/10 plan so
    // a caller that names no plan gets what GR has always sold.
    allocation = GR_PLANS[toGrPlanKey(body.plan)].leads;
    try {
      priceId = stripeGrPriceIdFor(allocation);
    } catch {
      return NextResponse.json(
        { error: "Guaranteed Rent isn't configured for checkout yet." },
        { status: 500 }
      );
    }
  } else {
    // Management capacity gate. Mirrors /api/signup exactly — a headcount of
    // active accounts against max_active_customers — so the cap means the same
    // thing however a customer arrives. GR has no equivalent gate by design
    // (CLAUDE.md §16), which is why this branch is management-only.
    const { data: setting } = await admin
      .from("system_settings")
      .select("value")
      .eq("key", "max_active_customers")
      .maybeSingle();
    const maxActive = parseInt(setting?.value ?? "10", 10);
    const { count: activeCount } = await admin
      .from("customers")
      .select("*", { count: "exact", head: true })
      .eq("account_status", "active");

    if ((activeCount ?? 0) >= maxActive) {
      return NextResponse.json(
        {
          error:
            "Management leads are at capacity right now. Contact support and we'll add you to the list for the next opening.",
          atCapacity: true,
        },
        { status: 409 }
      );
    }

    allocation = PLANS[toPlanKey(body.plan)].leads;
    try {
      priceId = stripePriceIdFor(allocation);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Plan not configured" },
        { status: 500 }
      );
    }
  }

  // Ensure a Stripe customer to bill against. An admin-provisioned GR-only
  // account may not have one yet.
  let stripeCustomerId = customer.stripe_customer_id;
  if (!stripeCustomerId) {
    const created = await stripe.customers.create({
      email: customer.email,
      name: customer.business_name,
      phone: customer.phone || undefined,
      metadata: { supabase_user_id: user.id },
    });
    stripeCustomerId = created.id;
    await admin
      .from("customers")
      .update({ stripe_customer_id: stripeCustomerId })
      .eq("id", customer.id);
  }

  // Size the plan on the row BEFORE checkout. `invoice.paid` credits the
  // allocation stored on the customer, NOT the plan the invoice was for, so a
  // customer who bought the £150/10 plan on a row still carrying the default 20
  // would be credited 20 leads a month for a 10-lead price — every month,
  // silently. Writing it here puts the row in the same shape an admin invite
  // produces, so the webhook needs no special case. If the customer abandons
  // checkout the column is inert: it gates nothing for a customer who does not
  // hold the product, and any later admin action sets it again.
  //
  // This now covers BOTH products. It was management-only while GR had a single
  // plan and gr_monthly_allocation could only ever be its default of 10; with a
  // 20-lead GR plan on sale, leaving it out would under-credit every £300 GR
  // subscriber by half.
  if (allocation != null) {
    await admin
      .from("customers")
      .update(
        leadType === "guaranteed_rent"
          ? { gr_monthly_allocation: allocation }
          : { monthly_allocation: allocation }
      )
      .eq("id", customer.id);
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: stripeCustomerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${APP_URL}/dashboard/packages?checkout=success&product=${leadType}`,
    cancel_url: `${APP_URL}/dashboard/packages?checkout=cancelled`,
    subscription_data: {
      metadata: {
        supabase_user_id: user.id,
        ...(leadType === "guaranteed_rent"
          ? { product_type: "guaranteed_rent" }
          : {}),
      },
    },
    metadata: {
      supabase_user_id: user.id,
      ...(leadType === "guaranteed_rent"
        ? { product_type: "guaranteed_rent" }
        : {}),
    },
  });

  return NextResponse.json({ url: session.url });
}
