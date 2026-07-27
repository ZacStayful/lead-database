/**
 * Subscription plans — the single source of truth for the two lead tiers.
 *
 * The per-customer discriminator stored in the database is `monthly_allocation`
 * (10 or 20). Everything else about a plan (price, Stripe price id, marketing
 * copy) is derived from this file, so allocation logic elsewhere
 * (get_next_customers_for_lead, assign_lead_to_customer, pacing) needs no change.
 */

import type { LeadType } from "@/lib/types";

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

/**
 * Price recorded against a single delivered lead, in POUNDS, per product.
 *
 * This is what goes into lead_assignments.price_paid — the per-lead attribution
 * every revenue figure sums. It is NOT what the customer is invoiced; that is
 * the monthly subscription above.
 *
 * Both products are £150/month for 10 leads, so both are £15 a lead.
 *
 * WHY THIS LIVES HERE
 * -------------------
 * It used to be three separate pairs of constants — in lib/ingest.ts, in
 * api/admin/assign/bulk, and as a bare literal in api/admin/assign. When
 * Guaranteed Rent was repriced from £100/mo to £150/mo (#46) the landing page,
 * signup page and .env.example were all updated and the code was not, so every
 * GR lead carried on being recorded at £10 against a £15 sale. Three copies is
 * why it was missed; one copy is the fix.
 */
export const LEAD_PRICE_GBP: Record<LeadType, number> = {
  management: 15.0,
  guaranteed_rent: 15.0,
};

/** Price to record for a lead of the given product. */
export function leadPriceFor(leadType: LeadType | string | undefined): number {
  return leadType === "guaranteed_rent"
    ? LEAD_PRICE_GBP.guaranteed_rent
    : LEAD_PRICE_GBP.management;
}

/**
 * Price recorded for a RECLAIMED lead, in pounds, per product.
 *
 * A reclaimed lead is a second-hand lead: another operator has had it for three
 * working days and may still be working it. Roughly a third off full price
 * reflects that, and both products carry the same discount because both are the
 * same £15 a lead.
 *
 * Deliberately explicit rather than computed as a fraction of LEAD_PRICE_GBP.
 * £15 × ⅔ is 10.000000000000002 in floating point, and a price is the last
 * place to accept a rounding surprise — but it lives here, beside the full
 * price, so the pair is read and changed together. Keeping them in separate
 * files is exactly how the GR price went stale in the first place (#49).
 */
export const RECLAIM_PRICE_GBP: Record<LeadType, number> = {
  management: 10.0,
  guaranteed_rent: 10.0,
};

/** Price to record for a reclaimed lead of the given product. */
export function reclaimPriceFor(leadType: LeadType | string | undefined): number {
  return leadType === "guaranteed_rent"
    ? RECLAIM_PRICE_GBP.guaranteed_rent
    : RECLAIM_PRICE_GBP.management;
}
