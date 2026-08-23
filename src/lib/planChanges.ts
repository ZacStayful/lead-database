import type { SupabaseClient } from "@supabase/supabase-js";
import { planForProductAllocation } from "@/lib/plans";
import type { LeadType } from "@/lib/types";

/**
 * Self-serve tier changes (0088) — the pieces shared by the request route and
 * the Stripe webhook that applies them.
 *
 * THE SPLIT, AND WHY IT MATTERS
 * -----------------------------
 * `customers.(gr_)pending_monthly_allocation` is the LIVE state and the only
 * authority on whether a change is outstanding. `subscription_plan_changes` is
 * history: every function here that writes to it logs and returns rather than
 * throwing, because a missing audit row is a reporting gap and a failed plan
 * change is a customer's money. Same discipline as `stampEpisodeEnded` for
 * pause episodes (§21).
 *
 * WHY THE COLUMN NAMES ARE RESOLVED HERE
 * --------------------------------------
 * Management and GR are fully parallel (invariant 6) and the two callers must
 * never disagree about which column pair belongs to which product. One mapping,
 * used by both.
 */

export interface PlanChangeColumns {
  allocation: "monthly_allocation" | "gr_monthly_allocation";
  pending: "pending_monthly_allocation" | "gr_pending_monthly_allocation";
  pendingAt: "pending_plan_change_at" | "gr_pending_plan_change_at";
  subscriptionId: "stripe_subscription_id" | "gr_stripe_subscription_id";
}

export function planChangeColumns(leadType: LeadType): PlanChangeColumns {
  return leadType === "guaranteed_rent"
    ? {
        allocation: "gr_monthly_allocation",
        pending: "gr_pending_monthly_allocation",
        pendingAt: "gr_pending_plan_change_at",
        subscriptionId: "gr_stripe_subscription_id",
      }
    : {
        allocation: "monthly_allocation",
        pending: "pending_monthly_allocation",
        pendingAt: "pending_plan_change_at",
        subscriptionId: "stripe_subscription_id",
      };
}

/** Every column the pending-change machinery reads, for a `select()`. */
export const PLAN_CHANGE_SELECT =
  "monthly_allocation, pending_monthly_allocation, pending_plan_change_at, " +
  "gr_monthly_allocation, gr_pending_monthly_allocation, gr_pending_plan_change_at";

/**
 * Close whichever change is currently open for this customer and product.
 *
 * Called when a new request supersedes an older one and when a customer reverts
 * before their invoice lands. Stamps the LATEST open row rather than every open
 * one, for the reason `stampEpisodeEnded` gives: because these writes are
 * allowed to fail, an older un-closed row can exist, and a blanket update would
 * back-date a change that did happen into one that was cancelled.
 */
export async function closeOpenPlanChange(
  admin: SupabaseClient,
  customerId: string,
  leadType: LeadType,
  outcome: "cancelled_at" | "applied_at",
  source: string
): Promise<void> {
  const { data: open, error: findError } = await admin
    .from("subscription_plan_changes")
    .select("id")
    .eq("customer_id", customerId)
    .eq("lead_type", leadType)
    .is("applied_at", null)
    .is("cancelled_at", null)
    .order("requested_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (findError) {
    console.error(`[${source}] could not find open plan change`, {
      customer: customerId,
      leadType,
      error: findError.message,
    });
    return;
  }
  // No open row is normal: an insert that failed at request time, or a change
  // made directly in Stripe that this system never recorded.
  if (!open) return;

  const { error: stampError } = await admin
    .from("subscription_plan_changes")
    .update({ [outcome]: new Date().toISOString() })
    .eq("id", open.id);

  if (stampError) {
    console.error(`[${source}] plan change stamp failed`, {
      customer: customerId,
      change: open.id,
      outcome,
      error: stampError.message,
    });
  }
}

/** Record a newly requested change. Best-effort; never fails the request. */
export async function recordPlanChange(
  admin: SupabaseClient,
  params: {
    customerId: string;
    leadType: LeadType;
    fromAllocation: number;
    toAllocation: number;
    stripePriceId: string;
    effectiveAt: string | null;
  },
  source: string
): Promise<void> {
  const { error } = await admin.from("subscription_plan_changes").insert({
    customer_id: params.customerId,
    lead_type: params.leadType,
    from_allocation: params.fromAllocation,
    to_allocation: params.toAllocation,
    stripe_price_id: params.stripePriceId,
    effective_at: params.effectiveAt,
  });

  if (error) {
    console.error(`[${source}] plan change insert failed`, {
      customer: params.customerId,
      leadType: params.leadType,
      error: error.message,
    });
  }
}

/**
 * Apply a pending tier change, if the invoice being paid is actually the one
 * that bills it.
 *
 * Called from the Stripe webhook's `invoice.paid` handler BEFORE it sizes the
 * credit, so the leads granted match the plan just billed.
 *
 * THE EQUALITY TEST IS THE SAFETY
 * -------------------------------
 * `invoiceAllocation` is what the invoice's own price ids say the customer paid
 * for. Applying only when that equals the pending figure means an unrelated,
 * stale or out-of-order invoice can never promote a change early — and, just as
 * importantly, an allocation an admin has hand-edited is never silently
 * re-sized from an invoice. §17 declined to switch crediting onto the invoice
 * price wholesale for exactly that reason; this is the narrow case where the
 * customer has explicitly asked for the change, so there is nothing to guess.
 *
 * Returns the allocation to credit: the new one if it applied, otherwise the
 * caller's current value untouched.
 */
/**
 * Re-price an in-force filter forecast after the allocation changes.
 *
 * A downgrade taken on our own advice keeps the SAME expected leads — that is
 * the condition under which it is recommended at all — but the cost per lead is
 * planPrice / expected, and the plan price just halved. Leaving the stored
 * figure alone would show a customer £50 a lead on a £150 plan for a month
 * after their bill dropped, which is the one number this feature exists to get
 * right.
 *
 * The expected COUNT is deliberately not recomputed. It was struck against the
 * volumes of the day, and a plan change is not the customer's cue to be
 * re-quoted; only the cap could move it, and a downgrade is only ever
 * recommended when the forecast already fits under the smaller plan. An upgrade
 * can leave the forecast below the new allocation, which is correct: they bought
 * more capacity than this filter can currently fill, and the panel will say so
 * next time they look.
 *
 * Best-effort. A stale price is a display bug; a thrown error here would strand
 * the plan change itself, which has real money behind it.
 */
async function repriceFilterForecast(
  admin: SupabaseClient,
  customerId: string,
  leadType: LeadType,
  allocation: number,
  source: string
): Promise<void> {
  const g = forecastColumns(leadType);
  const { data, error } = await admin
    .from("customers")
    .select(`${g.status}, ${g.expected}`)
    .eq("id", customerId)
    .maybeSingle();
  if (error || !data) return;

  const row = data as unknown as Record<string, unknown>;
  const status = String(row[g.status] ?? "off");
  const expected = Number(row[g.expected] ?? 0);
  if (!["active", "pending_lift"].includes(status) || expected <= 0) return;

  const plan = planForProductAllocation(leadType, allocation);
  const planPricePence = Math.round(plan.priceGbp * 100);
  // Capped at the new allocation, for the same reason forecastVolume caps: a
  // figure above what the plan sells is not deliverable, so quoting it would
  // price the customer's leads against volume they have not bought.
  const capped = Math.min(expected, allocation);

  const { error: updateError } = await admin
    .from("customers")
    .update({
      [g.expected]: capped,
      [g.planPrice]: planPricePence,
      // Ceil, as filterForecast.ts does, so expected * cost >= plan price.
      [g.costPerLead]: Math.ceil(planPricePence / capped),
      updated_at: new Date().toISOString(),
    })
    .eq("id", customerId);
  if (updateError) {
    console.error(`[${source}] forecast reprice failed`, updateError);
  }
}

function forecastColumns(leadType: LeadType) {
  return leadType === "guaranteed_rent"
    ? {
        status: "gr_filter_status",
        expected: "gr_filter_expected_leads",
        costPerLead: "gr_filter_forecast_cost_per_lead_pence",
        planPrice: "gr_filter_forecast_plan_price_pence",
      }
    : {
        status: "filter_status",
        expected: "filter_expected_leads",
        costPerLead: "filter_forecast_cost_per_lead_pence",
        planPrice: "filter_forecast_plan_price_pence",
      };
}

export async function applyPendingPlanChange(
  admin: SupabaseClient,
  params: {
    customerId: string;
    leadType: LeadType;
    currentAllocation: number;
    pendingAllocation: number | null;
    invoiceAllocation: number | null;
  },
  source: string
): Promise<number> {
  const { pendingAllocation, invoiceAllocation, currentAllocation } = params;

  if (pendingAllocation == null) return currentAllocation;
  if (invoiceAllocation == null || invoiceAllocation !== pendingAllocation) {
    return currentAllocation;
  }

  const cols = planChangeColumns(params.leadType);
  const { error } = await admin
    .from("customers")
    .update({
      [cols.allocation]: pendingAllocation,
      [cols.pending]: null,
      [cols.pendingAt]: null,
    })
    .eq("id", params.customerId);

  if (error) {
    // Credit the OLD allocation. Under-crediting by a tier is recoverable — the
    // balance carries forward (invariant 2) and the next invoice applies the
    // change — where crediting a tier the row does not record is not.
    console.error(`[${source}] pending plan change apply failed`, {
      customer: params.customerId,
      leadType: params.leadType,
      error: error.message,
    });
    return currentAllocation;
  }

  await closeOpenPlanChange(
    admin,
    params.customerId,
    params.leadType,
    "applied_at",
    source
  );

  await repriceFilterForecast(admin, params.customerId, params.leadType, pendingAllocation, source);

  console.log(
    `[${source}] applied pending plan change for customer ${params.customerId}: ` +
      `${params.leadType} ${currentAllocation} -> ${pendingAllocation} leads.`
  );

  return pendingAllocation;
}
