import { createAdminClient } from "@/lib/supabase/admin";
import { planForAllocation } from "@/lib/plans";
import type { LeadType } from "@/lib/types";

/**
 * Service health: how many customers the lead supply can actually carry, and
 * which of the current ones look like leaving.
 *
 * Both figures are read LIVE on every admin page load rather than from the
 * nightly snapshot. The snapshot series (0070) exists to answer "how has this
 * moved over weeks", which is what churn prediction will eventually need; this
 * answers "what is true right now", which is what someone looking at the admin
 * page is asking. Deriving the live number from a table written once a day
 * would mean the panel disagreed with the database for up to 24 hours after
 * every signup, cancellation or escalation.
 */

export interface ProductCapacity {
  product: LeadType;
  /** New leads ingested per month, from a 28-day window scaled to 30 days. */
  leadsPerMonth: number;
  /**
   * Sustainable sellable slots per month — the sum of max_assignments over
   * newly ingested leads. Rises by itself as escalation raises caps. This is
   * the number that decides how many customers can be carried indefinitely.
   */
  slotsPerMonth: number;
  /**
   * Recurring slots recovered from leads nobody worked, via escalation.
   *
   * Unlike inventory this REFILLS: a measured share of everything delivered
   * goes unworked every month and comes back to be sold again. That is what
   * earns it a place in the ceiling where inventory is excluded.
   *
   * Counts ONE rung ahead only. A lead going out for its first resale does not
   * also contribute its second — the new operator may work it, which ends the
   * ladder there. The second resale is counted when it actually happens.
   */
  recycledSlotsPerMonth: number;
  /** slotsPerMonth + recycledSlotsPerMonth. What the ceiling is built from. */
  serviceableSlotsPerMonth: number;
  /**
   * "observed" once escalation has actually run, "estimated" before then. An
   * estimate must never be read as a count, so the panel says which it is.
   */
  recyclingBasis: string;
  /**
   * Live count of leads sitting with an operator who is not working them, and
   * which could be passed on today. One per LEAD, not per assignment.
   */
  recycledSlotsNow: number;
  /** Share of delivered leads never worked inside their own first ten days. */
  unworkedRate: number | null;
  /** How many assignments that rate was measured over. */
  recyclingSample: number;
  /**
   * Slots sitting unsold in the back catalogue. Real and sellable, but a
   * ONE-OFF buffer — kept separate from slotsPerMonth and never added to it,
   * because seating customers against a stock that does not refill is how you
   * end up unable to serve them next month.
   */
  inventorySlotsNow: number;
  unsoldLeadsNow: number;
  /** Sum of monthly allocations promised to active customers. */
  demandPerMonth: number;
  /** What was actually delivered per month — the check on the other two. */
  deliveredPerMonth: number;
  activeCustomers: number;
  /** Customers who have received their full allocation in the current cycle. */
  fullyServed: number;
  avgAllocation: number;
  /**
   * Customers this product can carry indefinitely on serviceable supply —
   * new leads PLUS recycling. The headline ceiling.
   */
  sustainableCustomers: number;
  /**
   * What the ceiling would be on new leads alone. Shown beside the headline so
   * the split is never taken on trust: the gap between the two is exactly how
   * much of the headroom depends on customers continuing to ignore leads.
   */
  sustainableCustomersNewOnly: number;
  /** sustainableCustomers − activeCustomers, floored at zero. */
  roomForCustomers: number;
  /** True when more is promised each month than sustainably arrives. */
  borrowingFromInventory: boolean;
}

export type RiskBand = "critical" | "high" | "medium" | "watch" | "ok";

export interface CustomerRisk {
  customerId: string;
  businessName: string;
  email: string;
  daysSinceLastActivity: number | null;
  tenureDays: number | null;
  payingDays: number | null;
  lifetimeDelivered: number;
  lifetimeWorked: number;
  lifetimeWorkedRate: number | null;
  band: RiskBand;
  reason: string;
  /** Monthly subscription value at risk, in GBP, across both products held. */
  monthlyValueGbp: number;
}

export interface ServiceHealth {
  /** True when the underlying functions could not be read — see getServiceHealth. */
  unavailable?: boolean;
  capacity: ProductCapacity[];
  risk: CustomerRisk[];
  /** Monthly revenue represented by customers in the critical and high bands. */
  revenueAtRiskGbp: number;
  /** Monthly revenue across every active customer, for context. */
  totalMonthlyRevenueGbp: number;
}

const RISK_ORDER: Record<RiskBand, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  watch: 3,
  ok: 4,
};

/** Bands that count toward "revenue at risk". */
const AT_RISK: RiskBand[] = ["critical", "high"];

function toBand(value: unknown): RiskBand {
  return value === "critical" ||
    value === "high" ||
    value === "medium" ||
    value === "watch"
    ? value
    : "ok";
}

/**
 * Price a customer's monthly subscription from their allocations.
 *
 * Deliberately derived through planForAllocation rather than read from the
 * payments table: payments is known to be incomplete (three active subscribers
 * have no payment row at all), so summing it would understate the exposure of
 * exactly the longest-standing customers. Plan price is what they are committed
 * to pay each month, which is the number that matters for "what does losing
 * them cost".
 */
function monthlyValue(
  holdsManagement: boolean,
  managementAllocation: number | null,
  holdsGr: boolean,
  grAllocation: number | null
): number {
  let total = 0;
  if (holdsManagement) total += planForAllocation(managementAllocation ?? 0).priceGbp;
  if (holdsGr) total += planForAllocation(grAllocation ?? 0).priceGbp;
  return total;
}

export async function getServiceHealth(): Promise<ServiceHealth> {
  const admin = createAdminClient();

  const [capRes, riskRes] = await Promise.all([
    admin.rpc("get_service_capacity"),
    admin.rpc("get_customer_risk"),
  ]);

  // Degrade rather than throw.
  //
  // /admin is the page an admin opens when something is wrong, so it is the last
  // page that should break. Throwing here 500s the whole overview — capacity
  // panels, customer stats, everything — because two panels could not load, and
  // the most likely reason for that is simply that this feature's migration has
  // not been applied to the environment yet.
  if (capRes.error || riskRes.error) {
    console.error("[serviceHealth] unavailable", capRes.error ?? riskRes.error);
    return {
      capacity: [],
      risk: [],
      revenueAtRiskGbp: 0,
      totalMonthlyRevenueGbp: 0,
      unavailable: true,
    };
  }

  const capacity: ProductCapacity[] = (
    (capRes.data ?? []) as Record<string, unknown>[]
  ).map((r) => {
    const slots = Number(r.slots_per_month ?? 0);
    const demand = Number(r.demand_per_month ?? 0);
    const leads = Number(r.leads_per_month ?? 0);
    return {
      product: r.lead_type as LeadType,
      leadsPerMonth: leads,
      slotsPerMonth: slots,
      recycledSlotsPerMonth: Number(r.recycled_slots_per_month ?? 0),
      serviceableSlotsPerMonth: Number(r.serviceable_slots_per_month ?? slots),
      recyclingBasis: String(r.recycling_basis ?? "estimated"),
      recycledSlotsNow: Number(r.recycled_slots_now ?? 0),
      unworkedRate: r.unworked_rate == null ? null : Number(r.unworked_rate),
      recyclingSample: Number(r.recycling_sample ?? 0),
      inventorySlotsNow: Number(r.inventory_slots_now ?? 0),
      unsoldLeadsNow: Number(r.unsold_leads_now ?? 0),
      demandPerMonth: demand,
      deliveredPerMonth: Number(r.delivered_per_month ?? 0),
      activeCustomers: Number(r.active_customers ?? 0),
      fullyServed: Number(r.fully_served ?? 0),
      avgAllocation: Number(r.avg_allocation ?? 0),
      sustainableCustomers: Number(r.sustainable_customers ?? 0),
      sustainableCustomersNewOnly: Number(r.sustainable_customers_new_only ?? 0),
      roomForCustomers: Number(r.room_for_customers ?? 0),
      // Still measured against NEW-lead slots, not serviceable ones. The
      // question this answers is "are we promising more than arrives", and
      // recycled supply is a recovery from what already went out — folding it in
      // would hide a genuine inflow shortfall behind our own customers'
      // inactivity.
      borrowingFromInventory: demand > slots,
    };
  });

  const risk: CustomerRisk[] = (
    (riskRes.data ?? []) as Record<string, unknown>[]
  ).map((r) => ({
    customerId: String(r.customer_id),
    businessName: String(r.business_name ?? ""),
    email: String(r.email ?? ""),
    daysSinceLastActivity:
      r.days_since_last_activity == null ? null : Number(r.days_since_last_activity),
    tenureDays: r.tenure_days == null ? null : Number(r.tenure_days),
    payingDays: r.paying_days == null ? null : Number(r.paying_days),
    lifetimeDelivered: Number(r.lifetime_delivered ?? 0),
    lifetimeWorked: Number(r.lifetime_worked ?? 0),
    lifetimeWorkedRate:
      r.lifetime_worked_rate == null ? null : Number(r.lifetime_worked_rate),
    band: toBand(r.risk_band),
    reason: String(r.risk_reason ?? ""),
    monthlyValueGbp: monthlyValue(
      Boolean(r.holds_management),
      r.monthly_allocation == null ? null : Number(r.monthly_allocation),
      Boolean(r.holds_gr),
      r.gr_monthly_allocation == null ? null : Number(r.gr_monthly_allocation)
    ),
  }));

  risk.sort((a, b) => {
    const byBand = RISK_ORDER[a.band] - RISK_ORDER[b.band];
    if (byBand !== 0) return byBand;
    return (b.daysSinceLastActivity ?? 0) - (a.daysSinceLastActivity ?? 0);
  });

  const revenueAtRiskGbp = risk
    .filter((r) => AT_RISK.includes(r.band))
    .reduce((sum, r) => sum + r.monthlyValueGbp, 0);

  const totalMonthlyRevenueGbp = risk.reduce(
    (sum, r) => sum + r.monthlyValueGbp,
    0
  );

  return { capacity, risk, revenueAtRiskGbp, totalMonthlyRevenueGbp };
}
