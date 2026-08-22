/**
 * The MCP endpoint — Streamable HTTP, stateless, read-only.
 *
 * KEY-ONLY: no cookie-session fallback, deliberately. A page on another origin
 * can POST `application/json` with the visitor's cookies attached; it cannot
 * read the reply (we send no CORS headers), and everything here is a read — but
 * a JSON-RPC endpoint that honours ambient credentials is not a shape to ship,
 * and the cost of refusing is nil because no browser is a legitimate client.
 *
 * AUTHENTICATION IS REQUIRED ON EVERY REQUEST, `initialize` and `tools/list`
 * included. Those are the calls that enumerate the tool surface, so leaving
 * them open would publish the whole interface to anybody who found the URL.
 */
import { NextResponse, type NextRequest } from "next/server";
import { resolveCaller } from "@/lib/api/caller";
import { STATUS_BY_CODE } from "@/lib/api/errors";
import {
  ASSUMED_PROTOCOL_VERSION,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_PARSE_ERROR,
  SUPPORTED_PROTOCOL_VERSIONS,
  dispatch,
  rpcError,
  type JsonRpcMessage,
} from "@/lib/mcp/dispatch";
import { clientIp, logApiRequest, resolveRequestId } from "@/lib/api/log";
import { APP_URL } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DNS-rebinding guard required by the transport spec: if an Origin header is
 * present and is not one we recognise, refuse with 403.
 *
 * Real MCP clients — n8n, Claude Desktop, Cursor, a script — are not browsers
 * and send no Origin at all, so this only ever fires on something that is
 * pretending to be one of them from a web page.
 */
function originAllowed(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(APP_URL).origin;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  const requestId = resolveRequestId(request);
  const ip = clientIp(request);
  const userAgent = request.headers.get("user-agent");

  const log = (
    operation: string,
    statusCode: number,
    errorCode: string | null,
    keyId: string | null,
    customerId: string | null
  ) =>
    void logApiRequest({
      requestId,
      surface: "mcp",
      operation,
      statusCode,
      errorCode,
      keyId,
      customerId,
      durationMs: Date.now() - startedAt,
      ip,
      userAgent,
    });

  if (!originAllowed(request)) {
    log("origin_rejected", 403, "forbidden_origin", null, null);
    return NextResponse.json(
      rpcError(null, JSONRPC_INVALID_REQUEST, "Origin not allowed."),
      { status: 403, headers: { "X-Request-Id": requestId } }
    );
  }

  // An explicitly unsupported protocol version must be a 400 rather than a
  // best-effort guess; a client that asked for something we cannot speak needs
  // to know, not to receive plausible-looking nonsense.
  const declared = request.headers.get("mcp-protocol-version");
  if (
    declared &&
    !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(declared)
  ) {
    log("bad_protocol_version", 400, "invalid_request", null, null);
    return NextResponse.json(
      rpcError(
        null,
        JSONRPC_INVALID_REQUEST,
        `Unsupported MCP-Protocol-Version: ${declared}. Supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}.`
      ),
      { status: 400, headers: { "X-Request-Id": requestId } }
    );
  }

  const resolved = await resolveCaller(request, { allow: ["api_key"] });
  if (!resolved.ok) {
    log("unauthenticated", STATUS_BY_CODE[resolved.code], resolved.code, null, null);
    return NextResponse.json(
      rpcError(null, JSONRPC_INVALID_REQUEST, resolved.message),
      {
        status: STATUS_BY_CODE[resolved.code],
        headers: {
          "X-Request-Id": requestId,
          // Shaped so the OAuth phase can add a `resource_metadata` parameter
          // here without restructuring the response.
          "WWW-Authenticate": "Bearer",
        },
      }
    );
  }
  const caller = resolved.caller;

  let message: JsonRpcMessage;
  try {
    message = (await request.json()) as JsonRpcMessage;
  } catch {
    log("parse_error", 400, "invalid_request", caller.keyId, caller.customerId);
    return NextResponse.json(rpcError(null, JSONRPC_PARSE_ERROR, "Invalid JSON."), {
      status: 400,
      headers: { "X-Request-Id": requestId },
    });
  }

  if (!message || typeof message !== "object" || Array.isArray(message)) {
    // Batching was removed from the protocol, so an array is not a valid body.
    log("invalid_request", 400, "invalid_request", caller.keyId, caller.customerId);
    return NextResponse.json(
      rpcError(null, JSONRPC_INVALID_REQUEST, "Expected a single JSON-RPC message."),
      { status: 400, headers: { "X-Request-Id": requestId } }
    );
  }

  const outcome = await dispatch(message, caller);

  if (outcome.kind === "accepted") {
    log(outcome.operation, 202, null, caller.keyId, caller.customerId);
    return new NextResponse(null, {
      status: 202,
      headers: { "X-Request-Id": requestId },
    });
  }

  log(outcome.operation, 200, null, caller.keyId, caller.customerId);
  return NextResponse.json(outcome.body, {
    headers: {
      "X-Request-Id": requestId,
      "MCP-Protocol-Version": declared ?? ASSUMED_PROTOCOL_VERSION,
    },
  });
}

/**
 * 405 is the correct answer here, not an error: the spec says a server that
 * does not offer a server-initiated SSE stream at this endpoint should say so
 * this way, and a stateless read-only server has nothing to push.
 */
export async function GET() {
  return NextResponse.json(
    rpcError(null, JSONRPC_INVALID_REQUEST, "This MCP server does not offer an SSE stream. Use POST."),
    { status: 405, headers: { Allow: "POST" } }
  );
}
