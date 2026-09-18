/**
 * Is this lead a landlord Stayful is already working? (§64)
 *
 * Stayful's own sales pipeline lives on Monday board 5891626711, and nine of
 * its groups mean "being worked, or signed, by Stayful". A lead in the
 * database that matches an item in any of them must never reach an operator:
 * Stayful and the operator would both be ringing the same person.
 *
 * The match rule, decided with the owner: the same Monday item, OR the same
 * email (any address in a multi-address cell, lowercased), OR the same phone
 * (last nine digits — 0070's identity rule). Precedence item → email → phone
 * decides what `matched_by` records. Management leads only: a GR lead is
 * never checked.
 *
 * PURE. Nothing here touches the network or the database, so every branch is
 * unit-tested. The index is built from `fetchStayfulPipelineIndex()` in
 * monday.ts; the two identity primitives are imported from there rather than
 * written a second time (§20, §26.7).
 */
import {
  emailsFromCell,
  phoneMatchKey,
  type StayfulPipelineItem,
} from "@/lib/monday";

/** Which rule matched. Must equal the SQL CHECK on leads.stayful_conflict_matched_by. */
export const STAYFUL_CONFLICT_MATCHED_BY = ["item", "email", "phone"] as const;
export type StayfulConflictMatchedBy = (typeof STAYFUL_CONFLICT_MATCHED_BY)[number];

export interface StayfulConflictMatch {
  itemId: string;
  groupId: string;
  matchedBy: StayfulConflictMatchedBy;
}

export interface StayfulPipelineIndex {
  byItem: Map<string, StayfulPipelineItem>;
  byEmail: Map<string, StayfulPipelineItem>;
  byPhone: Map<string, StayfulPipelineItem>;
  /** Items indexed. */
  size: number;
}

/**
 * Index the nine groups' items by the three keys. First item wins per key,
 * with items sorted by id so the answer is deterministic whatever order the
 * board returned them in. Empty keys are never indexed.
 */
export function buildStayfulPipelineIndex(
  items: StayfulPipelineItem[]
): StayfulPipelineIndex {
  const byItem = new Map<string, StayfulPipelineItem>();
  const byEmail = new Map<string, StayfulPipelineItem>();
  const byPhone = new Map<string, StayfulPipelineItem>();
  const sorted = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const item of sorted) {
    if (!item.id) continue;
    if (!byItem.has(item.id)) byItem.set(item.id, item);
    for (const email of item.emails) {
      const key = email.trim().toLowerCase();
      if (key && !byEmail.has(key)) byEmail.set(key, item);
    }
    for (const key of item.phoneKeys) {
      if (key && !byPhone.has(key)) byPhone.set(key, item);
    }
  }
  return { byItem, byEmail, byPhone, size: sorted.length };
}

export interface ConflictCheckableLead {
  lead_type?: string | null;
  monday_item_id?: string | null;
  email?: string | null;
  phone?: string | null;
}

/**
 * The match, or null. Management only; item → email → phone.
 */
export function findStayfulConflict(
  lead: ConflictCheckableLead,
  index: StayfulPipelineIndex
): StayfulConflictMatch | null {
  if ((lead.lead_type ?? "management") !== "management") return null;

  const itemId = lead.monday_item_id ? String(lead.monday_item_id) : "";
  if (itemId) {
    const hit = index.byItem.get(itemId);
    if (hit) return { itemId: hit.id, groupId: hit.groupId, matchedBy: "item" };
  }

  for (const email of emailsFromCell(lead.email ?? "")) {
    const hit = index.byEmail.get(email);
    if (hit) return { itemId: hit.id, groupId: hit.groupId, matchedBy: "email" };
  }

  const phoneKey = phoneMatchKey(lead.phone);
  if (phoneKey) {
    const hit = index.byPhone.get(phoneKey);
    if (hit) return { itemId: hit.id, groupId: hit.groupId, matchedBy: "phone" };
  }

  return null;
}

/** Whether the lead has already been flagged (0155). */
export function isStayfulConflicted(lead: {
  stayful_conflict_at?: string | null;
}): boolean {
  return Boolean(lead.stayful_conflict_at);
}
