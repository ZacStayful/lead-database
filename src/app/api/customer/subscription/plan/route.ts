import { NextResponse, type NextRequest } from "next/server";
import type Stripe from "stripe";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe, subscriptionPeriodEnd } from "@/lib/stripe";
import {
  GR_PLANS,
  PLANS,
  grPlanForAllocation,
  planForAllocation,
  stripeGrPriceIdFor,
  stripePriceIdFor,
  toGrPlanKey,
  toPlanKey,
} from "@/lib/plans";
import { holdsProduct, toLeadType } from "@/lib/products";
import {
  closeOpenPlanChange,
  planChangeColumns,
  recordPlanChange,
} from "@/lib/planChanges";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SOURCE = "subscription/plan";

/**
 * The columns this route reads. Declared rather than inferred because the
 * per-product column names are resolved through `planChangeColumns()`, and an
 * index into an inferred PostgREST row type is an implicit `any`.
 */
interface PlanChangeRow {
  id: string;
  account_status: string;
  subscription_status: string;
  gr_subscription_status: string;
  paused_at: string | null;
  stripe_subscription_id: string | null;
  gr_stripe_subscription_id: string | null;
  monthly_allocation: number | null;
  pending_monthly_allocation: number | null;
  gr_monthly_allocation: number | null;
  gr_pending_monthly_allocation: number | null;
}

/**
 * Move a subscription between the 10-lead and 20-lead tier of a product the
 * customer ALREADY HOLDS.
 *
 * Not to be confused with `/api/customer/subscribe`, which starts a Checkout
 * session for the product they do not hold. That route sells; this one resizes.
 *
 * THE CHANGE TAKES EFFECT AT THE NEXT BILLING DATE
 * ------------------------------------------------
 * `proration_behavior: "none"` is the whole billing decision. Stripe swaps the
 * item price immediately, nothing is charged or refunded today, and the first
 * invoice at the new price is the customer's natural next one. They keep the
 * cycle they have already paid for at the tier they paid for.
 *
 * That is also why this route does NOT write the allocation. `invoice.paid`
 * credits `(gr_)monthly_allocation` (§17), and the same column drives pacing and
 * weighted capacity — so moving it now would pace a customer at 20 leads
 * through a cycle they paid £150 for. The new figure is parked in
 * `(gr_)pending_monthly_allocation` and the webhook applies it when the invoice
 * that bills it is paid. See §24 and `src/lib/planChanges.ts`.
 *
 * REVERTING IS THE SAME REQUEST
 * -----------------------------
 * Asking for the tier you are currently on, while a change is pending, swaps the
 * price back and clears the pending columns. One code path, so the undo can
 * never diverge from the do.
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
  const isGr = leadType === "guaranteed_rent";

  // Identity from the session, never the body — the §8 pattern.
  const admin = createAdminClient();
  const { data: customer } = await admin
    .from("customers")
    .select(
      "id, account_status, subscription_status, gr_subscription_status, paused_at, " +
        "stripe_subscription_id, gr_stripe_subscription_id, " +
        "monthly_allocation, pending_monthly_allocation, " +
        "gr_monthly_allocation, gr_pending_monthly_allocation"
    )
    .eq("user_id", user.id)
    .maybeSingle<PlanChangeRow>();

  if (!customer) {
    return NextResponse.json({ error: "No customer record" }, { status: 404 });
  }

  if (!holdsProduct(customer, leadType)) {
    return NextResponse.json(
      { error: "You don't have this subscription, so there's no plan to change." },
      { status: 403 }
    );
  }

  // Management only (invariant 6): `paused_at` is a management column and GR
  // keeps flowing to a paused management customer, so it must not gate GR.
  //
  // Under a pause Stripe is generating invoices and voiding them, so a price
  // change would land at a moment nobody can predict. A pending CANCELLATION is
  // deliberately not blocked — somebody weighing up leaving is exactly who
  // should be able to drop a tier instead.
  if (!isGr && customer.paused_at) {
    return NextResponse.json(
      {
        error:
          "Your subscription is paused. Resume it from Settings before changing plan.",
      },
      { status: 409 }
    );
  }

  const cols = planChangeColumns(leadType);
  const subscriptionId = customer[cols.subscriptionId] as string | null;
  if (!subscriptionId) {
    // Comped and hand-provisioned accounts genuinely have no subscription to
    // resize. Say so rather than throwing at Stripe.
    return NextResponse.json(
      {
        error:
          "We can't find a billing subscription for this package. Please contact support and we'll change it for you.",
      },
      { status: 409 }
    );
  }

  const currentAllocation = Number(customer[cols.allocation] ?? (isGr ? 10 : 20));
  const pendingAllocation = customer[cols.pending] as number | null;

  // Target tier. The narrowing helpers default differently per product
  // (DEFAULT_GR_PLAN is the £150/10 plan), which is correct for a caller that
  // names no plan.
  const targetAllocation = isGr
    ? GR_PLANS[toGrPlanKey(body.plan)].leads
    : PLANS[toPlanKey(body.plan)].leads;

  const revert = targetAllocation === currentAllocation && pendingAllocation != null;
  if (targetAllocation === currentAllocation && !revert) {
    return NextResponse.json({
      changed: false,
      message: "You're already on this plan.",
      currentLeads: currentAllocation,
      pendingLeads: null,
      effectiveAt: null,
    });
  }

  let priceId: string;
  try {
    priceId = isGr
      ? stripeGrPriceIdFor(targetAllocation)
      : stripePriceIdFor(targetAllocation);
  } catch (err) {
    console.error(`[${SOURCE}] price id unresolved`, err);
    return NextResponse.json(
      { error: "That plan isn't configured for billing yet. Please contact support." },
      { status: 500 }
    );
  }

  const stripe = getStripe();

  let subscription: Stripe.Subscription;
  try {
    subscription = await stripe.subscriptions.retrieve(subscriptionId);
  } catch (err) {
    console.error(`[${SOURCE}] subscription retrieve failed`, err);
    return NextResponse.json(
      { error: "Could not reach billing. Please try again." },
      { status: 502 }
    );
  }

  const items = subscription.items?.data ?? [];
  if (items.length !== 1) {
    // This route swaps ONE item's price. A subscription carrying several is not
    // something to guess at — refuse and let support look.
    console.error(`[${SOURCE}] subscription has ${items.length} items`, {
      customer: customer.id,
      subscription: subscriptionId,
    });
    return NextResponse.json(
      {
        error:
          "Your subscription is set up in a way we can't change automatically. Please contact support.",
      },
      { status: 409 }
    );
  }

  const item = items[0];
  const previousPriceId = item.price?.id ?? null;

  // `current_period_end` sits on the subscription or on its items depending on
  // the account's API version. `subscriptionPeriodEnd` is the one reading of
  // that, shared with the admin billing panel and the Monday sync — two answers
  // to "when does this subscription actually end" would eventually disagree.
  const periodEnd = subscriptionPeriodEnd(subscription);
  const effectiveAt = periodEnd ? new Date(periodEnd * 1000).toISOString() : null;

  // Stripe first. If the price swap fails nothing has been promised, and the
  // customer sees an error against a database that still matches billing.
  try {
    await stripe.subscriptions.update(subscriptionId, {
      items: [{ id: item.id, price: priceId }],
      proration_behavior: "none",
      metadata: {
        ...(subscription.metadata ?? {}),
        plan_change_source: "dashboard",
      },
    });
  } catch (err) {
    console.error(`[${SOURCE}] Stripe price swap failed`, err);
    return NextResponse.json(
      { error: "Could not change your plan with our payment provider. Please try again." },
      { status: 502 }
    );
  }

  // Then the database. A row that disagrees with Stripe is worse than a failed
  // request, so a write failure puts the price back.
  const { error: updateError } = await admin
    .from("customers")
    .update(
      revert
        ? { [cols.pending]: null, [cols.pendingAt]: null }
        : { [cols.pending]: targetAllocation, [cols.pendingAt]: effectiveAt }
    )
    .eq("id", customer.id);

  if (updateError) {
    if (previousPriceId) {
      try {
        await stripe.subscriptions.update(subscriptionId, {
          items: [{ id: item.id, price: previousPriceId }],
          proration_behavior: "none",
        });
      } catch (rollbackErr) {
        console.error(`[${SOURCE}] price rollback failed`, rollbackErr);
      }
    }
    console.error(`[${SOURCE}] pending write failed`, {
      customer: customer.id,
      error: updateError.message,
    });
    return NextResponse.json(
      { error: "Could not save your plan change. Please try again." },
      { status: 500 }
    );
  }

  // History, best-effort from here on — both systems already agree.
  if (revert) {
    await closeOpenPlanChange(admin, customer.id, leadType, "cancelled_at", SOURCE);
  } else {
    // A second change before the first has billed supersedes it.
    if (pendingAllocation != null) {
      await closeOpenPlanChange(admin, customer.id, leadType, "cancelled_at", SOURCE);
    }
    await recordPlanChange(
      admin,
      {
        customerId: customer.id,
        leadType,
        fromAllocation: currentAllocation,
        toAllocation: targetAllocation,
        stripePriceId: priceId,
        effectiveAt,
      },
      SOURCE
    );
  }

  const plan = isGr
    ? grPlanForAllocation(targetAllocation)
    : planForAllocation(targetAllocation);

  return NextResponse.json({
    changed: true,
    reverted: revert,
    currentLeads: currentAllocation,
    pendingLeads: revert ? null : targetAllocation,
    priceGbp: plan.priceGbp,
    effectiveAt: revert ? null : effectiveAt,
  });
}
