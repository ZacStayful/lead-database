import { createAdminClient } from "@/lib/supabase/admin";
import { PLANS } from "@/lib/plans";
import type { LeadType } from "@/lib/types";

/**
 * Weighted lead-capacity accounting.
 *
 * `system_settings.max_active_customers` is the cap on committed monthly lead
 * volume, expressed in "slots". Historically the used side of that comparison
 * was a raw headcount — a 10-lead customer and a 20-lead customer each consumed
 * one slot even though they represent different monthly commitments. This helper
 * replaces the headcount with a weighted sum: each active customer consumes
 * `monthly_allocation / SLOT_ALLOCATION` slots (a 20-lead customer = 1.0, a
 * 10-lead customer = 0.5).
 *
 * This is the single source of truth for "how much capacity is used". The admin
 * overview, the invite route, and the enquiry route all call it rather than
 * re-deriving the SQL/JS, so the rule can't drift between call sites.
 *
 * The two products are capped independently (0054): `max_active_customers` for
 * management, `gr_max_active_customers` for Guaranteed Rent. They are separate
 * numbers with separate populations and separate weights — a GR subscriber
 * consumes no management capacity and vice versa.
 */

/**
 * The monthly allocation that equals one full capacity slot.
 *
 * Anchored to the standard full-size plan's allocation (currently 20) rather
 * than a bare literal, so the weighting stays correct if plan copy/pricing is
 * edited in `plans.ts`. This is a fixed reference unit, NOT the largest plan:
 * a 10-lead customer is half the monthly commitment of a 20-lead customer, so
 * half a slot. If a bigger plan (e.g. 40 leads) is ever added, that customer
 * automatically counts as >1 slot, which is the intended behaviour.
 */
const SLOT_ALLOCATION = PLANS.lead_20.leads;

/**
 * The GR monthly allocation that equals one full GR capacity slot.
 *
 * Guaranteed Rent sells a single plan — £150/mo for 10 leads — so the reference
 * unit is 10, not 20, and one standard GR subscriber is exactly one slot. That
 * is what makes "10 / 10 slots used" read as "10 guaranteed rent customers",
 * which is how the cap is set. Weighting rather than counting heads still means
 * an unusually-sized GR allocation (set by hand in admin) is accounted for
 * honestly instead of counting as one like everybody else.
 */
const GR_SLOT_ALLOCATION = PLANS.lead_10.leads;

/**
 * Per-product capacity configuration.
 *
 * The GR row deliberately reads `gr_subscription_status`, NOT `account_status`.
 * `account_status` is management-only (CLAUDE.md §3, invariant 6) — the Stripe
 * webhook leaves it untouched on a GR cancellation, so using it here would keep
 * counting GR subscribers who had already gone, and would count management-only
 * customers who never held GR at all.
 */
const CAPACITY_PRODUCTS = {
  management: {
    settingKey: "max_active_customers",
    allocationColumn: "monthly_allocation",
    activeColumn: "account_status",
    slotAllocation: SLOT_ALLOCATION,
    label: "Management",
  },
  guaranteed_rent: {
    settingKey: "gr_max_active_customers",
    allocationColumn: "gr_monthly_allocation",
    activeColumn: "gr_subscription_status",
    slotAllocation: GR_SLOT_ALLOCATION,
    label: "Guaranteed Rent",
  },
} as const satisfies Record<LeadType, unknown>;

/** Default cap used when the settings row is missing — same for both products. */
const DEFAULT_LIMIT = 10;

/** Narrow an untrusted string to a capacity product, or null if it is neither. */
export function toCapacityProduct(value: unknown): LeadType | null {
  return value === "management" || value === "guaranteed_rent" ? value : null;
}

/** The `system_settings` key holding a product's cap. */
export function capacitySettingKey(product: LeadType): string {
  return CAPACITY_PRODUCTS[product].settingKey;
}

/** Capacity (in slots) that a single customer consumes for their allocation. */
export function capacityWeight(monthlyAllocation: number | null | undefined): number {
  return (monthlyAllocation ?? 0) / SLOT_ALLOCATION;
}

/** GR capacity (in slots) consumed by a single customer's GR allocation. */
export function grCapacityWeight(
  grMonthlyAllocation: number | null | undefined
): number {
  return (grMonthlyAllocation ?? 0) / GR_SLOT_ALLOCATION;
}

/** Round to at most 2 decimals so display/comparison isn't tripped by float noise. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface CapacityStatus {
  /** Which product this figure describes. */
  product: LeadType;
  /** Sum of per-customer weights across all active accounts. */
  weightedUsed: number;
  /** The product's cap from system_settings (unchanged in meaning). */
  limit: number;
  /** Unweighted count of active accounts — for display context. */
  rawActiveCount: number;
  /** True when weighted usage is already over the limit. */
  exceedsLimit: boolean;
  /** Human-readable warning when over the limit, else null. */
  warningMessage: string | null;
}

/**
 * Compute current weighted capacity usage for one product.
 *
 * Management counts `account_status = 'active'` customers — the same population
 * the raw headcount check used — weighted by `monthly_allocation`. Guaranteed
 * Rent counts `gr_subscription_status = 'active'` weighted by
 * `gr_monthly_allocation`. Neither population or column set overlaps the other.
 */
export async function getProductCapacityStatus(
  product: LeadType
): Promise<CapacityStatus> {
  const cfg = CAPACITY_PRODUCTS[product];
  const admin = createAdminClient();

  const { data: setting } = await admin
    .from("system_settings")
    .select("value")
    .eq("key", cfg.settingKey)
    .maybeSingle();
  const parsed = parseInt(setting?.value ?? "", 10);
  const limit = Number.isFinite(parsed) ? parsed : DEFAULT_LIMIT;

  // is_active is the master switch: an account switched off receives no leads
  // from any routing path, so it commits no monthly volume and must not consume
  // a capacity slot. The admin demo account is the case in point — it holds an
  // allocation for demonstration but is switched off, and counting it would
  // reserve a full slot against a customer who will never be sent a lead.
  const { data: rows } = await admin
    .from("customers")
    .select(cfg.allocationColumn)
    .eq(cfg.activeColumn, "active")
    .eq("is_active", true);

  const active = (rows ?? []) as unknown as Array<Record<string, number | null>>;
  const rawActiveCount = active.length;
  const weightedUsed = round2(
    active.reduce(
      (sum, c) => sum + (c[cfg.allocationColumn] ?? 0) / cfg.slotAllocation,
      0
    )
  );

  const exceedsLimit = weightedUsed > limit;
  const warningMessage = exceedsLimit
    ? `${cfg.label} weighted capacity is at ${weightedUsed} of ${limit} slots — over the limit.`
    : null;

  return { product, weightedUsed, limit, rawActiveCount, exceedsLimit, warningMessage };
}

/**
 * Management capacity usage.
 *
 * Kept as a named export with no argument because it is the figure the invite
 * and signup paths gate on; those are management-only decisions and should not
 * have to name a product to get the number they have always used.
 */
export async function getCapacityStatus(): Promise<CapacityStatus> {
  return getProductCapacityStatus("management");
}

/** Guaranteed Rent capacity usage. */
export async function getGrCapacityStatus(): Promise<CapacityStatus> {
  return getProductCapacityStatus("guaranteed_rent");
}
