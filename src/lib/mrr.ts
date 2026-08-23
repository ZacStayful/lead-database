import {
  grPlanForAllocation,
  planForAllocation,
  type Plan,
} from "@/lib/plans";
import type { Customer, LeadType } from "@/lib/types";

/**
 * Committed monthly revenue — the one definition.
 *
 * This was ~20 inline lines in src/app/admin/page.tsx, and a second,
 * independently derived version sat in serviceHealth.ts on the SAME page. The
 * monthly capture (0099) makes a third reader, and three copies of a pricing
 * rule is how the GR price went stale before LEAD_PRICE_GBP was consolidated
 * (§1: "three copies is why it was missed; one copy is the fix").
 *
 * ⚠️ PRICES LIVE HERE AND NEVER IN SQL. 0099 deliberately ships no capture
 * function: the cron computes these figures in TypeScript and upserts the rows,
 * because writing a SQL capture would mean hardcoding £150/£300 beside the copy
 * in plans.ts — creating the duplication the convention exists to prevent.
 *
 * Everything in this file is pure and does no I/O, so it is unit-testable under
 * the suite's no-database constraint (§27).
 */

/** Pence, not pounds: £150/£300 are exact in pence, and it matches the storage. */
const PENCE = 100;

function planFor(leadType: LeadType, allocation: number | null): Plan {
  return leadType === "guaranteed_rent"
    ? grPlanForAllocation(allocation ?? 0)
    : planForAllocation(allocation ?? 0);
}

/**
 * What one product's plan costs per month, in pence.
 *
 * ⚠️ Routing GR through grPlanForAllocation is a real fix, not tidying.
 * serviceHealth.ts priced GR with planForAllocation — the MANAGEMENT table —
 * and it was invisible only because both tables are £150/£300 today. The moment
 * either reprices, "revenue at risk" is silently wrong on the page an admin
 * opens precisely when something is wrong.
 *
 * Honest note on the test for that: while the two tables agree, no value
 * assertion can distinguish the fixed code from the broken code. The test in
 * __tests__/mrr.test.ts is a guard against regression AFTER a reprice, not
 * proof the bug is gone.
 */
export function planPricePence(
  leadType: LeadType,
  allocation: number | null
): number {
  return planFor(leadType, allocation).priceGbp * PENCE;
}

export interface CustomerMrr {
  /** Billed this month. */
  managementPence: number;
  /**
   * Paused management revenue. Reported BESIDE the total and never added to it
   * (§21) — invoices are being voided, so folding it in counts money that is
   * not being collected.
   */
  pausedManagementPence: number;
  grPence: number;
}

/**
 * One customer's committed monthly revenue, per product.
 *
 * Summed PER PRODUCT, not per customer (§18A): the two subscriptions are
 * independent, so somebody holding both contributes both fees.
 *
 * Counts only customers on a real Stripe subscription — comped and owner
 * accounts are active and generate no revenue. The GR side keys on
 * `gr_stripe_subscription_id` for the usual reason: the management subscription
 * id says nothing about whether GR is being billed.
 */
export function customerMrrPence(c: Customer): CustomerMrr {
  const result: CustomerMrr = {
    managementPence: 0,
    pausedManagementPence: 0,
    grPence: 0,
  };
  if (!c.is_active) return result;

  if (c.subscription_status === "active" && c.stripe_subscription_id) {
    const pence = planPricePence("management", c.monthly_allocation);
    // paused_at is management-only (§3, invariant 6) and must never gate GR.
    if (c.paused_at) result.pausedManagementPence = pence;
    else result.managementPence = pence;
  }

  if (c.gr_subscription_status === "active" && c.gr_stripe_subscription_id) {
    result.grPence = planPricePence(
      "guaranteed_rent",
      c.gr_monthly_allocation ?? null
    );
  }

  return result;
}

export interface MrrTotals {
  managementPence: number;
  grPence: number;
  /** Management + GR. Paused is deliberately absent from this sum. */
  totalPence: number;
  pausedPence: number;
  managementCustomers: number;
  grCustomers: number;
  pausedCustomers: number;
}

/** Aggregate committed revenue across a set of customers. */
export function mrrTotals(customers: Customer[]): MrrTotals {
  const totals: MrrTotals = {
    managementPence: 0,
    grPence: 0,
    totalPence: 0,
    pausedPence: 0,
    managementCustomers: 0,
    grCustomers: 0,
    pausedCustomers: 0,
  };

  for (const c of customers) {
    const m = customerMrrPence(c);
    totals.managementPence += m.managementPence;
    totals.grPence += m.grPence;
    totals.pausedPence += m.pausedManagementPence;
    if (m.managementPence > 0) totals.managementCustomers += 1;
    if (m.grPence > 0) totals.grCustomers += 1;
    if (m.pausedManagementPence > 0) totals.pausedCustomers += 1;
  }

  totals.totalPence = totals.managementPence + totals.grPence;
  return totals;
}

/** Pence to whole pounds, for display only. */
export function poundsFromPence(pence: number): number {
  return Math.round(pence / PENCE);
}
