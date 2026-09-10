import { DAYS_IN_CYCLE } from "@/lib/pacing";
import type { Customer } from "@/lib/types";

/**
 * The billing cycle a customer is currently in.
 *
 * Mirrors computePacing: the anchor is billing_cycle_anchor, falling back to
 * created_at, floored to midnight so the boundaries agree with the pacing
 * numbers shown on the dashboard. Cycles roll forward from the anchor in
 * DAYS_IN_CYCLE steps, so cycle_start is stable for a given customer and date
 * and can be used as the survey's unique key.
 */
export interface Cycle {
  start: Date;
  end: Date;
  /** ISO date (YYYY-MM-DD) — the natural key for cycle_quality_surveys. */
  startDate: string;
  endDate: string;
}

function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function currentCycle(customer: Customer, now: Date = new Date()): Cycle {
  const anchor = new Date(customer.billing_cycle_anchor ?? customer.created_at);
  anchor.setHours(0, 0, 0, 0);

  const msPerDay = 1000 * 60 * 60 * 24;
  const cycleMs = DAYS_IN_CYCLE * msPerDay;
  const elapsed = now.getTime() - anchor.getTime();
  const cyclesPassed = elapsed > 0 ? Math.floor(elapsed / cycleMs) : 0;

  const start = new Date(anchor.getTime() + cyclesPassed * cycleMs);
  const end = new Date(start.getTime() + cycleMs);

  return {
    start,
    end,
    startDate: toDateString(start),
    endDate: toDateString(end),
  };
}

/**
 * Whether it is time to ask this customer about the cycle's leads: either the
 * allocation has all been delivered, or the cycle is nearly over. Asking
 * mid-cycle would sample only the leads they happened to have worked so far.
 */
export const SURVEY_TAIL_DAYS = 3;

export function isSurveyDue(customer: Customer, now: Date = new Date()): boolean {
  if ((customer.leads_received_this_month ?? 0) === 0) return false;

  const allocation = customer.monthly_allocation ?? 0;
  if (allocation > 0 && customer.leads_received_this_month >= allocation) {
    return true;
  }

  const { end } = currentCycle(customer, now);
  const daysLeft = (end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
  return daysLeft <= SURVEY_TAIL_DAYS;
}
