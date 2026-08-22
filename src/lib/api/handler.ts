/**
 * The wrapper every /v1 route goes through.
 *
 * Resolve the caller, check the scope, run the service function, map the result
 * onto the envelope, attach the headers, and log. Doing all of that in one place
 * is what keeps the route files down to a handler call and a comment — and,
 * more importantly, means a new route cannot be served without being logged or
 * without honouring the kill switch.
 *
 * NO CORS HEADERS ANYWHERE, deliberately. API keys must never be used from a
 * browser, and the absence of `Access-Control-Allow-Origin` is also what makes
 * the cookie-session fallback safe: a page on another origin can send a request
 * with the user's cookies attached, but it cannot read the response.
 */
import { NextResponse, type NextRequest } from "next/server";
import { resolveCaller, type Caller, type CallerVia } from "@/lib/api/caller";
import { STATUS_BY_CODE, type ApiErrorCode, type ApiResult } from "@/lib/api/errors";
import type { ApiScope } from "@/lib/api/scopes";
import { RATE_LIMIT_PER_MINUTE, RATE_LIMIT_WINDOW_SECONDS } from "@/lib/api/limits";
import { clientIp, logApiRequest, resolveRequestId } from "@/lib/api/log";

export interface HandlerOptions<T> {
  /** Scope the caller must hold. */
  scope: ApiScope;
  /** Stable label for the request log, e.g. "GET /v1/leads". */
  operation: string;
  /** Which credentials this route accepts. */
  allow?: readonly CallerVia[];
  /** Success renderer. Defaults to JSON. */
  render?: (data: T) => NextResponse;
}

function baseHeaders(requestId: string, minuteCount: number): Record<string, string> {
  const remaining = Math.max(0, RATE_LIMIT_PER_MINUTE - minuteCount);
  return {
    "X-Request-Id": requestId,
    "X-RateLimit-Limit": String(RATE_LIMIT_PER_MINUTE),
    "X-RateLimit-Remaining": String(remaining),
    // Every response here is per-customer and authenticated. Next's default of
    // `public, max-age=0, must-revalidate` invites any shared proxy between us
    // and the caller to hold a copy, which for this surface would mean one
    // customer's leads sitting in someone else's cache.
    "Cache-Control": "no-store, private",
  };
}

export function withApi<T>(
  options: HandlerOptions<T>,
  fn: (caller: Caller, request: NextRequest, params: Record<string, string>) => Promise<ApiResult<T>>
) {
  return async function handler(
    request: NextRequest,
    context?: { params?: Record<string, string> }
  ): Promise<NextResponse> {
    const startedAt = Date.now();
    const requestId = resolveRequestId(request);
    const ip = clientIp(request);
    const userAgent = request.headers.get("user-agent");

    let caller: Caller | null = null;

    const finish = (
      status: number,
      body: unknown,
      errorCode: ApiErrorCode | null,
      headers: Record<string, string>
    ): NextResponse => {
      void logApiRequest({
        requestId,
        surface: "rest",
        operation: options.operation,
        statusCode: status,
        errorCode,
        keyId: caller?.keyId ?? null,
        customerId: caller?.customerId ?? null,
        durationMs: Date.now() - startedAt,
        ip,
        userAgent,
      });
      return NextResponse.json(body as object, { status, headers });
    };

    const resolved = await resolveCaller(request, { allow: options.allow });
    if (!resolved.ok) {
      const status = STATUS_BY_CODE[resolved.code];
      const headers = baseHeaders(requestId, RATE_LIMIT_PER_MINUTE);
      if (resolved.code === "rate_limited") {
        headers["Retry-After"] = String(RATE_LIMIT_WINDOW_SECONDS);
      }
      return finish(
        status,
        { error: { code: resolved.code, message: resolved.message } },
        resolved.code,
        headers
      );
    }

    caller = resolved.caller;
    const headers = baseHeaders(requestId, caller.minuteCount);

    if (!caller.scopes.includes(options.scope)) {
      return finish(
        403,
        {
          error: {
            code: "insufficient_scope",
            message: `This key does not carry the ${options.scope} scope.`,
          },
        },
        "insufficient_scope",
        headers
      );
    }

    let result: ApiResult<T>;
    try {
      result = await fn(caller, request, context?.params ?? {});
    } catch (err) {
      console.error(`[api] ${options.operation} threw`, err);
      return finish(
        500,
        {
          error: {
            code: "internal_error",
            message:
              "Something went wrong on our side. Quote the X-Request-Id header if you contact support.",
          },
        },
        "internal_error",
        headers
      );
    }

    if (!result.ok) {
      return finish(
        STATUS_BY_CODE[result.code],
        { error: { code: result.code, message: result.message } },
        result.code,
        headers
      );
    }

    // Success. A custom renderer (the report endpoint streams a PDF) still gets
    // the headers and still gets logged.
    if (options.render) {
      const response = options.render(result.data);
      for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
      void logApiRequest({
        requestId,
        surface: "rest",
        operation: options.operation,
        statusCode: response.status,
        errorCode: null,
        keyId: caller.keyId,
        customerId: caller.customerId,
        durationMs: Date.now() - startedAt,
        ip,
        userAgent,
      });
      return response;
    }

    return finish(200, result.data, null, headers);
  };
}
