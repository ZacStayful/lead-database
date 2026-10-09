import type { SupabaseClient } from "@supabase/supabase-js";
import { autoAssignLead, completeAssignment } from "@/lib/ingest";
import { outcodeOfPostcode } from "@/lib/leadBrief/geo";
import { briefRoutingEnabled, BRIEF_CANDIDATE_PROBE } from "@/lib/leadBrief/routing";
import { briefPacePctFrom, computePacing, isBehindBriefPace } from "@/lib/pacing";
import { leadPriceFor } from "@/lib/plans";
import { DEFAULT_MAX_ASSIGNMENTS, type Customer, type Lead } from "@/lib/types";

/**
 * The morning release's two Lead Brief passes (Phase 4). SERVER-SIDE ONLY.
 * Run by releasePendingLeads AFTER its ordinary pass, which offers every lead
 * to legacy customers exactly as before and never to a brief customer.
 *
 *   Pass 2 — first sale first. Every under-assigned Management lead in some
 *            brief's service or first-pick area is offered to brief customers
 *            only, leads that nobody has bought yet before a lead's second or
 *            third sale, then oldest first (the build prompt's "First sale
 *            first"). The daily curve (0148) still gives each customer at most
 *            their slot for the day, so the order decides WHICH lead it is.
 *
 *   Pass 3 — behind pace (A11). For each brief customer behind pace, leads in
 *            their pace outcodes (beyond the service area, inside the plan
 *            maximum), NEAREST FIRST. Each is re-checked through
 *            get_brief_candidates_for_lead, which applies the pace test, the
 *            curve, the cap and the balance, and assigned through the existing
 *            assign_lead_to_customer, unchanged.
 *
 * Nothing runs while lead_brief_enabled is off.
 */

export interface BriefReleaseResult {
  first_sale_assignments: number;
  pace_assignments: number;
  truncated?: boolean;
  skipped?: "disabled" | "unreadable";
}

/** Pass 3 reads at most this many leads per behind-pace customer. */
export const PACE_LEADS_PER_CUSTOMER = 10;

interface BriefWithCustomer {
  customer_id: string;
  service_outcodes: string[] | null;
  first_pick_outcodes: string[] | null;
  pace_outcodes: string[] | null;
  customer: Customer | Customer[] | null;
}

/**
 * Whether routing could send this brief customer a Management lead today, on
 * the columns the candidate function gates on. A pre-filter only: the SQL
 * re-checks all of it under its own reading.
 */
export function briefCustomerRoutable(c: Customer | null | undefined): c is Customer {
  return (
    !!c &&
    c.is_active === true &&
    c.lead_brief_required === true &&
    !!c.lead_brief_completed_at &&
    c.account_status === "active" &&
    c.subscription_status === "active" &&
    (c.lead_balance ?? 0) > 0 &&
    !c.paused_at
  );
}

/**
 * Pass 2's order: a lead nobody has bought yet first, then the lead that has
 * waited longest. Pure, so the rule is tested rather than reviewed.
 */
export function firstSaleOrder(a: Lead, b: Lead): number {
  const aFirst = (a.assignment_count ?? 0) === 0 ? 0 : 1;
  const bFirst = (b.assignment_count ?? 0) === 0 ? 0 : 1;
  return aFirst - bFirst || Date.parse(a.created_at) - Date.parse(b.created_at);
}

/**
 * Pass 3's order for one customer: nearest pace outcode first (pace_outcodes
 * is stored nearest first, 0162), then oldest. Leads outside the list are
 * dropped.
 */
export function paceLeadsFor(leads: Lead[], paceOutcodes: string[]): Lead[] {
  const rank = new Map(paceOutcodes.map((oc, i) => [oc, i] as const));
  return leads
    .map((lead) => ({ lead, at: rank.get(outcodeOfPostcode(lead.postcode) ?? "") }))
    .filter((x): x is { lead: Lead; at: number } => x.at !== undefined)
    .sort((a, b) => a.at - b.at || Date.parse(a.lead.created_at) - Date.parse(b.lead.created_at))
    .map((x) => x.lead);
}

function hasFreeSlot(lead: Lead): boolean {
  return (lead.assignment_count ?? 0) < (lead.max_assignments ?? DEFAULT_MAX_ASSIGNMENTS);
}

/** The same leads releasePendingLeads offers, Management only, re-read fresh. */
async function pendingManagementLeads(admin: SupabaseClient): Promise<Lead[] | null> {
  const { data, error } = await admin
    .from("leads")
    .select("*")
    .eq("lead_type", "management")
    .or("owner_customer_id.is.null,owner_resale_qualified_at.not.is.null")
    .is("stayful_conflict_at", null)
    .order("created_at", { ascending: true });
  if (error) {
    console.error("[lead-brief] release: pending leads unreadable", error);
    return null;
  }
  return ((data ?? []) as Lead[]).filter(hasFreeSlot);
}

export async function releaseToBriefCustomers(
  admin: SupabaseClient,
  opts: { deadline: number }
): Promise<BriefReleaseResult> {
  const result: BriefReleaseResult = { first_sale_assignments: 0, pace_assignments: 0 };
  if (!(await briefRoutingEnabled(admin))) return { ...result, skipped: "disabled" };

  const [briefsRes, pctRes] = await Promise.all([
    admin
      .from("customer_lead_briefs")
      .select(
        "customer_id, service_outcodes, first_pick_outcodes, pace_outcodes, customer:customers!inner(*)"
      )
      .eq("status", "active"),
    admin.from("system_settings").select("value").eq("key", "lead_brief_pace_deficit_pct").maybeSingle(),
  ]);
  if (briefsRes.error) {
    console.error("[lead-brief] release: briefs unreadable", briefsRes.error);
    return { ...result, skipped: "unreadable" };
  }
  const briefs = ((briefsRes.data ?? []) as unknown as BriefWithCustomer[])
    .map((b) => ({ ...b, customer: Array.isArray(b.customer) ? b.customer[0] : b.customer }))
    .filter((b): b is BriefWithCustomer & { customer: Customer } => briefCustomerRoutable(b.customer));
  if (briefs.length === 0) return result;

  // ---- Pass 2: first sale first, inside the service and first-pick areas ----
  const reachable = new Set<string>();
  for (const b of briefs) {
    for (const oc of b.service_outcodes ?? []) reachable.add(oc);
    for (const oc of b.first_pick_outcodes ?? []) reachable.add(oc);
  }
  const pass2 = await pendingManagementLeads(admin);
  if (!pass2) return { ...result, skipped: "unreadable" };
  const offer = pass2
    .filter((l) => reachable.has(outcodeOfPostcode(l.postcode) ?? ""))
    .sort(firstSaleOrder);
  for (const lead of offer) {
    if (Date.now() > opts.deadline) return { ...result, truncated: true };
    result.first_sale_assignments += await autoAssignLead(admin, lead, {
      brief: "only",
      includePace: false,
    });
  }

  // ---- Pass 3: behind-pace widening, customer by customer, nearest first ----
  const pct = briefPacePctFrom(
    pctRes.error ? null : (pctRes.data as { value?: string } | null)?.value
  );
  const behind = briefs
    .filter((b) => (b.pace_outcodes ?? []).length > 0 && isBehindBriefPace(b.customer, pct))
    // Furthest behind first: when two behind-pace customers want the same
    // lead, the one owed most this cycle gets it.
    .sort((a, b) => computePacing(b.customer).deficit - computePacing(a.customer).deficit);
  if (behind.length === 0) return result;

  const pass3 = await pendingManagementLeads(admin);
  if (!pass3) return { ...result, skipped: "unreadable" };
  const price = leadPriceFor("management");

  for (const b of behind) {
    for (const lead of paceLeadsFor(pass3, b.pace_outcodes ?? []).slice(0, PACE_LEADS_PER_CUSTOMER)) {
      if (Date.now() > opts.deadline) return { ...result, truncated: true };
      if (!hasFreeSlot(lead)) continue;

      const { data: rows, error } = await admin.rpc("get_brief_candidates_for_lead", {
        p_lead_id: lead.id,
        p_max: BRIEF_CANDIDATE_PROBE,
        p_include_pace: true,
      });
      if (error) {
        console.error("[lead-brief] release: pace check failed", { lead_id: lead.id, error });
        continue;
      }
      const admitted = ((rows ?? []) as { customer_id: string }[]).some(
        (r) => r.customer_id === b.customer_id
      );
      if (!admitted) continue;

      const { data: assignmentId, error: assignError } = await admin.rpc(
        "assign_lead_to_customer",
        {
          p_lead_id: lead.id,
          p_customer_id: b.customer_id,
          p_price: price,
          p_lead_type: "management",
        }
      );
      if (assignError || !assignmentId) continue;
      lead.assignment_count = (lead.assignment_count ?? 0) + 1;
      result.pace_assignments += 1;
      await completeAssignment(admin, lead, b.customer_id, assignmentId as string);
    }
  }

  return result;
}
