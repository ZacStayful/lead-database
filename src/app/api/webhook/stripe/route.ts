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

        const update: Record<string, unknown> = {
          stripe_subscription_id: sub.id,
          subscription_status: status,
          updated_at: new Date().toISOString(),
        };
        // Anchor the billing cycle to the current period start.
        const anchor = toDateString(sub.current_period_start);
        if (anchor) update.billing_cycle_anchor = anchor;

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
          // Subscription renewal — add 20 leads of credit.
          const { error: balanceError } = await admin.rpc(
            "increment_lead_balance",
            { p_stripe_customer_id: customerId, p_amount: 20 }
          );
          if (balanceError) {
            console.error("increment_lead_balance failed", balanceError);
          }

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
              credits_added: 20,
              payment_type: "subscription",
              status: "paid",
            });

            // Keep the subscription marked active and re-anchor the billing
            // cycle to the start of the period this invoice covers.
            const renewalUpdate: Record<string, unknown> = {
              subscription_status: "active",
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
    return NextResponse.json({ error: "Handler error" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
