import type { SupabaseClient } from "@supabase/supabase-js";
import { describeError } from "@/lib/logError";
import {
  buildBriefMatch,
  rankBriefCandidates,
  supplyLeadOf,
  type BriefAreaFields,
  type BriefCandidateRow,
  type BriefMatchRecord,
  type BriefScoringFields,
} from "@/lib/leadBrief/score";
import type { Customer, Lead } from "@/lib/types";

/**
 * The server half of Lead Brief routing (Phase 4). SERVER-SIDE ONLY.
 *
 * Three things, each small, each never throwing into the money path:
 *   - the `lead_brief_enabled` switch (0162), read with a short cache;
 *   - the ranked brief candidates for one lead (0163's function, scored in
 *     score.ts);
 *   - the label and "why" written onto a brief customer's assignment.
 */

/* ------------------------------------------------------------------ *
 * The switch
 * ------------------------------------------------------------------ */

const SWITCH_CACHE_MS = 30_000;
let switchCache: { enabled: boolean; readAt: number } | null = null;

/** Exported for tests, which must not inherit a cached value between cases. */
export function resetBriefSwitchCache(): void {
  switchCache = null;
}

/**
 * Whether brief routing is on.
 *
 * ⚠️ FAILS CLOSED, and a failed read is NOT cached. Off means brief customers
 * receive nothing from routing, which is the delivery gate working as
 * designed (Phase 0 §3); on by mistake would route on a switch an admin left
 * off. A blip costs a brief customer one pass, and the next call re-reads.
 *
 * Only the literal "true" is on, the way every other switch here is read.
 */
export async function briefRoutingEnabled(admin: SupabaseClient): Promise<boolean> {
  const now = Date.now();
  if (switchCache && now - switchCache.readAt < SWITCH_CACHE_MS) return switchCache.enabled;
  const { data, error } = await admin
    .from("system_settings")
    .select("value")
    .eq("key", "lead_brief_enabled")
    .maybeSingle();
  if (error) {
    console.error("[lead-brief] lead_brief_enabled read failed, treating as off", error);
    return false;
  }
  const enabled = ((data as { value?: string } | null)?.value ?? "").trim() === "true";
  switchCache = { enabled, readAt: now };
  return enabled;
}

/* ------------------------------------------------------------------ *
 * Candidates
 * ------------------------------------------------------------------ */

/**
 * How many brief candidates to read for one lead. The SQL orders by deficit,
 * the score orders by the customer's priorities, so asking for only the open
 * slots could cut the best match off before it is scored.
 */
export const BRIEF_CANDIDATE_PROBE = 50;

/**
 * Brief customers for one lead, best first. Management leads only.
 *
 * ⚠️ A FAILED READ IS AN EMPTY LIST, never an error that stops the legacy
 * placement it runs beside: brief customers come LAST (Phase 0 §2), so losing
 * them for one pass costs nobody else anything.
 */
export async function fetchRankedBriefCandidates(
  admin: SupabaseClient,
  lead: Lead,
  opts: { includePace: boolean }
): Promise<string[]> {
  if (lead.lead_type !== "management") return [];
  const { data, error, status } = await admin.rpc("get_brief_candidates_for_lead", {
    p_lead_id: lead.id,
    p_max: BRIEF_CANDIDATE_PROBE,
    p_include_pace: opts.includePace,
  });
  if (error) {
    console.error("[lead-brief] brief candidates failed; skipping brief customers", {
      lead_id: lead.id,
      error: describeError(error, status),
    });
    return [];
  }
  return rankBriefCandidates(supplyLeadOf(lead), (data ?? []) as BriefCandidateRow[]).map(
    (c) => c.customerId
  );
}

/* ------------------------------------------------------------------ *
 * The label written onto the assignment
 * ------------------------------------------------------------------ */

/** Whether this customer's deliveries carry a brief label. */
export function isBriefCustomer(
  customer: Pick<Customer, "lead_brief_required" | "lead_brief_completed_at">
): boolean {
  return customer.lead_brief_required === true && !!customer.lead_brief_completed_at;
}

type BriefRow = BriefScoringFields & BriefAreaFields & { id: string };

/**
 * Write match_label, match_score, match_reasons and match_brief_id onto a
 * brief customer's assignment, and return what was written (Phase 5 puts the
 * label in the email). Null for everyone else, and on any failure.
 *
 * Brief customers ONLY, and Management leads only: a GR lead a brief customer
 * also holds is never labelled (invariant 6, the brief is Management only).
 * Every other customer costs nothing here — the test is on the customer row
 * completeAssignment has already loaded.
 *
 * ⚠️ NEVER THROWS. It runs inside completeAssignment, downstream of the single
 * money path; a failure costs a label, never the assignment or the alerts.
 *
 * ⚠️ FIRST SALE IS "NO OTHER ROW" (D6). The First pick label claims the
 * customer was first to receive the lead, so it is given only when no other
 * assignment row exists for it. A failed count reads as NOT first, the
 * weaker claim. Known and accepted: a discarded earlier assignment leaves no
 * row behind (discard deletes it), so a lead discarded untouched by its first
 * holder can read as a first sale to the next.
 *
 * Written only where no label is set yet, so a retry cannot relabel.
 */
export async function recordBriefMatch(
  admin: SupabaseClient,
  customer: Customer,
  lead: Lead,
  assignmentId: string
): Promise<BriefMatchRecord | null> {
  if (!isBriefCustomer(customer) || lead.lead_type !== "management") return null;
  try {
    const { data: brief, error: briefErr } = await admin
      .from("customer_lead_briefs")
      .select(
        "id, allocation, travel_limit_miles, base_outcode, priority_outcodes, similar_areas, priorities, service_outcodes, first_pick_outcodes, pace_outcodes"
      )
      .eq("customer_id", customer.id)
      .eq("status", "active")
      .maybeSingle();
    if (briefErr || !brief) {
      if (briefErr) console.error("[lead-brief] active brief read failed", { assignmentId, error: briefErr });
      return null;
    }

    const others = await admin
      .from("lead_assignments")
      .select("id", { count: "exact", head: true })
      .eq("lead_id", lead.id)
      .neq("id", assignmentId);
    const isFirstSale = !others.error && others.count === 0;
    if (others.error) {
      console.error("[lead-brief] first-sale count failed; not calling it a first pick", {
        assignmentId,
        error: describeError(others.error, others.status),
      });
    }

    const record = buildBriefMatch(supplyLeadOf(lead), brief as BriefRow, { isFirstSale });
    const { error: writeErr } = await admin
      .from("lead_assignments")
      .update({
        match_label: record.label,
        match_score: record.score,
        match_reasons: record.reasons,
        match_brief_id: (brief as BriefRow).id,
      })
      .eq("id", assignmentId)
      .is("match_label", null);
    if (writeErr) {
      console.error("[lead-brief] match write failed", { assignmentId, error: writeErr });
      return null;
    }
    return record;
  } catch (error) {
    console.error("[lead-brief] recordBriefMatch failed", { assignmentId, error });
    return null;
  }
}
