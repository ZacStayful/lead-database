import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/stripe";
import { isAdminUser } from "@/lib/auth";
import { APP_URL } from "@/lib/env";
import { sendActivationEmail } from "@/lib/emails/activation";
import {
  planForAllocation,
  grPlanForAllocation,
  stripePriceIdFor,
  stripeGrPriceIdFor,
} from "@/lib/plans";
import {
  getProductCapacityStatus,
  capacityWeight,
  grCapacityWeight,
} from "@/lib/capacity";
import { holdsProduct, toLeadType } from "@/lib/products";

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
 * Invite a customer to subscribe to one product and send the activation email.
 *
 * `product` defaults to 'management', so every existing caller is unaffected.
 *
 * Also serves as the RE-INVITE for a customer who cancelled — see the eligibility
 * branch below. Management accepts `waitlisted` and `cancelled`; GR only asks
 * whether they already hold GR.
 *
 * WHY THIS TAKES A PRODUCT
 * ------------------------
 * This route used to be hard-coded to management: it always billed
 * `stripePriceIdFor(monthly_allocation)`, which is a MANAGEMENT price id. Since
 * the Stripe webhook identifies the product purely by the invoice's price id,
 * and both products are £150/month for 10 leads, a Guaranteed Rent sale
 * onboarded here was billed the right amount on the wrong price and provisioned
 * as a management customer — management credits, management capacity,
 * management leads. There was no other way to onboard a GR customer at all
 * (/api/signup is retired for non-owners and /api/customer/subscribe requires
 * already holding the other product), so every GR sale hit this.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  // Body is optional — an older caller sending none gets management, unchanged.
  const body = await req.json().catch(() => ({}));
  const product = toLeadType(body?.product) ?? "management";
  const isGr = product === "guaranteed_rent";

  const admin = createAdminClient();

  const { data: customer, error: fetchError } = await admin
    .from("customers")
    .select("*")
    .eq("id", params.id)
    .single();

  if (fetchError || !customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  // Eligibility is per product, because 'waitlisted' is a MANAGEMENT state.
  // account_status / subscription_status are management-only columns (CLAUDE.md
  // §3, invariant 6), so gating a GR invite on them would both refuse a paying
  // management customer who also wants GR, and read a column the GR side must
  // never depend on. The honest GR test is simply "do they already hold GR".
  if (isGr) {
    if (holdsProduct(customer, "guaranteed_rent")) {
      return NextResponse.json(
        { error: "Customer already has a Guaranteed Rent subscription" },
        { status: 400 }
      );
    }
  } else if (
    customer.account_status !== "waitlisted" &&
    customer.account_status !== "cancelled"
  ) {
    // 'cancelled' is admitted, and that is the whole point of this branch being
    // two states rather than one.
    //
    // A customer who leaves and wants to come back had NO in-app route at all:
    // this route refused them, /api/customer/subscribe requires already holding
    // the other product (so a cancelled management-only customer holds neither),
    // and /api/signup is retired for non-owners. The only way to take their money
    // was a hand-made Stripe Payment Link — undiscoverable, and easy to get wrong.
    //
    // It is safe here because an invite is not a grant: this route only ever
    // emails an activation link and creates a Checkout session. Nothing about the
    // customer's product state changes until they pay, and the invoice.paid
    // handler is what promotes account_status back to 'active' — a promotion that
    // now includes 'cancelled' precisely so this path cannot leave somebody paying
    // and lead-less.
    //
    // 'active' and 'invited' stay refused, for different reasons, so the message
    // names the state rather than repeating "not waitlisted" — which is what made
    // a deliberate policy read like a defect.
    const reason =
      customer.account_status === "invited"
        ? "Customer has already been invited — use Resend invite to send the link again"
        : `Customer already holds a management subscription (account status: ${customer.account_status})`;
    return NextResponse.json({ error: reason }, { status: 400 });
  }

  // Capacity is a non-blocking warning, never a hard block: the invite always
  // proceeds. We surface a warning when this customer becoming active would push
  // weighted usage over the limit, so the admin UI can flag it without stopping
  // the action. (Inviting flips the account to 'invited', which doesn't yet
  // consume a slot — only 'active' does — so we project the post-activation
  // weight on top of current usage.)
  //
  // Each product is capped independently over its own population (§16), so a GR
  // invite must be weighed against the GR cap. Charging it against the
  // management panel is what let a GR sale consume management capacity.
  const capacity = await getProductCapacityStatus(product);
  const projectedWeighted =
    Math.round(
      (capacity.weightedUsed +
        (isGr
          ? grCapacityWeight(customer.gr_monthly_allocation)
          : capacityWeight(customer.monthly_allocation))) *
        100
    ) / 100;
  const capacityWarning = projectedWeighted > capacity.limit;
  const warningMessage = capacityWarning
    ? `Inviting this customer projects ${capacity.product === "guaranteed_rent" ? "Guaranteed Rent" : "Management"} weighted usage to ${projectedWeighted} of ${capacity.limit} slots, over the capacity limit.`
    : null;

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

    // Fresh Checkout session for this customer's plan. Each product bills off
    // its OWN allocation column — billing a GR invite from monthly_allocation
    // would sell a 20-lead management customer the £300 GR plan by accident.
    // Both resolvers throw when the plan's price env var is missing, caught
    // below and surfaced as a descriptive error instead of an opaque 500.
    const plan = isGr
      ? grPlanForAllocation(customer.gr_monthly_allocation ?? 10)
      : planForAllocation(customer.monthly_allocation ?? 20);
    const priceId = isGr
      ? stripeGrPriceIdFor(customer.gr_monthly_allocation ?? 10)
      : stripePriceIdFor(customer.monthly_allocation ?? 20);

    // Put the row in the shape the webhook expects BEFORE checkout, the same
    // reason /api/customer/subscribe does (CLAUDE.md §17): the invoice.paid
    // handler sizes the credit and paces from the customer's stored allocation,
    // not from the invoice. Abandoning checkout leaves this inert — it gates
    // nothing for a customer who does not hold the product.
    if (isGr && customer.gr_monthly_allocation !== plan.leads) {
      await admin
        .from("customers")
        .update({ gr_monthly_allocation: plan.leads })
        .eq("id", customer.id);
    }

    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${APP_URL}/dashboard?checkout=success${isGr ? "&product=guaranteed-rent" : ""}`,
      cancel_url: `${APP_URL}/signup?checkout=cancelled`,
      // product_type mirrors /api/signup's GR checkout so the subscription is
      // self-describing in Stripe. The webhook still routes on the price id —
      // this is for humans reading the dashboard.
      ...(isGr
        ? { subscription_data: { metadata: { product_type: "guaranteed_rent" } } }
        : {}),
      metadata: {
        supabase_customer_id: customer.id,
        ...(isGr ? { product_type: "guaranteed_rent" } : {}),
      },
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
        options: { redirectTo: `${APP_URL}/reset-password` },
      });
      // Route the link through /auth/confirm using the token hash (verifyOtp),
      // NOT the raw action_link. The browser client uses the PKCE flow, whose
      // ?code exchange needs a code-verifier cookie that only exists if the flow
      // began in this user's browser — it never does for an admin-generated
      // link, so the old action_link → /login path could never establish a
      // session (and /login has no set-password step). The token-hash path needs
      // no verifier, works cross-device, and lands the user on /reset-password
      // with a live recovery session.
      const hashedToken = link?.properties?.hashed_token;
      setPasswordUrl = hashedToken
        ? `${APP_URL}/auth/confirm?token_hash=${hashedToken}&type=recovery&next=/reset-password`
        : (link?.properties?.action_link ?? null);
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
      product,
    });

    // 'invited' is a MANAGEMENT state — account_status is management-only, and
    // the GR half of the Stripe webhook deliberately never writes it. Marking a
    // GR invitee 'invited' would put them in the management funnel and, once
    // paid, leave them looking like a management customer to every reader of
    // that column. A GR invitee simply stays as they were until their GR
    // payment sets gr_subscription_status = 'active'; that is the only state
    // that makes them a GR customer, and it is the one the GR routing and
    // capacity queries read.
    //
    // For a RE-INVITE this moves the row off 'cancelled', which is correct — they
    // are back in the funnel — and loses nothing, because `cancelled_at` is what
    // records that they once left and it is left alone here. (The Stripe webhook
    // clears `cancelled_at` only when a subscription is genuinely active again.)
    if (!isGr) {
      await admin
        .from("customers")
        .update({ account_status: "invited" })
        .eq("id", customer.id);
    }

    return NextResponse.json({ ok: true, product, capacityWarning, warningMessage });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invite failed";
    console.error("invite route error", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
