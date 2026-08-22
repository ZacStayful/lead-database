/**
 * The MCP tool surface.
 *
 * FIVE NAMED TOOLS WITH FIXED SHAPES. None takes a query, a table name, a
 * column list, a path or an arbitrary filter, and none ever will — a generic
 * "run this query" tool would hand over in one commit everything the rest of
 * this design protects. That is the standing rule in CLAUDE.md, and it applies
 * here harder than anywhere else, because this is the surface where "just one
 * more filter" looks most convenient.
 *
 * THE DESCRIPTIONS ARE THE PRODUCT. They are the only context a model gets, so
 * they say what the data MEANS rather than what type it is — most importantly
 * that `status` is self-reported, and that Stayful's projection and the
 * operator's own estimate are two different numbers that must never be merged.
 * The field-level text comes from src/lib/api/schema.ts so it is written once.
 */
import { ASSIGNMENT_FIELDS, LEAD_FIELDS, NOTE_FIELDS } from "@/lib/api/schema";
import type { ApiScope } from "@/lib/api/scopes";
import type { ApiResult } from "@/lib/api/errors";
import type { Caller } from "@/lib/api/caller";
import { getAccount } from "@/lib/api/service/account";
import { getAssignment, listAssignments, listNotes } from "@/lib/api/service/leads";
import { getReportSummary } from "@/lib/api/service/report";
import { MAX_PAGE_SIZE } from "@/lib/api/limits";

export interface McpTool {
  name: string;
  title: string;
  description: string;
  scope: ApiScope;
  inputSchema: Record<string, unknown>;
  run: (caller: Caller, args: Record<string, unknown>) => Promise<ApiResult<unknown>>;
}

/** Renders the shared field vocabulary into a description block. */
function fieldGuide(fields: readonly { field: string; description: string }[]): string {
  return fields.map((f) => `- ${f.field}: ${f.description}`).join("\n");
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

export const MCP_TOOLS: McpTool[] = [
  {
    name: "get_account",
    title: "Get account and plan",
    scope: "profile:read",
    description: `Return the signed-in operator's own Stayful account: which lead products they hold, their monthly allocation, remaining lead balance, how many leads they have received this cycle, their delivery pacing, and any lead filter in force.

Use this to answer "how many leads am I owed this month", "am I behind", or "what areas am I filtered to". One block per product held — Management and Guaranteed Rent are independent subscriptions with independent balances, and a figure from one never applies to the other.`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async (caller) => getAccount(caller),
  },

  {
    name: "list_leads",
    title: "List my leads",
    scope: "leads:read",
    description: `List the operator's own lead assignments, newest first, with the landlord's details and Stayful's property analysis attached.

A lead is a pre-screened landlord enquiry that this operator has PAID for. Each row is an assignment — this operator's own relationship to the lead — so its status, pipeline stage, notes and estimate belong to them alone. The same landlord may sit with other operators too, and nothing here reveals that.

Use \`updated_since\` with \`sort=last_status_change_at\` for an incremental sync: it pages by when something changed rather than when it arrived. Note that a DISCARDED lead simply disappears with no tombstone, so a long-running sync should occasionally do a full walk to reconcile.

Pagination is by cursor: pass \`next_cursor\` from the previous response. A cursor belongs to the sort it was issued under and will be refused under the other.

Fields on each assignment:
${fieldGuide(ASSIGNMENT_FIELDS)}

Fields on the nested lead:
${fieldGuide(LEAD_FIELDS)}`,
    inputSchema: {
      type: "object",
      properties: {
        product: { type: "string", enum: ["management", "guaranteed_rent"], description: "Restrict to one product." },
        status: {
          type: "string",
          enum: ["new", "contacted", "in_discussion", "won", "not_relevant", "rejected"],
          description: "Restrict to one status. Remember this is self-reported.",
        },
        pipeline_stage: { type: "string", description: "Restrict to one pipeline stage." },
        assigned_since: { type: "string", description: "ISO 8601. Only leads delivered at or after this time." },
        updated_since: { type: "string", description: "ISO 8601. Only assignments whose status changed at or after this time." },
        sort: {
          type: "string",
          enum: ["assigned_at", "last_status_change_at"],
          description: "Order. Defaults to assigned_at. Use last_status_change_at for incremental syncs.",
        },
        limit: { type: "integer", minimum: 1, maximum: MAX_PAGE_SIZE, description: `Page size, up to ${MAX_PAGE_SIZE}. Defaults to 25.` },
        cursor: { type: "string", description: "next_cursor from a previous call." },
      },
      additionalProperties: false,
    },
    run: async (caller, args) =>
      listAssignments(caller, {
        product: str(args.product),
        status: str(args.status),
        pipeline_stage: str(args.pipeline_stage),
        assigned_since: str(args.assigned_since),
        updated_since: str(args.updated_since),
        sort: str(args.sort),
        limit: args.limit != null ? String(args.limit) : null,
        cursor: str(args.cursor),
      }),
  },

  {
    name: "get_lead",
    title: "Get one lead",
    scope: "leads:read",
    description: `Return one of the operator's lead assignments in full, by its assignment id.

The id is the ASSIGNMENT id — the \`id\` field from list_leads — not the lead's own id. An id that does not belong to this operator returns the same "not found" as one that does not exist.`,
    inputSchema: {
      type: "object",
      properties: {
        assignment_id: { type: "string", description: "The `id` from list_leads." },
      },
      required: ["assignment_id"],
      additionalProperties: false,
    },
    run: async (caller, args) => getAssignment(caller, String(args.assignment_id ?? "")),
  },

  {
    name: "list_lead_notes",
    title: "Read notes on a lead",
    scope: "leads:read",
    description: `Return the operator's own notes on one assignment, newest first.

These are what the operator wrote about their conversations with the landlord, and are the best evidence of what has actually happened on a lead — more reliable than \`status\`, which somebody can set without doing anything.

Fields:
${fieldGuide(NOTE_FIELDS)}`,
    inputSchema: {
      type: "object",
      properties: {
        assignment_id: { type: "string", description: "The `id` from list_leads." },
      },
      required: ["assignment_id"],
      additionalProperties: false,
    },
    run: async (caller, args) => listNotes(caller, String(args.assignment_id ?? "")),
  },

  {
    name: "get_lead_report_summary",
    title: "Check the property analysis",
    scope: "leads:read",
    description: `Report whether Stayful's full property-analysis PDF is available for one assignment, and how large it is.

The PDF itself is downloaded over HTTPS rather than through this tool, because a model cannot usefully read raw PDF bytes: fetch \`/api/v1/leads/{assignment_id}/report\` with the same API key. The headline figures the report is based on — projected gross annual revenue, nightly rate and occupancy — are already on the lead returned by list_leads and get_lead, so most questions can be answered without opening it.`,
    inputSchema: {
      type: "object",
      properties: {
        assignment_id: { type: "string", description: "The `id` from list_leads." },
      },
      required: ["assignment_id"],
      additionalProperties: false,
    },
    run: async (caller, args) => {
      const id = String(args.assignment_id ?? "");
      const result = await getReportSummary(caller, id);
      if (!result.ok) return result;
      return {
        ok: true,
        data: {
          available: true,
          size_bytes: result.data.size_bytes,
          download_url: `/api/v1/leads/${id}/report`,
          note: "Fetch the download_url with the same Authorization header to retrieve the PDF.",
        },
      };
    },
  },
];

export const TOOLS_BY_NAME = new Map(MCP_TOOLS.map((t) => [t.name, t]));
