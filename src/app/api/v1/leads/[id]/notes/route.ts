/**
 * GET /api/v1/leads/{id}/notes — notes on one assignment, newest first.
 *
 * `{id}` is an ASSIGNMENT id (see ../route.ts). Bounded; the cap is reported in
 * the response so a truncated list cannot be read as a complete one.
 */
import { withApi } from "@/lib/api/handler";
import { listNotes } from "@/lib/api/service/leads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(
  { scope: "leads:read", operation: "GET /v1/leads/{id}/notes" },
  async (caller, _request, params) => listNotes(caller, params.id ?? "")
);
