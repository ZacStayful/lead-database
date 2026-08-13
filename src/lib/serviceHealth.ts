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
   * Sellable slots per month — the sum of max_assignments over those leads, not
   * a lead count times a constant. Rises by itself as escalation raises caps.
   */
  slotsPerMonth: number;
  /** Sum of monthly allocations across active customers of this product. */
  demandPerMonth: number;
  /** slots − demand. Negative means oversubscribed. */
  headroomPerMonth: number;
  /** demand / slots. Above 1.0 means promising more leads than arrive. */
  utilisation: number | null;
  activeCustomers: number;
  /** Unfilled slots sitting in inventory right now. */
  openSlotsNow: number;
  /** Leads never sold to anybody. */
  unsoldLeadsNow: number;
  /** How many more customers the headroom supports, at each plan size. */
  roomForCustomers: { atTen: number; atTwenty: number };
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

  if (capRes.error) throw new Error(capRes.error.message);
  if (riskRes.error) throw new Error(riskRes.error.message);

  const capacity: ProductCapacity[] = (
    (capRes.data ?? []) as Record<string, unknown>[]
  ).map((r) => {
    const headroom = Number(r.headroom_per_month ?? 0);
    return {
      product: r.lead_type as LeadType,
      leadsPerMonth: Number(r.leads_per_month ?? 0),
      slotsPerMonth: Number(r.slots_per_month ?? 0),
      demandPerMonth: Number(r.demand_per_month ?? 0),
      headroomPerMonth: headroom,
      utilisation: r.utilisation == null ? null : Number(r.utilisation),
      activeCustomers: Number(r.active_customers ?? 0),
      openSlotsNow: Number(r.open_slots_now ?? 0),
      unsoldLeadsNow: Number(r.unsold_leads_now ?? 0),
      // Floor, and never negative: an oversubscribed product has room for
      // nobody, not for a negative number of people.
      roomForCustomers: {
        atTen: Math.max(0, Math.floor(headroom / 10)),
        atTwenty: Math.max(0, Math.floor(headroom / 20)),
      },
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
