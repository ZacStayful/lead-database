/**
 * One row per API request, REST and MCP alike.
 *
 * SHARED BY BOTH SURFACES ON PURPOSE. If the MCP dispatcher logged separately —
 * or not at all — the admin view would show REST traffic and silently omit MCP,
 * which is exactly the half somebody investigating an integration would be
 * looking for.
 *
 * REJECTED REQUESTS ARE LOGGED TOO, with a null key and customer. A bad key, an
 * expired one, a tripped rate limit and the kill switch are most of what is
 * worth seeing when something is wrong; a log that only recorded successes
 * would be empty in exactly the situation it exists for.
 *
 * Best-effort throughout: a lost log row must never cost a customer their data.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import type { NextRequest } from "next/server";

type Admin = ReturnType<typeof createAdminClient>;

export type ApiSurface = "rest" | "mcp";

export interface LogEntry {
  requestId: string;
  surface: ApiSurface;
  operation: string;
  statusCode: number;
  errorCode?: string | null;
  keyId?: string | null;
  customerId?: string | null;
  durationMs?: number | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * A request id for correlation. An inbound one is echoed so a caller that
 * already has tracing can join their logs to ours; otherwise we mint one.
 * Bounded and stripped, because it is written to the database and returned in
 * a header.
 */
export function resolveRequestId(request: NextRequest): string {
  const inbound = request.headers.get("x-request-id");
  if (inbound) {
    const cleaned = inbound.replace(/[^\w.:-]/g, "").slice(0, 80);
    if (cleaned.length > 0) return cleaned;
  }
  return crypto.randomUUID();
}

/** Client IP as far as the platform reports it. */
export function clientIp(request: NextRequest): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim().slice(0, 60) || null;
  return request.headers.get("x-real-ip")?.slice(0, 60) ?? null;
}

export async function logApiRequest(
  entry: LogEntry,
  adminClient?: Admin
): Promise<void> {
  try {
    const admin = adminClient ?? createAdminClient();
    const { error } = await admin.from("api_request_log").insert({
      request_id: entry.requestId,
      key_id: entry.keyId ?? null,
      customer_id: entry.customerId ?? null,
      surface: entry.surface,
      operation: entry.operation.slice(0, 200),
      status_code: entry.statusCode,
      error_code: entry.errorCode ?? null,
      duration_ms: entry.durationMs ?? null,
      ip: entry.ip ?? null,
      user_agent: entry.userAgent?.slice(0, 300) ?? null,
    });
    if (error) console.error("[api] request log insert failed", error);
  } catch (err) {
    console.error("[api] request log threw", err);
  }
}
