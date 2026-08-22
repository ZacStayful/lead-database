/**
 * JSON-RPC dispatch for the MCP endpoint.
 *
 * HAND-ROLLED, WITH NO SDK, DELIBERATELY. The official SDK's Streamable HTTP
 * transport is built around Node's req/res objects and does not mount in an App
 * Router handler without an adapter; the adapters pin their SDK peer exactly,
 * pull in zod — which this repository has deliberately never had — and at least
 * one line requires a Node floor this project does not pin anywhere. That is
 * the same trap `unpdf` is pinned to ~1.7.0 to avoid.
 *
 * What we actually need is five read-only tools over a stateless
 * request/response server, which the transport spec explicitly permits: a POST
 * carrying one JSON-RPC request may be answered with a single
 * `Content-Type: application/json` object. No SSE, no session ids, no
 * long-lived connections, and therefore no maxDuration question.
 */
import { MCP_TOOLS, TOOLS_BY_NAME } from "@/lib/mcp/tools";
import type { Caller } from "@/lib/api/caller";

/** Versions we can speak, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
] as const;
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/** What a client that sends no MCP-Protocol-Version header is assumed to speak. */
export const ASSUMED_PROTOCOL_VERSION = "2025-03-26";

export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;

export interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export type DispatchOutcome =
  | { kind: "response"; body: Record<string, unknown>; operation: string }
  /** A notification or response from the client: 202 with no body. */
  | { kind: "accepted"; operation: string };

function result(id: unknown, value: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, result: value };
}

export function rpcError(
  id: unknown,
  code: number,
  message: string
): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/**
 * Negotiate a protocol version.
 *
 * If the client asks for one we speak, agree to it. Otherwise answer with our
 * latest and let the client decide whether it can continue — which is what the
 * lifecycle spec asks for, rather than refusing outright.
 */
function negotiate(requested: unknown): string {
  if (
    typeof requested === "string" &&
    (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
  ) {
    return requested;
  }
  return LATEST_PROTOCOL_VERSION;
}

export async function dispatch(
  message: JsonRpcMessage,
  caller: Caller
): Promise<DispatchOutcome> {
  const method = typeof message.method === "string" ? message.method : "";
  const isNotification = message.id === undefined || message.id === null;

  // Client notifications and responses are acknowledged with 202 and no body,
  // per the transport spec. `notifications/initialized` is the common one.
  if (isNotification) {
    return { kind: "accepted", operation: method || "notification" };
  }

  const id = message.id;

  switch (method) {
    case "initialize": {
      const params = (message.params ?? {}) as Record<string, unknown>;
      return {
        kind: "response",
        operation: "initialize",
        body: result(id, {
          protocolVersion: negotiate(params.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: "stayful-leads",
            title: "Stayful Lead Marketplace",
            version: "1.0.0",
          },
          instructions:
            "Read-only access to this operator's own Stayful leads. A lead is a pre-screened landlord enquiry they have paid for. Two money figures exist and are never interchangeable: `gross_annual_income` is Stayful's projection for the property, identical for everyone holding that lead; `income_estimate` is the operator's own hand-entered figure. `status` is self-reported, so it measures record-keeping rather than work — notes are better evidence of what has actually happened.",
        }),
      };
    }

    case "ping":
      return { kind: "response", operation: "ping", body: result(id, {}) };

    case "tools/list":
      return {
        kind: "response",
        operation: "tools/list",
        body: result(id, {
          tools: MCP_TOOLS.map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        }),
      };

    case "tools/call": {
      const params = (message.params ?? {}) as Record<string, unknown>;
      const name = typeof params.name === "string" ? params.name : "";
      const tool = TOOLS_BY_NAME.get(name);

      if (!tool) {
        return {
          kind: "response",
          operation: `tools/call:${name || "unknown"}`,
          body: rpcError(id, JSONRPC_INVALID_PARAMS, `Unknown tool: ${name}`),
        };
      }

      const operation = `tools/call:${tool.name}`;

      if (!caller.scopes.includes(tool.scope)) {
        return {
          kind: "response",
          operation,
          body: result(id, {
            isError: true,
            content: [
              {
                type: "text",
                text: `This API key does not carry the ${tool.scope} scope, which ${tool.name} requires.`,
              },
            ],
          }),
        };
      }

      const args = (params.arguments ?? {}) as Record<string, unknown>;

      let outcome;
      try {
        outcome = await tool.run(caller, args);
      } catch (err) {
        console.error(`[mcp] ${tool.name} threw`, err);
        return {
          kind: "response",
          operation,
          body: rpcError(id, JSONRPC_INTERNAL_ERROR, "The tool failed unexpectedly."),
        };
      }

      // A tool that refuses is reported as tool CONTENT with isError, not as a
      // JSON-RPC error: the model needs to read "that lead is not yours" and
      // adjust, whereas a protocol-level error is invisible to it.
      if (!outcome.ok) {
        return {
          kind: "response",
          operation,
          body: result(id, {
            isError: true,
            content: [{ type: "text", text: outcome.message }],
          }),
        };
      }

      const text = JSON.stringify(outcome.data, null, 2);
      return {
        kind: "response",
        operation,
        body: result(id, {
          content: [{ type: "text", text }],
          structuredContent: outcome.data,
        }),
      };
    }

    default:
      return {
        kind: "response",
        operation: method || "unknown",
        body: rpcError(id, JSONRPC_METHOD_NOT_FOUND, `Unknown method: ${method}`),
      };
  }
}
