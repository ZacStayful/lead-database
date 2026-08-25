/**
 * /v1/leads — the caller's own assignments, and the notes on them.
 *
 * EVERY QUERY IS SCOPED BY `caller.customerId`, which is resolved server-side
 * from the credential and never read from the request. There is no endpoint
 * anywhere in this surface that accepts a customer id, which is what makes
 * cross-customer access structurally impossible rather than merely refused.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { PIPELINE_STAGES, GR_PIPELINE_STAGES } from "@/components/dashboard/pipelineStage";
import { toLeadType } from "@/lib/products";
import {
  ASSIGNMENT_COLUMNS,
  NOTE_COLUMNS,
  serializeAssignment,
  serializeNote,
} from "@/lib/api/serialize";
import {
  DEFAULT_SORT,
  SORTS,
  cursorFilter,
  decodeCursor,
  encodeCursor,
  isSortKey,
  type SortKey,
} from "@/lib/api/cursor";
import { fail, internal, notFound, ok, type ApiResult } from "@/lib/api/errors";
import { DEFAULT_PAGE_SIZE, MAX_NOTES, MAX_PAGE_SIZE } from "@/lib/api/limits";
import type { Caller } from "@/lib/api/caller";

type Admin = ReturnType<typeof createAdminClient>;

const STATUSES = [
  "new",
  "contacted",
  "in_discussion",
  "won",
  "not_relevant",
  "rejected",
] as const;

const ALL_STAGES = new Set(
  [...PIPELINE_STAGES, ...GR_PIPELINE_STAGES].map((s) => s.value)
);

export interface ListParams {
  product?: string | null;
  status?: string | null;
  pipeline_stage?: string | null;
  assigned_since?: string | null;
  updated_since?: string | null;
  sort?: string | null;
  limit?: string | null;
  cursor?: string | null;
}

/**
 * Validation refuses rather than ignores.
 *
 * A misspelled filter that silently returned an unfiltered page — or an empty
 * one — is the kind of thing an automated sync acts on for weeks before anybody
 * notices. Every bad input is a 400 naming the field.
 */
export async function listAssignments(
  caller: Caller,
  params: ListParams,
  adminClient?: Admin
): Promise<ApiResult<Record<string, unknown>>> {
  const admin = adminClient ?? createAdminClient();

  let limit = DEFAULT_PAGE_SIZE;
  if (params.limit != null && params.limit !== "") {
    const parsed = Number(params.limit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_SIZE) {
      return fail("invalid_request", `limit must be a whole number between 1 and ${MAX_PAGE_SIZE}.`);
    }
    limit = parsed;
  }

  let sort: SortKey = DEFAULT_SORT;
  if (params.sort != null && params.sort !== "") {
    if (!isSortKey(params.sort)) {
      return fail("invalid_request", `sort must be one of: ${Object.keys(SORTS).join(", ")}.`);
    }
    sort = params.sort;
  }
  const sortColumn = SORTS[sort].column;

  let query = admin
    .from("lead_assignments")
    .select(ASSIGNMENT_COLUMNS)
    .eq("customer_id", caller.customerId)
    .order(sortColumn, { ascending: false })
    .order("id", { ascending: false })
    // One more than asked for, so "is there a next page" needs no count query.
    .limit(limit + 1);

  if (params.status) {
    if (!(STATUSES as readonly string[]).includes(params.status)) {
      return fail("invalid_request", `status must be one of: ${STATUSES.join(", ")}.`);
    }
    query = query.eq("status", params.status);
  }

  if (params.pipeline_stage) {
    if (!ALL_STAGES.has(params.pipeline_stage as never)) {
      return fail("invalid_request", "pipeline_stage is not a recognised stage.");
    }
    query = query.eq("pipeline_stage", params.pipeline_stage);
  }

  if (params.product) {
    const leadType = toLeadType(params.product);
    if (!leadType) {
      return fail("invalid_request", "product must be `management` or `guaranteed_rent`.");
    }
    query = query.eq("lead.lead_type", leadType);
  }

  for (const [name, column] of [
    ["assigned_since", "assigned_at"],
    ["updated_since", "last_status_change_at"],
  ] as const) {
    const raw = params[name];
    if (!raw) continue;
    const when = new Date(raw);
    if (Number.isNaN(when.getTime())) {
      return fail("invalid_request", `${name} must be an ISO 8601 date-time.`);
    }
    query = query.gte(column, when.toISOString());
  }

  if (params.cursor) {
    const decoded = decodeCursor(params.cursor, sort);
    if (!decoded.ok) return fail("invalid_request", decoded.reason);
    query = query.or(cursorFilter(decoded.cursor));
  }

  const { data, error } = await query;
  if (error) return internal("listAssignments", error);

  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  let nextCursor: string | null = null;
  if (hasMore && page.length > 0) {
    const last = page[page.length - 1];
    // The RAW string off the row, never a re-parsed Date — see cursor.ts.
    nextCursor = encodeCursor(sort, String(last[sortColumn]), String(last.id));
  }

  return ok({
    data: page.map((row) => serializeAssignment(row, caller.customerId)),
    next_cursor: nextCursor,
  });
}

/** One assignment. A foreign or unknown id is the same 404 (see errors.ts). */
export async function getAssignment(
  caller: Caller,
  assignmentId: string,
  adminClient?: Admin
): Promise<ApiResult<Record<string, unknown>>> {
  const admin = adminClient ?? createAdminClient();

  const { data, error } = await admin
    .from("lead_assignments")
    .select(ASSIGNMENT_COLUMNS)
    .eq("id", assignmentId)
    .eq("customer_id", caller.customerId)
    .maybeSingle();

  if (error) {
    // An invalid uuid reaches Postgres as a cast failure. That is a caller
    // mistake, not our fault, but the shape of the id is not something we owe
    // an oracle about either — so it is the same 404 as everything else.
    if (error.code === "22P02") return notFound();
    return internal("getAssignment", error);
  }
  if (!data) return notFound();

  return ok(
    serializeAssignment(
      data as unknown as Record<string, unknown>,
      caller.customerId
    )
  );
}

/**
 * Notes on one assignment, newest first and BOUNDED.
 *
 * An unbounded array is a page size decided by whichever customer has been
 * most diligent — the leaderboard shows operators averaging ten notes a lead,
 * but nothing stops one having hundreds.
 */
export async function listNotes(
  caller: Caller,
  assignmentId: string,
  adminClient?: Admin
): Promise<ApiResult<Record<string, unknown>>> {
  const admin = adminClient ?? createAdminClient();

  // Ownership first: this is what stops the notes endpoint being a way to read
  // another operator's notes on a lead you happen to share.
  const owned = await getAssignment(caller, assignmentId, admin);
  if (!owned.ok) return owned;

  const { data, error } = await admin
    .from("lead_notes")
    .select(NOTE_COLUMNS)
    .eq("lead_assignment_id", assignmentId)
    .eq("customer_id", caller.customerId)
    .order("created_at", { ascending: false })
    .limit(MAX_NOTES);

  if (error) return internal("listNotes", error);

  return ok({
    data: ((data ?? []) as unknown as Record<string, unknown>[]).map(serializeNote),
    limit: MAX_NOTES,
  });
}
