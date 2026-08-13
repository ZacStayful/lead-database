import { createAdminClient } from "@/lib/supabase/admin";
import type { AssignmentWithLead } from "@/lib/types";

export type LeadSource = "leads" | "priority";

export function parseSource(value: string | undefined | null): LeadSource {
  return value === "priority" ? "priority" : "leads";
}

function time(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return isNaN(t) ? null : t;
}

/**
 * Priority sort:
 *   1. due_to_call_date ascending — earliest (overdue) first, nulls last
 *   2. within the same due date, assigned_at ascending (held longest first)
 */
export function sortPriority(rows: AssignmentWithLead[]): AssignmentWithLead[] {
  return [...rows].sort((a, b) => {
    const da = time(a.due_to_call_date);
    const db = time(b.due_to_call_date);
    if (da === null && db !== null) return 1; // a has no due date → last
    if (da !== null && db === null) return -1;
    if (da !== null && db !== null && da !== db) return da - db;
    // same (or both-null) due date → longest held first; unknown last.
    // Ordered by how long the CUSTOMER has held the lead, not by how old the
    // enquiry is. Customers no longer see the enquiry date anywhere, so ranking
    // by it would sort their queue on a fact they cannot see — and on an
    // escalated lead the two disagree by up to three weeks.
    const ea = time(a.assigned_at) ?? Infinity;
    const eb = time(b.assigned_at) ?? Infinity;
    return ea - eb;
  });
}

/**
 * The customer's assignments in the same order as the named source list, so
 * prev/next navigation from a lead matches the list it was opened from.
 * - "leads": the main list order (assigned_at descending)
 * - "priority": excludes won/not_relevant, sorted by the priority rules above
 */
export async function fetchOrderedAssignments(
  customerId: string,
  source: LeadSource
): Promise<AssignmentWithLead[]> {
  const admin = createAdminClient();

  if (source === "priority") {
    const { data } = await admin
      .from("lead_assignments")
      .select("*, lead:leads(*)")
      .eq("customer_id", customerId)
      .not("status", "in", "(won,not_relevant)");
    return sortPriority((data ?? []) as AssignmentWithLead[]);
  }

  const { data } = await admin
    .from("lead_assignments")
    .select("*, lead:leads(*)")
    .eq("customer_id", customerId)
    .order("assigned_at", { ascending: false });
  return (data ?? []) as AssignmentWithLead[];
}
