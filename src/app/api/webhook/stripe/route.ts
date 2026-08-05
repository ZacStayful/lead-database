import { NextResponse, type NextRequest } from "next/server";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  grAllocationForPriceIds,
  grPlanForAllocation,
  isGuaranteedRentPriceId,
  planForAllocation,
} from "@/lib/plans";
import {
  sendFilterLiftCompletedEmail,
  sendAccountReadyEmail,
  sendSubscriptionResumedEmail,
} from "@/lib/emails";
import { provisionPaidSubscriber } from "@/lib/provisioning";
import type { LeadType } from "@/lib/types";

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
 * If a customer has a lift scheduled for this product, execute it now (renewal
 * is the genuine per-customer cutover) and send the completion notification +
 * email. No-op when no lift is pending.
 */
async function maybeExecuteFilterLift(
  admin: ReturnType<typeof createAdminClient>,
  customerId: string,
  leadType: LeadType
): Promise<void> {
  const { data: executed, error } = await admin.rpc("execute_filter_lift", {
    p_customer_id: customerId,
    p_lead_type: leadType,
  });
  if (error) {
    console.error("execute_filter_lift failed", error);
    return;
  }
  if (!executed) return;

  const { data: customer } = await admin
    .from("customers")
    .select("email")
    .eq("id", customerId)
    .maybeSingle();

  await admin.from("notifications").insert({
    customer_id: customerId,
    notification_type: "filter_lift_completed",
    message:
      "Your filter has been lifted. You're now back on the standard guaranteed lead allocation.",
  });

  if (customer?.email) {
    await sendFilterLiftCompletedEmail({ to: customer.email });
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

/**
 * Resolve the management plan tier ('10' | '20') an invoice is for. Prefers an
 * exact price-id match against the configured env prices; falls back to the
 * pre-discount subtotal (£150 → 10, £300 → 20) so redemption via a Payment Link
 * that references a different price object than the checkout env vars is still
 * labelled correctly. `subtotal` (not `amount_paid`) is used because it excludes
 * the promo discount.
 */
function allocationFromPrices(
  priceIds: string[],
  subtotalPence: number | null
): number {
  const tenId = process.env.STRIPE_PRICE_ID_10;
  if (tenId && priceIds.includes(tenId)) return 10;
  const twentyId =
    process.env.STRIPE_PRICE_ID_20 ?? process.env.STRIPE_MONTHLY_PRICE_ID;
  if (twentyId && priceIds.includes(twentyId)) return 20;
  return subtotalPence != null && subtotalPence > 0 && subtotalPence < 22500
    ? 10
    : 20;
}

/**
 * The subscription id an invoice belongs to, tolerant of Stripe API versions.
 * Older versions (<= acacia) expose `invoice.subscription`; newer versions
 * (basil+, which this account is on — it emits `invoice_payment.paid` events)
 * removed that field and nest it under
 * `invoice.parent.subscription_details.subscription`. Reading only the old field
 * silently skipped ALL subscription crediting/activation once the account
 * upgraded, so we check both.
 */
function subscriptionIdFromInvoice(invoice: Stripe.Invoice): string | null {
  const inv = invoice as unknown as {
    subscription?: string | { id?: string } | null;
    parent?: {
      subscription_details?: {
        subscription?: string | { id?: string } | null;
      } | null;
    } | null;
  };
  const legacy = inv.subscription;
  if (legacy) return typeof legacy === "string" ? legacy : (legacy.id ?? null);
  const nested = inv.parent?.subscription_details?.subscription;
  if (nested) return typeof nested === "string" ? nested : (nested.id ?? null);
  return null;
}

/**
 * Price ids on an invoice's line items, tolerant of API versions. Older versions
 * expose `line.price.id`; newer versions moved it to
 * `line.pricing.price_details.price`.
 */
function priceIdsFromInvoice(invoice: Stripe.Invoice): string[] {
  const ids: string[] = [];
  for (const line of invoice.lines?.data ?? []) {
    const l = line as unknown as {
      price?: { id?: string } | null;
      pricing?: { price_details?: { price?: string | { id?: string } } | null } | null;
    };
    if (l.price?.id) {
      ids.push(l.price.id);
      continue;
    }
    const p = l.pricing?.price_details?.price;
    if (p) ids.push(typeof p === "string" ? p : (p.id ?? ""));
  }
  return ids.filter(Boolean);
}

function planFromInvoice(invoice: Stripe.Invoice, priceIds: string[]): "10" | "20" {
  return allocationFromPrices(priceIds, invoice.subtotal) === 10 ? "10" : "20";
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
        // Matches ANY configured GR price, not just the original £150/10 one —
        // see isGuaranteedRentPriceId. With a single-price check, a £300/20 GR
        // subscription was routed into the management branch below, which on a
        // cancellation would set account_status = 'cancelled' on a customer
        // whose management subscription was never involved.
        const isGuaranteedRent = isGuaranteedRentPriceId(subPriceIds);

        const update: Record<string, unknown> = {
          updated_at: new Date().toISOString(),
        };
        // current_period_start moved from the subscription to its items in the
        // newer API version — read both. (invoice.paid also re-anchors, so this
        // is belt-and-braces.)
        const periodStart =
          sub.current_period_start ??
          (sub.items?.data?.[0] as unknown as { current_period_start?: number })
            ?.current_period_start ??
          null;
        const anchor = toDateString(periodStart);

        if (isGuaranteedRent) {
          update.gr_subscription_status = status;
          update.gr_stripe_subscription_id = sub.id;
          update.gr_stripe_price_id = subPriceIds[0] ?? null;
          if (anchor) update.gr_billing_cycle_anchor = anchor;

          // Re-size gr_monthly_allocation when — and only when — the GR
          // subscription's PRICE changes. `invoice.paid` credits
          // gr_monthly_allocation, not the price on the invoice, so without
          // this a 20-lead buyer sitting on the column's default of 10 is
          // credited half what they pay for, every month.
          //
          // The checkout routes set the allocation before redirecting (the GR
          // half of the CLAUDE.md §17 trap). This is the backstop for every
          // other way a GR subscription's price can be set or changed: a
          // Payment Link, a plan switch in the Stripe billing portal, or an
          // admin editing the subscription in Stripe directly.
          //
          // Keyed on "the price is not the one we last recorded" rather than on
          // the event type. That is precisely a plan change — on creation the
          // stored id is null, so it fires there too. An allocation an admin
          // has hand-edited while the price stayed put is never touched, which
          // is the silent re-sizing §17 declined to introduce on the management
          // side. An unrecognised price id changes nothing.
          const grAllocation = grAllocationForPriceIds(subPriceIds);
          if (grAllocation) {
            const { data: grRow } = await admin
              .from("customers")
              .select("gr_stripe_price_id")
              .eq("stripe_customer_id", customerId)
              .maybeSingle();
            if (grRow && grRow.gr_stripe_price_id !== subPriceIds[0]) {
              update.gr_monthly_allocation = grAllocation;
            }
          }
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

        // Resume detection (management only). If the management subscription is
        // NOT paused in Stripe but our record still marks it paused, the customer
        // has resumed collection out-of-band (e.g. they chose to continue paying
        // rather than wait out the 3 months). Clear the pause so lead routing
        // restarts. The guarded update (`paused_at is not null`) means only the
        // ONE writer that actually flips paused_at → null sends the "you're
        // back" email, so this never double-emails with the resume cron.
        if (!isGuaranteedRent && !sub.pause_collection) {
          // Re-baseline pacing on resume (anchor = today, monthly counter = 0),
          // mirroring execute_filter_lift and the resume cron. Without it the
          // stale billing_cycle_anchor from before the pause would read as a
          // maximal deficit and flood the customer with leads on resume.
          // lead_balance is untouched — credits carry forward.
          const { data: resumedRow } = await admin
            .from("customers")
            .update({
              paused_at: null,
              pause_resumes_at: null,
              billing_cycle_anchor: new Date().toISOString().slice(0, 10),
              leads_received_this_month: 0,
              updated_at: new Date().toISOString(),
            })
            .eq("stripe_customer_id", customerId)
            .not("paused_at", "is", null)
            .select("email, contact_name")
            .maybeSingle();

          // Only notify on a genuine resume — never when the subscription is
          // being cancelled/deleted (that path also has a null pause_collection).
          if (resumedRow?.email && status === "active") {
            await sendSubscriptionResumedEmail({
              to: resumedRow.email,
              contactName: resumedRow.contact_name ?? resumedRow.email,
            });
          }
        }
        break;
      }

      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = invoice.customer as string;

        // Only subscription invoices grant lead credit. Read the subscription
        // id in a version-tolerant way (see subscriptionIdFromInvoice) — the
        // old invoice.subscription field is gone on this account's API version.
        const subscriptionId = subscriptionIdFromInvoice(invoice);
        if (subscriptionId) {
          // Detect the product from the invoice line item price ids.
          const priceIds = priceIdsFromInvoice(invoice);
          const isGuaranteedRent = isGuaranteedRentPriceId(priceIds);

          if (isGuaranteedRent) {
            // Guaranteed Rent renewal — credit the customer's GR allocation and
            // mark the GR subscription active. Management fields are untouched.
            const { data: customer } = await admin
              .from("customers")
              .select("id, gr_monthly_allocation")
              .eq("stripe_customer_id", customerId)
              .maybeSingle();

            if (!customer) {
              console.error(
                "invoice.paid (GR) for unknown stripe_customer_id — no credit granted",
                customerId
              );
              break;
            }

            // How many GR leads this invoice buys. Read from the customer row,
            // exactly as the management branch reads monthly_allocation, so an
            // allocation an admin has hand-edited is honoured rather than being
            // silently re-sized by whatever price the invoice happens to carry
            // (CLAUDE.md §17). This was a bare `10` while GR had one plan; left
            // as a literal it would credit a £300/20 subscriber 10 leads a
            // month, for ever, with nothing in the UI to show it.
            const grCredits = grPlanForAllocation(
              customer.gr_monthly_allocation ?? 10
            ).leads;

            // The row is the source of truth, but if it disagrees with the
            // price actually being billed, somebody is being over- or
            // under-credited every month. Log it loudly rather than papering
            // over it — this is the one signal that a GR checkout was created
            // without its allocation being set first.
            const grInvoiceAllocation = grAllocationForPriceIds(priceIds);
            if (grInvoiceAllocation && grInvoiceAllocation !== grCredits) {
              console.error(
                `GR allocation drift for customer ${customer.id}: invoice price implies ${grInvoiceAllocation} leads but gr_monthly_allocation credits ${grCredits}. Crediting ${grCredits} — correct gr_monthly_allocation in admin.`
              );
            }

            // Idempotent, invoice-keyed credit: records the paid invoice and
            // moves gr_lead_balance in a single transaction. A replayed delivery
            // of an already-credited invoice is a no-op, so a failure anywhere
            // after this line can be safely retried without double-crediting.
            const { error: creditError } = await admin.rpc("credit_invoice", {
              p_customer_id: customer.id,
              p_amount: grCredits,
              p_invoice_id: invoice.id,
              p_payment_intent_id:
                (invoice.payment_intent as string | null) ?? null,
              p_amount_pence: invoice.amount_paid ?? 0,
              p_payment_type: "gr_subscription",
            });
            if (creditError) {
              // Throw so the outer handler releases the idempotency claim and
              // Stripe retries; credit_invoice is idempotent, so this is safe.
              throw new Error(
                `credit_invoice (GR) failed: ${creditError.message}`
              );
            }

            const grUpdate: Record<string, unknown> = {
              gr_subscription_status: "active",
              gr_stripe_subscription_id: subscriptionId,
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

            // Execute a scheduled GR filter lift at this genuine renewal.
            await maybeExecuteFilterLift(admin, customer.id, "guaranteed_rent");
            break;
          }

          // Management renewal. The credit granted each month is the customer's
          // plan allocation (10 or 20). Read the customer first so we can both
          // size the credit and detect a mismatched Stripe id.
          let { data: customer } = await admin
            .from("customers")
            .select("id, monthly_allocation")
            .eq("stripe_customer_id", customerId)
            .maybeSingle();

          // Post-call discount redemption. Runs BEFORE the customer-existence
          // guard on purpose: a prospect who pays via a Payment Link may have no
          // customers row yet (the links use customer_creation: "if_required"),
          // and the offer must still be marked redeemed so the "Discount applied"
          // state is reliably visible. matched_customer_id links a real customer
          // when one exists, otherwise stays null. Idempotent via redeemed_at IS
          // NULL; independent of and additive to the crediting logic below — it
          // never touches lead allocation.
          const promoCodeId = promotionCodeIdFromInvoice(invoice);
          if (promoCodeId) {
            const { error: redeemError } = await admin
              .from("post_call_offers")
              .update({
                redeemed_at: new Date().toISOString(),
                matched_customer_id: customer?.id ?? null,
                redeemed_plan: planFromInvoice(invoice, priceIds),
              })
              .eq("stripe_promo_code_id", promoCodeId)
              .is("redeemed_at", null);
            if (redeemError) {
              console.error("post_call_offers redemption update failed", redeemError);
            }
          }

          if (!customer) {
            // No linked portal account — a Payment Link signup that never went
            // through the admin invite flow. Provision one now (create/link the
            // customers row + a login), then credit it as a normal first
            // payment. This is what makes the reusable discount Payment Link
            // work end-to-end instead of stranding the payer.
            const sc = await stripe.customers.retrieve(customerId);
            const email = "deleted" in sc && sc.deleted ? null : sc.email;
            const name = "deleted" in sc && sc.deleted ? null : sc.name;
            if (email) {
              const result = await provisionPaidSubscriber(admin, {
                stripeCustomerId: customerId,
                email,
                name: name ?? null,
                subscriptionId,
                allocation: allocationFromPrices(priceIds, invoice.subtotal),
                billingAnchor: toDateString(invoice.period_start),
              });
              if (result) {
                if (result.createdUser && result.setPasswordUrl) {
                  await sendAccountReadyEmail({
                    to: email,
                    contactName: name ?? email,
                    setPasswordUrl: result.setPasswordUrl,
                  });
                }
                const { data: linked } = await admin
                  .from("customers")
                  .select("id, monthly_allocation")
                  .eq("id", result.customerId)
                  .maybeSingle();
                customer = linked ?? null;
              }
            }
          }

          if (!customer) {
            console.error(
              "invoice.paid: could not resolve or provision customer for stripe id",
              customerId
            );
            break;
          }

          const credits = planForAllocation(
            customer.monthly_allocation ?? 20
          ).leads;

          // Idempotent, invoice-keyed credit: records the paid invoice and moves
          // lead_balance in a single transaction. A replayed delivery of an
          // already-credited invoice is a no-op, so a failure anywhere after this
          // line can be safely retried without double-crediting.
          const { error: creditError } = await admin.rpc("credit_invoice", {
            p_customer_id: customer.id,
            p_amount: credits,
            p_invoice_id: invoice.id,
            p_payment_intent_id:
              (invoice.payment_intent as string | null) ?? null,
            p_amount_pence: invoice.amount_paid ?? 0,
            p_payment_type: "subscription",
          });
          if (creditError) {
            // Throw so the outer handler releases the idempotency claim and
            // Stripe retries; credit_invoice is idempotent, so this is safe.
            throw new Error(`credit_invoice failed: ${creditError.message}`);
          }

          // Promote to active on a successful payment. Anyone who has paid
          // should be active regardless of how they got here — the previous
          // 'invited'-only guard left customers who paid while still
          // 'waitlisted' stuck as inactive (and therefore ineligible for
          // auto-assignment). Restrict to the pre-active states so this is a
          // no-op on renewals (already 'active') and never resurrects a
          // deliberately 'cancelled' account.
          // Key on the RESOLVED customer.id, not the event's stripe_customer_id:
          // a payer who signed up (Stripe customer A) then paid via a Payment
          // Link (Stripe customer B) is credited by email-match, but their row
          // still carries the stale id A. Matching by stripe_customer_id here
          // would miss them and leave a paid customer stuck 'waitlisted' (and so
          // ineligible for assignment). customer.id always matches the row we
          // just credited.
          await admin
            .from("customers")
            .update({ account_status: "active" })
            .eq("id", customer.id)
            .in("account_status", ["invited", "waitlisted"]);

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

          // Execute a scheduled management filter lift at this genuine renewal.
          await maybeExecuteFilterLift(admin, customer.id, "management");
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
          // Detect the product from the invoice's line-item price ids, exactly
          // as invoice.paid does. Without this the handler was product-blind:
          // every failure was recorded as a management 'subscription' payment
          // AND marked the MANAGEMENT subscription past_due — so a failed GR
          // invoice silently degraded the customer's management subscription,
          // breaking the parallel-column invariant. Branch on the product and
          // touch only that product's columns.
          const priceIds = priceIdsFromInvoice(invoice);
          const isGuaranteedRent = isGuaranteedRentPriceId(priceIds);

          await admin.from("payments").insert({
            customer_id: customer.id,
            stripe_invoice_id: invoice.id,
            amount_pence: invoice.amount_due ?? 0,
            payment_type: isGuaranteedRent ? "gr_subscription" : "subscription",
            status: "failed",
            lead_type: isGuaranteedRent ? "guaranteed_rent" : "management",
          });

          await admin
            .from("customers")
            .update(
              isGuaranteedRent
                ? {
                    gr_subscription_status: "past_due",
                    updated_at: new Date().toISOString(),
                  }
                : {
                    subscription_status: "past_due",
                    updated_at: new Date().toISOString(),
                  }
            )
            .eq("id", customer.id);
        }
        break;
      }

      case "checkout.session.completed": {
        // Only the lead top-up fallback path uses hosted Checkout (payment mode);
        // subscriptions are created via subscription-mode Checkout/Payment Links
        // and credited through invoice.paid, not here. Gate strictly on our own
        // metadata so no other checkout completion is ever mistaken for a top-up.
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.metadata?.kind !== "lead_topup") break;
        if (session.payment_status !== "paid") break;

        const tokenId = session.metadata.token_id;
        if (!tokenId) {
          console.error("lead_topup checkout.session.completed missing token_id");
          break;
        }

        const paymentIntentId =
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : (session.payment_intent?.id ?? null);

        // Idempotent, token-keyed credit: +5 to the matching balance and a
        // 'topup' payment row, in one transaction. A replayed delivery is a
        // no-op, so a failure after this line can be retried safely.
        const { data: credited, error: creditError } = await admin.rpc(
          "record_lead_topup_success",
          { p_token_id: tokenId, p_payment_intent_id: paymentIntentId }
        );
        if (creditError) {
          throw new Error(
            `record_lead_topup_success failed: ${creditError.message}`
          );
        }
        // false = we declined to credit (unknown token, or already paid). On a
        // session we know was paid, that is a money-moved-but-no-credit event —
        // log it loudly as the reconciliation tripwire rather than silently
        // acknowledging.
        if (credited === false) {
          console.error(
            "lead_topup checkout paid but credit skipped (already paid or unknown token)",
            { tokenId, paymentIntentId }
          );
        }
        break;
      }

      case "payment_intent.succeeded": {
        // Safety net for the off-session path. If the charge was captured but
        // our request died before we could credit (connection reset, timeout,
        // an intent that settled asynchronously), this is what still credits
        // the customer. record_lead_topup_success promotes a token previously
        // marked 'failed' and is a no-op once 'paid', so this is safe to run on
        // every delivery and can never double-credit.
        const intent = event.data.object as Stripe.PaymentIntent;
        if (intent.metadata?.kind !== "lead_topup") break;

        const tokenId = intent.metadata.token_id;
        if (!tokenId) {
          console.error("lead_topup payment_intent.succeeded missing token_id");
          break;
        }

        const { error: creditError } = await admin.rpc(
          "record_lead_topup_success",
          { p_token_id: tokenId, p_payment_intent_id: intent.id }
        );
        if (creditError) {
          throw new Error(
            `record_lead_topup_success (recovery) failed: ${creditError.message}`
          );
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
