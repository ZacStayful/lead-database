import { parseBedrooms } from "@/lib/filterPrediction";
import { outcodeOfPostcode } from "@/lib/leadBrief/geo";
import { evaluateLead, labelFor, type LeadEvaluation, type MatchContext } from "@/lib/leadBrief/match";
import { capMilesFor, isBriefPlan, isTravelLimit } from "@/lib/leadBrief/plans";
import {
  PRIORITY_KEYS,
  type BriefPriority,
  type CompetitionTier,
  type MatchLabel,
  type PriorityKey,
  type SupplyLead,
} from "@/lib/leadBrief/types";
import type { Lead } from "@/lib/types";

/**
 * Routing and labelling for a Lead Brief customer (Phase 4). Pure: the SQL
 * decides who is ELIGIBLE (get_brief_candidates_for_lead, 0163); this decides
 * the ORDER among them and the label each delivery carries.
 *
 * One definition with the preview: the score and the label come from
 * evaluateLead / labelFor in match.ts, the functions the expected mix a
 * customer was shown at confirmation was computed with.
 */

/** A lead as the engine sees it, from the leads row routing already holds. */
export function supplyLeadOf(
  lead: Pick<
    Lead,
    "postcode" | "postcode_area" | "bedrooms" | "gross_annual_income" | "avg_nightly_rate" | "occupancy_rate"
  >
): SupplyLead {
  const num = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    // The same pattern as leads.outcode (0161), which is what the SQL tested.
    outcode: outcodeOfPostcode(lead.postcode),
    area: lead.postcode_area?.trim().toUpperCase() || null,
    bedrooms: parseBedrooms(lead.bedrooms),
    gross: num(lead.gross_annual_income),
    nightly: num(lead.avg_nightly_rate),
    occupancy: num(lead.occupancy_rate),
  };
}

/**
 * customer_lead_briefs.priorities (0162) back into the engine's shape. An
 * omitted threshold is "could not be resolved" (prioritiesForStorage), so it
 * comes back as null and that priority is not judged. An unknown key or a
 * malformed entry is dropped rather than guessed at: the CHECK already refuses
 * both, so this only ever runs on what the CHECK let through.
 */
export function prioritiesFromStorage(raw: unknown): BriefPriority[] {
  if (!Array.isArray(raw)) return [];
  const out: BriefPriority[] = [];
  const seen = new Set<PriorityKey>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const key = (entry as { key?: unknown }).key;
    if (typeof key !== "string" || !(PRIORITY_KEYS as readonly string[]).includes(key)) continue;
    if (seen.has(key as PriorityKey)) continue;
    seen.add(key as PriorityKey);
    const t = (entry as { threshold?: unknown }).threshold;
    out.push({
      key: key as PriorityKey,
      threshold: typeof t === "number" && Number.isFinite(t) ? t : null,
    });
  }
  return out;
}

/** The brief fields scoring needs, as both the candidate RPC and the brief row carry them. */
export interface BriefScoringFields {
  allocation: number | null;
  travel_limit_miles: number | null;
  base_outcode: string;
  priority_outcodes: string[] | null;
  similar_areas: string[] | null;
  priorities: unknown;
}

export function matchContextFor(brief: BriefScoringFields): MatchContext {
  const plan = isBriefPlan(brief.allocation) ? brief.allocation : 20;
  const travel = isTravelLimit(brief.travel_limit_miles) ? brief.travel_limit_miles : null;
  return {
    baseOutcode: brief.base_outcode,
    priorityOutcodes: brief.priority_outcodes ?? [],
    similarAreas: brief.similar_areas ?? [],
    capMiles: capMilesFor(plan, travel),
  };
}

export function evaluateForBrief(lead: SupplyLead, brief: BriefScoringFields): LeadEvaluation {
  return evaluateLead(lead, prioritiesFromStorage(brief.priorities), matchContextFor(brief));
}

/** One row of get_brief_candidates_for_lead (0163). */
export interface BriefCandidateRow extends BriefScoringFields {
  customer_id: string;
  brief_id: string;
  /** Postgres numeric: PostgREST serialises it as a string. */
  deficit: number | string;
  last_assignment_at: string | null;
  in_service: boolean;
  in_first_pick: boolean;
  pace_only: boolean;
}

export interface ScoredBriefCandidate {
  customerId: string;
  briefId: string;
  paceOnly: boolean;
  score: number;
  deficit: number;
}

/**
 * The order brief customers are offered a lead in:
 *
 *   1. in the service area or a first-pick area, before a behind-pace widening
 *      (Phase 0 §2: at ingest, legacy, then in-area brief, then pace brief);
 *   2. highest score first (the customer's ranked priorities, match.ts);
 *   3. deficit breaks ties, largest first;
 *   4. then whoever waited longest for a lead, then the order the SQL gave.
 *
 * ⚠️ A DEFICIT NEVER OUTRANKS A SCORE. It is the tie-break the build prompt
 * names ("Highest score first; deficit breaks ties"), not a weight.
 */
export function rankBriefCandidates(lead: SupplyLead, rows: BriefCandidateRow[]): ScoredBriefCandidate[] {
  const scored = rows.map((row, index) => ({
    customerId: row.customer_id,
    briefId: row.brief_id,
    paceOnly: row.pace_only === true,
    score: evaluateForBrief(lead, row).score,
    deficit: Number(row.deficit) || 0,
    waited: row.last_assignment_at ? Date.parse(row.last_assignment_at) : Number.NEGATIVE_INFINITY,
    index,
  }));
  scored.sort(
    (a, b) =>
      Number(a.paceOnly) - Number(b.paceOnly) ||
      b.score - a.score ||
      b.deficit - a.deficit ||
      a.waited - b.waited ||
      a.index - b.index
  );
  return scored.map(({ customerId, briefId, paceOnly, score, deficit }) => ({
    customerId,
    briefId,
    paceOnly,
    score,
    deficit,
  }));
}

/* ------------------------------------------------------------------ *
 * The label and "why" written onto the assignment
 * ------------------------------------------------------------------ */

/** Why the lead was eligible, from the brief's own lists. */
export type MatchArea = "service" | "first_pick" | "pace" | "outside";

export interface BriefAreaFields {
  service_outcodes: string[] | null;
  first_pick_outcodes: string[] | null;
  pace_outcodes: string[] | null;
}

export function matchAreaFor(outcode: string | null, brief: BriefAreaFields): MatchArea {
  if (!outcode) return "outside";
  if ((brief.service_outcodes ?? []).includes(outcode)) return "service";
  if ((brief.first_pick_outcodes ?? []).includes(outcode)) return "first_pick";
  if ((brief.pace_outcodes ?? []).includes(outcode)) return "pace";
  return "outside";
}

/**
 * The version of match_reasons. Phase 5 renders by it; bump it on any change
 * to the shape rather than reinterpreting old rows.
 */
export const MATCH_REASONS_VERSION = 1;

export interface MatchReasonPriority {
  key: PriorityKey;
  threshold: number | null;
  /** The lead's figure: miles from the customer's nearest area, pounds, bedrooms or percent. */
  value: number | null;
  /** Null when the priority could not be judged. */
  met: boolean | null;
}

/**
 * What lead_assignments.match_reasons holds (0162).
 *
 * ⚠️ READ BY THE CUSTOMER'S OWN BROWSER. Every field is either the customer's
 * own brief or the lead's own figures, which the customer can already see on
 * the lead. Nothing about another holder, how many there are, any deficit or
 * any area volume (locked decision 9), and a test pins the key set.
 */
/**
 * The customer's own progress through their cycle at the moment a ROUTED
 * Nearby lead arrived (Phase 5): "sent to keep your N leads on track. You're on
 * x of N, with d days left". Stored, not recomputed, because the sentence
 * describes that moment.
 */
export interface MatchProgress {
  /** Leads received this cycle, this one included. */
  received: number;
  /** The plan's allocation net of any pool debit (pacing's effectiveAllocation). */
  allocation: number;
  /** Days until the next renewal. */
  days_left: number;
}

export interface MatchReasons {
  v: typeof MATCH_REASONS_VERSION;
  area: MatchArea;
  /** The First pick label, or the "First pick" tag on a Top match. */
  first_pick: boolean;
  priorities: MatchReasonPriority[];
  /**
   * Phase 5. Present only on a Nearby lead that routing sent to keep the
   * customer on pace, and only while it reads true (x < N, days left). A
   * hand-placed lead never carries it, so its reason stays neutral.
   */
  progress?: MatchProgress;
  /**
   * Phase 5. The admin-set competition tier (D5) of a lead in a first-pick
   * area, so the First pick reason can say "low competition" only when it is.
   */
  competition?: CompetitionTier;
  /**
   * Batch 04 Phase 4. Present only on a lead sent on a top-up credit, which
   * is always a Nearby opportunity from beyond the service area (locked
   * decision 6). The reason then reads "From just outside your area, as part
   * of your top-up."
   */
  topup?: true;
}

export interface BriefMatchRecord {
  label: MatchLabel;
  score: number;
  reasons: MatchReasons;
}

function round1(v: number | null): number | null {
  return v === null ? null : Math.round(v * 10) / 10;
}

/**
 * The label and reasons for one delivery to a brief customer.
 *
 * `isFirstSale` is true only when no other assignment row exists for the lead
 * (D6): First pick is never claimed when somebody had the lead first. A lead
 * outside the service area and the first-pick areas — a behind-pace widening,
 * or an admin's hand placement — is a Nearby opportunity whatever it scores.
 */
export function buildBriefMatch(
  lead: SupplyLead,
  brief: BriefScoringFields & BriefAreaFields,
  flags: {
    isFirstSale: boolean;
    /** Phase 5: the customer's progress, for a routed delivery only. */
    progress?: MatchProgress | null;
    /** Phase 5: the lead's admin-set tier, when known. */
    competition?: CompetitionTier | null;
    /**
     * Batch 04 Phase 4: sent on a top-up credit. Always Nearby opportunity
     * (locked decision 6), whatever it scores and wherever outside the
     * service area it is, with no progress and no competition clause.
     */
    topup?: boolean;
  }
): BriefMatchRecord {
  const evaluation = evaluateForBrief(lead, brief);
  const area = matchAreaFor(lead.outcode, brief);
  const inFirstPick =
    lead.outcode !== null && (brief.first_pick_outcodes ?? []).includes(lead.outcode);
  const { label, firstPickTag } = flags.topup
    ? { label: "nearby_opportunity" as const, firstPickTag: false }
    : labelFor(evaluation, {
        inFirstPick,
        isFirstSale: flags.isFirstSale,
        paceOnly: area === "pace" || area === "outside",
      });
  const reasons: MatchReasons = {
    v: MATCH_REASONS_VERSION,
    area,
    first_pick: label === "first_pick" || firstPickTag,
    priorities: evaluation.results.map((r) => ({
      key: r.key,
      threshold: r.threshold,
      value: r.key === "location" ? round1(r.value) : r.value,
      met: r.met,
    })),
  };
  if (flags.topup) {
    reasons.topup = true;
    return { label, score: evaluation.score, reasons };
  }
  const p = flags.progress;
  if (
    label === "nearby_opportunity" &&
    p &&
    p.received < p.allocation &&
    p.days_left > 0
  ) {
    reasons.progress = { received: p.received, allocation: p.allocation, days_left: p.days_left };
  }
  if (area === "first_pick" && flags.competition) reasons.competition = flags.competition;
  return { label, score: evaluation.score, reasons };
}
