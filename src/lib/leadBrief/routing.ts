import type { SupabaseClient } from "@supabase/supabase-js";
import { describeError } from "@/lib/logError";
import { tierForOutcode } from "@/lib/leadBrief/areas";
import { areaOfOutcode } from "@/lib/leadBrief/geo";
import {
  buildBriefMatch,
  rankBriefCandidates,
  supplyLeadOf,
  type BriefAreaFields,
  type BriefCandidateRow,
  type BriefMatchRecord,
  type BriefScoringFields,
  type MatchProgress,
} from "@/lib/leadBrief/score";
import type { CompetitionTier } from "@/lib/leadBrief/types";
import { computePacing } from "@/lib/pacing";
import { nextGrantDate } from "@/lib/quality/replacementEntitlement";
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
 * Written only where no label is set yet, so a retry cannot relabel. A run
 * that writes nothing returns null, so an alert can never carry a label that
 * disagrees with the one stored.
 *
 * Phase 5: `routed` says routing sent this lead (autoAssignLead, or the
 * release's pace pass). Only then is the customer's progress stored, because
 * only then is "sent to keep your leads on track" true. Every hand placement —
 * an admin assign, a swap, a replacement — stays neutral.
 */
export async function recordBriefMatch(
  admin: SupabaseClient,
  customer: Customer,
  lead: Lead,
  assignmentId: string,
  opts: { routed: boolean } = { routed: false }
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

    const supplyLead = supplyLeadOf(lead);
    const inFirstPickArea =
      supplyLead.outcode !== null &&
      ((brief as BriefRow).first_pick_outcodes ?? []).includes(supplyLead.outcode) &&
      !((brief as BriefRow).service_outcodes ?? []).includes(supplyLead.outcode);
    const competition = inFirstPickArea
      ? await competitionTierFor(admin, supplyLead.outcode as string)
      : null;

    const record = buildBriefMatch(supplyLead, brief as BriefRow, {
      isFirstSale,
      progress: opts.routed ? deliveryProgress(customer) : null,
      competition,
    });
    const { data: written, error: writeErr } = await admin
      .from("lead_assignments")
      .update({
        match_label: record.label,
        match_score: record.score,
        match_reasons: record.reasons,
        match_brief_id: (brief as BriefRow).id,
      })
      .eq("id", assignmentId)
      .is("match_label", null)
      .select("id");
    if (writeErr) {
      console.error("[lead-brief] match write failed", { assignmentId, error: writeErr });
      return null;
    }
    if (!written || written.length === 0) return null;
    return record;
  } catch (error) {
    console.error("[lead-brief] recordBriefMatch failed", { assignmentId, error });
    return null;
  }
}

/**
 * The customer's progress at the moment a lead arrives, for the Nearby reason
 * (Phase 5). Read from the customer row completeAssignment loads AFTER the
 * assign, so `received` includes this lead.
 *
 *   received   leads_received_this_month
 *   allocation pacing's effectiveAllocation, as the dashboard card shows it
 *   days_left  days from today to the next renewal (nextGrantDate), the date
 *              every renewal message prints
 *
 * Null when a figure is missing. buildBriefMatch then also drops it whenever
 * the sentence would be false (x ≥ N, or no days left).
 */
export function deliveryProgress(customer: Customer, now: Date = new Date()): MatchProgress | null {
  const received = customer.leads_received_this_month;
  if (typeof received !== "number" || !Number.isFinite(received)) return null;
  const allocation = computePacing(customer, now).effectiveAllocation;
  const renewal = nextGrantDate(customer, now);
  if (!renewal) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days_left = Math.round((Date.parse(`${renewal}T00:00:00Z`) - today) / 86_400_000);
  if (!Number.isFinite(days_left)) return null;
  return { received, allocation, days_left };
}

/**
 * The admin-set tier (D5) of a lead's outcode, falling back to its postcode
 * area. Null on any failure, which only drops the "low competition" clause.
 */
async function competitionTierFor(
  admin: SupabaseClient,
  outcode: string
): Promise<CompetitionTier | null> {
  const codes = [outcode, areaOfOutcode(outcode)];
  const { data, error } = await admin
    .from("area_competition")
    .select("area_kind, area_code, tier")
    .eq("source", "admin")
    .in("area_code", codes);
  if (error) {
    console.error("[lead-brief] competition tier read failed; leaving it out", error.message);
    return null;
  }
  const map: Record<string, CompetitionTier> = {};
  for (const r of (data ?? []) as { area_kind: string; area_code: string; tier: string }[]) {
    if (r.tier === "high" || r.tier === "medium" || r.tier === "low") {
      map[`${r.area_kind}:${r.area_code}`] = r.tier;
    }
  }
  return tierForOutcode(outcode, map);
}
