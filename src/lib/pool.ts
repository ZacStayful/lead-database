import { createAdminClient } from "@/lib/supabase/admin";
import type { LeadType } from "@/lib/types";

/**
 * Admin reader for the expired leads pool.
 *
 * Follows the outcomes.ts arrangement: every panel is read in one pass and a
 * missing function degrades to `unavailable` rather than throwing, because the
 * usual cause is the migration not having been applied to this environment yet
 * and a blank panel with an explanation beats a 500.
 */

export interface PoolSummary {
  leadType: LeadType;
  inPool: number;
  inPoolIgnored: number;
  inPoolUnassigned: number;
  pendingEntry: number;
  claimedTotal: number;
  expiredTotal: number;
  excludedTotal: number;
  barredTotal: number;
  oldestInPoolDays: number;
}

export interface AdminPoolLead {
  leadId: string;
  leadName: string;
  address: string | null;
  postcodeArea: string | null;
  bedrooms: string | null;
  basis: string | null;
  assignmentCount: number;
  maxAssignments: number;
  poolEnteredAt: string;
  daysInPool: number;
  daysUntilExpiry: number;
  lastActivityAt: string | null;
}

export interface PoolClaim {
  assignmentId: string;
  leadId: string;
  leadName: string;
  leadType: LeadType;
  customerId: string;
  businessName: string;
  claimedAt: string;
  pricePaid: number;
  status: string;
  pipelineStage: string;
  customerPoolDebit: number;
}

export interface PoolOverview {
  unavailable: boolean;
  summary: PoolSummary[];
  management: AdminPoolLead[];
  guaranteedRent: AdminPoolLead[];
  claims: PoolClaim[];
}

const n = (v: unknown): number => Number(v ?? 0);
const sOrNull = (v: unknown): string | null => (v == null ? null : String(v));

function toLead(r: Record<string, unknown>): AdminPoolLead {
  return {
    leadId: String(r.lead_id),
    leadName: String(r.lead_name ?? ""),
    address: sOrNull(r.address),
    postcodeArea: sOrNull(r.postcode_area),
    bedrooms: sOrNull(r.bedrooms),
    basis: sOrNull(r.basis),
    assignmentCount: n(r.assignment_count),
    maxAssignments: n(r.max_assignments),
    poolEnteredAt: String(r.pool_entered_at),
    daysInPool: n(r.days_in_pool),
    daysUntilExpiry: n(r.days_until_expiry),
    lastActivityAt: sOrNull(r.last_activity_at),
  };
}

export async function getPoolOverview(): Promise<PoolOverview> {
  const admin = createAdminClient();

  const [summaryRes, mgmtRes, grRes, claimsRes] = await Promise.all([
    admin.rpc("get_admin_pool_summary"),
    admin.rpc("get_admin_pool_leads", { p_lead_type: "management" }),
    admin.rpc("get_admin_pool_leads", { p_lead_type: "guaranteed_rent" }),
    admin.rpc("get_pool_claim_history", { p_limit: 200 }),
  ]);

  if (summaryRes.error || mgmtRes.error || grRes.error || claimsRes.error) {
    console.error(
      "[pool] unavailable",
      summaryRes.error ?? mgmtRes.error ?? grRes.error ?? claimsRes.error
    );
    return {
      unavailable: true,
      summary: [],
      management: [],
      guaranteedRent: [],
      claims: [],
    };
  }

  const summary: PoolSummary[] = (
    (summaryRes.data ?? []) as Record<string, unknown>[]
  ).map((r) => ({
    leadType: r.lead_type as LeadType,
    inPool: n(r.in_pool),
    inPoolIgnored: n(r.in_pool_ignored),
    inPoolUnassigned: n(r.in_pool_unassigned),
    pendingEntry: n(r.pending_entry),
    claimedTotal: n(r.claimed_total),
    expiredTotal: n(r.expired_total),
    excludedTotal: n(r.excluded_total),
    barredTotal: n(r.barred_total),
    oldestInPoolDays: n(r.oldest_in_pool_days),
  }));

  const claims: PoolClaim[] = (
    (claimsRes.data ?? []) as Record<string, unknown>[]
  ).map((r) => ({
    assignmentId: String(r.assignment_id),
    leadId: String(r.lead_id),
    leadName: String(r.lead_name ?? ""),
    leadType: r.lead_type as LeadType,
    customerId: String(r.customer_id),
    businessName: String(r.business_name ?? ""),
    claimedAt: String(r.claimed_at),
    pricePaid: n(r.price_paid),
    status: String(r.status ?? ""),
    pipelineStage: String(r.pipeline_stage ?? ""),
    customerPoolDebit: n(r.customer_pool_debit),
  }));

  return {
    unavailable: false,
    summary,
    management: ((mgmtRes.data ?? []) as Record<string, unknown>[]).map(toLead),
    guaranteedRent: ((grRes.data ?? []) as Record<string, unknown>[]).map(toLead),
    claims,
  };
}
