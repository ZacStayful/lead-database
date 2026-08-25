/**
 * Reselling a customer's own lead — the predicates, in one place.
 *
 * A lead a customer uploaded is sold to nobody until it qualifies, and it
 * qualifies when a PAID analysis (§31) returns figures we trust. From that
 * moment it is ordinary supply for EXACTLY ONE further operator: uploader plus
 * one, never more, never back to the uploader, never into the expired pool.
 *
 * The database is the authority on all of that — 0107 guards every SQL path and
 * 0108 holds the cap under the row lock in `assign_lead_to_customer`. What lives
 * here is the application side of the same rule, and it exists because two cap
 * writes are NOT in SQL and so cannot be guarded there: the contention branch in
 * `ingest.ts`, which writes `max_assignments` straight through PostgREST, and
 * the admin PATCH on `/api/admin/leads/[id]`.
 *
 * Pure and dependency-free so both can be unit-tested without a database.
 */

/** The lead columns these predicates read. */
export interface ResaleLeadFields {
  owner_customer_id?: string | null;
  owner_resale_qualified_at?: string | null;
}

/** Whether a lead was brought in by a customer rather than sourced by us. */
export function isCustomerOwnedLead(lead: ResaleLeadFields): boolean {
  return Boolean(lead.owner_customer_id);
}

/**
 * Whether this lead may be offered to another operator right now.
 *
 * A marketplace lead is always true — it is not owned by anybody, and the whole
 * question is about owned leads. An owned lead is true only once qualified.
 */
export function isResellable(lead: ResaleLeadFields): boolean {
  if (!isCustomerOwnedLead(lead)) return true;
  return Boolean(lead.owner_resale_qualified_at);
}

/**
 * Whether `autoAssignLead` should look for candidates at all.
 *
 * Replaces the flat `if (lead.owner_customer_id) return 0` that stood while an
 * owned lead was never offered to anyone.
 */
export function shouldRouteLead(lead: ResaleLeadFields): boolean {
  return isResellable(lead);
}

/**
 * Whether the contended-lead branch may raise this lead's `max_assignments`.
 *
 * ⚠️ THE MOST DANGEROUS CAP WRITE IN THE CODEBASE, for this feature. The
 * contention branch updates `max_assignments` to CONTENDED_FILTERED_CUSTOMERS
 * (4) directly through PostgREST, so it bypasses `assign_lead_to_customer`'s
 * row lock and every guard 0107 added — it is the one path that could take an
 * owned lead past its uploader plus one.
 *
 * And the update's own `.lt("max_assignments", 4)` predicate is NOT protection:
 * a qualified owned lead sits at 2, which satisfies it.
 *
 * So owned leads are excluded here, qualified or not. Contention means "more
 * filtered customers want this than there are slots", and the answer to that on
 * somebody's own lead is that they only ever get one — not that we widen it.
 */
export function shouldRaiseContentionCap(
  lead: ResaleLeadFields,
  filteredCandidateCount: number,
  contendedThreshold: number
): boolean {
  if (isCustomerOwnedLead(lead)) return false;
  return filteredCandidateCount >= contendedThreshold;
}
