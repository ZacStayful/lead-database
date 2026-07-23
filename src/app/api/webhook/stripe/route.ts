import { NextResponse, type NextRequest } from "next/server";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { planForAllocation } from "@/lib/plans";

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

/**
 * Extract the Stripe Promotion Code id applied to an invoice, if any. Handles
 * both the single `discount` field and the `discounts` array, whether the
 * promotion_code is an id string or an expanded object. Returns null when the
 * invoice carries no promotion code.
 */
function promotionCodeIdFromInvoice(invoice: Stripe.Invoice): string | null {
  const fromDiscount = (
    d: Stripe.Discount | Stripe.DeletedDiscount | string | null | undefined
  ): string | null => {
    if (!d || typeof d === "string") return null;
    const promo = (d as Stripe.Discount).promotion_code;
    if (!promo) return null;
    return typeof promo === "string" ? promo : promo.id;
  };

  const single = fromDiscount(invoice.discount);
  if (single) return single;

  for (const d of invoice.discounts ?? []) {
    const id = fromDiscount(d);
    if (id) return id;
  }
  return null;
}

/** Map an invoice's line price ids to the management plan tier ('10' | '20'). */
function planFromInvoicePriceIds(priceIds: string[]): "10" | "20" {
  const tenId = process.env.STRIPE_PRICE_ID_10;
  return tenId && priceIds.includes(tenId) ? "10" : "20";
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
          // A cancelled management subscription must release its capacity slot —
          // capacity is counted by account_status = 'active'. GR cancellations
          // must NOT touch account_status.
          if (status === "canceled") update.account_status = "cancelled";
          if (anchor) update.billing_cycle_anchor = anchor;
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
          // Detect the product from the invoice line item price id.
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
            const { data: customer } = await admin
              .from("customers")
              .select("id")
              .eq("stripe_customer_id", customerId)
              .maybeSingle();

            if (customer) {
              // Idempotent credit: records the paid invoice and moves the GR
              // balance in one transaction. Returns false (no-op) on a replayed
              // invoice, so a webhook retry can never double-credit.
              const { data: credited, error: creditError } = await admin.rpc(
                "credit_invoice",
                {
                  p_customer_id: customer.id,
                  p_amount: 10,
                  p_invoice_id: invoice.id,
                  p_payment_intent_id:
                    (invoice.payment_intent as string | null) ?? null,
                  p_amount_pence: invoice.amount_paid ?? 0,
                  p_payment_type: "gr_subscription",
                }
              );
              if (creditError) {
                console.error("credit_invoice (gr) failed", creditError);
              } else if (credited === false) {
                console.log("GR invoice already credited, skipping", invoice.id);
              }

              const grUpdate: Record<string, unknown> = {
                gr_subscription_status: "active",
                gr_stripe_subscription_id: invoice.subscription as string,
                updated_at: new Date().toISOString(),
              };
              // Re-anchor the GR billing cycle to this period's start on every
              // renewal, mirroring the management handler so both products pace
              // consistently.
              const grAnchor =
                toDateString(invoice.period_start) ??
                toDateString(invoice.created);
              if (grAnchor) grUpdate.gr_billing_cycle_anchor = grAnchor;

              await admin
                .from("customers")
                .update(grUpdate)
                .eq("id", customer.id);
            }
            break;
          }

          // Management renewal. The credit granted each month is the customer's
          // plan allocation (10 or 20). Read the customer first so we can both
          // size the credit and detect a mismatched Stripe id.
          const { data: customer } = await admin
            .from("customers")
            .select("id, monthly_allocation")
            .eq("stripe_customer_id", customerId)
            .maybeSingle();

          if (!customer) {
            console.error(
              "invoice.paid for unknown stripe_customer_id — no credit granted",
              customerId
            );
            break;
          }

          const credits = planForAllocation(
            customer.monthly_allocation ?? 20
          ).leads;

          // Idempotent credit: records the paid invoice and moves the balance in
          // one transaction, so a replayed webhook can never credit twice. This
          // replaces the old unconditional increment + separate payment insert.
          const { data: credited, error: balanceError } = await admin.rpc(
            "credit_invoice",
            {
              p_customer_id: customer.id,
              p_amount: credits,
              p_invoice_id: invoice.id,
              p_payment_intent_id:
                (invoice.payment_intent as string | null) ?? null,
              p_amount_pence: invoice.amount_paid ?? 0,
              p_payment_type: "subscription",
            }
          );
          if (balanceError) {
            console.error("credit_invoice failed", balanceError);
          } else if (credited === false) {
            console.log("Invoice already credited, skipping", invoice.id);
          }

          // Promote invited → active on the first successful payment. The
          // account_status guard makes this a no-op on later renewals.
          await admin
            .from("customers")
            .update({ account_status: "active" })
            .eq("stripe_customer_id", customerId)
            .eq("account_status", "invited");

          // Keep the subscription marked active and re-anchor the billing cycle
          // to the start of the period this invoice covers.
          const renewalUpdate: Record<string, unknown> = {
            subscription_status: "active",
            updated_at: new Date().toISOString(),
          };
          const renewalAnchor = toDateString(invoice.period_start);
          if (renewalAnchor) renewalUpdate.billing_cycle_anchor = renewalAnchor;

          await admin
            .from("customers")
            .update(renewalUpdate)
            .eq("id", customer.id);

          // Post-call discount redemption. If a promotion code was applied to
          // this invoice and it matches an unredeemed post_call_offers row, mark
          // it redeemed and tie it to this customer + plan. Kept separate from —
          // and additive to — the crediting logic above; it does not touch lead
          // allocation. Guarded on redeemed_at IS NULL so a webhook retry is a
          // no-op.
          const promoCodeId = promotionCodeIdFromInvoice(invoice);
          if (promoCodeId) {
            const redeemedPlan = planFromInvoicePriceIds(priceIds);
            const { error: redeemError } = await admin
              .from("post_call_offers")
              .update({
                redeemed_at: new Date().toISOString(),
                matched_customer_id: customer.id,
                redeemed_plan: redeemedPlan,
              })
              .eq("stripe_promo_code_id", promoCodeId)
              .is("redeemed_at", null);
            if (redeemError) {
              console.error("post_call_offers redemption update failed", redeemError);
            }
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
