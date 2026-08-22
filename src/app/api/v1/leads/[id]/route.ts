/**
 * GET /api/v1/leads/{id} — one assignment.
 *
 * `{id}` IS AN ASSIGNMENT ID, not a lead id. Every identifier in /v1 is an
 * assignment id, without exception — note that the older browser-facing routes
 * under /api/leads/[id] take a LEAD id, so do not copy a call site from there.
 *
 * The assignment is the caller's own relationship to the lead: one lead reaches
 * up to three operators, each with independent status, stage, estimate and
 * notes, so a lead id could not answer "whose status?".
 */
import { withApi } from "@/lib/api/handler";
import { getAssignment } from "@/lib/api/service/leads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(
  { scope: "leads:read", operation: "GET /v1/leads/{id}" },
  async (caller, _request, params) => getAssignment(caller, params.id ?? "")
);
