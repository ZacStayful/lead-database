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

/**
 * Whether THIS customer is the one who added this lead.
 *
 * ⚠️ RELATIVE TO THE VIEWER, always. `owner_customer_id` being set means the
 * lead belongs to SOME customer, which stopped being the same question the
 * moment an analysed owned lead could be sold to one other operator (§32): the
 * buyer holds a lead with an owner, and that owner is not them.
 *
 * Read as a bare null check — which is what this was until §32 — it tells the
 * buyer "Your lead · you added this yourself, it is only visible to you", puts
 * "Added by you" in their export, offers them a Delete that 404s, and hides
 * Reject on a lead they paid £15 for. Every one of those is wrong and three of
 * them are visible on the first screen.
 */
export function isOwnedLead(
  lead: { owner_customer_id?: string | null } | null | undefined,
  viewerCustomerId: string | null | undefined
): boolean {
  return Boolean(
    lead?.owner_customer_id && viewerCustomerId && lead.owner_customer_id === viewerCustomerId
  );
}

/**
 * The Source value shown to the customer, in the export and anywhere else the
 * provenance of a lead is stated. One definition so the export, the badge and
 * any future surface cannot disagree.
 *
 * Takes no viewer parameter: an assignment row IS the viewer — every one of
 * them carries the `customer_id` it belongs to. That is why this is the shape
 * the fix wanted, and why a caller cannot forget to pass the viewer in.
 *
 * A resold owned lead reads "Allocated" to its buyer. True — it arrived by
 * ordinary routing at the ordinary price — and it says nothing about the
 * operator who brought it in, which is the §19.7 standard: what the people who
 * held a lead before you did with it is never yours to see.
 */
export function leadSourceLabel(assignment: {
  customer_id?: string | null;
  claimed_from_pool_at?: string | null;
  lead?: { owner_customer_id?: string | null } | null;
}): string {
  if (isOwnedLead(assignment.lead, assignment.customer_id)) return "Added by you";
  if (assignment.claimed_from_pool_at) return "Claimed from expired leads";
  return "Allocated";
}

/**
 * Strip another customer's identity out of a lead before it reaches the browser.
 *
 * Customer lead surfaces select `lead:leads(*)`, which since §32 can carry an
 * `owner_customer_id` belonging to somebody else — the operator who uploaded a
 * lead that was then sold on. That id is another customer's primary key, and
 * shipping it to the buyer's browser is the sort of thing §19.7 rules out on
 * principle: what the people who held a lead before you did is not yours to
 * see, and neither is who they were.
 *
 * So it is nulled at the page boundary. The buyer gets a lead that looks like
 * any other allocated lead, which is exactly what it is to them, and every
 * client component's `Boolean(lead.owner_customer_id)` becomes correct without
 * needing to know the viewer.
 *
 * ⚠️ **`lead_profile` goes too, and that is the more important half.** On a
 * marketplace lead that column is our own qualification blurb, written to be
 * read by whoever holds the lead. On an IMPORTED one it is whatever the
 * customer's spreadsheet had left over: `leadImport.ts` folds every column it
 * could not map into it as `Header: value`, plus every column mapped to notes.
 * That is the uploader's own working material — margins, source attribution,
 * "will take 12%, spoke to Dave" — and handing it to a competing operator is a
 * different act from handing over the landlord's phone number. We cannot tell
 * the useful lines from the private ones, so the buyer gets none of them. They
 * still receive the name, address, bedrooms, contact details and the full
 * analysis, which is everything needed to price a call.
 *
 * This does NOT replace `isOwnedLead`'s viewer argument. Server-side callers —
 * analytics, goals, the API routes — read the columns directly and must never
 * depend on a sanitisation step having been run somewhere upstream.
 *
 * ⚠️ Nor is it a security boundary. `leads_select_assigned` (0014) grants any
 * holder `select` on the whole row, so a buyer with their own Supabase session
 * can read `owner_customer_id` and `lead_profile` from the browser directly.
 * What that yields is an opaque customer UUID that resolves to nothing
 * (`customers` is select-own) and text they were arguably sold — this is a
 * presentation control that keeps another operator's material out of the
 * product, not a wall. Anything that must be unreachable needs RLS or a column
 * that is never selected.
 */
export function viewerScopedLead<
  T extends {
    owner_customer_id?: string | null;
    lead_profile?: string | null;
    lead_quality_override_by?: string | null;
    lead_quality_override_note?: string | null;
  },
>(lead: T | null | undefined, viewerCustomerId: string | null | undefined): T | null {
  if (!lead) return null;

  // 0111. The contact-quality override records WHO decided, and that is an
  // admin's email address plus a private note about the lead. Customer lead
  // surfaces select `leads(*)`, so without this it ships to the browser of every
  // operator holding the lead.
  //
  // Stripped for EVERY viewer, unlike the owner fields below, because there is
  // no customer this is ever addressed to. The verdict columns themselves stay —
  // they say nothing an operator cannot see by looking at the lead.
  const scrubbed =
    lead.lead_quality_override_by == null && lead.lead_quality_override_note == null
      ? lead
      : { ...lead, lead_quality_override_by: null, lead_quality_override_note: null };

  if (!scrubbed.owner_customer_id) return scrubbed;
  if (viewerCustomerId && scrubbed.owner_customer_id === viewerCustomerId) {
    return scrubbed;
  }
  return { ...scrubbed, owner_customer_id: null, lead_profile: null };
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

/**
 * Why the BUYER of a resold lead cannot discard it.
 *
 * Discard is the one outcome refused to both parties, and this half is not
 * about ownership at all: discarding decrements `assignment_count`, which would
 * put the lead back under its cap with nothing left recording that it has
 * already been sold once — so ordinary routing would sell it again and the cap
 * of one would be breached by the single path that also destroys the evidence
 * (§19.6's argument, in its original form). 0107 raises inside
 * `discard_lead_assignment`; this is the sentence the customer reads.
 *
 * Reject and close are both open to them, and either records the outcome.
 */
export const RESOLD_LEAD_DISCARD_REFUSAL =
  "This lead can't be discarded. Reject it or close it instead — both record the outcome and neither costs you anything.";
