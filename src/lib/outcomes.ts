import { createAdminClient } from "@/lib/supabase/admin";
import type { LeadType } from "@/lib/types";

/**
 * Everything the admin outcome view reads.
 *
 * One fetch, four questions: which leads were won, how each customer compares,
 * which recorded outcomes are not supported by what the operator actually did,
 * and which landlords have been ingested more than once.
 *
 * Every call degrades to an empty result rather than throwing, for the same
 * reason serviceHealth does: the most likely cause of failure is this feature's
 * migration not being applied to the environment yet, and one unavailable panel
 * must not take the page with it.
 */

export interface Win {
  assignmentId: string;
  businessName: string;
  leadName: string;
  leadType: LeadType;
  leadProfile: string | null;
  address: string | null;
  bedrooms: string | null;
  incomeEstimate: number | null;
  assignedAt: string;
  wonAt: string;
  daysToWin: number | null;
  pipelineStage: string;
  /** Won on a lead another operator had ignored first. */
  wasEscalated: boolean;
  operatorsOnLead: number;
}

export interface ScoreboardRow {
  customerId: string;
  businessName: string;
  monthlyAllocation: number | null;
  delivered: number;
  worked: number;
  workedRate: number | null;
  attempted: number;
  wins: number;
  winsPerAttempted: number | null;
  medianDaysToWin: number | null;
}

export interface OutcomeEvidence {
  assignmentId: string;
  businessName: string;
  leadName: string;
  status: string;
  closedReason: string | null;
  pipelineStage: string;
  contactAttempts: number;
  opens: number;
  noteCount: number;
  notes: string | null;
  evidenceLevel: "strong" | "partial" | "none";
  contradicted: boolean;
  reviewReason: string | null;
}

export interface DuplicateGroup {
  confidence: "exact" | "probable";
  leadName: string;
  email: string | null;
  phone: string | null;
  leadType: LeadType;
  copies: number;
  assignmentsMade: number;
  firstSeen: string;
  lastSeen: string;
  spansProducts: boolean;
}

export interface OutcomeOverview {
  unavailable: boolean;
  wins: Win[];
  scoreboard: ScoreboardRow[];
  needsReview: OutcomeEvidence[];
  duplicates: DuplicateGroup[];
}

const n = (v: unknown): number => Number(v ?? 0);
const nOrNull = (v: unknown): number | null => (v == null ? null : Number(v));
const sOrNull = (v: unknown): string | null => (v == null ? null : String(v));

export async function getOutcomeOverview(): Promise<OutcomeOverview> {
  const admin = createAdminClient();

  const [winsRes, boardRes, evidenceRes, dupRes] = await Promise.all([
    admin.rpc("get_wins"),
    admin.rpc("get_customer_scoreboard"),
    admin.rpc("get_outcome_evidence"),
    admin.rpc("get_duplicate_leads"),
  ]);

  if (winsRes.error || boardRes.error || evidenceRes.error || dupRes.error) {
    console.error(
      "[outcomes] unavailable",
      winsRes.error ?? boardRes.error ?? evidenceRes.error ?? dupRes.error
    );
    return {
      unavailable: true,
      wins: [],
      scoreboard: [],
      needsReview: [],
      duplicates: [],
    };
  }

  const wins: Win[] = ((winsRes.data ?? []) as Record<string, unknown>[]).map(
    (r) => ({
      assignmentId: String(r.assignment_id),
      businessName: String(r.business_name ?? ""),
      leadName: String(r.lead_name ?? ""),
      leadType: r.lead_type as LeadType,
      leadProfile: sOrNull(r.lead_profile),
      address: sOrNull(r.address),
      bedrooms: sOrNull(r.bedrooms),
      incomeEstimate: nOrNull(r.income_estimate),
      assignedAt: String(r.assigned_at),
      wonAt: String(r.won_at),
      daysToWin: nOrNull(r.days_to_win),
      pipelineStage: String(r.pipeline_stage ?? ""),
      wasEscalated: Boolean(r.was_escalated),
      operatorsOnLead: n(r.operators_on_lead),
    })
  );

  const scoreboard: ScoreboardRow[] = (
    (boardRes.data ?? []) as Record<string, unknown>[]
  )
    .map((r) => ({
      customerId: String(r.customer_id),
      businessName: String(r.business_name ?? ""),
      monthlyAllocation: nOrNull(r.monthly_allocation),
      delivered: n(r.delivered),
      worked: n(r.worked),
      workedRate: nOrNull(r.worked_rate),
      attempted: n(r.attempted),
      wins: n(r.wins),
      winsPerAttempted: nOrNull(r.wins_per_attempted),
      medianDaysToWin: nOrNull(r.median_days_to_win),
    }))
    // Customers who have never been sent a lead have nothing to compare and
    // would sit at the bottom of every ranking looking like poor performers.
    .filter((r) => r.delivered > 0)
    // Wins first, then how much of what they were sent they actually worked.
    // Deliberately not a single composite score — see get_customer_scoreboard.
    .sort((a, b) => b.wins - a.wins || (b.workedRate ?? 0) - (a.workedRate ?? 0));

  // Only the rows with something to look at. An evidence list that includes
  // every well-supported outcome is a list nobody opens twice.
  const needsReview: OutcomeEvidence[] = (
    (evidenceRes.data ?? []) as Record<string, unknown>[]
  )
    .map((r) => ({
      assignmentId: String(r.assignment_id),
      businessName: String(r.business_name ?? ""),
      leadName: String(r.lead_name ?? ""),
      status: String(r.status ?? ""),
      closedReason: sOrNull(r.closed_reason),
      pipelineStage: String(r.pipeline_stage ?? ""),
      contactAttempts: n(r.contact_attempts),
      opens: n(r.opens),
      noteCount: n(r.note_count),
      notes: sOrNull(r.notes),
      evidenceLevel: (r.evidence_level as OutcomeEvidence["evidenceLevel"]) ?? "none",
      contradicted: Boolean(r.contradicted),
      reviewReason: sOrNull(r.review_reason),
    }))
    .filter((r) => r.reviewReason != null);

  const duplicates: DuplicateGroup[] = (
    (dupRes.data ?? []) as Record<string, unknown>[]
  ).map((r) => ({
    confidence: (r.confidence as DuplicateGroup["confidence"]) ?? "exact",
    leadName: String(r.lead_name ?? ""),
    email: sOrNull(r.email),
    phone: sOrNull(r.phone),
    leadType: r.lead_type as LeadType,
    copies: n(r.copies),
    assignmentsMade: n(r.assignments_made),
    firstSeen: String(r.first_seen),
    lastSeen: String(r.last_seen),
    spansProducts: Boolean(r.spans_products),
  }));

  return { unavailable: false, wins, scoreboard, needsReview, duplicates };
}

/**
 * Why customers pause, and what happened next (0077).
 *
 * FETCHED SEPARATELY from getOutcomeOverview, deliberately. That function makes
 * every panel unavailable if any one of its RPCs errors, which is right when the
 * four ship as one release — but this one ships later, so bundling it would take
 * the whole outcomes page dark on any environment where 0077 has not been
 * applied yet. Here a missing function costs only this block.
 */
export interface PauseInsight {
  unavailable: boolean;
  /** Every pause ever recorded. */
  total: number;
  /** Pauses that have finished with an observable outcome. */
  completed: number;
  /**
   * reason -> how many pauses cited it. A pause citing two reasons counts once
   * under each, so these deliberately sum to more than `total`.
   */
  reasonCounts: { reason: string; count: number }[];
  outcomeCounts: { outcome: string; count: number }[];
  /** reason by outcome, suppressed until the sample can carry it. */
  crossTab: { reason: string; outcome: string; count: number }[];
  crossTabSuppressed: boolean;
  /** Stripe's own cancellation reason, for customers who left outright. */
  cancellationFeedback: { feedback: string; count: number }[];
  cancellationComments: { businessName: string; comment: string }[];
}

/**
 * Completed pauses needed before the reason-by-outcome breakdown is shown.
 *
 * Below this one customer moves a whole cell, and the block would read as "100%
 * of lead-quality pauses churn" off a single person. Plain counts are shown at
 * any size — a count with its N attached is honest, where a breakdown implies a
 * rate. Same instinct as the cohort suppression in section 10.
 */
const CROSS_TAB_MIN_COMPLETED = 10;

export async function getPauseInsight(): Promise<PauseInsight> {
  const admin = createAdminClient();
  const empty: PauseInsight = {
    unavailable: true,
    total: 0,
    completed: 0,
    reasonCounts: [],
    outcomeCounts: [],
    crossTab: [],
    crossTabSuppressed: true,
    cancellationFeedback: [],
    cancellationComments: [],
  };

  const [outcomesRes, cancelRes] = await Promise.all([
    admin.rpc("get_pause_outcomes"),
    admin
      .from("customers")
      .select("business_name, cancellation_feedback, cancellation_comment")
      .not("cancellation_feedback", "is", null),
  ]);

  if (outcomesRes.error) {
    console.error("[outcomes] pause insight unavailable", outcomesRes.error);
    return empty;
  }

  const rows = (outcomesRes.data ?? []) as Record<string, unknown>[];
  const total = rows.length;
  // "Completed" excludes pauses still running AND those whose end was never
  // stamped: an outcome we could not observe is not evidence either way.
  const finished = rows.filter(
    (r) => r.outcome !== "active" && r.outcome !== "ended_untracked"
  );
  const completed = finished.length;

  const tally = (keys: string[]): { key: string; count: number }[] => {
    const m = new Map<string, number>();
    for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
    // Array.from rather than spreading the iterator: this project's tsconfig
    // target does not enable downlevelIteration, so [...map.entries()] fails to
    // compile even though it type-checks fine in isolation.
    return Array.from(m.entries())
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count);
  };

  const crossTabSuppressed = completed < CROSS_TAB_MIN_COMPLETED;

  const cancelRows = (cancelRes.data ?? []) as {
    business_name: string;
    cancellation_feedback: string | null;
    cancellation_comment: string | null;
  }[];

  return {
    unavailable: false,
    total,
    completed,
    reasonCounts: tally(
      rows.flatMap((r) => ((r.reasons ?? []) as string[]).map(String))
    ).map(({ key, count }) => ({ reason: key, count })),
    outcomeCounts: tally(rows.map((r) => String(r.outcome))).map(
      ({ key, count }) => ({ outcome: key, count })
    ),
    crossTab: crossTabSuppressed
      ? []
      : tally(
          finished.flatMap((r) =>
            ((r.reasons ?? []) as string[]).map((x) => `${x}|${r.outcome}`)
          )
        ).map(({ key, count }) => {
          const [reason, outcome] = key.split("|");
          return { reason, outcome, count };
        }),
    crossTabSuppressed,
    cancellationFeedback: tally(
      cancelRows.map((r) => r.cancellation_feedback ?? "unknown")
    ).map(({ key, count }) => ({ feedback: key, count })),
    cancellationComments: cancelRows
      .filter((r) => r.cancellation_comment)
      .map((r) => ({
        businessName: r.business_name,
        comment: r.cancellation_comment as string,
      })),
  };
}
