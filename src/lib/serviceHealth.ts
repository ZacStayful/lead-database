import { createAdminClient } from "@/lib/supabase/admin";
import { planForAllocation } from "@/lib/plans";
import type { LeadType } from "@/lib/types";

/**
 * Service health: how many customers the lead supply can actually carry, and
 * which of the current ones look like leaving.
 *
 * Both figures are read LIVE on every admin page load rather than from the
 * nightly snapshot. The snapshot series (0058) exists to answer "how has this
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
  /** Customers this product's monthly inflow can carry indefinitely. */
  sustainableCustomers: number;
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
    return {
      product: r.lead_type as LeadType,
      leadsPerMonth: Number(r.leads_per_month ?? 0),
      slotsPerMonth: slots,
      inventorySlotsNow: Number(r.inventory_slots_now ?? 0),
      unsoldLeadsNow: Number(r.unsold_leads_now ?? 0),
      demandPerMonth: demand,
      deliveredPerMonth: Number(r.delivered_per_month ?? 0),
      activeCustomers: Number(r.active_customers ?? 0),
      fullyServed: Number(r.fully_served ?? 0),
      avgAllocation: Number(r.avg_allocation ?? 0),
      sustainableCustomers: Number(r.sustainable_customers ?? 0),
      roomForCustomers: Number(r.room_for_customers ?? 0),
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
