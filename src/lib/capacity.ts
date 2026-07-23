import { createAdminClient } from "@/lib/supabase/admin";
import { PLANS } from "@/lib/plans";

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

/** Capacity (in slots) that a single customer consumes for their allocation. */
export function capacityWeight(monthlyAllocation: number | null | undefined): number {
  return (monthlyAllocation ?? 0) / SLOT_ALLOCATION;
}

/** Round to at most 2 decimals so display/comparison isn't tripped by float noise. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface CapacityStatus {
  /** Sum of per-customer weights across all active accounts. */
  weightedUsed: number;
  /** `max_active_customers` from system_settings (unchanged in meaning). */
  limit: number;
  /** Unweighted count of active accounts — for display context. */
  rawActiveCount: number;
  /** True when weighted usage is already over the limit. */
  exceedsLimit: boolean;
  /** Human-readable warning when over the limit, else null. */
  warningMessage: string | null;
}

/**
 * Compute current weighted capacity usage.
 *
 * Counts only `account_status = 'active'` customers — the same population the
 * raw headcount check used. Guaranteed Rent is deliberately excluded: this sums
 * `monthly_allocation` (the management allocation), and GR has no capacity cap.
 */
export async function getCapacityStatus(): Promise<CapacityStatus> {
  const admin = createAdminClient();

  const { data: setting } = await admin
    .from("system_settings")
    .select("value")
    .eq("key", "max_active_customers")
    .single();
  const limit = parseInt(setting?.value ?? "10", 10);

  const { data: rows } = await admin
    .from("customers")
    .select("monthly_allocation")
    .eq("account_status", "active");

  const active = rows ?? [];
  const rawActiveCount = active.length;
  const weightedUsed = round2(
    active.reduce((sum, c) => sum + capacityWeight(c.monthly_allocation), 0)
  );

  const exceedsLimit = weightedUsed > limit;
  const warningMessage = exceedsLimit
    ? `Weighted capacity is at ${weightedUsed} of ${limit} slots — over the limit.`
    : null;

  return { weightedUsed, limit, rawActiveCount, exceedsLimit, warningMessage };
}
