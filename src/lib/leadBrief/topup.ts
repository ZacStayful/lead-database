import { distancesFrom, distancesFromNearest, outcodeOfPostcode } from "@/lib/leadBrief/geo";
import { PLAN_MAX_MILES, isBriefPlan } from "@/lib/leadBrief/plans";
import type { Customer, Lead, LeadType } from "@/lib/types";

/**
 * Top-ups for Lead Brief customers (batch 04 Phase 4, locked decision 6).
 *
 * A brief customer's top-up costs credits and follows rollover, like anyone's.
 * What differs is where its leads come from: the closest matching outcodes
 * BEYOND the service area, nearest first, never further than the plan maximum
 * (40 or 75 miles), and never inside the area. Their area's supply is already
 * set by their plan.
 *
 * The credits themselves are counted by customers.brief_topup_credits (0170):
 * part of lead_balance, kept for leads beyond the area. The in-area pool
 * spends only the rest (get_brief_candidates_for_lead), and the morning
 * release's top-up pass (briefRelease.ts) spends these through
 * assign_brief_topup_lead.
 *
 * ⚠️ THE DISTANCE LIVES HERE, NOT IN SQL. The database holds no outcode
 * centroids, so 0170 checks "outside the service area" and this file decides
 * "within the plan maximum, nearest first", the way the pace pass orders
 * pace_outcodes.
 *
 * ⚠️ C7, decided in the build: the reach is the PLAN MAXIMUM, as locked
 * decision 6 says, not the customer's travel limit the pace ring stops at.
 * Nearest first means anything inside the travel limit still comes first.
 */

/**
 * Whether a top-up for this product goes beyond a brief customer's area, the
 * same test 0170's record_lead_topup_success uses: a Management top-up for a
 * customer with lead_brief_required. Everyone else's top-up is unchanged.
 */
export function briefTopupApplies(
  customer: Pick<Customer, "lead_brief_required">,
  leadType: LeadType
): boolean {
  return leadType === "management" && customer.lead_brief_required === true;
}

type Credits = Pick<Customer, "lead_balance"> & { brief_topup_credits?: number | null };

/**
 * Top-up credits the customer can still be sent leads on: never more than the
 * balance holds, as get_brief_topup_candidates_for_lead reads it (a credit
 * spent elsewhere comes out of the plan share first, 0170).
 */
export function briefTopupCredits(c: Credits): number {
  return Math.max(0, Math.min(c.brief_topup_credits ?? 0, c.lead_balance ?? 0));
}

/** Plan credits: what the in-area pool may spend (lead_balance > brief_topup_credits). */
export function briefPlanCredits(c: Credits): number {
  return Math.max(0, (c.lead_balance ?? 0) - (c.brief_topup_credits ?? 0));
}

/** The active brief's columns the reach is worked out from. */
export interface TopupBrief {
  allocation: number;
  base_outcode: string;
  priority_outcodes: string[] | null;
  service_outcodes: string[] | null;
}

/**
 * Every outcode a top-up lead may come from, nearest first.
 *
 *   - beyond the service area (first picks and the pace ring included),
 *   - within the plan maximum of the base, the point the A3 cap is measured
 *     from,
 *   - ordered by distance from the customer's nearest area (the base and the
 *     other areas they named), the order the pace ring uses.
 *
 * Empty when the plan or the base cannot be placed, so a malformed brief is
 * sent nothing rather than something from anywhere.
 */
export function topupReach(brief: TopupBrief): string[] {
  if (!isBriefPlan(brief.allocation)) return [];
  const cap = PLAN_MAX_MILES[brief.allocation];
  const fromBase = distancesFrom(brief.base_outcode);
  if (!fromBase) return [];
  const centres = [brief.base_outcode];
  for (const oc of brief.priority_outcodes ?? []) if (!centres.includes(oc)) centres.push(oc);
  const order = distancesFromNearest(centres) ?? fromBase;
  const service = new Set(brief.service_outcodes ?? []);

  const out: string[] = [];
  for (const oc of Array.from(order.keys())) {
    if (service.has(oc)) continue;
    const d = fromBase.get(oc);
    if (d !== undefined && d <= cap) out.push(oc);
  }
  return out;
}

/**
 * The top-up pass's order for one customer: the nearest outcode first, then
 * the lead that has waited longest. Leads outside the reach are dropped.
 */
export function topupLeadsFor(leads: Lead[], reach: string[]): Lead[] {
  const rank = new Map(reach.map((oc, i) => [oc, i] as const));
  return leads
    .map((lead) => ({ lead, at: rank.get(outcodeOfPostcode(lead.postcode) ?? "") }))
    .filter((x): x is { lead: Lead; at: number } => x.at !== undefined)
    .sort((a, b) => a.at - b.at || Date.parse(a.lead.created_at) - Date.parse(b.lead.created_at))
    .map((x) => x.lead);
}
