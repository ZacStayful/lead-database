/**
 * Subscription plans — the single source of truth for the two lead tiers.
 *
 * The per-customer discriminator stored in the database is `monthly_allocation`
 * (10 or 20). Everything else about a plan (price, Stripe price id, marketing
 * copy) is derived from this file, so allocation logic elsewhere
 * (get_next_customers_for_lead, assign_lead_to_customer, pacing) needs no change.
 */

export type PlanKey = "lead_10" | "lead_20";

export interface Plan {
  key: PlanKey;
  /** Monthly lead allocation — also the value written to customers.monthly_allocation. */
  leads: number;
  /** Headline monthly price in GBP (ex VAT). */
  priceGbp: number;
  /** Env var holding the Stripe Price id for this plan. */
  priceEnv: string;
}

export const PLANS: Record<PlanKey, Plan> = {
  lead_10: { key: "lead_10", leads: 10, priceGbp: 150, priceEnv: "STRIPE_PRICE_ID_10" },
  lead_20: { key: "lead_20", leads: 20, priceGbp: 300, priceEnv: "STRIPE_PRICE_ID_20" },
};

export const DEFAULT_PLAN: PlanKey = "lead_20";

/** Narrow an untrusted string to a valid plan key, falling back to the default. */
export function toPlanKey(value: unknown): PlanKey {
  return value === "lead_10" || value === "lead_20" ? value : DEFAULT_PLAN;
}

/** Map a stored monthly_allocation back to a plan (10 → lead_10, else lead_20). */
export function planForAllocation(allocation: number): Plan {
  return allocation <= 10 ? PLANS.lead_10 : PLANS.lead_20;
}

/**
 * Resolve the Stripe Price id for a customer's allocation.
 *
 * The £300/20 plan keeps its historical env var `STRIPE_MONTHLY_PRICE_ID` for
 * backwards compatibility; a newer `STRIPE_PRICE_ID_20` overrides it if set.
 */
export function stripePriceIdFor(allocation: number): string {
  const plan = planForAllocation(allocation);
  const id =
    process.env[plan.priceEnv] ??
    (plan.key === "lead_20" ? process.env.STRIPE_MONTHLY_PRICE_ID : undefined);
  if (!id) {
    throw new Error(
      `Missing Stripe price env var for ${plan.key} (set ${plan.priceEnv}` +
        (plan.key === "lead_20" ? " or STRIPE_MONTHLY_PRICE_ID" : "") +
        ")."
    );
  }
  return id;
}
