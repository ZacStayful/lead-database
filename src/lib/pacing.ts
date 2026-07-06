import type { Customer } from "@/lib/types";

export const DAYS_IN_CYCLE = 30;

export type PacingStatus = "behind" | "on_track" | "ahead";

export interface Pacing {
  daysElapsed: number;
  daysRemaining: number;
  expected: number;
  deficit: number;
  status: PacingStatus;
}

/**
 * Pacing maths for a single customer, mirroring the SQL used by
 * get_next_customers_for_lead:
 *
 *   days_elapsed = today - billing_cycle_anchor
 *   expected     = ROUND((days_elapsed / 30) * monthly_allocation)
 *   deficit      = expected - leads_received_this_month
 *
 * A positive deficit means the customer is behind pace. If the customer has no
 * billing_cycle_anchor yet (subscription webhook not received), we fall back to
 * their created_at so the number is still meaningful.
 */
export function computePacing(customer: Customer, now: Date = new Date()): Pacing {
  const anchorStr = customer.billing_cycle_anchor ?? customer.created_at;
  // Match the SQL (coalesce(billing_cycle_anchor, created_at::date)): count from
  // midnight of the anchor date, not the exact created_at instant, so the
  // dashboard deficit agrees with the value used for lead-ordering.
  const anchor = new Date(anchorStr);
  anchor.setHours(0, 0, 0, 0);

  const msPerDay = 1000 * 60 * 60 * 24;
  const rawElapsed = Math.floor((now.getTime() - anchor.getTime()) / msPerDay);
  const daysElapsed = Math.max(0, Math.min(rawElapsed, DAYS_IN_CYCLE));
  const daysRemaining = Math.max(0, DAYS_IN_CYCLE - daysElapsed);

  const allocation = customer.monthly_allocation ?? 20;
  const expected = Math.round((daysElapsed / DAYS_IN_CYCLE) * allocation);
  const deficit = expected - customer.leads_received_this_month;

  return { daysElapsed, daysRemaining, expected, deficit, status: statusFor(deficit) };
}

export function statusFor(deficit: number): PacingStatus {
  if (deficit >= 3) return "behind";
  if (deficit <= -3) return "ahead";
  return "on_track";
}

/**
 * Contextual sentence shown to the customer on their dashboard. Pass the
 * customer's monthly allocation so the "on track" copy reflects their plan
 * (10 or 20 leads) rather than a hardcoded number.
 */
export function pacingMessage(deficit: number, monthlyAllocation = 20): string {
  const status = statusFor(deficit);
  if (status === "behind") {
    return "You are behind pace this month — your leads are being prioritised.";
  }
  if (status === "ahead") {
    return "You are ahead of pace this month.";
  }
  return `You are on track to receive your ${monthlyAllocation} leads this month.`;
}
