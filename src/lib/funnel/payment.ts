import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { APP_URL } from "@/lib/env";
import { enquiryBoardId } from "@/lib/monday";
import { sendFunnelWelcomeEmail } from "@/lib/emails";

/**
 * A funnel payer's account (batch 02 Phase 5): the ONE additive call in the
 * Stripe webhook's Management `invoice.paid` branch, approved by Zac on 9 Oct.
 *
 * ⚠️ IT RUNS BEFORE THE CUSTOMER READ, NOT AFTER pushMondayStatus as Phase 0
 * first proposed. At that later point the existing provisioning
 * (provisionPaidSubscriber) has already created the login and emailed a
 * set-password link, so a funnel payer would get two emails and the password
 * step C2 drops. Running first, this makes the login, so the provisioning that
 * follows finds `user_id` set and sends nothing. Everything about money stays
 * where it was: linking the Stripe customer, crediting the invoice and
 * promoting the row to active are still the webhook's own code, untouched.
 *
 * What it does, once per funnel session:
 *   1. the customer row for the session's email: found, or created waitlisted;
 *   2. the login, with no usable password (C2), linked to the row;
 *   3. `lead_brief_required = true`, so their first sign-in is the brief
 *      confirmation; `signup_source = 'funnel'` when this call made the login,
 *      which is what the "set a password" prompt keys on;
 *   4. the Monday item n8n gave the session, when the row has none, so the
 *      webhook's own pushMondayStatus labels it "Management Customer";
 *   5. the session marked `paid`, claimed by a conditional write;
 *   6. a sign-in (magic) link through Resend, sent only by the claim's winner.
 *
 * Only for the subscription's FIRST invoice, and only when the subscription
 * says it came from the funnel (startManagementCheckout tags it). Every other
 * invoice costs nothing here.
 *
 * NEVER THROWS. The webhook deletes its idempotency claim on a throw so Stripe
 * retries, and an exception here would redeliver an invoice that may already
 * have been credited (§23.6). A failure is logged and the invoice is processed
 * exactly as it would have been without this call.
 */

type Admin = SupabaseClient;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Where the sign-in link lands: the brief, which the gate also sends them to. */
export const FUNNEL_SIGN_IN_NEXT = "/onboarding/brief";

export type FunnelPaymentOutcome =
  | "not_first_invoice"
  | "not_funnel"
  | "session_missing"
  | "already_paid"
  | "provisioned"
  | "provisioned_email_failed"
  | "error";

type Metadata = Record<string, string> | null | undefined;

/** The funnel session a subscription's tags name, or null. */
export function funnelSessionIdFrom(metadata: Metadata): string | null {
  if (!metadata || metadata.source !== "funnel") return null;
  const id = metadata.funnel_session_id;
  return typeof id === "string" && UUID.test(id) ? id : null;
}

/**
 * The subscription metadata the invoice carries, under either API shape
 * (basil moved it under `parent`). Null when the invoice carries none, and the
 * caller then asks Stripe for the subscription itself.
 */
export function invoiceSubscriptionMetadata(invoice: Stripe.Invoice): Metadata {
  const inv = invoice as unknown as {
    parent?: { subscription_details?: { metadata?: Metadata } | null } | null;
    subscription_details?: { metadata?: Metadata } | null;
  };
  return inv.parent?.subscription_details?.metadata ?? inv.subscription_details?.metadata ?? null;
}

/** The magic link, verified by /auth/confirm (token hash, so it works on any device, §15). */
export function funnelSignInUrl(hashedToken: string): string {
  const params = new URLSearchParams({ token_hash: hashedToken, type: "magiclink", next: FUNNEL_SIGN_IN_NEXT });
  return `${APP_URL}/auth/confirm?${params.toString()}`;
}

const SESSION_COLUMNS = "id, name, email, phone, monday_item_id, plan_selected, step, customer_id";
const CUSTOMER_COLUMNS = "id, user_id, monday_item_id";

interface SessionRow {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  monday_item_id: string | null;
  plan_selected: number | null;
  step: string;
  customer_id: string | null;
}

interface CustomerRow {
  id: string;
  user_id: string | null;
  monday_item_id: string | null;
}

async function sessionIdFor(
  stripe: Stripe,
  invoice: Stripe.Invoice,
  subscriptionId: string | null
): Promise<string | null> {
  // The invoice snapshots the subscription's tags when it is finalised, and a
  // checkout sets them at creation, so an empty set means "not ours" with no
  // Stripe call. Only an invoice carrying no snapshot at all asks Stripe.
  const carried = invoiceSubscriptionMetadata(invoice);
  if (carried) return funnelSessionIdFrom(carried);
  if (!subscriptionId) return null;
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  return funnelSessionIdFrom(sub.metadata as Metadata);
}

/** The row for this email, or a new waitlisted one. Activation stays the webhook's. */
async function customerFor(admin: Admin, session: SessionRow): Promise<CustomerRow | null> {
  const found = await admin.from("customers").select(CUSTOMER_COLUMNS).eq("email", session.email).maybeSingle();
  if (found.error) {
    console.error("[funnel-payment] customer lookup failed", found.error.message);
    return null;
  }
  if (found.data) return found.data as CustomerRow;

  const item = session.monday_item_id;
  const inserted = await admin
    .from("customers")
    .insert({
      email: session.email,
      business_name: session.name,
      contact_name: session.name,
      phone: session.phone,
      account_status: "waitlisted",
      signup_source: "funnel",
      lead_brief_required: true,
      ...(session.plan_selected === 10 || session.plan_selected === 20
        ? { monthly_allocation: session.plan_selected }
        : {}),
      // The enquiry item n8n opened the session from (C5's board, 18420649520).
      ...(item
        ? {
            monday_item_id: item,
            monday_board_id: enquiryBoardId(),
            monday_link_state: "linked",
            monday_link_matched_by: "created",
          }
        : {}),
    })
    .select(CUSTOMER_COLUMNS)
    .maybeSingle();
  if (inserted.data) return inserted.data as CustomerRow;

  // Lost a race on the unique email: read the winner's row.
  const again = await admin.from("customers").select(CUSTOMER_COLUMNS).eq("email", session.email).maybeSingle();
  if (again.data) return again.data as CustomerRow;
  console.error("[funnel-payment] could not create the customer row", inserted.error?.message);
  return null;
}

type GeneratedLink = { userId: string | null; hashedToken: string | null };

async function magicLink(admin: Admin, email: string): Promise<GeneratedLink> {
  // generateLink mints the token and SENDS NOTHING (invariant 10, §15).
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error) console.error("[funnel-payment] generateLink failed", error.message);
  return {
    userId: data?.user?.id ?? null,
    hashedToken: data?.properties?.hashed_token ?? null,
  };
}

export async function completeFunnelPayment(
  admin: Admin,
  stripe: Stripe,
  args: { invoice: Stripe.Invoice; subscriptionId: string | null }
): Promise<FunnelPaymentOutcome> {
  try {
    if (args.invoice.billing_reason !== "subscription_create") return "not_first_invoice";

    const sessionId = await sessionIdFor(stripe, args.invoice, args.subscriptionId);
    if (!sessionId) return "not_funnel";

    const sessionRead = await admin.from("funnel_sessions").select(SESSION_COLUMNS).eq("id", sessionId).maybeSingle();
    if (sessionRead.error || !sessionRead.data) {
      console.error("[funnel-payment] session not found", sessionId, sessionRead.error?.message);
      return "session_missing";
    }
    const session = sessionRead.data as SessionRow;
    if (session.step === "paid") return "already_paid";

    // 1. The customer row.
    const row = await customerFor(admin, session);
    if (!row) return "error";

    // 2. The login. No usable password: C2's "no password step". A random
    // one keeps the row in the same shape provisioning leaves it in.
    let userId = row.user_id;
    let createdUser = false;
    let link: GeneratedLink | null = null;
    if (!userId) {
      const created = await admin.auth.admin.createUser({
        email: session.email,
        password: `${randomUUID()}${randomUUID()}`,
        email_confirm: true,
        app_metadata: { role: "customer" },
        user_metadata: { role: "customer", contact_name: session.name },
      });
      if (created.data?.user) {
        userId = created.data.user.id;
        createdUser = true;
      } else {
        // Already exists: generateLink names the existing user.
        link = await magicLink(admin, session.email);
        userId = link.userId;
      }
    }
    if (userId) {
      await admin.from("customers").update({ user_id: userId }).eq("id", row.id).is("user_id", null);
    }

    // 3 and 4. The flags, and the Monday item when the row has none.
    const flags: Record<string, unknown> = { lead_brief_required: true };
    if (createdUser) flags.signup_source = "funnel";
    if (!row.monday_item_id && session.monday_item_id) {
      flags.monday_item_id = session.monday_item_id;
      flags.monday_board_id = enquiryBoardId();
      flags.monday_link_state = "linked";
      flags.monday_link_matched_by = "created";
    }
    const flagged = await admin.from("customers").update(flags).eq("id", row.id);
    if (flagged.error) console.error("[funnel-payment] could not flag the customer", flagged.error.message);

    // 5. Paid, claimed by write: whoever moves it sends the email.
    const claim = await admin
      .from("funnel_sessions")
      .update({ step: "paid", paid_at: new Date().toISOString(), customer_id: row.id })
      .eq("id", session.id)
      .neq("step", "paid")
      .select("id");
    if (claim.error) {
      console.error("[funnel-payment] could not mark the session paid", claim.error.message);
      return "error";
    }
    if ((claim.data ?? []).length !== 1) return "already_paid";

    // 6. The sign-in link.
    link ??= await magicLink(admin, session.email);
    if (!link.hashedToken) return "provisioned_email_failed";
    const sent = await sendFunnelWelcomeEmail({
      to: session.email,
      contactName: session.name,
      signInUrl: funnelSignInUrl(link.hashedToken),
    });
    if (sent.error) {
      // Not released: invoice.paid is not redelivered once it succeeds, so a
      // released claim would never be retried. "Forgot your password?" on the
      // login page is the way in, and the payment-received notice says so.
      console.error("[funnel-payment] sign-in email failed", session.id, sent.error);
      return "provisioned_email_failed";
    }
    return "provisioned";
  } catch (err) {
    console.error("[funnel-payment] failed, the invoice is processed as normal", err instanceof Error ? err.message : err);
    return "error";
  }
}
