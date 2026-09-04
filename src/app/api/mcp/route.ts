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
 *
 * ⚠️ THE ORIGIN GUARD AND THE NO-CORS POSTURE ARE GONE, deliberately. The
 * paragraph above is why they were safe to remove: the objection they answered
 * was that a cross-origin page could POST with the visitor's cookies attached,
 * and this endpoint cannot read a cookie session at all. `src/lib/api/cors.ts`
 * carries the full argument and the one rule that replaces them — never send
 * `Access-Control-Allow-Credentials`. Browser-based OAuth clients need to read
 * `WWW-Authenticate` to find our metadata, which a same-origin-only endpoint
 * makes impossible.
 */
import { NextResponse, type NextRequest } from "next/server";
import { resolveCaller } from "@/lib/api/caller";
import { STATUS_BY_CODE } from "@/lib/api/errors";
import {
  JSONRPC_INVALID_REQUEST,
  JSONRPC_PARSE_ERROR,
  dispatch,
  protocolVersionForHeader,
  rpcError,
  type JsonRpcMessage,
} from "@/lib/mcp/dispatch";
import { clientIp, logApiRequest, resolveRequestId } from "@/lib/api/log";
import { withCors } from "@/lib/api/cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  const requestId = resolveRequestId(request);
  const ip = clientIp(request);
  const userAgent = request.headers.get("user-agent");

  // Awaited for the reason given in src/lib/api/handler.ts: an un-awaited
  // insert can be lost when the invocation freezes on responding.
  const log = (
    operation: string,
    statusCode: number,
    errorCode: string | null,
    keyId: string | null,
    customerId: string | null
  ) =>
    logApiRequest({
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

  // An unknown protocol version is negotiated down rather than refused — see
  // protocolVersionForHeader() for why the old 400 was a hazard, and why it
  // being raised BEFORE authentication made it a worse one.
  const protocolVersion = protocolVersionForHeader(
    request.headers.get("mcp-protocol-version")
  );

  const resolved = await resolveCaller(request, { allow: ["api_key"] });
  if (!resolved.ok) {
    await log("unauthenticated", STATUS_BY_CODE[resolved.code], resolved.code, null, null);
    return NextResponse.json(
      rpcError(null, JSONRPC_INVALID_REQUEST, resolved.message),
      {
        status: STATUS_BY_CODE[resolved.code],
        headers: withCors({
          "X-Request-Id": requestId,
          "Cache-Control": "no-store, private",
          // Shaped so the OAuth phase can add a `resource_metadata` parameter
          // here without restructuring the response.
          "WWW-Authenticate": "Bearer",
        }),
      }
    );
  }
  const caller = resolved.caller;

  let message: JsonRpcMessage;
  try {
    message = (await request.json()) as JsonRpcMessage;
  } catch {
    await log("parse_error", 400, "invalid_request", caller.keyId, caller.customerId);
    return NextResponse.json(rpcError(null, JSONRPC_PARSE_ERROR, "Invalid JSON."), {
      status: 400,
      headers: withCors({
        "X-Request-Id": requestId,
        "Cache-Control": "no-store, private",
      }),
    });
  }

  if (!message || typeof message !== "object" || Array.isArray(message)) {
    // Batching was removed from the protocol, so an array is not a valid body.
    await log("invalid_request", 400, "invalid_request", caller.keyId, caller.customerId);
    return NextResponse.json(
      rpcError(null, JSONRPC_INVALID_REQUEST, "Expected a single JSON-RPC message."),
      { status: 400, headers: withCors({ "X-Request-Id": requestId }) }
    );
  }

  const outcome = await dispatch(message, caller);

  if (outcome.kind === "accepted") {
    await log(outcome.operation, 202, null, caller.keyId, caller.customerId);
    return new NextResponse(null, {
      status: 202,
      headers: withCors({
        "X-Request-Id": requestId,
        "Cache-Control": "no-store, private",
      }),
    });
  }

  log(outcome.operation, 200, null, caller.keyId, caller.customerId);
  return NextResponse.json(outcome.body, {
    headers: withCors({
      "X-Request-Id": requestId,
      "Cache-Control": "no-store, private",
      "MCP-Protocol-Version": protocolVersion,
    }),
  });
}

/**
 * 405 is the correct answer here, not an error: the spec says a server that
 * does not offer a server-initiated SSE stream at this endpoint should say so
 * this way, and a stateless read-only server has nothing to push.
 *
 * It carries the CORS headers and the same `WWW-Authenticate` challenge as the
 * POST because SOME CLIENTS PROBE WITH A GET FIRST — the deprecated HTTP+SSE
 * transport starts that way. A client that never gets as far as a POST would
 * otherwise see nothing telling it that authentication exists or where the
 * metadata lives.
 */
export async function GET() {
  return NextResponse.json(
    rpcError(null, JSONRPC_INVALID_REQUEST, "This MCP server does not offer an SSE stream. Use POST."),
    {
      status: 405,
      headers: withCors({
        Allow: "POST, OPTIONS",
        "Cache-Control": "no-store, private",
        "WWW-Authenticate": "Bearer",
      }),
    }
  );
}

/** CORS preflight. Browser-based OAuth clients send one before the first POST. */
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: withCors({ Allow: "POST, OPTIONS" }),
  });
}
