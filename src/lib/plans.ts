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

/**
 * Guaranteed Rent plans.
 *
 * GR sold a single £150/10 plan for its whole life, which is why its price id
 * lived in one bare env var (`STRIPE_GR_MONTHLY_PRICE_ID`) rather than a plan
 * table. The £300/20 plan makes GR a two-plan product exactly as management is,
 * so it gets the same shape — and, critically, the same rule that the price id
 * a customer is billed on and the allocation credited to their row are derived
 * from ONE place.
 *
 * The 10-lead entry deliberately keeps the historical env var name. Renaming it
 * would silently unconfigure GR checkout on every deployed environment at the
 * moment this ships.
 *
 * Per-lead economics are unchanged: £300 for 20 is the same £15 a lead as £150
 * for 10, so `LEAD_PRICE_GBP` below needs no GR branch.
 */
export const GR_PLANS: Record<PlanKey, Plan> = {
  lead_10: {
    key: "lead_10",
    leads: 10,
    priceGbp: 150,
    priceEnv: "STRIPE_GR_MONTHLY_PRICE_ID",
  },
  lead_20: {
    key: "lead_20",
    leads: 20,
    priceGbp: 300,
    priceEnv: "STRIPE_GR_PRICE_ID_20",
  },
};

/** The plan table for a product. */
export function plansFor(leadType: LeadType | string | undefined): Record<PlanKey, Plan> {
  return leadType === "guaranteed_rent" ? GR_PLANS : PLANS;
}

export const DEFAULT_PLAN: PlanKey = "lead_20";

/**
 * The plan a GR request falls back to when it names none.
 *
 * `lead_10` — NOT the management default of `lead_20`. Every GR caller that
 * predates the 20-lead plan (the /signup GR funnel, marketing links) sends no
 * plan at all, and they are all asking for the £150/10 plan GR has always sold.
 * Sharing management's default would silently upsell every one of them to £300.
 */
export const DEFAULT_GR_PLAN: PlanKey = "lead_10";

/** Narrow an untrusted string to a valid plan key, falling back to the default. */
export function toPlanKey(value: unknown): PlanKey {
  return value === "lead_10" || value === "lead_20" ? value : DEFAULT_PLAN;
}

/** Narrow an untrusted string to a GR plan key, falling back to the GR default. */
export function toGrPlanKey(value: unknown): PlanKey {
  return value === "lead_10" || value === "lead_20" ? value : DEFAULT_GR_PLAN;
}

/** Map a stored monthly_allocation back to a plan (10 → lead_10, else lead_20). */
export function planForAllocation(allocation: number): Plan {
  return allocation <= 10 ? PLANS.lead_10 : PLANS.lead_20;
}

/** Map a stored gr_monthly_allocation back to a GR plan. */
export function grPlanForAllocation(allocation: number): Plan {
  return allocation <= 10 ? GR_PLANS.lead_10 : GR_PLANS.lead_20;
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
 * Resolve the Stripe Price id for a GR allocation.
 *
 * Throws rather than falling back to the 10-lead price: billing a customer who
 * chose the £300/20 plan on the £150/10 price would be a silent mis-charge, and
 * a 500 at checkout is a far better outcome than that.
 */
export function stripeGrPriceIdFor(allocation: number): string {
  const plan = grPlanForAllocation(allocation);
  const id = process.env[plan.priceEnv];
  if (!id) {
    throw new Error(
      `Missing Stripe price env var for Guaranteed Rent ${plan.leads} leads (set ${plan.priceEnv}).`
    );
  }
  return id;
}

/** Every GR price id configured in this environment, in plan order. */
export function configuredGrPriceIds(): string[] {
  return Object.values(GR_PLANS)
    .map((plan) => process.env[plan.priceEnv])
    .filter((id): id is string => Boolean(id));
}

/**
 * Whether any of these Stripe price ids belongs to Guaranteed Rent.
 *
 * THIS IS THE PRODUCT ROUTER for every Stripe webhook event, and it must know
 * about ALL GR prices. It used to be an equality test against the single
 * `STRIPE_GR_MONTHLY_PRICE_ID`, which meant a GR subscription on any other
 * price fell through to the management branch — crediting management leads for
 * a GR invoice, and flipping `account_status` on a GR cancellation, in direct
 * breach of invariant 6. That is why this is derived from the plan table rather
 * than written out at each of the webhook's call sites.
 *
 * Fails closed on an unconfigured env var: an unknown price is treated as
 * management, exactly as before, so a management Payment Link referencing a
 * price object that is not in env keeps working.
 */
export function isGuaranteedRentPriceId(priceIds: string[]): boolean {
  const grIds = configuredGrPriceIds();
  return grIds.length > 0 && priceIds.some((id) => grIds.includes(id));
}

/**
 * The GR allocation implied by a set of price ids, or null if none is a known
 * GR price. Used only to detect drift against the customer row — never to
 * overwrite a hand-edited allocation. See the webhook's credit path.
 */
export function grAllocationForPriceIds(priceIds: string[]): number | null {
  for (const plan of Object.values(GR_PLANS)) {
    const configured = process.env[plan.priceEnv];
    if (configured && priceIds.includes(configured)) return plan.leads;
  }
  return null;
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
