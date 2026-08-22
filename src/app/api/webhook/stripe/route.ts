import { NextResponse, type NextRequest } from "next/server";
import type Stripe from "stripe";
import { getStripe, subscriptionPeriodEnd } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  applyPastDueEpisode,
  mapStripeSubscriptionStatus as mapStatus,
} from "@/lib/pastDueEpisode";
import { syncCustomerMondayStatus } from "@/lib/mondayStatus";
import {
  GR_PLANS,
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
import { stampEpisodeEnded } from "@/lib/pauseEpisodes";
import { applyPendingPlanChange } from "@/lib/planChanges";
import type { LeadType } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Convert a Stripe unix timestamp (seconds) to a YYYY-MM-DD date string. */
function toDateString(unixSeconds: number | null | undefined): string | null {
  if (!unixSeconds) return null;
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * Push a customer's state to the Monday sales board, swallowing everything.
 *
 * The try/catch is not defensive habit — it is load-bearing. This handler DELETES
 * its stripe_events idempotency claim on any throw so that Stripe retries, so an
 * exception escaping a Monday failure would make Stripe redeliver an invoice that
 * has already been credited. syncCustomerMondayStatus already returns a result
 * object rather than throwing; this is the second stop.
 *
 * Used by the branches that need no cancellation context. The
 * customer.subscription.* branch calls syncCustomerMondayStatus directly, because
 * only it knows cancel_at_period_end and the real end-of-service date.
 */
async function pushMondayStatus(
  admin: ReturnType<typeof createAdminClient>,
  customerId: string,
  reason: string
): Promise<void> {
  try {
    const push = await syncCustomerMondayStatus(admin, customerId, { reason });
    logMondayPush(customerId, reason, push);
  } catch (err) {
    console.error("[monday-status] push threw", { reason, err });
  }
}

/**
 * Log a push outcome that deserves attention.
 *
 * `error` alone is not enough: a revoked token or an unreachable board comes back as
 * a `skipped` code, and logging only on `error` meant the entire sync could stop
 * working with nothing in the logs at all. The ordinary outcomes — unchanged, no
 * label, archived — stay silent, and so does not_configured, which is the expected
 * steady state before the token is set rather than a fault.
 */
function logMondayPush(
  customerId: string,
  reason: string,
  push: { error?: string; skipped?: string }
): void {
  const noteworthy: (string | undefined)[] = [
    "board_unreadable",
    "unlinked",
    "ambiguous",
    "not_status_board",
    "missing_customer",
  ];
  if (push.error || noteworthy.includes(push.skipped)) {
    console.error("[monday-status] push did not land", {
      customer: customerId,
      reason,
      skipped: push.skipped,
      error: push.error,
    });
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

/**
 * PostgREST filter selecting the customer row a Stripe event belongs to.
 *
 * Management bills against `stripe_customer_id` and always has. GR may bill
 * against EITHER that shared column or its own `gr_stripe_customer_id` (0056):
 * every GR subscription created through signup or the dashboard reuses the
 * shared Stripe customer, while a GR Payment Link mints its own. Matching both
 * is what lets those two coexist without either product stealing the other's
 * id.
 *
 * Interpolating into a filter string is safe here because Stripe customer ids
 * are `cus_` + alphanumerics — no commas, quotes or parens for PostgREST to
 * mis-parse — and the value comes from a signature-verified Stripe event, not
 * from user input.
 */
function customerMatchFilter(
  stripeCustomerId: string,
  isGuaranteedRent: boolean
): string {
  return isGuaranteedRent
    ? `gr_stripe_customer_id.eq.${stripeCustomerId},stripe_customer_id.eq.${stripeCustomerId}`
    : `stripe_customer_id.eq.${stripeCustomerId}`;
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

        // Read the current cancellation stamps before writing, so the first
        // cancellation date is preserved rather than overwritten by a later one.
        //
        // Matched through customerMatchFilter, like every other lookup here: a
        // GR customer's Stripe id can live in gr_stripe_customer_id rather than
        // stripe_customer_id, and a plain .eq on the management column would
        // find nothing for them — leaving the "first cancellation wins" guard
        // reading an empty row and overwriting the date on every event.
        // `id` is selected purely so the Monday status push at the end of this
        // branch has a customer to sync. This branch matches by
        // customerMatchFilter and never by id, so without it there would be no
        // handle on the row — and adding the column here costs no extra query.
        const { data: existing } = await admin
          .from("customers")
          .select(
            "id, cancelled_at, gr_cancelled_at, cancellation_feedback, " +
              "past_due_since, gr_past_due_since"
          )
          .or(customerMatchFilter(customerId, isGuaranteedRent))
          .maybeSingle<{
            id: string;
            cancelled_at: string | null;
            gr_cancelled_at: string | null;
            cancellation_feedback: string | null;
            past_due_since: string | null;
            gr_past_due_since: string | null;
          }>();

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

        // When a subscription ends, record WHEN.
        //
        // Without a date, the engagement history (0058) has nothing to line
        // itself up against: "their activity fell away and six weeks later they
        // left" is unanswerable if the leaving has no timestamp. This is the
        // only place either column is ever written, and it is the input every
        // future churn model needs.
        //
        // Set with coalesce semantics — first cancellation wins — so a customer
        // who cancels, resubscribes and cancels again keeps the original date
        // rather than having their history quietly rewritten. Cleared on
        // reactivation below, which is the one case where the old date is
        // genuinely wrong.
        const nowIso = new Date().toISOString();

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
          //
          // ONE EXCEPTION, ADDED IN 0088: a self-serve tier change made from the
          // dashboard. That route swaps the price with proration_behavior:'none'
          // precisely so the customer keeps the cycle they have already paid
          // for, and parks the new figure in gr_pending_monthly_allocation for
          // the invoice to apply. Stripe reports the swap immediately, so
          // without this guard the backstop would undo the deferral within
          // seconds and re-size them a month early. A GR plan switch made in the
          // Stripe portal or by an admin has no pending row and still re-sizes
          // at once, exactly as before.
          const grAllocation = grAllocationForPriceIds(subPriceIds);
          if (grAllocation) {
            const { data: grRow } = await admin
              .from("customers")
              .select("gr_stripe_price_id, gr_pending_monthly_allocation")
              .or(customerMatchFilter(customerId, true))
              .maybeSingle();
            const deferred =
              grRow?.gr_pending_monthly_allocation === grAllocation;
            if (grRow && grRow.gr_stripe_price_id !== subPriceIds[0] && !deferred) {
              update.gr_monthly_allocation = grAllocation;
            }
          }

          if (status === "canceled") {
            if (!existing?.gr_cancelled_at) update.gr_cancelled_at = nowIso;
          } else if (status === "active") {
            update.gr_cancelled_at = null;
          }

          // Past-due episode (0094). A GR failure never touches account_status
          // (invariant 6) — gr_subscription_status = 'past_due' already removes
          // them from GR routing and GR capacity, so what the lapse adds on this
          // side is the board label and the cancellation date.
          applyPastDueEpisode(
            update,
            status,
            existing?.gr_past_due_since,
            true,
            nowIso
          );

          // Pending cancellation (0087). Stored so the Monday label rule is a pure
          // function of the row rather than depending on this branch passing it
          // along — see the migration header. Cleared on the same condition the
          // management side clears cancellation_feedback: active AND no longer
          // scheduled to cancel, which is the only genuine change of mind.
          update.gr_cancel_at_period_end =
            status !== "canceled" && sub.cancel_at_period_end === true;
        } else {
          update.stripe_subscription_id = sub.id;
          update.subscription_status = status;
          // Recorded for symmetry with gr_stripe_price_id, and because which
          // price a management customer is actually billed on was otherwise
          // invisible to admin (0088). OBSERVABILITY ONLY: deliberately no
          // allocation re-size follows it. §17 declined to introduce silent
          // re-sizing on the management side, and a self-serve tier change
          // carries its own pending column rather than being inferred here.
          update.stripe_price_id = subPriceIds[0] ?? null;
          // A cancelled management subscription must release its capacity slot —
          // capacity is counted by account_status = 'active'. GR cancellations
          // must NOT touch account_status.
          if (status === "canceled") {
            update.account_status = "cancelled";
            if (!existing?.cancelled_at) update.cancelled_at = nowIso;
          } else if (status === "active" && !sub.cancel_at_period_end) {
            update.cancelled_at = null;
          }

          // Why they left (0077), captured WHENEVER Stripe gives it to us rather
          // than only on the canceled event.
          //
          // This account's portal is configured mode: "at_period_end", so a
          // cancellation is not a canceled subscription — it arrives as
          // customer.subscription.updated with status STILL "active",
          // cancel_at_period_end true, and cancellation_details already
          // populated. Reading it only under `status === "canceled"` would have
          // discarded the reason at the moment it was given and recovered it a
          // whole billing period later, on the deletion — and the branch above
          // would have actively nulled it in the meantime. That is the entire
          // window in which knowing why someone is leaving is worth anything.
          //
          // First reason wins, matching cancelled_at: a customer who leaves,
          // returns and leaves again keeps the original rather than having their
          // history quietly rewritten.
          const details = sub.cancellation_details;
          const feedback = details?.feedback ?? null;
          const comment = details?.comment ?? null;
          if (!existing?.cancellation_feedback && (feedback || comment)) {
            update.cancellation_feedback = feedback;
            update.cancellation_comment = comment;
          }
          // Cleared only on a genuine change of mind — active AND no longer
          // scheduled to cancel. Clearing on any active event would wipe the
          // reason on the customer's next renewal, which is the same trap the
          // status-only check above fell into.
          if (status === "active" && !sub.cancel_at_period_end) {
            update.cancellation_feedback = null;
            update.cancellation_comment = null;
          }

          // Pending cancellation (0087), stored beside the reason it is captured
          // with and cleared by the same rule.
          //
          // This is what lets the Monday board say `Cancelled` from the moment the
          // customer asks, rather than a billing period later. It is a COLUMN and
          // not a parameter because the label rule must not vary by which hook
          // happens to fire: before this, a GR renewal or a pause could recompute
          // the label without knowing a cancellation was pending and quietly write
          // `Management Customer` back over `Cancelled`.
          //
          // False once the cancellation has actually happened — status 'canceled'
          // is the stronger signal at that point and the flag would just be a
          // second thing to keep true.
          update.cancel_at_period_end =
            status !== "canceled" && sub.cancel_at_period_end === true;

          // Past-due episode (0094). Cleared by every non-past_due status,
          // including 'canceled' — a subscription that has actually ended is
          // described by cancelled_at and account_status, and leaving a stale
          // write-off stamp behind would make lapsed_at mean two things.
          applyPastDueEpisode(
            update,
            status,
            existing?.past_due_since,
            false,
            nowIso
          );

          if (anchor) update.billing_cycle_anchor = anchor;
        }

        await admin
          .from("customers")
          .update(update)
          .or(customerMatchFilter(customerId, isGuaranteedRent));

        // Resume detection (management only). If the management subscription is
        // NOT paused in Stripe but our record still marks it paused, the customer
        // has resumed collection out-of-band (e.g. they chose to continue paying
        // rather than wait out the pause). Clear the pause so lead routing
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
            .select("id, email, contact_name")
            .maybeSingle();

          // Close the pause episode (0077). Runs whatever the status is,
          // deliberately: this block also fires on a CANCELLATION (a cancelled
          // subscription reports no pause_collection), and a pause that ended
          // because the customer left is exactly the history we most want kept.
          // The episode row is what preserves it — the clear above erases
          // paused_at either way.
          //
          // Best-effort and reporting-only, like the cron's stamp.
          if (resumedRow?.id) {
            await stampEpisodeEnded(admin, resumedRow.id, "stripe");
          }

          // Only notify on a genuine resume — never when the subscription is
          // being cancelled/deleted (that path also has a null pause_collection).
          if (resumedRow?.email && status === "active") {
            await sendSubscriptionResumedEmail({
              to: resumedRow.email,
              contactName: resumedRow.contact_name ?? resumedRow.email,
            });
          }
        }

        // Push the resulting state to the Monday sales board.
        //
        // Placed AFTER the resume-detection block, not before: that block can
        // clear paused_at — including on a cancellation, §21's "third case" — so
        // a push from earlier in this branch would label somebody who has just
        // left as Paused.
        //
        // This one call covers every subscription transition: management cancelled
        // -> Cancelled; GR cancelled on a management holder -> still Management
        // Customer; GR-only cancelled -> Cancelled; re-subscribed -> back to
        // Management Customer; resumed early through the portal -> Management
        // Customer.
        if (existing?.id) {
          // The pending-cancellation flag is NOT passed here — it was written to
          // the customer row above (0087), and syncCustomerMondayStatus re-reads
          // the row, so the label rule sees it without any caller having to
          // remember. That is deliberate: while it was a parameter, every hook that
          // did not pass it recomputed a leaving customer as `Management Customer`
          // and wrote it back over `Cancelled`.
          const cancellationPending = sub.cancel_at_period_end === true;

          // The REAL end of service, not the date they asked. cancel_at is what
          // Stripe sets when a cancellation is scheduled; ended_at is set once it
          // has actually happened. Passing null CLEARS the cell, which is the
          // change-of-mind case — gated on exactly the condition the
          // cancellation-reason clearing above uses, so the two never disagree.
          //
          // Computed for BOTH products. The board automation that used to stamp
          // this fired on the `Cancelled` label whichever product caused it, so
          // deriving it for management only would have quietly dropped the end date
          // for a departing GR customer the moment that automation was deleted.
          let endDate: string | null | undefined;
          if (status === "canceled") {
            endDate =
              toDateString(sub.ended_at) ??
              toDateString(sub.canceled_at) ??
              new Date().toISOString().slice(0, 10);
          } else if (cancellationPending) {
            endDate =
              toDateString(sub.cancel_at) ??
              toDateString(subscriptionPeriodEnd(sub));
          } else if (status === "active") {
            // Active and no longer scheduled to cancel — they changed their mind.
            endDate = null;
          }

          try {
            const push = await syncCustomerMondayStatus(admin, existing.id, {
              endDate,
              reason: event.type,
            });
            logMondayPush(existing.id, event.type, push);
          } catch (err) {
            // Must never reach the outer catch: that deletes the stripe_events
            // claim and Stripe would redeliver an already-processed event.
            console.error("[monday-status] push threw", err);
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
            // A GR subscription may be billed against either the shared
            // stripe_customer_id or a GR-only gr_stripe_customer_id minted by a
            // Payment Link (0056). Match on either.
            let { data: customer } = await admin
              .from("customers")
              .select("id, gr_monthly_allocation, gr_pending_monthly_allocation")
              .or(customerMatchFilter(customerId, true))
              .maybeSingle();

            if (!customer) {
              // No linked portal account — a GR Payment Link purchase that
              // never went through signup or an admin invite. Provision one now
              // (create/link the customers row + a login) and then credit it,
              // mirroring the management branch below. Without this the payer
              // was charged and got nothing: the old code logged and bailed,
              // which is survivable while GR had no public purchase path and
              // becomes a silent "took the money, delivered no leads" the
              // moment a GR Payment Link exists.
              const sc = await stripe.customers.retrieve(customerId);
              const email = "deleted" in sc && sc.deleted ? null : sc.email;
              const name = "deleted" in sc && sc.deleted ? null : sc.name;
              if (email) {
                const result = await provisionPaidSubscriber(admin, {
                  stripeCustomerId: customerId,
                  email,
                  name: name ?? null,
                  subscriptionId,
                  // Size the plan from the price actually paid. Unlike the
                  // renewal path there is no customer row to read an allocation
                  // from yet — this call is what creates it — so the invoice is
                  // the only source of truth available.
                  allocation:
                    grAllocationForPriceIds(priceIds) ?? GR_PLANS.lead_10.leads,
                  billingAnchor: toDateString(invoice.period_start),
                  leadType: "guaranteed_rent",
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
                    .select("id, gr_monthly_allocation, gr_pending_monthly_allocation")
                    .eq("id", result.customerId)
                    .maybeSingle();
                  customer = linked ?? null;
                }
              }
            }

            if (!customer) {
              console.error(
                "invoice.paid (GR) for unknown stripe customer and could not provision — no credit granted",
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
            //
            // A self-serve tier change lands HERE, not when the customer asked
            // for it (0088). The dashboard route swaps the Stripe price with no
            // proration and parks the new figure in
            // gr_pending_monthly_allocation; this is the invoice that bills it,
            // so this is where the allocation moves — the same moment the leads
            // it sizes are granted. Applied only when the invoice's own price
            // agrees with the pending figure, so nothing can promote a change
            // early. See src/lib/planChanges.ts.
            const grInvoiceAllocation = grAllocationForPriceIds(priceIds);
            const grAllocationNow = await applyPendingPlanChange(
              admin,
              {
                customerId: customer.id,
                leadType: "guaranteed_rent",
                currentAllocation: customer.gr_monthly_allocation ?? 10,
                pendingAllocation: customer.gr_pending_monthly_allocation ?? null,
                invoiceAllocation: grInvoiceAllocation,
              },
              "invoice.paid"
            );

            const grCredits = grPlanForAllocation(grAllocationNow).leads;

            // The row is the source of truth, but if it disagrees with the
            // price actually being billed, somebody is being over- or
            // under-credited every month. Log it loudly rather than papering
            // over it — this is the one signal that a GR checkout was created
            // without its allocation being set first. A pending tier change is
            // not drift — it has just been applied above, so the two agree.
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
              // Close any past-due episode and undo any write-off (0094), as the
              // management branch does. No account_status counterpart here — that
              // column is management-only (invariant 6).
              gr_past_due_since: null,
              gr_lapsed_at: null,
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

            // Board push, after the status write above so the fresh re-read sees
            // gr_subscription_status = 'active'. A no-op on renewals: the cached
            // label already matches, so this costs one SELECT and no Monday call.
            await pushMondayStatus(admin, customer.id, "invoice.paid/gr");
            break;
          }

          // Management renewal. The credit granted each month is the customer's
          // plan allocation (10 or 20). Read the customer first so we can both
          // size the credit and detect a mismatched Stripe id.
          let { data: customer } = await admin
            .from("customers")
            .select("id, monthly_allocation, pending_monthly_allocation")
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
                  .select("id, monthly_allocation, pending_monthly_allocation")
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

          // A self-serve tier change lands HERE (0088), for the reason the GR
          // branch above sets out: the dashboard route swapped the price with no
          // proration, and this is the first invoice that actually bills it.
          // Applied only when the invoice's own price agrees with the pending
          // figure — so an allocation an admin has hand-edited is still never
          // silently re-sized from an invoice, which is the line §17 drew.
          const allocationNow = await applyPendingPlanChange(
            admin,
            {
              customerId: customer.id,
              leadType: "management",
              currentAllocation: customer.monthly_allocation ?? 20,
              pendingAllocation: customer.pending_monthly_allocation ?? null,
              invoiceAllocation: allocationFromPrices(priceIds, invoice.subtotal),
            },
            "invoice.paid"
          );

          const credits = planForAllocation(allocationNow).leads;

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
          // auto-assignment).
          //
          // 'cancelled' is included, and that is a deliberate reversal of the
          // earlier rule that excluded it. A returning customer pays, so
          // `subscription_status` goes back to 'active', but nothing here or in
          // the customer.subscription.* branch ever moved `account_status` off
          // 'cancelled' — and `provisionPaidSubscriber` short-circuits on a
          // known stripe_customer_id before its activation object is applied
          // (provisioning.ts:60-62). The row was therefore left billing normally
          // while BOTH candidate functions require account_status = 'active'
          // (0073), so it received no leads at all — and `credit_invoice` still
          // topped up lead_balance every month, banking credits that could never
          // be spent. It also silently dropped out of the nudge, the weekly
          // report, announcements, pause, top-ups, capacity and the admin active
          // count.
          //
          // Restricting to the three pre-active states still keeps this a no-op
          // on renewals (already 'active'). What makes resurrecting 'cancelled'
          // safe is the gate this sits behind: a PAID invoice. The row is only
          // promoted because money arrived.
          //
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
            .in("account_status", ["invited", "waitlisted", "cancelled"]);

          // Keep the subscription marked active and re-anchor the billing cycle
          // to the start of the period this invoice covers.
          const renewalUpdate: Record<string, unknown> = {
            subscription_status: "active",
            // Close any past-due episode and undo any write-off (0094). Money
            // arrived, so both facts are now false; the promotion above has
            // already taken account_status back out of 'cancelled'. Together
            // these are what make recovery from a lapse need no manual step.
            past_due_since: null,
            lapsed_at: null,
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

          // Board push, last so the fresh re-read sees both the account_status
          // promotion and subscription_status = 'active'. This is also the hook
          // that recovers a customer from "Wants to pay card declined" — a
          // successful payment clears past_due, so the label rule returns
          // Management Customer again with no special handling.
          await pushMondayStatus(admin, customer.id, "invoice.paid/management");
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = invoice.customer as string;

        // Detect the product from the invoice's line-item price ids, exactly as
        // invoice.paid does. Without this the handler was product-blind: every
        // failure was recorded as a management 'subscription' payment AND
        // marked the MANAGEMENT subscription past_due — so a failed GR invoice
        // silently degraded the customer's management subscription, breaking
        // the parallel-column invariant. Branch on the product and touch only
        // that product's columns.
        //
        // Resolved BEFORE the lookup because which column identifies the
        // customer depends on the product: a GR Payment Link subscriber is
        // keyed on gr_stripe_customer_id (0056), and looking them up by
        // stripe_customer_id alone would find nothing and drop the failure
        // silently.
        const priceIds = priceIdsFromInvoice(invoice);
        const isGuaranteedRent = isGuaranteedRentPriceId(priceIds);

        // past_due_since rides on the lookup this branch already performs — one
        // more column on a query that has to run anyway (0094).
        const { data: customer } = await admin
          .from("customers")
          .select("id, past_due_since, gr_past_due_since")
          .or(customerMatchFilter(customerId, isGuaranteedRent))
          .maybeSingle<{
            id: string;
            past_due_since: string | null;
            gr_past_due_since: string | null;
          }>();

        if (customer) {
          await admin.from("payments").insert({
            customer_id: customer.id,
            stripe_invoice_id: invoice.id,
            amount_pence: invoice.amount_due ?? 0,
            payment_type: isGuaranteedRent ? "gr_subscription" : "subscription",
            status: "failed",
            lead_type: isGuaranteedRent ? "guaranteed_rent" : "management",
          });

          // Stamp the start of this past-due episode, FIRST FAILURE ONLY (0094).
          // Stripe retries a declined card repeatedly over the following weeks and
          // every retry lands here; re-stamping would hold the lapse clock at zero
          // for ever, so a customer with a permanently dead card would never lapse
          // — which is precisely the state this was built to end.
          const failureUpdate: Record<string, unknown> = {
            updated_at: new Date().toISOString(),
          };
          if (isGuaranteedRent) {
            failureUpdate.gr_subscription_status = "past_due";
            if (!customer.gr_past_due_since) {
              failureUpdate.gr_past_due_since = new Date().toISOString();
            }
          } else {
            failureUpdate.subscription_status = "past_due";
            if (!customer.past_due_since) {
              failureUpdate.past_due_since = new Date().toISOString();
            }
          }

          await admin
            .from("customers")
            .update(failureUpdate)
            .eq("id", customer.id);

          // Board push -> "Wants to pay card declined". Reverted automatically on
          // recovery: invoice.paid sets the status back to 'active' and pushes
          // again. Note past_due is tested BEFORE the held-product rules in the
          // label rule, because holdsProduct() counts past_due as still held.
          await pushMondayStatus(admin, customer.id, "invoice.payment_failed");
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
