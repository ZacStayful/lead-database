import { NextResponse, type NextRequest } from "next/server";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Convert a Stripe unix timestamp (seconds) to a YYYY-MM-DD date string. */
function toDateString(unixSeconds: number | null | undefined): string | null {
  if (!unixSeconds) return null;
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/** Map a Stripe subscription status onto our customers.subscription_status. */
function mapStatus(status: Stripe.Subscription.Status): string {
  switch (status) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    default:
      return "inactive";
  }
}

export async function POST(request: NextRequest) {
  const stripe = getStripe();
  const signature = request.headers.get("stripe-signature");
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!signature || !secret) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  const payload = await request.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(payload, signature, secret);
  } catch (err) {
    console.error("Stripe signature verification failed", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Idempotency: claim this event id before doing any crediting. Stripe retries
  // deliver the same event more than once; a unique-violation here means we've
  // already processed it, so acknowledge and skip. If the claim fails for any
  // other reason we fall through and process rather than dropping the event.
  const { error: claimError } = await admin
    .from("stripe_events")
    .insert({ id: event.id, type: event.type });
  if (claimError) {
    if (claimError.code === "23505") {
      return NextResponse.json({ received: true, deduped: true });
    }
    console.error("stripe_events claim failed", claimError);
  }

  try {
    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = sub.customer as string;
        const status =
          event.type === "customer.subscription.deleted"
            ? "canceled"
            : mapStatus(sub.status);

        // A customer can hold both a management and a GR subscription against
        // the same Stripe customer. Route the lifecycle event to the matching
        // column set by inspecting the subscription's price id, so a GR event
        // never clobbers management state (and vice-versa).
        const subPriceIds = (sub.items?.data ?? [])
          .map((item) => item.price?.id)
          .filter((id): id is string => Boolean(id));
        const grPriceId = process.env.STRIPE_GR_MONTHLY_PRICE_ID;
        const isGuaranteedRent = Boolean(
          grPriceId && subPriceIds.includes(grPriceId)
        );

        const update: Record<string, unknown> = {
          updated_at: new Date().toISOString(),
        };
        const anchor = toDateString(sub.current_period_start);

        if (isGuaranteedRent) {
          update.gr_subscription_status = status;
          update.gr_stripe_subscription_id = sub.id;
          update.gr_stripe_price_id = subPriceIds[0] ?? null;
          if (anchor) update.gr_billing_cycle_anchor = anchor;
        } else {
          update.stripe_subscription_id = sub.id;
          update.subscription_status = status;
          if (anchor) update.billing_cycle_anchor = anchor;
          // Keep monthly_allocation in sync with the management tier.
          const tenPriceId = process.env.STRIPE_MONTHLY_10_PRICE_ID;
          update.monthly_allocation =
            tenPriceId && subPriceIds.includes(tenPriceId) ? 10 : 20;
        }

        await admin
          .from("customers")
          .update(update)
          .eq("stripe_customer_id", customerId);
        break;
      }

      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = invoice.customer as string;

        // Only subscription renewals grant lead credit. Every invoice this
        // integration receives is a subscription invoice.
        if (invoice.subscription) {
          // Determine the product from the invoice line item price id.
          const priceIds = (invoice.lines?.data ?? [])
            .map((line) => line.price?.id)
            .filter((id): id is string => Boolean(id));
          const grPriceId = process.env.STRIPE_GR_MONTHLY_PRICE_ID;
          const isGuaranteedRent = Boolean(
            grPriceId && priceIds.includes(grPriceId)
          );

          if (isGuaranteedRent) {
            // Guaranteed Rent renewal — add 10 GR leads of credit and mark the
            // GR subscription active. Management fields are left untouched.
            const { error: grBalanceError } = await admin.rpc(
              "increment_gr_lead_balance",
              { p_stripe_customer_id: customerId, p_amount: 10 }
            );
            if (grBalanceError) {
              console.error("increment_gr_lead_balance failed", grBalanceError);
            }

            const { data: customer } = await admin
              .from("customers")
              .select("id")
              .eq("stripe_customer_id", customerId)
              .maybeSingle();

            if (customer) {
              const grUpdate: Record<string, unknown> = {
                gr_subscription_status: "active",
                gr_stripe_subscription_id: invoice.subscription as string,
                updated_at: new Date().toISOString(),
              };
              // Re-anchor the GR billing cycle to this period's start on every
              // renewal, mirroring the management invoice.paid handler so the
              // two products pace consistently.
              const anchor =
                toDateString(invoice.period_start) ??
                toDateString(invoice.created);
              if (anchor) grUpdate.gr_billing_cycle_anchor = anchor;

              await admin
                .from("customers")
                .update(grUpdate)
                .eq("id", customer.id);

              await admin.from("payments").insert({
                customer_id: customer.id,
                stripe_invoice_id: invoice.id,
                stripe_payment_intent_id:
                  (invoice.payment_intent as string | null) ?? null,
                amount_pence: invoice.amount_paid ?? 0,
                credits_added: 10,
                payment_type: "gr_subscription",
                status: "paid",
              });
            }
            break;
          }

          // Management subscription renewal. The 10-lead tier grants 10 credits
          // (allocation 10); the 20-lead tier grants 20 (allocation 20).
          const tenPriceId = process.env.STRIPE_MONTHLY_10_PRICE_ID;
          const isTenPlan = Boolean(tenPriceId && priceIds.includes(tenPriceId));
          const credits = isTenPlan ? 10 : 20;
          const allocation = isTenPlan ? 10 : 20;

          const { error: balanceError } = await admin.rpc(
            "increment_lead_balance",
            { p_stripe_customer_id: customerId, p_amount: credits }
          );
          if (balanceError) {
            console.error("increment_lead_balance failed", balanceError);
          }

          // Promote invited → active on the first successful payment. The
          // account_status guard makes this a no-op on later renewals.
          await admin
            .from("customers")
            .update({ account_status: "active" })
            .eq("stripe_customer_id", customerId)
            .eq("account_status", "invited");

          const { data: customer } = await admin
            .from("customers")
            .select("id")
            .eq("stripe_customer_id", customerId)
            .maybeSingle();

          if (customer) {
            // Record the payment.
            await admin.from("payments").insert({
              customer_id: customer.id,
              stripe_invoice_id: invoice.id,
              stripe_payment_intent_id:
                (invoice.payment_intent as string | null) ?? null,
              amount_pence: invoice.amount_paid ?? 0,
              credits_added: credits,
              payment_type: "subscription",
              status: "paid",
            });

            // Keep the subscription marked active, set the tier's monthly
            // allocation, and re-anchor the billing cycle to this period start.
            const renewalUpdate: Record<string, unknown> = {
              subscription_status: "active",
              monthly_allocation: allocation,
              updated_at: new Date().toISOString(),
            };
            const renewalAnchor = toDateString(invoice.period_start);
            if (renewalAnchor)
              renewalUpdate.billing_cycle_anchor = renewalAnchor;

            await admin
              .from("customers")
              .update(renewalUpdate)
              .eq("id", customer.id);
          }
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = invoice.customer as string;

        const { data: customer } = await admin
          .from("customers")
          .select("id")
          .eq("stripe_customer_id", customerId)
          .maybeSingle();

        if (customer) {
          await admin.from("payments").insert({
            customer_id: customer.id,
            stripe_invoice_id: invoice.id,
            amount_pence: invoice.amount_due ?? 0,
            payment_type: "subscription",
            status: "failed",
          });
          await admin
            .from("customers")
            .update({
              subscription_status: "past_due",
              updated_at: new Date().toISOString(),
            })
            .eq("id", customer.id);
        }
        break;
      }

      default:
        // Unhandled event types are acknowledged so Stripe stops retrying.
        break;
    }
  } catch (err) {
    console.error("Stripe webhook handler error", err);
    // Release the idempotency claim so Stripe's retry can reprocess this event.
    await admin.from("stripe_events").delete().eq("id", event.id);
    return NextResponse.json({ error: "Handler error" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
