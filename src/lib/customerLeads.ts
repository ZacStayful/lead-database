/**
 * Customer-owned leads: the shared server-side pieces.
 *
 * A customer-owned lead is one the customer brought in themselves, by
 * spreadsheet import or by typing it into a form. It lives in `leads` like any
 * other, is worked through the same assignments/notes/stages machinery, and is
 * visible to exactly one customer plus admin. The database enforces that it is
 * never allocated, escalated or pooled (migration 0102); this module is the
 * TypeScript side of the same idea.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { extractPostcode, postcodeArea } from "./postcode";
import type { LeadType } from "./types";

/** How an owned lead was created. */
export type OwnedLeadSource = "import" | "manual";

/** What `create_customer_leads` did with one input row. */
export type CreateOutcome = "created" | "duplicate" | "empty";

export interface OwnedLeadInput {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  /**
   * A postcode the customer supplied separately from the address — a spreadsheet
   * column of its own, or the manual form's postcode field. Optional: where it
   * is absent the postcode is read out of the address as it always was.
   */
  postcode?: string | null;
  bedrooms?: string | null;
  profile?: string | null;
}

export interface CreateOwnedLeadsResult {
  created: number;
  duplicates: number;
  empty: number;
  leadIds: string[];
}

/** A lead the customer owns, for the badge and the source filter. */
export function isOwnedLead(
  lead: { owner_customer_id?: string | null } | null | undefined
): boolean {
  return Boolean(lead?.owner_customer_id);
}

/**
 * The Source value shown to the customer, in the export and anywhere else the
 * provenance of a lead is stated. One definition so the export, the badge and
 * any future surface cannot disagree.
 */
export function leadSourceLabel(assignment: {
  claimed_from_pool_at?: string | null;
  lead?: { owner_customer_id?: string | null } | null;
}): string {
  if (isOwnedLead(assignment.lead)) return "Added by you";
  if (assignment.claimed_from_pool_at) return "Claimed from expired leads";
  return "Allocated";
}

/**
 * A row is worth creating if it can identify or reach somebody. Mirrors the
 * same test inside `create_customer_leads`, which is the authority — this copy
 * exists so a manual submission can be refused with a helpful message instead
 * of coming back as a silent `empty` outcome.
 */
export function hasAnyContactDetail(row: OwnedLeadInput): boolean {
  return Boolean(
    row.name?.trim() || row.email?.trim() || row.phone?.trim() || row.address?.trim()
  );
}

function clean(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Shape one row for the RPC, resolving the postcode.
 *
 * Postcode derivation happens HERE rather than in SQL because
 * `extractPostcode`/`postcodeArea` are the app's single implementation
 * (src/lib/postcode.ts) and a second one in Postgres would eventually give a
 * different answer for the same address. 0097 is the record of what that
 * costs: a subtly different regex filed every Bristol lead under Sheffield.
 *
 * An EXPLICIT postcode wins over one found in the address, because a customer
 * who keeps a postcode column meant it. The address is only searched as a
 * fallback — and the two are then RECONCILED: where a separate postcode column
 * exists and the address does not already carry it, it is appended to the
 * address. A stored address missing its own postcode reads as incomplete to the
 * operator working the lead, and every other consumer in the app finds a
 * postcode by looking in the address.
 */
export function toRpcRow(row: OwnedLeadInput): Record<string, string> {
  const rawAddress = clean(row.address);
  const explicit = extractPostcode(clean(row.postcode));
  const fromAddress = extractPostcode(rawAddress);
  const postcode = explicit ?? fromAddress;

  const address =
    explicit && !fromAddress && rawAddress
      ? `${rawAddress}, ${explicit}`
      : rawAddress || explicit || "";

  return {
    name: clean(row.name),
    email: clean(row.email),
    phone: clean(row.phone),
    address,
    bedrooms: clean(row.bedrooms),
    profile: clean(row.profile),
    postcode: postcode ?? "",
    postcode_area: postcodeArea(postcode) ?? "",
  };
}

/**
 * Create owned leads through the RPC.
 *
 * Everything about atomicity lives in the function (0102 §8): a lead and its
 * assignment are inserted together, because the assignment row is what makes
 * the lead visible to its owner under `leads_select_assigned`. Callers only
 * shape rows and read the tally back.
 *
 * Requires a SERVICE-ROLE client — the RPC is revoked from `authenticated`.
 */
export async function createOwnedLeads(
  admin: SupabaseClient,
  params: {
    customerId: string;
    leadType: LeadType;
    source: OwnedLeadSource;
    rows: OwnedLeadInput[];
  }
): Promise<{ result: CreateOwnedLeadsResult | null; error: string | null }> {
  const { data, error } = await admin.rpc("create_customer_leads", {
    p_customer_id: params.customerId,
    p_lead_type: params.leadType,
    p_source: params.source,
    p_rows: params.rows.map(toRpcRow),
  });

  if (error) return { result: null, error: error.message };

  const rows = (data ?? []) as {
    row_index: number;
    outcome: CreateOutcome;
    created_lead_id: string | null;
  }[];

  const result: CreateOwnedLeadsResult = {
    created: rows.filter((r) => r.outcome === "created").length,
    duplicates: rows.filter((r) => r.outcome === "duplicate").length,
    empty: rows.filter((r) => r.outcome === "empty").length,
    leadIds: rows
      .filter((r) => r.outcome === "created" && r.created_lead_id)
      .map((r) => r.created_lead_id as string),
  };

  return { result, error: null };
}

/**
 * Confirm a lead is owned by this customer, for the routes that may only act on
 * an owned lead (delete) or must refuse one (reject / discard / close).
 *
 * Returns `null` when the lead does not exist, so callers can answer with one
 * indistinguishable 404 and the endpoint cannot be used to discover which lead
 * ids exist.
 */
export async function getLeadOwnership(
  admin: SupabaseClient,
  leadId: string
): Promise<{ ownerCustomerId: string | null } | null> {
  const { data, error } = await admin
    .from("leads")
    .select("id, owner_customer_id")
    .eq("id", leadId)
    .maybeSingle();

  if (error || !data) return null;
  return {
    ownerCustomerId: (data as { owner_customer_id: string | null }).owner_customer_id,
  };
}

/**
 * The same question asked of an assignment rather than a lead.
 *
 * `/api/leads/[id]/reject` and `/close` identify the lead through the
 * `assignment_id` in their body and never read the route param, so this is the
 * id they actually have. Returns null when the assignment does not exist.
 */
export async function getAssignmentLeadOwnership(
  admin: SupabaseClient,
  assignmentId: string
): Promise<{ ownerCustomerId: string | null } | null> {
  const { data, error } = await admin
    .from("lead_assignments")
    .select("id, lead:leads!inner(owner_customer_id)")
    .eq("id", assignmentId)
    .maybeSingle();

  if (error || !data) return null;
  // supabase-js types an embedded resource as an array; a to-one relation
  // returns a single object at runtime. Accept either rather than assert one.
  const embedded = (data as unknown as {
    lead?: { owner_customer_id: string | null } | { owner_customer_id: string | null }[] | null;
  }).lead;
  const lead = Array.isArray(embedded) ? embedded[0] : embedded;
  return { ownerCustomerId: lead?.owner_customer_id ?? null };
}

/**
 * The message the marketplace outcome routes give when handed an owned lead.
 *
 * Reject is chargeable and stage-gated, close tells us not to re-offer a
 * landlord to anyone else, and discard decrements `assignment_count` and
 * returns the lead to circulation — all three are marketplace concepts, and
 * discard in particular would strand an owned lead with no assignment at all:
 * invisible to its owner under RLS, invisible in their feed, and impossible to
 * delete from the UI. Deleting is the right verb for a lead you own.
 */
export const OWNED_LEAD_OUTCOME_REFUSAL =
  "This is a lead you added yourself. Delete it instead — reject, discard and close only apply to leads supplied by Stayful.";
