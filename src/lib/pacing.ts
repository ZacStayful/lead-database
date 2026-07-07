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
  const anchor = new Date(anchorStr);

  const msPerDay = 1000 * 60 * 60 * 24;
  const rawElapsed = Math.floor((now.getTime() - anchor.getTime()) / msPerDay);
  const daysElapsed = Math.max(0, Math.min(rawElapsed, DAYS_IN_CYCLE));
  const daysRemaining = Math.max(0, DAYS_IN_CYCLE - daysElapsed);

  const expected = Math.round(
    (daysElapsed / DAYS_IN_CYCLE) * customer.monthly_allocation
  );
  const deficit = expected - customer.leads_received_this_month;

  return { daysElapsed, daysRemaining, expected, deficit, status: statusFor(deficit) };
}

/**
 * GR pacing — the same maths as computePacing but on the guaranteed-rent
 * columns (gr_billing_cycle_anchor, gr_monthly_allocation,
 * gr_leads_received_this_month), mirroring the GR branch of
 * get_next_customers_for_lead.
 */
export function computeGrPacing(customer: Customer, now: Date = new Date()): Pacing {
  const anchorStr = customer.gr_billing_cycle_anchor ?? customer.created_at;
  const anchor = new Date(anchorStr);

  const msPerDay = 1000 * 60 * 60 * 24;
  const rawElapsed = Math.floor((now.getTime() - anchor.getTime()) / msPerDay);
  const daysElapsed = Math.max(0, Math.min(rawElapsed, DAYS_IN_CYCLE));
  const daysRemaining = Math.max(0, DAYS_IN_CYCLE - daysElapsed);

  const expected = Math.round(
    (daysElapsed / DAYS_IN_CYCLE) * customer.gr_monthly_allocation
  );
  const deficit = expected - customer.gr_leads_received_this_month;

  return { daysElapsed, daysRemaining, expected, deficit, status: statusFor(deficit) };
}

export function statusFor(deficit: number): PacingStatus {
  if (deficit >= 3) return "behind";
  if (deficit <= -3) return "ahead";
  return "on_track";
}

/** Contextual sentence shown to the customer on their dashboard. */
export function pacingMessage(deficit: number): string {
  const status = statusFor(deficit);
  if (status === "behind") {
    return "You are behind pace this month — your leads are being prioritised.";
  }
  if (status === "ahead") {
    return "You are ahead of pace this month.";
  }
  return "You are on track to receive your 20 leads this month.";
}
