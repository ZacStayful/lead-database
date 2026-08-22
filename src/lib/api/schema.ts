/**
 * THE field vocabulary for the public API.
 *
 * This file is the single definition of what leaves the building. Both the
 * `.select()` column lists and the serialized output are DERIVED from the specs
 * below, which is what makes the containment property structural rather than a
 * habit:
 *
 *   - you cannot select a column you do not expose — the select string IS the
 *     spec;
 *   - you cannot expose a field you did not select — same source;
 *   - you cannot forget to serialize a listed field — the serializer iterates
 *     the spec rather than assigning fields by hand, so the output keys are
 *     exactly the spec keys, always.
 *
 * The remaining failure mode is somebody ADDING an entry carelessly, and
 * `__tests__/serialize.test.ts` asserts the emitted key set against a literal
 * list so that an addition has to be made in two places on purpose.
 *
 * The descriptions are not decoration. They are rendered into the OpenAPI
 * document and into the MCP tool schemas, where they are the ONLY context a
 * model gets about what a number means — see the two income fields below.
 */

export interface ApiFieldSpec {
  /** Name in the JSON response. */
  field: string;
  /** Column to select. Several fields may share one column. */
  column: string;
  /** Rendered into OpenAPI and the MCP tool schemas. */
  description: string;
  /** Optional transform. Receives the column's value and the selected row. */
  derive?: (value: unknown, row: Record<string, unknown>) => unknown;
}

/* ------------------------------------------------------------------ *
 * Lead — the property enquiry itself. Identical for every holder.
 * ------------------------------------------------------------------ */

export const LEAD_FIELDS: readonly ApiFieldSpec[] = [
  { field: "id", column: "id", description: "Stayful's identifier for the lead. Stable, and the same for every operator holding it." },
  { field: "lead_type", column: "lead_type", description: "Which product this lead belongs to: `management` or `guaranteed_rent`." },
  { field: "lead_name", column: "lead_name", description: "The landlord's name." },
  { field: "address", column: "address", description: "The property address as the landlord gave it. Free text; not normalised." },
  { field: "postcode", column: "postcode", description: "Full postcode where one could be parsed from the address, otherwise null." },
  { field: "postcode_area", column: "postcode_area", description: "Outward postcode area (for example `M20`). Null when the postcode could not be parsed." },
  { field: "bedrooms", column: "bedrooms", description: "Bedroom count as supplied. Free text: may be a number, a range, or absent." },
  { field: "phone", column: "phone", description: "The landlord's phone number." },
  { field: "email", column: "email", description: "The landlord's email address." },
  { field: "lead_profile", column: "lead_profile", description: "Free-text notes captured when the enquiry was qualified." },
  { field: "desired_rent", column: "desired_rent", description: "Guaranteed Rent leads only: the rent the landlord is asking for. Null on management leads." },
  { field: "created_at", column: "created_at", description: "When Stayful ingested the lead. Not when the landlord enquired." },
  {
    field: "gross_annual_income",
    column: "gross_annual_income",
    description:
      "STAYFUL'S projected gross annual short-term-let revenue for the property, in pounds, read from our own analysis of it. One figure per lead, identical for every operator who holds it. This is NOT the operator's own estimate — see `income_estimate` on the assignment — and the two must never be merged, summed, or used as a fallback for one another. Null when no analysis could be read. Management leads only.",
  },
  { field: "avg_nightly_rate", column: "avg_nightly_rate", description: "Average nightly rate behind the gross figure, in whole pounds. Null when the analysis does not state one." },
  { field: "occupancy_rate", column: "occupancy_rate", description: "Occupancy behind the gross figure, as a percentage (63 means 63%). Null when the analysis does not state one." },
  {
    field: "income_report_available",
    column: "income_report_path",
    description: "Whether a full property-analysis PDF is stored for this lead and can be fetched from the report endpoint.",
    derive: (v) => v != null,
  },
] as const;

/* ------------------------------------------------------------------ *
 * Assignment — this customer's own relationship to that lead.
 * ------------------------------------------------------------------ */

export const ASSIGNMENT_FIELDS: readonly ApiFieldSpec[] = [
  { field: "id", column: "id", description: "Identifier for YOUR assignment of this lead. This is the id every endpoint here takes. One lead can be held by several operators, each with their own assignment, status and notes." },
  {
    field: "status",
    column: "status",
    description:
      "Where you have said this lead stands: `new`, `contacted`, `in_discussion`, `won`, `not_relevant` or `rejected`. SELF-REPORTED — it moves when you or your team set it, so it measures record-keeping rather than work done. Some transitions are automatic: adding a note, attaching a file, moving the pipeline stage, or clicking the landlord's phone number all set `contacted`.",
  },
  { field: "pipeline_stage", column: "pipeline_stage", description: "Your position in the sales pipeline for this lead. The stage vocabulary differs per product. Reaching a terminal winning stage also sets `status` to `won`." },
  {
    field: "source",
    column: "claimed_from_pool_at",
    description: "How you came to hold this lead: `allocated` if it was delivered to you, or `pool_claim` if you claimed it yourself from the expired-leads pool.",
    derive: (v) => (v != null ? "pool_claim" : "allocated"),
  },
  { field: "assigned_at", column: "assigned_at", description: "When this lead was delivered to you. Lead age is measured from here, not from the enquiry date." },
  { field: "viewed_at", column: "viewed_at", description: "When you first expanded this lead in the feed. Null does not mean unread — opening the lead's own page does not set it." },
  { field: "first_contacted_at", column: "first_contacted_at", description: "When the first evidence of contact was recorded. First touch wins permanently; it is never overwritten." },
  { field: "last_status_change_at", column: "last_status_change_at", description: "When `status` last changed. This is the field `updated_since` and `sort=last_status_change_at` operate on." },
  { field: "due_to_call_date", column: "due_to_call_date", description: "A callback date you set. Null if none." },
  {
    field: "income_estimate",
    column: "income_estimate",
    description:
      "YOUR OWN estimate for this lead, typed by you or your team. One per assignment, so two operators holding the same lead can hold different figures. This is NOT Stayful's projection — see `gross_annual_income` on the lead — and the two must never be merged or summed. Null until somebody enters one.",
  },
  { field: "price_paid", column: "price_paid", description: "What this lead cost you, in pounds." },
  { field: "closed_at", column: "closed_at", description: "When you recorded a final outcome from the landlord's side. Null if still open." },
  { field: "closed_reason", column: "closed_reason", description: "Why it closed: `not_interested` or `sorted_elsewhere`. Both describe the landlord's decision, not yours." },
] as const;

/* ------------------------------------------------------------------ *
 * Note
 * ------------------------------------------------------------------ */

export const NOTE_FIELDS: readonly ApiFieldSpec[] = [
  { field: "id", column: "id", description: "Identifier for the note." },
  { field: "body", column: "body", description: "The note text." },
  { field: "created_at", column: "created_at", description: "When the note was written." },
] as const;

/* ------------------------------------------------------------------ *
 * Deliberately absent — recorded here so a future addition is a decision
 * ------------------------------------------------------------------ */

/**
 * Fields that exist on these rows and MUST NOT be exposed. Kept as a list
 * rather than a comment so it can be asserted in a test.
 *
 *  - assignment_count / max_assignments: together they tell an operator how
 *    many competitors hold the same lead. The pool view keeps this off its type
 *    entirely for the same reason — "three operators passed on this" is an
 *    argument against ringing, and the premise is that they never rang.
 *  - enquiry_date: free text of uneven quality that does not always parse, and
 *    is rendered nowhere in the product including admin. Publishing it would
 *    make a contract out of a field we deliberately do not trust.
 *  - monday_item_id: internal provenance and the ingest idempotency key.
 *  - income_report_path / _asset_id / _status / _error: server-side only. The
 *    path in particular would disclose our storage layout.
 *  - pool_* : internal lifecycle. pool_entry_basis in particular would reveal
 *    that a lead was never sold to anybody.
 *  - customer_id: redundant — it is the caller, by construction.
 *  - notification_sent / email_sent: our own delivery mechanics.
 *  - is_reclaimed / reclaimed_at: a retired feature.
 *  - due_to_call_date_set_at / income_estimate_set_at: trigger-maintained, and
 *    their nulls mean "predates the migration" rather than "unset".
 *  - estimated_monthly_income: dead since the first migration.
 */
export const NEVER_EXPOSED = [
  "assignment_count",
  "max_assignments",
  "enquiry_date",
  "monday_item_id",
  "income_report_path",
  "income_report_asset_id",
  "income_report_status",
  "income_report_error",
  "income_report_parsed_at",
  "income_report_size_bytes",
  "pool_entered_at",
  "pool_first_entered_at",
  "pool_expired_at",
  "pool_excluded_at",
  "pool_entry_basis",
  "customer_id",
  "notification_sent",
  "email_sent",
  "is_reclaimed",
  "reclaimed_at",
  "due_to_call_date_set_at",
  "income_estimate_set_at",
  "estimated_monthly_income",
  "net_annual_income",
  "long_let_annual_income",
  "platform_fee_pct",
  "cleaning_fee_pct",
  "monthly_revenue_profile",
] as const;
