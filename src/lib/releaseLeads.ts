/**
 * Re-offer every under-assigned lead to the next eligible customers (§54).
 *
 * Extracted verbatim from /api/admin/leads/assign-pending so that TWO callers
 * run the same pass: the admin button, and the 07:30 weekday cron that fills
 * each customer's slot for the day BEFORE the 08:15 daily email goes out.
 *
 * Nothing here decides who gets a lead. Every lead goes through autoAssignLead,
 * whose two candidate RPCs carry the one-a-working-day rule
 * (customer_release_allows, 0148) — so with the switch off this is exactly the
 * backstop it has always been, and with it on it is the morning release.
 *
 * Leads are offered OLDEST FIRST so stock does not age behind fresh arrivals:
 * when a customer has one slot today, the lead that has waited longest gets it.
 *
 * Credit-gated (the same eligibility as fresh ingest), so it never gives paid
 * leads away, and it never charges twice: assign_lead_to_customer refuses a
 * duplicate under the row lock whatever this loop hands it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { autoAssignLead } from "@/lib/ingest";
import { DEFAULT_MAX_ASSIGNMENTS, type Lead, type LeadType } from "@/lib/types";

export interface ReleaseLeadsResult {
  status: "ok";
  pending: number;
  leads_topped_up: number;
  assignments: number;
  /** Set when the loop stopped early on the wall clock. */
  truncated?: boolean;
  dry_run?: boolean;
  /** Dry run only: the leads that would have been offered, oldest first. */
  would_offer?: { lead_id: string; lead_name: string; lead_type: string }[];
}

export async function releasePendingLeads(
  admin: SupabaseClient,
  opts: { leadType?: LeadType; dryRun?: boolean; budgetMs?: number } = {}
): Promise<ReleaseLeadsResult | { error: string }> {
  const started = Date.now();
  const budgetMs = opts.budgetMs ?? 240_000;

  // Column-vs-column comparisons aren't expressible in PostgREST, so pull the
  // leads and filter the shortfall in JS (open leads are a few hundred at most).
  //
  // Customer-owned leads are not ours to place, and this sweep is the one path
  // that would otherwise hand one to another customer at full price the day
  // after it was imported — WITH ONE EXCEPTION since §32. A lead whose paid
  // analysis came back with trustworthy figures is sellable to exactly one
  // further operator, and the analysis worker offers it the moment it
  // qualifies. If that call found no candidate — everybody at quota, which is
  // ordinary — this is where it gets picked up.
  //
  // Deliberately reopening what §30.8 closed, and only for qualified leads. The
  // cap still holds: assign_lead_to_customer refuses a third holder under the
  // row lock whatever this query returns.
  let query = admin
    .from("leads")
    .select("*")
    .or("owner_customer_id.is.null,owner_resale_qualified_at.not.is.null")
    .order("created_at", { ascending: true });
  if (opts.leadType) query = query.eq("lead_type", opts.leadType);

  const { data: leadsRaw, error } = await query;
  if (error) return { error: error.message };

  const pending = ((leadsRaw ?? []) as Lead[]).filter(
    (l) => (l.assignment_count ?? 0) < (l.max_assignments ?? DEFAULT_MAX_ASSIGNMENTS)
  );

  if (opts.dryRun) {
    return {
      status: "ok",
      dry_run: true,
      pending: pending.length,
      leads_topped_up: 0,
      assignments: 0,
      would_offer: pending.map((l) => ({
        lead_id: l.id,
        lead_name: l.lead_name,
        lead_type: l.lead_type ?? "management",
      })),
    };
  }

  let assignments = 0;
  let filled = 0;
  let truncated = false;
  for (const lead of pending) {
    if (Date.now() - started > budgetMs) {
      truncated = true;
      break;
    }
    const made = await autoAssignLead(admin, lead);
    assignments += made;
    if (made > 0) filled += 1;
  }

  return {
    status: "ok",
    pending: pending.length,
    leads_topped_up: filled,
    assignments,
    ...(truncated ? { truncated } : {}),
  };
}
