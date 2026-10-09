/**
 * GET /api/internal/retention — the retention summary JARVIS reads (§74).
 *
 * The same figures as /admin/retention, shaped by src/lib/retentionSummary.ts
 * (pure, tested) from the same getRetentionData() read. Nothing here writes,
 * spends a credit, or touches a balance, counter, pacing or capacity column.
 *
 * TWO WAYS IN, AND THE ORDER MATTERS
 *   1. `x-internal-secret` equal to JARVIS_INTERNAL_SECRET — the machine
 *      caller (ZacStayful/Jarvis, `lib/retention/lead-db.ts`). ⚠️ FAILS CLOSED:
 *      with the env var unset the route answers 404, the analyser's own
 *      INTERNAL_API_SECRET shape (`src/lib/analyserClient.ts`), so a half-
 *      deployed secret can never be an open door. A wrong secret is 401.
 *   2. No header at all → an admin session, so Zac can open it in a browser
 *      the way /api/admin/monday-status-check works.
 *
 * ⚠️ NOT ADMIN_SECRET_KEY. That key also authorises the admin WRITE routes
 * (invite, reset-password, assign). JARVIS gets its own read-only secret so
 * a leak there cannot reach them.
 *
 * ⚠️ NOT the public API (§27.1). No API key, no /api/v1, no rate limiter — it
 * is one server talking to another with a shared secret, like the analyser.
 *
 * The view-as middleware matches this path but refuses only mutating methods,
 * so a GET passes untouched.
 */

import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isAdminUser } from "@/lib/auth";
import { getRetentionData } from "@/lib/retentionData";
import { summariseRetention } from "@/lib/retentionSummary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store, private" };

function secretMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function isAuthorised(request: NextRequest): Promise<NextResponse | null> {
  const given = request.headers.get("x-internal-secret");
  if (given !== null) {
    const expected = process.env.JARVIS_INTERNAL_SECRET?.trim();
    if (!expected) {
      return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
    }
    if (!secretMatches(given.trim(), expected)) {
      return NextResponse.json({ error: "Unauthorised" }, { status: 401, headers: NO_STORE });
    }
    return null;
  }

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!isAdminUser(user)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401, headers: NO_STORE });
  }
  return null;
}

export async function GET(request: NextRequest) {
  const refusal = await isAuthorised(request);
  if (refusal) return refusal;

  const data = await getRetentionData();
  const summary = summariseRetention(data, new Date());
  return NextResponse.json(summary, {
    status: data.unavailable ? 503 : 200,
    headers: NO_STORE,
  });
}
