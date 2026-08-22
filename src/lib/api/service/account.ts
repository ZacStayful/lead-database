/**
 * GET /v1/me — who the caller is, and where they stand on each product.
 *
 * PER PRODUCT, AND ONLY PRODUCTS THEY HOLD. Every balance, counter and pacing
 * figure in this system exists twice, once per product, and a block that mixed
 * them would be wrong for both. `holdsProduct` reads only that product's own
 * columns, which is why a Guaranteed Rent subscriber sitting at
 * `account_status = 'waitlisted'` for management still reports correctly.
 */
import { computeGrPacing, computePacing } from "@/lib/pacing";
import { holdsProduct } from "@/lib/products";
import { ok, type ApiResult } from "@/lib/api/errors";
import type { Caller } from "@/lib/api/caller";
import type { Customer, LeadType } from "@/lib/types";

function filterBlock(customer: Customer, leadType: LeadType) {
  const gr = leadType === "guaranteed_rent";
  return {
    status: gr ? customer.gr_filter_status : customer.filter_status,
    // A filter can be set by naming areas OR by a radius around an outcode.
    // Reporting only the area list would render a radius filter as "no areas",
    // which is a WRONG answer rather than a missing one.
    selection_mode: gr
      ? customer.gr_filter_selection_mode
      : customer.filter_selection_mode,
    areas: (gr ? customer.gr_filter_areas : customer.filter_areas) ?? [],
    radius_outcode: gr
      ? customer.gr_filter_radius_outcode
      : customer.filter_radius_outcode,
    radius_miles: gr
      ? customer.gr_filter_radius_miles
      : customer.filter_radius_miles,
    min_bedrooms: gr
      ? customer.gr_filter_min_bedrooms
      : customer.filter_min_bedrooms,
    max_bedrooms: gr
      ? customer.gr_filter_max_bedrooms
      : customer.filter_max_bedrooms,
  };
}

function productBlock(customer: Customer, leadType: LeadType) {
  const gr = leadType === "guaranteed_rent";
  const pacing = gr ? computeGrPacing(customer) : computePacing(customer);

  const block: Record<string, unknown> = {
    product: leadType,
    status: gr ? customer.gr_subscription_status : customer.subscription_status,
    monthly_allocation: gr
      ? customer.gr_monthly_allocation
      : customer.monthly_allocation,
    lead_balance: gr ? customer.gr_lead_balance : customer.lead_balance,
    leads_received_this_month: gr
      ? customer.gr_leads_received_this_month
      : customer.leads_received_this_month,
    // Leads claimed from the expired pool with no credit behind them, being
    // settled against future renewals. Returned because it is the only thing
    // that explains a deficit the customer did not cause.
    pool_debit: gr ? customer.gr_pool_debit : customer.pool_debit,
    pacing: {
      expected: pacing.expected,
      deficit: pacing.deficit,
      status: pacing.status,
      effective_allocation: pacing.effectiveAllocation,
      days_elapsed: pacing.daysElapsed,
      days_remaining: pacing.daysRemaining,
    },
    filter: filterBlock(customer, leadType),
  };

  // MANAGEMENT ONLY. There is no Guaranteed Rent pause — the Stripe webhook
  // deliberately leaves `paused_at` untouched on a GR cancellation — so
  // emitting `paused: false` on a GR block would assert that a GR pause exists
  // and is currently off.
  if (!gr) {
    block.paused = customer.paused_at != null;
    block.pause_resumes_at = customer.pause_resumes_at;
  }

  return block;
}

export function getAccount(caller: Caller): ApiResult<Record<string, unknown>> {
  const customer = caller.customer;
  const products: Record<string, unknown>[] = [];

  for (const leadType of ["management", "guaranteed_rent"] as LeadType[]) {
    if (holdsProduct(customer, leadType)) {
      products.push(productBlock(customer, leadType));
    }
  }

  return ok({
    customer: {
      id: customer.id,
      business_name: customer.business_name,
      contact_name: customer.contact_name,
      email: customer.email,
    },
    products,
  });
}
