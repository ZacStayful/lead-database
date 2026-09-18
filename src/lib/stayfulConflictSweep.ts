/**
 * The fifteen-minute sweep over already-ingested management leads (§64).
 *
 * Stayful's "Qualified lead" automation moves an item INTO a pipeline group
 * after it has been sold — 5 of the 11 live conflicts arrived that way — so
 * an ingest-time check alone would miss most of them. This pass reads the
 * nine groups fresh, matches every unflagged management lead, flags each
 * match (withdrawing live assignments and recording what is owed), and then
 * tries EVERY open debt against stock, not only this run's: a customer who
 * was paused when they were owed is filled the moment they resume, and
 * yesterday's debt is tried against today's stock.
 *
 * ⚠️ NOTHING IS FLAGGED ON A FAILED BOARD READ. A sweep that could not look
 * must not conclude anything (§18.3's rule for the escalation cron). Ingest
 * fails the other way, on purpose — see stayfulConflictIndex.ts.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchStayfulPipelineIndex,
  STAYFUL_PIPELINE_CONFLICT_GROUPS,
} from "@/lib/monday";
import {
  buildStayfulPipelineIndex,
  findStayfulConflict,
  type StayfulConflictMatch,
} from "@/lib/stayfulConflict";
import {
  flagStayfulConflictLead,
  fulfilOpenOwedFromStock,
  type OnAssigned,
} from "@/lib/owedReplacements";
import { completeAssignment } from "@/lib/ingest";
import type { Lead } from "@/lib/types";

/** Pinned to a literal by the guard test; never derived. */
export const STAYFUL_SWEEP_BUDGET_MS = 45_000;

export interface StayfulConflictSweepResult {
  ok: boolean;
  dry_run: boolean;
  /** Pipeline items indexed. A permanent zero means a group id has moved. */
  fetched: number;
  /** Unflagged management leads examined. */
  examined: number;
  matched: number;
  flagged: number;
  withdrawn: number;
  fulfilled: number;
  owed_waiting: number;
  /** Open debts after the run. */
  owed_open: number;
  would_flag?: {
    lead_id: string;
    lead_name: string;
    item_id: string;
    group_id: string;
    group_name: string;
    matched_by: string;
    live_assignments: number;
  }[];
  truncated: boolean;
  errors: string[];
}

type SweepLead = Pick<
  Lead,
  | "id"
  | "lead_name"
  | "lead_type"
  | "monday_item_id"
  | "email"
  | "phone"
  | "assignment_count"
  | "max_assignments"
  | "stayful_conflict_at"
>;

export async function runStayfulConflictSweep(
  admin: SupabaseClient,
  opts: { dryRun: boolean; budgetMs?: number }
): Promise<StayfulConflictSweepResult> {
  const started = Date.now();
  const deadline = started + (opts.budgetMs ?? STAYFUL_SWEEP_BUDGET_MS);
  const result: StayfulConflictSweepResult = {
    ok: true,
    dry_run: opts.dryRun,
    fetched: 0,
    examined: 0,
    matched: 0,
    flagged: 0,
    withdrawn: 0,
    fulfilled: 0,
    owed_waiting: 0,
    owed_open: 0,
    truncated: false,
    errors: [],
  };

  const board = await fetchStayfulPipelineIndex();
  if (!board.ok) {
    result.ok = false;
    result.errors.push(board.error);
    return result;
  }
  const index = buildStayfulPipelineIndex(board.items);
  result.fetched = index.size;

  const { data: leadsRaw, error: leadsErr } = await admin
    .from("leads")
    .select(
      "id, lead_name, lead_type, monday_item_id, email, phone, assignment_count, max_assignments, stayful_conflict_at"
    )
    .eq("lead_type", "management")
    .is("stayful_conflict_at", null)
    .is("owner_customer_id", null);
  if (leadsErr) {
    result.ok = false;
    result.errors.push(leadsErr.message);
    return result;
  }
  const leads = (leadsRaw ?? []) as SweepLead[];
  result.examined = leads.length;

  const matches: { lead: SweepLead; match: StayfulConflictMatch }[] = [];
  for (const lead of leads) {
    const match = findStayfulConflict(lead, index);
    if (match) matches.push({ lead, match });
  }
  result.matched = matches.length;

  if (opts.dryRun) {
    const ids = matches.map((m) => m.lead.id);
    const live = new Map<string, number>();
    if (ids.length > 0) {
      const { data: rows } = await admin
        .from("lead_assignments")
        .select("lead_id, status, closed_at")
        .in("lead_id", ids);
      for (const r of (rows ?? []) as { lead_id: string; status: string; closed_at: string | null }[]) {
        if (["new", "contacted", "in_discussion"].includes(r.status) && !r.closed_at) {
          live.set(r.lead_id, (live.get(r.lead_id) ?? 0) + 1);
        }
      }
    }
    result.would_flag = matches.map(({ lead, match }) => ({
      lead_id: lead.id,
      lead_name: lead.lead_name,
      item_id: match.itemId,
      group_id: match.groupId,
      group_name:
        STAYFUL_PIPELINE_CONFLICT_GROUPS[
          match.groupId as keyof typeof STAYFUL_PIPELINE_CONFLICT_GROUPS
        ] ?? match.groupId,
      matched_by: match.matchedBy,
      live_assignments: live.get(lead.id) ?? 0,
    }));
    const { count } = await admin
      .from("owed_lead_replacements")
      .select("id", { count: "exact", head: true })
      .eq("status", "open");
    result.owed_open = count ?? 0;
    return result;
  }

  const onAssigned: OnAssigned = (lead, customerId, assignmentId) =>
    completeAssignment(admin, lead, customerId, assignmentId, false);

  for (const { lead, match } of matches) {
    if (Date.now() > deadline) {
      result.truncated = true;
      break;
    }
    try {
      const outcome = await flagStayfulConflictLead(admin, lead as Lead, match, onAssigned);
      result.flagged += 1;
      result.withdrawn += outcome.withdrawn;
      result.fulfilled += outcome.fulfilled;
      result.owed_waiting += outcome.waiting;
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  if (!result.truncated) {
    const stock = await fulfilOpenOwedFromStock(admin, onAssigned, { deadline });
    result.fulfilled += stock.fulfilled;
    result.truncated = stock.truncated;
    result.errors.push(...stock.errors);
  }

  const { count } = await admin
    .from("owed_lead_replacements")
    .select("id", { count: "exact", head: true })
    .eq("status", "open");
  result.owed_open = count ?? 0;

  if (result.errors.length > 0) result.ok = false;
  return result;
}
