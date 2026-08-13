import type { Customer } from "@/lib/types";

export const DAYS_IN_CYCLE = 30;

/**
 * Deficit at or beyond which an unfiltered customer is "critically behind" and
 * reclaims a lead slot from a matching filtered candidate (the guarantee-floor
 * override in routing). Matches the admin supply-problem alert threshold
 * (deficit >= 5) — the strongest existing behind-pace signal.
 */
export const CRITICALLY_BEHIND_DEFICIT = 5;

export type PacingStatus = "behind" | "on_track" | "ahead";

export interface Pacing {
  daysElapsed: number;
  daysRemaining: number;
  expected: number;
  deficit: number;
  status: PacingStatus;
  /**
   * The plan allocation actually owed this cycle: allocation − pool debit,
   * floored at zero. Equals `allocation` for the overwhelming majority of
   * customers, who have never claimed from the pool.
   */
  effectiveAllocation: number;
  /** Leads claimed from the pool last cycle and being settled from this one. */
  poolDebit: number;
}

/**
 * Leads a customer is owed this cycle.
 *
 * A customer on 20 a month who claimed 3 from the expired pool while at zero
 * balance is owed 17 this cycle — they have already had the other 3. Counting
 * the full 20 would show them a deficit of 3 for the whole month, name them on
 * the admin supply-problem banner, and push leads at them ahead of customers
 * who genuinely are short.
 *
 * Floored at zero, matching public.effective_allocation(): a debit larger than
 * the allocation means the customer has already drawn more than this cycle
 * owes, and a negative expectation would rank them below customers who are
 * exactly level.
 */
export function effectiveAllocation(
  allocation: number | null | undefined,
  poolDebit: number | null | undefined
): number {
  return Math.max((allocation ?? 0) - (poolDebit ?? 0), 0);
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

  const poolDebit = customer.pool_debit ?? 0;
  const allocation = effectiveAllocation(customer.monthly_allocation ?? 20, poolDebit);
  const expected = Math.round((daysElapsed / DAYS_IN_CYCLE) * allocation);
  const deficit = expected - customer.leads_received_this_month;

  return {
    daysElapsed,
    daysRemaining,
    expected,
    deficit,
    status: statusFor(deficit),
    effectiveAllocation: allocation,
    poolDebit,
  };
}

/**
 * GR pacing — the same maths as computePacing but on the guaranteed-rent
 * columns (gr_billing_cycle_anchor, gr_monthly_allocation,
 * gr_leads_received_this_month), mirroring the GR branch of
 * get_next_customers_for_lead.
 */
export function computeGrPacing(customer: Customer, now: Date = new Date()): Pacing {
  const anchorStr = customer.gr_billing_cycle_anchor ?? customer.created_at;
  // Normalised to midnight for the same reason computePacing is: the SQL counts
  // from coalesce(gr_billing_cycle_anchor, created_at::date), and created_at is
  // a full timestamp. Without this the fallback path kept its time-of-day and
  // could report a day less elapsed than the value used for lead-ordering.
  const anchor = new Date(anchorStr);
  anchor.setHours(0, 0, 0, 0);

  const msPerDay = 1000 * 60 * 60 * 24;
  const rawElapsed = Math.floor((now.getTime() - anchor.getTime()) / msPerDay);
  const daysElapsed = Math.max(0, Math.min(rawElapsed, DAYS_IN_CYCLE));
  const daysRemaining = Math.max(0, DAYS_IN_CYCLE - daysElapsed);

  const poolDebit = customer.gr_pool_debit ?? 0;
  const allocation = effectiveAllocation(customer.gr_monthly_allocation, poolDebit);
  const expected = Math.round((daysElapsed / DAYS_IN_CYCLE) * allocation);
  const deficit = expected - customer.gr_leads_received_this_month;

  return {
    daysElapsed,
    daysRemaining,
    expected,
    deficit,
    status: statusFor(deficit),
    effectiveAllocation: allocation,
    poolDebit,
  };
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
 *
 * Pass the EFFECTIVE allocation where a debit is in play. Promising "your 20
 * leads this month" to a customer who is owed 18 sets up a complaint we would
 * deserve; poolDebitExplanation() below says why the number moved.
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

/**
 * Why this cycle's allocation is smaller than the plan, or null when it is not.
 *
 * A reduced number with no explanation reads as a mistake, and the customer's
 * first move is to email support about leads they have already had. Naming the
 * cause turns it into a receipt for a choice they made.
 *
 * Plain, no exclamation, no apology: the customer got the leads, this is the
 * bill. Singular/plural handled because "1 leads" undercuts the tone the rest
 * of the pool copy is written in.
 */
export function poolDebitExplanation(
  effectiveAllocationThisCycle: number,
  poolDebit: number
): string | null {
  if (poolDebit <= 0) return null;
  const leads = poolDebit === 1 ? "1 lead" : `${poolDebit} leads`;
  return (
    `${effectiveAllocationThisCycle} leads this cycle. ` +
    `Your allocation is reduced by ${leads} you claimed from expired leads last cycle.`
  );
}
