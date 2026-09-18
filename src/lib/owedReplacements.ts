/**
 * Flagging a Stayful-pipeline conflict and settling the replacements it owes
 * (§64). The database helpers shared by ingest and the sweep — in their own
 * module so `ingest.ts` and `stayfulConflictSweep.ts` cannot import each
 * other.
 *
 * All three RPCs live in 0155. Nothing here decides money: a flag moves no
 * credit, and a fulfilment inserts the assignment at the price the customer
 * already paid (the swap's rule, §52.1).
 *
 * `onAssigned` is always `completeAssignment(admin, lead, customerId,
 * assignmentId, false)`: the ordinary new-lead email, text and contact-plan
 * enrolment — a replacement IS a delivery from the customer's side (§34) —
 * with threshold warnings off, because no credit moved and those branches key
 * on exact balances (the swap route's reason).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Lead } from "@/lib/types";
import type { StayfulConflictMatch } from "@/lib/stayfulConflict";

export type OnAssigned = (
  lead: Lead,
  customerId: string,
  assignmentId: string
) => Promise<void>;

interface FlagRow {
  owed_id: string | null;
  customer_id: string;
  withdrawn_assignment_id: string;
}

/**
 * Load the lead a fulfilment just placed, then notify. Best effort: a failed
 * notification never fails the fulfilment, which is already committed.
 */
async function notifyPlacement(
  admin: SupabaseClient,
  assignmentId: string,
  onAssigned: OnAssigned
): Promise<void> {
  try {
    const { data: created } = await admin
      .from("lead_assignments")
      .select("id, customer_id, lead_id")
      .eq("id", assignmentId)
      .maybeSingle();
    if (!created) return;
    const { data: lead } = await admin
      .from("leads")
      .select("*")
      .eq("id", created.lead_id as string)
      .maybeSingle();
    if (!lead) return;
    await onAssigned(lead as Lead, created.customer_id as string, assignmentId);
  } catch (err) {
    console.error("[stayful-conflict] replacement placed, notify failed", assignmentId, err);
  }
}

/**
 * Flag one lead, withdraw its live assignments, and settle what is owed from
 * stock right away where a matching lead exists.
 *
 * Mutates the in-memory `lead` so a caller that goes on to consult it (the
 * ingest duplicate branch) sees the flag and the clamped cap.
 */
export async function flagStayfulConflictLead(
  admin: SupabaseClient,
  lead: Lead,
  match: StayfulConflictMatch,
  onAssigned: OnAssigned
): Promise<{ withdrawn: number; fulfilled: number; waiting: number }> {
  const { data, error } = await admin.rpc("flag_stayful_conflict", {
    p_lead_id: lead.id,
    p_item_id: match.itemId,
    p_group_id: match.groupId,
    p_matched_by: match.matchedBy,
  });
  if (error) {
    // Surfaced, not swallowed: the sweep counts this run's errors, and the
    // next tick retries because the lead is still unflagged.
    throw new Error(`flag_stayful_conflict failed for ${lead.id}: ${error.message}`);
  }

  const rows = (data ?? []) as FlagRow[];
  const now = new Date().toISOString();
  lead.stayful_conflict_at = now;
  lead.stayful_conflict_item_id = match.itemId;
  lead.stayful_conflict_group_id = match.groupId;
  lead.stayful_conflict_matched_by = match.matchedBy;
  lead.assignment_count = Math.max((lead.assignment_count ?? 0) - rows.length, 0);
  lead.max_assignments = lead.assignment_count;

  let fulfilled = 0;
  let waiting = 0;
  for (const row of rows) {
    if (!row.owed_id) {
      waiting += 1;
      continue;
    }
    const { data: assignmentId, error: fulfilErr } = await admin.rpc(
      "fulfil_owed_from_stock",
      { p_owed_id: row.owed_id }
    );
    if (fulfilErr) {
      console.error("[stayful-conflict] fulfil_owed_from_stock failed", row.owed_id, fulfilErr);
      waiting += 1;
      continue;
    }
    if (!assignmentId) {
      waiting += 1;
      continue;
    }
    fulfilled += 1;
    await notifyPlacement(admin, assignmentId as string, onAssigned);
  }

  return { withdrawn: rows.length, fulfilled, waiting };
}

/**
 * On an arriving lead: hand it to whoever is owed a replacement it satisfies,
 * BEFORE ordinary routing (§64, decision 5). Longest-owed customer first, up
 * to `max` placements.
 *
 * FAILS OPEN on a failed read — the `lead_is_closed` argument in
 * autoAssignLead: code deployed before its migration must not halt every
 * assignment on the platform. A raise from the fulfilment RPC is "not this
 * lead for this customer" and is skipped, not fatal.
 */
export async function fulfilOwedReplacementsForLead(
  admin: SupabaseClient,
  lead: Lead,
  max: number,
  onAssigned: OnAssigned
): Promise<number> {
  if (max <= 0) return 0;

  const { data, error } = await admin.rpc("open_owed_replacements_for_lead", {
    p_lead_id: lead.id,
  });
  if (error) {
    console.error("[stayful-conflict] open_owed_replacements_for_lead failed; proceeding", error);
    return 0;
  }

  const owed = ((data ?? []) as { owed_id: string; customer_id: string; owed_since: string }[])
    .slice()
    .sort((a, b) => (a.owed_since < b.owed_since ? -1 : a.owed_since > b.owed_since ? 1 : 0));

  let placed = 0;
  for (const row of owed) {
    if (placed >= max) break;
    const { data: assignmentId, error: fulfilErr } = await admin.rpc(
      "fulfil_owed_replacement",
      { p_owed_id: row.owed_id, p_lead_id: lead.id }
    );
    if (fulfilErr || !assignmentId) {
      if (fulfilErr) {
        console.error("[stayful-conflict] fulfil_owed_replacement refused", row.owed_id, fulfilErr.message);
      }
      continue;
    }
    placed += 1;
    lead.assignment_count = (lead.assignment_count ?? 0) + 1;
    try {
      await onAssigned(lead, row.customer_id, assignmentId as string);
    } catch (err) {
      console.error("[stayful-conflict] replacement placed, notify failed", assignmentId, err);
    }
  }
  return placed;
}

/**
 * Every open debt, oldest first, tried against stock. Covers a customer who
 * was paused when they were owed and has since resumed, and yesterday's
 * debts against today's stock.
 */
export async function fulfilOpenOwedFromStock(
  admin: SupabaseClient,
  onAssigned: OnAssigned,
  opts: { deadline: number }
): Promise<{ fulfilled: number; waiting: number; truncated: boolean; errors: string[] }> {
  const { data, error } = await admin
    .from("owed_lead_replacements")
    .select("id")
    .eq("status", "open")
    .order("created_at", { ascending: true });
  if (error) {
    return { fulfilled: 0, waiting: 0, truncated: false, errors: [error.message] };
  }

  let fulfilled = 0;
  let waiting = 0;
  let truncated = false;
  const errors: string[] = [];
  for (const row of (data ?? []) as { id: string }[]) {
    if (Date.now() > opts.deadline) {
      truncated = true;
      break;
    }
    const { data: assignmentId, error: fulfilErr } = await admin.rpc(
      "fulfil_owed_from_stock",
      { p_owed_id: row.id }
    );
    if (fulfilErr) {
      errors.push(`${row.id}: ${fulfilErr.message}`);
      waiting += 1;
      continue;
    }
    if (!assignmentId) {
      waiting += 1;
      continue;
    }
    fulfilled += 1;
    await notifyPlacement(admin, assignmentId as string, onAssigned);
  }
  return { fulfilled, waiting, truncated, errors };
}
