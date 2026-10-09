import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isGuaranteedRentPriceId } from "@/lib/plans";
import { paymentIntentIdFromInvoice } from "@/lib/declineDetail";
import { sendDuplicateSubscriptionEmail } from "@/lib/emails";
import { duplicateVerdict, shouldCheckForDuplicate, type SubscriptionView } from "@/lib/checkout/rules";

/**
 * The webhook backstop for a second Management subscription (batch 02 Phase 4,
 * decision C3). The guarded checkout stops almost every way of paying twice;
 * this catches what gets past it: a raw Stripe Payment Link still in somebody's
 * inbox, or two checkouts in the same instant.
 *
 * When one person (the same Stripe customer, or another Stripe customer with
 * the same email) has two live Management subscriptions, the NEWER one is:
 *   1. recorded in duplicate_subscriptions (0165), FIRST;
 *   2. cancelled immediately;
 *   3. refunded its first invoice;
 *   4. reported to Zac by email, through Resend, with both ids.
 *
 * ⚠️ THE RECORD COMES FIRST AND IS WHAT MAKES THE REST SAFE. Cancelling the
 * duplicate fires customer.subscription.deleted, and on a shared Stripe
 * customer that event would otherwise mark the REAL customer cancelled
 * (webhook, management branch). Every event for a recorded subscription is
 * skipped, and so is every invoice. If the record cannot be written, nothing
 * is cancelled.
 *
 * Two call sites in the Stripe webhook, each one additive line before
 * anything else in its branch:
 *   - the top of customer.subscription.* (skip a recorded duplicate; check a
 *     new subscription);
 *   - the top of the invoice.paid Management branch, before any credit (a
 *     duplicate's first invoice can arrive before its subscription event).
 *
 * ⚠️ NEVER THROWS. The webhook deletes its stripe_events claim on a throw, so
 * Stripe would redeliver an event that may already have credited somebody
 * (§23.6). Every step is caught; a failure is logged, written to the row's
 * `error`, and named in the email so it can be finished by hand. When the
 * check itself cannot run, the event is processed exactly as before.
 */

type Admin = SupabaseClient;

interface DuplicateRow {
  subscription_id: string;
  stripe_customer_id: string;
  kept_subscription_id: string;
  detected_from: "subscription_created" | "invoice_paid";
  invoice_id: string | null;
  cancelled_at: string | null;
  refund_id: string | null;
  emailed_at: string | null;
  error: string | null;
}

const ROW_COLUMNS =
  "subscription_id, stripe_customer_id, kept_subscription_id, detected_from, invoice_id, cancelled_at, refund_id, emailed_at, error";

function idOf(ref: string | { id?: string } | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : (ref.id ?? null);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readRecorded(admin: Admin, subscriptionId: string): Promise<DuplicateRow | null | "error"> {
  const { data, error } = await admin
    .from("duplicate_subscriptions")
    .select(ROW_COLUMNS)
    .eq("subscription_id", subscriptionId)
    .maybeSingle();
  if (error) {
    console.error("[duplicate-subscription] lookup failed, processing the event as normal", error.message);
    return "error";
  }
  return (data as DuplicateRow | null) ?? null;
}

function subscriptionView(s: Stripe.Subscription): SubscriptionView {
  const priceIds = (s.items?.data ?? []).map((i) => i.price?.id).filter((id): id is string => Boolean(id));
  return {
    id: s.id,
    created: s.created,
    status: s.status,
    cancelAtPeriodEnd: Boolean(s.cancel_at_period_end),
    isManagement: !isGuaranteedRentPriceId(priceIds),
  };
}

/**
 * The older live Management subscription this one duplicates, or null.
 *
 * "The same person" is the same Stripe customer, or another Stripe customer
 * with the same email, found two ways because Stripe's email filter is
 * case-sensitive: our own customers table (lower-cased) and Stripe itself.
 */
async function findKeptSubscription(
  admin: Admin,
  stripe: Stripe,
  sub: Stripe.Subscription
): Promise<{ keptId: string; stripeCustomerId: string; email: string | null } | null> {
  const stripeCustomerId = idOf(sub.customer as string | { id?: string });
  if (!stripeCustomerId) return null;

  const candidates = new Set<string>([stripeCustomerId]);
  let email: string | null = null;
  const sc = await stripe.customers.retrieve(stripeCustomerId);
  if (!("deleted" in sc && sc.deleted)) email = sc.email ?? null;
  if (email) {
    const lower = email.trim().toLowerCase();
    const { data } = await admin.from("customers").select("stripe_customer_id").eq("email", lower).limit(5);
    for (const row of (data ?? []) as { stripe_customer_id: string | null }[]) {
      if (row.stripe_customer_id) candidates.add(row.stripe_customer_id);
    }
    for (const variant of Array.from(new Set([email, lower]))) {
      const list = await stripe.customers.list({ email: variant, limit: 10 });
      for (const c of list.data) candidates.add(c.id);
    }
  }

  const others: SubscriptionView[] = [];
  for (const customer of Array.from(candidates).slice(0, 10)) {
    const subs = await stripe.subscriptions.list({ customer, status: "all", limit: 20 });
    for (const s of subs.data) if (s.id !== sub.id) others.push(subscriptionView(s));
  }
  if (others.length === 0) return null;

  const { data: recordedRows } = await admin
    .from("duplicate_subscriptions")
    .select("subscription_id")
    .in(
      "subscription_id",
      others.map((o) => o.id)
    );
  const recorded = new Set(((recordedRows ?? []) as { subscription_id: string }[]).map((r) => r.subscription_id));

  const verdict = duplicateVerdict({ id: sub.id, created: sub.created }, others, recorded);
  return verdict.duplicate ? { keptId: verdict.keptId, stripeCustomerId, email } : null;
}

/** The invoice to refund, with its payment visible on either API version. */
async function retrieveInvoice(stripe: Stripe, invoiceId: string): Promise<Stripe.Invoice> {
  try {
    return await stripe.invoices.retrieve(invoiceId, { expand: ["payments"] });
  } catch {
    // An older API version has no `payments` to expand; payment_intent is on the invoice.
    return await stripe.invoices.retrieve(invoiceId);
  }
}

/**
 * Record, cancel, refund, email: each step done once, and each re-tried by a
 * later event if it did not finish. Idempotency keys make a repeated Stripe
 * call return the first result rather than act twice.
 */
async function settleDuplicate(
  admin: Admin,
  stripe: Stripe,
  args: {
    subscriptionId: string;
    stripeCustomerId: string;
    keptSubscriptionId: string;
    detectedFrom: DuplicateRow["detected_from"];
    invoiceId: string | null;
    email: string | null;
  }
): Promise<void> {
  // 1. The record. The primary key is the claim: two deliveries cannot both
  // create it, and whichever loses reads the winner's row.
  let row: DuplicateRow;
  const inserted = await admin
    .from("duplicate_subscriptions")
    .insert({
      subscription_id: args.subscriptionId,
      stripe_customer_id: args.stripeCustomerId,
      kept_subscription_id: args.keptSubscriptionId,
      detected_from: args.detectedFrom,
      invoice_id: args.invoiceId,
    })
    .select(ROW_COLUMNS)
    .maybeSingle();
  if (inserted.error && inserted.error.code !== "23505") {
    // ⚠️ Without the record, cancelling would let the deleted event reach the
    // real customer. Leave the duplicate alone; the next event tries again.
    console.error("[duplicate-subscription] could not record, NOT cancelling", args.subscriptionId, inserted.error.message);
    return;
  }
  if (inserted.data) {
    row = inserted.data as DuplicateRow;
  } else {
    const existing = await readRecorded(admin, args.subscriptionId);
    if (!existing || existing === "error") return;
    row = existing;
  }

  const errors: string[] = [];
  const patch: Partial<DuplicateRow> = {};
  const invoiceId = args.invoiceId ?? row.invoice_id;
  if (invoiceId && !row.invoice_id) patch.invoice_id = invoiceId;

  // 2. Cancel, now. Not at period end: they must not be billed twice.
  let cancelledNote = row.cancelled_at ? "Cancelled" : "Not cancelled";
  if (!row.cancelled_at) {
    try {
      await stripe.subscriptions.cancel(
        args.subscriptionId,
        { cancellation_details: { comment: "Second Management subscription for one person (guarded checkout backstop)" } },
        { idempotencyKey: `dup-cancel:${args.subscriptionId}` }
      );
      patch.cancelled_at = new Date().toISOString();
      cancelledNote = "Cancelled";
    } catch (err) {
      // Already cancelled (by hand, or a parallel delivery) counts as done.
      try {
        const current = await stripe.subscriptions.retrieve(args.subscriptionId);
        if (current.status === "canceled") {
          patch.cancelled_at = new Date().toISOString();
          cancelledNote = "Cancelled";
        } else {
          errors.push(`cancel failed: ${message(err)}`);
        }
      } catch {
        errors.push(`cancel failed: ${message(err)}`);
      }
    }
  }

  // 3. Refund its first invoice, once it has been paid.
  let refundNote = row.refund_id ? `Refunded (${row.refund_id})` : "Not refunded";
  if (!row.refund_id) {
    try {
      const sub = invoiceId ? null : await stripe.subscriptions.retrieve(args.subscriptionId);
      const firstInvoiceId = invoiceId ?? idOf(sub?.latest_invoice as string | { id?: string } | null);
      if (!firstInvoiceId) {
        refundNote = "No invoice yet, so nothing was charged";
      } else {
        if (!row.invoice_id && !patch.invoice_id) patch.invoice_id = firstInvoiceId;
        const invoice = await retrieveInvoice(stripe, firstInvoiceId);
        if (invoice.status !== "paid") {
          refundNote = "Pending: its first invoice is not paid yet, and is refunded if it is";
        } else if ((invoice.amount_paid ?? 0) <= 0) {
          refundNote = "Nothing to refund: the first invoice was £0";
        } else {
          const pi = paymentIntentIdFromInvoice(invoice);
          const charge = idOf((invoice as unknown as { charge?: string | { id?: string } | null }).charge);
          if (!pi && !charge) {
            errors.push(`refund failed: no payment found on invoice ${invoice.id}`);
          } else {
            const refund = await stripe.refunds.create(
              {
                ...(pi ? { payment_intent: pi } : { charge: charge as string }),
                metadata: { reason: "duplicate_management_subscription", subscription_id: args.subscriptionId },
              },
              { idempotencyKey: `dup-refund:${invoice.id}` }
            );
            patch.refund_id = refund.id;
            refundNote = `Refunded (${refund.id})`;
          }
        }
      }
    } catch (err) {
      errors.push(`refund failed: ${message(err)}`);
    }
  }

  if (errors.length > 0) {
    const joined = [row.error, ...errors].filter(Boolean).join("; ");
    patch.error = joined.slice(0, 500);
  }
  if (Object.keys(patch).length > 0) {
    const { error } = await admin.from("duplicate_subscriptions").update(patch).eq("subscription_id", args.subscriptionId);
    if (error) console.error("[duplicate-subscription] could not update the record", error.message);
  }

  // 4. Tell Zac, once: claim the email by write, then send.
  if (!row.emailed_at) {
    const claim = await admin
      .from("duplicate_subscriptions")
      .update({ emailed_at: new Date().toISOString() })
      .eq("subscription_id", args.subscriptionId)
      .is("emailed_at", null)
      .select("subscription_id");
    if (!claim.error && (claim.data ?? []).length === 1) {
      const sent = await sendDuplicateSubscriptionEmail({
        duplicateSubscriptionId: args.subscriptionId,
        keptSubscriptionId: row.kept_subscription_id,
        stripeCustomerId: row.stripe_customer_id,
        email: args.email,
        detectedFrom: row.detected_from === "invoice_paid" ? "its first payment" : "its subscription being created",
        cancelled: cancelledNote,
        refund: refundNote,
        error: errors.length > 0 ? errors.join("; ") : null,
      });
      if (sent.error) {
        console.error("[duplicate-subscription] email failed, releasing the claim", sent.error);
        await admin.from("duplicate_subscriptions").update({ emailed_at: null }).eq("subscription_id", args.subscriptionId);
      }
    }
  }

  if (errors.length > 0) console.error("[duplicate-subscription] unfinished", args.subscriptionId, errors);
}

/**
 * The customer.subscription.* touch point. True means "a duplicate: skip the
 * rest of this event". Guaranteed Rent is never checked (a customer may hold
 * both products).
 */
export async function skipDuplicateSubscriptionEvent(
  admin: Admin,
  stripe: Stripe,
  args: { eventType: string; subscription: Stripe.Subscription; isGuaranteedRent: boolean; nowSeconds?: number }
): Promise<boolean> {
  try {
    if (args.isGuaranteedRent) return false;
    const sub = args.subscription;
    const recorded = await readRecorded(admin, sub.id);
    if (recorded === "error") return false;
    if (recorded) {
      // Finish anything left undone; a deleted event is the cancellation landing.
      if (args.eventType !== "customer.subscription.deleted") {
        await settleDuplicate(admin, stripe, {
          subscriptionId: sub.id,
          stripeCustomerId: recorded.stripe_customer_id,
          keptSubscriptionId: recorded.kept_subscription_id,
          detectedFrom: recorded.detected_from,
          invoiceId: recorded.invoice_id,
          email: null,
        });
      }
      return true;
    }
    const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (!shouldCheckForDuplicate(args.eventType, sub.created, now)) return false;
    const found = await findKeptSubscription(admin, stripe, sub);
    if (!found) return false;
    await settleDuplicate(admin, stripe, {
      subscriptionId: sub.id,
      stripeCustomerId: found.stripeCustomerId,
      keptSubscriptionId: found.keptId,
      detectedFrom: "subscription_created",
      invoiceId: idOf(sub.latest_invoice as string | { id?: string } | null),
      email: found.email,
    });
    return true;
  } catch (err) {
    console.error("[duplicate-subscription] subscription check failed, processing the event as normal", message(err));
    return false;
  }
}

/**
 * The invoice.paid Management touch point, before any credit. True means "a
 * duplicate's invoice: credit nothing". Only a subscription's FIRST invoice
 * is checked for being a new duplicate, so a renewal costs no Stripe call.
 */
export async function skipDuplicateInvoice(
  admin: Admin,
  stripe: Stripe,
  args: { invoice: Stripe.Invoice; subscriptionId: string }
): Promise<boolean> {
  try {
    const recorded = await readRecorded(admin, args.subscriptionId);
    if (recorded === "error") return false;
    if (recorded) {
      await settleDuplicate(admin, stripe, {
        subscriptionId: args.subscriptionId,
        stripeCustomerId: recorded.stripe_customer_id,
        keptSubscriptionId: recorded.kept_subscription_id,
        detectedFrom: recorded.detected_from,
        invoiceId: recorded.invoice_id ?? args.invoice.id ?? null,
        email: null,
      });
      return true;
    }
    if (args.invoice.billing_reason !== "subscription_create") return false;
    const sub = await stripe.subscriptions.retrieve(args.subscriptionId);
    const found = await findKeptSubscription(admin, stripe, sub);
    if (!found) return false;
    await settleDuplicate(admin, stripe, {
      subscriptionId: args.subscriptionId,
      stripeCustomerId: found.stripeCustomerId,
      keptSubscriptionId: found.keptId,
      detectedFrom: "invoice_paid",
      invoiceId: args.invoice.id ?? null,
      email: found.email,
    });
    return true;
  } catch (err) {
    console.error("[duplicate-subscription] invoice check failed, processing the invoice as normal", message(err));
    return false;
  }
}
