/**
 * GET /v1/me — who the caller is, and where they stand on each product.
 *
 * PER PRODUCT, AND ONLY PRODUCTS THEY HOLD. Every balance, counter and pacing
 * figure in this system exists twice, once per product, and a block that mixed
 * them would be wrong for both. `holdsProduct` reads only that product's own
 * columns, which is why a Guaranteed Rent subscriber sitting at
 * `account_status = 'waitlisted'` for management still reports correctly.
 */
import {
  RELEASE_SETTING_KEYS,
  computeGrPacing,
  computePacing,
  londonDate,
  releaseSchedule,
  releaseSettingsFrom,
  type ReleaseSettings,
} from "@/lib/pacing";
import { createAdminClient } from "@/lib/supabase/admin";
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

function productBlock(
  customer: Customer,
  leadType: LeadType,
  release: { settings: ReleaseSettings; receivedToday: number; now: Date }
) {
  const gr = leadType === "guaranteed_rent";
  const pacing = gr ? computeGrPacing(customer) : computePacing(customer);
  // §54. A date or null — a FIXED field, never a filter (§27.1). Null while
  // the daily release is off, for an exempt customer, or when everything this
  // cycle owes has been delivered.
  const schedule = releaseSchedule(customer, leadType, release.receivedToday, release.settings, release.now);
  const nextLeadDue =
    schedule.enabled && schedule.mode === "daily" ? schedule.nextReleaseDate : null;

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
    next_lead_due: nextLeadDue,
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

export async function getAccount(
  caller: Caller,
  admin = createAdminClient()
): Promise<ApiResult<Record<string, unknown>>> {
  const customer = caller.customer;
  const products: Record<string, unknown>[] = [];

  // Two small reads for next_lead_due: the release settings, and this
  // customer's assignments dated today in London (what the daily cap counts).
  // Both scoped by caller.customerId, like every query on this surface.
  const now = new Date();
  const today = londonDate(now);
  const [settingRows, todayRows] = await Promise.all([
    admin.from("system_settings").select("key, value").in("key", [...RELEASE_SETTING_KEYS]),
    admin
      .from("lead_assignments")
      .select("assigned_at, lead:leads!inner(lead_type)")
      .eq("customer_id", caller.customerId)
      .gte("assigned_at", new Date(now.getTime() - 36 * 3_600_000).toISOString()),
  ]);
  const settings = releaseSettingsFrom(
    (settingRows.data ?? []) as { key: string; value: string }[]
  );
  const receivedToday = (lt: LeadType) =>
    ((todayRows.data ?? []) as unknown as { assigned_at: string; lead: { lead_type: string } | null }[])
      .filter((r) => (r.lead?.lead_type ?? "management") === lt && londonDate(new Date(r.assigned_at)) === today)
      .length;

  for (const leadType of ["management", "guaranteed_rent"] as LeadType[]) {
    if (holdsProduct(customer, leadType)) {
      products.push(
        productBlock(customer, leadType, { settings, receivedToday: receivedToday(leadType), now })
      );
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
