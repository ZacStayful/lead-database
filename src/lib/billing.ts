import { getStripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Customer } from "@/lib/types";

/**
 * Bill an opted-in customer for a single overflow lead (£20). We attach a
 * pending invoice item to their Stripe customer using STRIPE_OVERFLOW_PRICE_ID;
 * it is collected on their next subscription invoice. Records a pending payment
 * row so overflow is auditable even before Stripe finalises the invoice.
 *
 * Safe to call on every assignment — it no-ops unless the customer is genuinely
 * over allocation AND has overflow enabled AND a Stripe customer on file.
 */
export async function chargeOverflowLead(customer: Customer): Promise<boolean> {
  if (!customer.overflow_enabled) return false;
  if (customer.leads_received_this_month <= customer.monthly_allocation) {
    return false;
  }
  if (!customer.stripe_customer_id) return false;
  if (!process.env.STRIPE_OVERFLOW_PRICE_ID) return false;

  const stripe = getStripe();
  try {
    const item = await stripe.invoiceItems.create({
      customer: customer.stripe_customer_id,
      price: process.env.STRIPE_OVERFLOW_PRICE_ID,
      metadata: { type: "overflow_lead" },
    });

    const admin = createAdminClient();
    await admin.from("payments").insert({
      customer_id: customer.id,
      amount_pence: 2000,
      credits_added: 1,
      payment_type: "overflow",
      status: "pending",
      stripe_payment_intent_id: null,
      stripe_invoice_id: item.invoice ? String(item.invoice) : null,
    });
    return true;
  } catch (err) {
    console.error("Overflow charge failed", err);
    return false;
  }
}
