import { randomUUID } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { APP_URL } from "@/lib/env";
import type { LeadType } from "@/lib/types";

type Admin = ReturnType<typeof createAdminClient>;

export interface ProvisionResult {
  customerId: string;
  /** True only on the call that first created the auth user — the caller emails
   *  the set-password link exactly once off this flag. */
  createdUser: boolean;
  setPasswordUrl: string | null;
}

/**
 * Provision (or link + activate) a portal account for someone who paid via a
 * Stripe Payment Link, where no admin invite flow ever ran — so there's no
 * customers row linked by stripe_customer_id and (usually) no login.
 *
 * Called from the Stripe `invoice.paid` handler when a management invoice
 * arrives for an unknown Stripe customer. Idempotent and safe under webhook
 * retries: it links by Stripe id first, then by email, and creates the auth
 * user only once.
 *
 * It does NOT credit leads — crediting stays with the invoice-keyed
 * `credit_invoice` RPC in the webhook, which is idempotent on the invoice id.
 * It returns a working set-password link (through /auth/confirm) ONLY when it
 * freshly created the auth user, so the caller sends the email exactly once.
 */
export async function provisionPaidSubscriber(
  admin: Admin,
  params: {
    stripeCustomerId: string;
    email: string;
    name: string | null;
    subscriptionId: string | null;
    allocation: number;
    billingAnchor: string | null;
    /** Which product was paid for. Defaults to management. */
    leadType?: LeadType;
  }
): Promise<ProvisionResult | null> {
  const email = params.email.trim().toLowerCase();
  if (!email) return null;
  const name = params.name?.trim() || email;
  const isGuaranteedRent = params.leadType === "guaranteed_rent";

  // Already linked by Stripe id → the standard flow owns this account. A GR
  // payer may be keyed on either column (see 0056), so check both.
  const { data: byStripe } = await admin
    .from("customers")
    .select("id")
    .or(
      isGuaranteedRent
        ? `gr_stripe_customer_id.eq.${params.stripeCustomerId},stripe_customer_id.eq.${params.stripeCustomerId}`
        : `stripe_customer_id.eq.${params.stripeCustomerId}`
    )
    .maybeSingle();
  if (byStripe) {
    return { customerId: byStripe.id, createdUser: false, setPasswordUrl: null };
  }

  // The columns that mark this product as bought and paid for.
  //
  // The GR set deliberately writes NO management column — not
  // `account_status`, not `subscription_status`, not `monthly_allocation`
  // (CLAUDE.md invariant 6). A GR Payment Link buyer who never bought
  // management must not come out of this looking like an active management
  // subscriber; GR routing gates on gr_subscription_status and gr_lead_balance
  // alone, so the GR columns are all it needs to start receiving leads.
  //
  // GR writes `gr_stripe_customer_id`, never `stripe_customer_id`. A Payment
  // Link mints its own Stripe customer, and repointing the shared column would
  // detach this customer's management subscription from every future webhook
  // lookup — see 0056.
  const activation = isGuaranteedRent
    ? {
        gr_stripe_customer_id: params.stripeCustomerId,
        gr_stripe_subscription_id: params.subscriptionId,
        gr_subscription_status: "active",
        gr_monthly_allocation: params.allocation,
        ...(params.billingAnchor
          ? { gr_billing_cycle_anchor: params.billingAnchor }
          : {}),
        updated_at: new Date().toISOString(),
      }
    : {
        stripe_customer_id: params.stripeCustomerId,
        stripe_subscription_id: params.subscriptionId,
        subscription_status: "active",
        account_status: "active",
        monthly_allocation: params.allocation,
        ...(params.billingAnchor
          ? { billing_cycle_anchor: params.billingAnchor }
          : {}),
        updated_at: new Date().toISOString(),
      };

  // Reuse an existing row for this email (e.g. an enquiry-form lead), else
  // create one. Emails are matched lowercased.
  const { data: byEmail } = await admin
    .from("customers")
    .select("id, user_id")
    .eq("email", email)
    .maybeSingle();

  let customerId: string;
  let userId: string | null;

  if (byEmail) {
    customerId = byEmail.id;
    userId = (byEmail.user_id as string | null) ?? null;
    // Link (or RE-link) this row to the paying Stripe customer. We only reach
    // here when NO row is linked to params.stripeCustomerId (the byStripe lookup
    // above was empty), so for MANAGEMENT any existing non-null
    // stripe_customer_id on this row is a STALE id from an earlier signup whose
    // subscription now lives on a different (Payment-Link) Stripe customer.
    // Relinking — rather than the old "only claim while null" guard — is what
    // heals that duplicate: from here on credits, activation, and subscription
    // lifecycle events all match this row directly instead of silently missing
    // it. Same email = same person for this product, so there is no legitimate
    // row to protect from being clobbered.
    //
    // For GR the same reasoning applies to `gr_stripe_customer_id`, which this
    // is the only writer of. `stripe_customer_id` is untouched on the GR path,
    // so an active management subscription on a different Stripe customer keeps
    // matching — the failure 0056 exists to prevent.
    await admin
      .from("customers")
      .update(activation)
      .eq("id", customerId);
  } else {
    const { data: inserted, error: insErr } = await admin
      .from("customers")
      .insert({ email, business_name: name, contact_name: name, ...activation })
      .select("id, user_id")
      .maybeSingle();
    if (insErr || !inserted) {
      // Most likely a concurrent insert lost the unique-email race — re-read.
      const { data: again } = await admin
        .from("customers")
        .select("id, user_id")
        .eq("email", email)
        .maybeSingle();
      if (!again) {
        console.error("provision: insert failed and no row found", insErr);
        return null;
      }
      customerId = again.id;
      userId = (again.user_id as string | null) ?? null;
    } else {
      customerId = inserted.id;
      userId = (inserted.user_id as string | null) ?? null;
    }
  }

  // Ensure a login exists. createUser fails if the auth user already exists, so
  // a fresh success is our once-only signal to email the set-password link.
  let createdUser = false;
  if (!userId) {
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password: `${randomUUID()}${randomUUID()}`,
      email_confirm: true,
      app_metadata: { role: "customer" },
      user_metadata: { role: "customer", contact_name: name },
    });
    if (created?.user) {
      userId = created.user.id;
      createdUser = true;
    } else {
      // Auth user already exists (or transient error) — its id is recovered via
      // generateLink below so the row still gets linked. Don't email in this case.
      console.error("provision: createUser (may already exist)", createErr);
    }
  }

  // Recovery link: for a freshly-created user this is the set-password link we
  // email; for an ALREADY-EXISTING user it's how we recover the auth id. The
  // dashboard resolves the customer row by user_id, so an unlinked row shows
  // "couldn't find your customer record" even after the customer has set a
  // password — we must link it whether the auth user is new or pre-existing.
  // Skip the call only when the row is already linked and no email is due.
  let setPasswordUrl: string | null = null;
  if (createdUser || !userId) {
    try {
      const { data: link } = await admin.auth.admin.generateLink({
        type: "recovery",
        email,
        options: { redirectTo: `${APP_URL}/reset-password` },
      });
      if (!userId && link?.user?.id) userId = link.user.id;
      if (createdUser) {
        const hashedToken = link?.properties?.hashed_token;
        setPasswordUrl = hashedToken
          ? `${APP_URL}/auth/confirm?token_hash=${hashedToken}&type=recovery&next=/reset-password`
          : (link?.properties?.action_link ?? null);
      }
    } catch (err) {
      console.error("provision: generateLink failed", err);
    }
  }

  // Link the auth user to the customer row — the one fix that prevents the
  // "couldn't find your customer record" dead end. Only claim while unlinked so
  // a concurrent event can't repoint an already-linked row.
  if (userId) {
    await admin
      .from("customers")
      .update({ user_id: userId })
      .eq("id", customerId)
      .is("user_id", null);
  }

  return { customerId, createdUser, setPasswordUrl };
}
