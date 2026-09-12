/**
 * The readings beside the release switch on /admin/allocation (§54). Pure, so
 * the arithmetic is testable without a client; the page does the reads.
 *
 * The number this whole change exists to move is DELIVERY DAYS PER CUSTOMER
 * PER CYCLE — measured at 2.0 on production before it shipped (81% of
 * management leads landed in the first week of a cycle, a typical delivery
 * day dropped 8 on one customer). If the switch is doing its job that climbs
 * towards the working days in a month.
 */
import type { Customer, LeadType } from "@/lib/types";
import {
  londonDate,
  releaseSchedule,
  type ReleaseSchedule,
  type ReleaseSettings,
} from "@/lib/pacing";

export interface CustomerReleaseRow {
  customerId: string;
  businessName: string;
  leadType: LeadType;
  schedule: ReleaseSchedule;
  /** Days since the anchor. Over the cycle length means the anchor is stale
   *  (§11's invoice.period_start trap) and the rule is letting everything through. */
  anchorAgeDays: number;
}

export interface ReleaseOverview {
  rows: CustomerReleaseRow[];
  slotOpenToday: number;
  heldAtCapToday: number;
  onHold: number;
  exhausted: number;
  staleAnchors: number;
}

/** Customers holding a product, per product. Mirrors the routing gates. */
function holds(c: Customer, leadType: LeadType): boolean {
  if (!c.is_active) return false;
  if (leadType === "guaranteed_rent") return c.gr_subscription_status === "active";
  return (
    c.account_status === "active" &&
    c.subscription_status === "active" &&
    c.paused_at == null
  );
}

function daysBetween(fromYmd: string, toYmd: string): number {
  const a = Date.UTC(
    Number(fromYmd.slice(0, 4)),
    Number(fromYmd.slice(5, 7)) - 1,
    Number(fromYmd.slice(8, 10))
  );
  const b = Date.UTC(
    Number(toYmd.slice(0, 4)),
    Number(toYmd.slice(5, 7)) - 1,
    Number(toYmd.slice(8, 10))
  );
  return Math.round((b - a) / 86_400_000);
}

/**
 * `todayCounts` is keyed `${customerId}:${leadType}` → assignments dated today
 * in London, which the SQL rule counts against the daily cap.
 */
export function releaseOverview(
  customers: Customer[],
  todayCounts: Map<string, number>,
  settings: ReleaseSettings,
  now: Date = new Date()
): ReleaseOverview {
  const today = londonDate(now);
  const rows: CustomerReleaseRow[] = [];
  for (const c of customers) {
    for (const leadType of ["management", "guaranteed_rent"] as LeadType[]) {
      if (!holds(c, leadType)) continue;
      const receivedToday = todayCounts.get(`${c.id}:${leadType}`) ?? 0;
      const schedule = releaseSchedule(c, leadType, receivedToday, settings, now);
      const anchorRaw =
        leadType === "guaranteed_rent"
          ? (c.gr_billing_cycle_anchor ?? c.created_at)
          : (c.billing_cycle_anchor ?? c.created_at);
      rows.push({
        customerId: c.id,
        businessName: c.business_name,
        leadType,
        schedule,
        anchorAgeDays: daysBetween(anchorRaw.slice(0, 10), today),
      });
    }
  }
  return {
    rows,
    slotOpenToday: rows.filter((r) => r.schedule.dueToday).length,
    heldAtCapToday: rows.filter(
      (r) =>
        r.schedule.enabled &&
        !r.schedule.dueToday &&
        !r.schedule.exhausted &&
        !r.schedule.onHoldUntil &&
        r.schedule.receivedToday >= settings.maxPerDay
    ).length,
    onHold: rows.filter((r) => r.schedule.onHoldUntil != null).length,
    exhausted: rows.filter((r) => r.schedule.exhausted).length,
    staleAnchors: rows.filter((r) => r.anchorAgeDays > settings.cycleDays).length,
  };
}

/**
 * Distinct (customer, London day) pairs per customer over a window — the KPI.
 * `assignments` is every marketplace assignment in the window.
 */
export function deliveryDaysPerCustomer(
  assignments: { customer_id: string; assigned_at: string }[]
): { customers: number; deliveryDays: number; perCustomer: number } {
  const days = new Set<string>();
  const customers = new Set<string>();
  for (const a of assignments) {
    customers.add(a.customer_id);
    days.add(`${a.customer_id}:${londonDate(new Date(a.assigned_at))}`);
  }
  const perCustomer = customers.size === 0 ? 0 : days.size / customers.size;
  return {
    customers: customers.size,
    deliveryDays: days.size,
    perCustomer: Math.round(perCustomer * 10) / 10,
  };
}

/** Unsold stock with a free slot: count and the oldest lead's age in days. */
export function stockSummary(
  leads: { created_at: string; lead_type: string; assignment_count: number | null; max_assignments: number | null }[],
  leadType: LeadType,
  now: Date = new Date()
): { count: number; oldestDays: number | null } {
  const open = leads.filter(
    (l) =>
      l.lead_type === leadType &&
      (l.assignment_count ?? 0) < (l.max_assignments ?? 3)
  );
  if (open.length === 0) return { count: 0, oldestDays: null };
  const oldest = Math.min(...open.map((l) => new Date(l.created_at).getTime()));
  return {
    count: open.length,
    oldestDays: Math.floor((now.getTime() - oldest) / 86_400_000),
  };
}
