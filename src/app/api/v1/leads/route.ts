/**
 * GET /api/v1/leads — the caller's own lead assignments, newest first.
 *
 * Cursor-paginated. Filters: product, status, pipeline_stage, assigned_since,
 * updated_since. Two sort modes — `assigned_at` (default) and
 * `last_status_change_at`, the latter for incremental syncs that need to page by
 * when something changed rather than when it arrived.
 */
import { withApi } from "@/lib/api/handler";
import { listAssignments } from "@/lib/api/service/leads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(
  { scope: "leads:read", operation: "GET /v1/leads" },
  async (caller, request) => {
    const q = request.nextUrl.searchParams;
    return listAssignments(caller, {
      product: q.get("product"),
      status: q.get("status"),
      pipeline_stage: q.get("pipeline_stage"),
      assigned_since: q.get("assigned_since"),
      updated_since: q.get("updated_since"),
      sort: q.get("sort"),
      limit: q.get("limit"),
      cursor: q.get("cursor"),
    });
  }
);
