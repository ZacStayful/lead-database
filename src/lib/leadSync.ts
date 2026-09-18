/**
 * The five-minute lead poll (§63.1): pull NEW sellable items off both Monday
 * lead boards within minutes of them appearing, instead of once a day.
 *
 * Measured before it was built: 263 of 279 marketplace leads in the preceding
 * 60 days were created at 10:00 London — the 09:00 UTC sync — and the instant
 * n8n webhook had no caller. Leads arrived once a day, in one lump.
 *
 * Shared by the cron and an admin dry run, the `releaseLeads.ts` two-caller
 * shape (§54). The 09:00 syncs are untouched and remain the backstop.
 *
 * ⚠️ IT INGESTS UNKNOWN ITEMS ONLY. The daily sync walks the whole board and
 * lands every lead already in the book in `ingestLead`'s duplicate branch,
 * which re-judges quality and re-runs allocation per lead — fine once a day,
 * ruinous every five minutes. So the poll reads ONE page per board, drops
 * every id already in `leads` with a single `in(...)` read, and hands only the
 * remainder to `ingestLead`.
 *
 * ⚠️ NO CLAIM TABLE, ARGUED. 0151 needed one because its side effects (a
 * customer row, a WhatsApp) happen before any unique key is written. Here the
 * FIRST side effect is the `leads` insert and `monday_item_id` is unique, so
 * two overlapping callers — this poll and the 09:00 sync, or this poll and the
 * admin button — both call `ingestLead` and the loser gets 23505 (reported as
 * `duplicate`, zero assignments) or the existing row. `assign_lead_to_customer`
 * refuses a duplicate under its row lock regardless. Idempotent by construction.
 *
 * ⚠️ THE SETTLE IS ON updated_at, AND IT DEFERS RATHER THAN CLAIMS. Ingest
 * never re-reads an item once it exists, so a lead ingested seconds after its
 * cells were half-typed is frozen that way. An item changed inside the last
 * two minutes is left for the next tick; since "unknown" is re-evaluated every
 * tick, a defer is free.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchRecentGuaranteedRentLeads,
  fetchRecentManagementLeads,
  type RecentLeadItem,
} from "@/lib/monday";
import { ingestLead } from "@/lib/ingest";
import type { LeadType } from "@/lib/types";

/** Leave an item alone until its cells have stopped changing. */
export const LEAD_SETTLE_MS = 120_000;
/** One page per board, newest-updated first. */
export const LEAD_POLL_PAGE = 30;
/** At most this many ingests per tick — a real ingest sends email and SMS. */
export const LEAD_POLL_MAX_INGEST = 10;
/** Wall clock, under the route's 60-second ceiling. */
export const LEAD_POLL_BUDGET_MS = 45_000;

export interface PickResult {
  ingest: RecentLeadItem[];
  deferred: number;
  known: number;
}

/**
 * PURE. Newest-first page in, oldest-first list of what to ingest out.
 *
 * Drops every item already in `leads`; defers anything updated inside the
 * settle window; reverses so the lead that has waited longest goes first; caps.
 */
export function pickItemsToIngest(
  items: RecentLeadItem[],
  knownIds: Set<string>,
  now: Date,
  settleMs: number,
  max: number
): PickResult {
  let deferred = 0;
  let known = 0;
  const fresh: RecentLeadItem[] = [];
  for (const item of items) {
    if (knownIds.has(String(item.payload.monday_item_id))) {
      known += 1;
      continue;
    }
    const updated = Date.parse(item.updatedAt || item.createdAt || "");
    if (Number.isFinite(updated) && now.getTime() - updated < settleMs) {
      deferred += 1;
      continue;
    }
    fresh.push(item);
  }
  fresh.reverse();
  return { ingest: fresh.slice(0, max), deferred, known };
}

export interface LeadSyncBoardReport {
  /** ⚠️ A permanent zero means the board or the status label moved and this is silently dead. */
  fetched: number;
  known: number;
  deferred: number;
  would_ingest: string[];
  created: number;
  /**
   * `ingestLead` answered "duplicate": a race with the daily sync (23505, or
   * the row landing between our read and the insert), or a landlord already
   * in the book under another item. All idempotent, none an error.
   */
  duplicates: number;
  assignments: number;
  errors: string[];
}

export interface LeadSyncResult {
  ok: boolean;
  dryRun: boolean;
  truncated: boolean;
  boards: Record<LeadType, LeadSyncBoardReport>;
  /** Board reads or the known-ids read failing outright. */
  errors: string[];
}

function emptyReport(): LeadSyncBoardReport {
  return {
    fetched: 0,
    known: 0,
    deferred: 0,
    would_ingest: [],
    created: 0,
    duplicates: 0,
    assignments: 0,
    errors: [],
  };
}

export async function syncNewMondayLeads(
  admin: SupabaseClient,
  opts: { dryRun?: boolean; now?: Date; budgetMs?: number; page?: number } = {}
): Promise<LeadSyncResult> {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun === true;
  const budgetMs = opts.budgetMs ?? LEAD_POLL_BUDGET_MS;
  // The wall clock is real time, whatever `now` was injected for the settle.
  const started = Date.now();

  const result: LeadSyncResult = {
    ok: true,
    dryRun,
    truncated: false,
    boards: { management: emptyReport(), guaranteed_rent: emptyReport() },
    errors: [],
  };

  // Both boards in parallel. A failed board is reported and the other proceeds.
  const [mgmt, gr] = await Promise.all([
    fetchRecentManagementLeads(opts.page ?? LEAD_POLL_PAGE),
    fetchRecentGuaranteedRentLeads(opts.page ?? LEAD_POLL_PAGE),
  ]);
  const pages: { type: LeadType; items: RecentLeadItem[] }[] = [];
  if (mgmt.ok) {
    pages.push({ type: "management", items: mgmt.items });
    result.boards.management.fetched = mgmt.items.length;
  } else {
    result.errors.push(`management board: ${mgmt.error}`);
  }
  if (gr.ok) {
    pages.push({ type: "guaranteed_rent", items: gr.items });
    result.boards.guaranteed_rent.fetched = gr.items.length;
  } else {
    result.errors.push(`guaranteed rent board: ${gr.error}`);
  }
  if (pages.length === 0) {
    result.ok = false;
    return result;
  }

  // ONE read of which ids we already hold. A failed read is a failed run —
  // never "everything is new".
  const allIds = pages.flatMap((p) => p.items.map((i) => String(i.payload.monday_item_id)));
  const knownIds = new Set<string>();
  if (allIds.length > 0) {
    const { data, error } = await admin
      .from("leads")
      .select("monday_item_id")
      .in("monday_item_id", allIds);
    if (error) {
      result.ok = false;
      result.errors.push(`leads read failed: ${error.message}`);
      return result;
    }
    for (const row of (data ?? []) as { monday_item_id: string | null }[]) {
      if (row.monday_item_id) knownIds.add(String(row.monday_item_id));
    }
  }

  for (const page of pages) {
    const report = result.boards[page.type];
    const picked = pickItemsToIngest(page.items, knownIds, now, LEAD_SETTLE_MS, LEAD_POLL_MAX_INGEST);
    report.known = picked.known;
    report.deferred = picked.deferred;
    report.would_ingest = picked.ingest.map((i) => String(i.payload.monday_item_id));
    if (dryRun) continue;

    for (const item of picked.ingest) {
      if (Date.now() - started > budgetMs) {
        result.truncated = true;
        break;
      }
      try {
        const res = await ingestLead(item.payload);
        if (res.status === "created") {
          report.created += 1;
          report.assignments += res.assignments_made;
        } else if (res.status === "duplicate") {
          report.duplicates += 1;
          report.assignments += res.assignments_made ?? 0;
        } else {
          report.errors.push(`${item.payload.lead_name}: ${res.error ?? "ingest failed"}`);
        }
      } catch (err) {
        report.errors.push(
          `${item.payload.lead_name}: ${err instanceof Error ? err.message : "ingest threw"}`
        );
      }
    }
    if (result.truncated) break;
  }

  return result;
}
