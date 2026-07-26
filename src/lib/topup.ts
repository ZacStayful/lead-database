/**
 * One-off lead top-up — shared constants, token helpers and the offer trigger.
 *
 * When a subscriber's balance for a product hits zero they can buy 5 more leads
 * for £75 flat (£15/lead, identical for Management and GR — the GR premium over
 * its £10/lead subscription rate is deliberate). The charge goes straight to the
 * card on file with no Checkout redirect; the customer only opens a single-use,
 * time-limited link to confirm.
 *
 * Parallel-column invariant: every function here takes an explicit `leadType`
 * and reads/writes only that product's column (lead_balance vs gr_lead_balance).
 * Nothing in one product's path may touch the other's.
 */
import { createHash, randomBytes } from "crypto";
import { APP_URL } from "@/lib/env";
import { sendCreditsExhaustedEmail } from "@/lib/emails";
import { sendSms } from "@/lib/sms";
import type { createAdminClient } from "@/lib/supabase/admin";
import type { Customer, LeadType } from "@/lib/types";

/** Fixed top-up size and price (both products). */
export const TOPUP_CREDITS = 5;
export const TOPUP_AMOUNT_PENCE = 7500; // £75 flat = £15/lead
/** Link lifetime — the confirmation link is valid for 48h from issue. */
export const TOPUP_TTL_MS = 48 * 60 * 60 * 1000;

/** Human product label for copy. */
export function productLabel(leadType: LeadType): string {
  return leadType === "guaranteed_rent" ? "Guaranteed Rent" : "Management";
}

/** SHA-256 hex of the opaque URL token — only the hash is ever stored. */
export function hashTopupToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Mint a high-entropy opaque token and its stored hash. */
export function generateTopupToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashTopupToken(raw) };
}

/** Public confirmation URL for a raw token. */
export function topupUrl(raw: string): string {
  return `${APP_URL}/topup/${raw}`;
}

/**
 * Whether a lead filter is in force for a product.
 *
 * 'pending_lift' still filters — the lift only executes at the next renewal
 * (see execute_filter_lift) — so it counts as in force for the purposes of
 * setting delivery expectations. Reads only the given product's column.
 */
export function leadFilterInForce(
  customer: Pick<Customer, "filter_status" | "gr_filter_status">,
  leadType: LeadType
): boolean {
  const status =
    leadType === "guaranteed_rent"
      ? customer.gr_filter_status
      : customer.filter_status;
  return status === "active" || status === "pending_lift";
}

/**
 * What a customer is told after buying a top-up.
 *
 * The point being made: a top-up increases the number of leads we OWE them, not
 * the speed at which leads arrive. Balance is a claim on future matching
 * enquiries, and the delivery rate depends on what comes in — so no timeframe
 * can be promised. A customer with a filter active is told this more firmly,
 * because restricting to their criteria genuinely reduces how many enquiries
 * can be matched to them, which is exactly when a paid top-up is most likely to
 * feel slow.
 *
 * Single source of truth for this wording — the in-portal panel, the emailed
 * link's confirmation page and the receipt email all render this, so the promise
 * we make can never drift between surfaces.
 */
export function topupDeliveryNote(filterInForce: boolean): string {
  const base =
    "This adds to the leads we owe you. Your balance never expires and carries forward until every lead has been delivered — but leads are assigned as matching enquiries come in, so we can't guarantee a timeframe.";
  if (!filterInForce) return base;
  return `${base} You currently have a lead filter applied, so only enquiries matching your criteria can be assigned to you. That usually means fewer matches and a longer wait — widening or lifting your filter is the quickest way to receive them sooner.`;
}

/** View state of a top-up token for the read-only confirmation page. */
export type TopupTokenView =
  | { status: "invalid" }
  | { status: "expired" }
  | { status: "used" }
  | { status: "paid" }
  | {
      status: "valid";
      leadType: LeadType;
      credits: number;
      amountPence: number;
      /** Whether a filter is in force for this product (drives the delivery note). */
      filterInForce: boolean;
    };

/**
 * Resolve a raw token to its display state WITHOUT consuming it (the page is a
 * pure read; the token is only claimed on POST-confirm). `paid` is separated
 * from `used` so a already-topped-up link shows a positive message.
 */
export async function describeTopupToken(
  supabase: ReturnType<typeof createAdminClient>,
  rawToken: string
): Promise<TopupTokenView> {
  const { data } = await supabase
    .from("lead_topup_tokens")
    .select(
      "customer_id, lead_type, credits, amount_pence, expires_at, used_at, charge_status"
    )
    .eq("token_hash", hashTopupToken(rawToken))
    .maybeSingle();

  if (!data) return { status: "invalid" };
  if (data.charge_status === "paid") return { status: "paid" };
  if (data.used_at) return { status: "used" };
  if (new Date(data.expires_at).getTime() <= Date.now()) {
    return { status: "expired" };
  }

  const leadType = data.lead_type as LeadType;

  // Filter state drives the delivery expectation shown on the page. A failed
  // read must not block the purchase — default to the unfiltered wording.
  const { data: customer } = await supabase
    .from("customers")
    .select("filter_status, gr_filter_status")
    .eq("id", data.customer_id)
    .maybeSingle();

  return {
    status: "valid",
    leadType,
    credits: data.credits as number,
    amountPence: data.amount_pence as number,
    filterInForce: customer
      ? leadFilterInForce(
          customer as Pick<Customer, "filter_status" | "gr_filter_status">,
          leadType
        )
      : false,
  };
}

/** The customer's current balance for a product (post-decrement at call time). */
function balanceFor(customer: Customer, leadType: LeadType): number {
  return leadType === "guaranteed_rent"
    ? customer.gr_lead_balance
    : customer.lead_balance;
}

/** credit_warnings opt-out is an explicit `false`; anything else means opted in. */
function wantsCreditEmail(customer: Customer): boolean {
  return customer.notification_preferences?.credit_warnings !== false;
}

/** The instant-SMS opt-out (sms_alerts_enabled) also gates the top-up SMS. */
function wantsSms(customer: Customer): boolean {
  return customer.sms_alerts_enabled !== false;
}

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Issue an active top-up token for a customer+product, or reuse an expired one
 * in place — returning the raw token when a NEW link should be sent, or null
 * when a live link already exists (so we must not resend) or on error.
 *
 * The partial unique index uq_lead_topup_tokens_active guarantees at most one
 * unused token per (customer, product). A 23505 on insert therefore means an
 * unused token already exists:
 *   - still live  → return null (don't resend; the existing link is valid);
 *   - expired     → overwrite it in place with a fresh token+expiry and send.
 * This mirrors the post_call_offers reuse-in-place behaviour (0037).
 */
async function issueOrReuseToken(
  supabase: Admin,
  customerId: string,
  leadType: LeadType
): Promise<{ raw: string } | null> {
  const { raw, hash } = generateTopupToken();
  const expiresAt = new Date(Date.now() + TOPUP_TTL_MS).toISOString();

  const { error } = await supabase.from("lead_topup_tokens").insert({
    customer_id: customerId,
    lead_type: leadType,
    token_hash: hash,
    credits: TOPUP_CREDITS,
    amount_pence: TOPUP_AMOUNT_PENCE,
    expires_at: expiresAt,
  });

  if (!error) return { raw };

  if (error.code !== "23505") {
    console.error("lead_topup_tokens insert failed", { customerId, leadType, error });
    return null;
  }

  // An unused token already occupies the active slot for this customer+product.
  const { data: existing } = await supabase
    .from("lead_topup_tokens")
    .select("id, expires_at")
    .eq("customer_id", customerId)
    .eq("lead_type", leadType)
    .is("used_at", null)
    .maybeSingle();

  // Raced away (claimed/used between the insert and this read): skip this round;
  // a subsequent zero-balance event will re-offer.
  if (!existing) return null;

  // Still live → a valid link is already out; do not resend.
  if (new Date(existing.expires_at).getTime() > Date.now()) return null;

  // Expired-but-unused → reuse the row in place with a fresh token + expiry.
  // Guarded on used_at so a token claimed since the read above isn't reopened.
  // The affected row MUST be checked: a zero-row update means someone else
  // claimed or rewrote it, and returning the raw token anyway would send a link
  // whose hash was never stored — the recipient would see "isn't valid".
  const { data: reused, error: updateError } = await supabase
    .from("lead_topup_tokens")
    .update({
      token_hash: hash,
      expires_at: expiresAt,
      created_at: new Date().toISOString(),
      charge_status: null,
    })
    .eq("id", existing.id)
    .is("used_at", null)
    .select("id")
    .maybeSingle();

  if (updateError || !reused) {
    console.error("lead_topup_tokens reuse failed", { customerId, leadType, updateError });
    return null;
  }

  return { raw };
}

/**
 * If the customer's balance for `leadType` is exactly zero, offer a one-off
 * top-up: mint (or reuse) the single-use link and send the exhausted-credits
 * email (with the buy CTA) and an SMS. Deduplicated so only one live link/offer
 * exists per zero-balance event — a live link suppresses a resend, and the slot
 * frees on redemption so the next zero-balance event fires a fresh offer.
 *
 * No-op when the balance is non-zero or the customer has opted out of both
 * channels (so we never mint an orphan link nobody will receive). Never throws —
 * a failed email/SMS must not break assignment.
 */
export async function maybeSendTopupOffer(
  supabase: Admin,
  customer: Customer,
  leadType: LeadType
): Promise<void> {
  if (balanceFor(customer, leadType) !== 0) return;

  const emailOptIn = wantsCreditEmail(customer);
  const smsOptIn = wantsSms(customer);
  if (!emailOptIn && !smsOptIn) return;

  const issued = await issueOrReuseToken(supabase, customer.id, leadType);
  if (!issued) return;

  const url = topupUrl(issued.raw);

  if (emailOptIn) {
    await sendCreditsExhaustedEmail({
      to: customer.email,
      topup: {
        url,
        product: leadType,
        credits: TOPUP_CREDITS,
        pricePence: TOPUP_AMOUNT_PENCE,
      },
    });
  }

  if (smsOptIn) {
    const price = `£${TOPUP_AMOUNT_PENCE / 100}`;
    const body = `Stayful: you're out of ${productLabel(leadType)} leads. Buy ${TOPUP_CREDITS} more for ${price} — confirm here: ${url}`;
    const res = await sendSms(customer.phone, body);
    if (!res.ok) {
      console.error("top-up SMS failed", { customerId: customer.id, leadType, reason: res.reason });
    }
  }
}
