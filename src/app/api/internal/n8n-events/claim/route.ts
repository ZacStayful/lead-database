import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { N8N_EVENT_MAX_AGE_HOURS, n8nClaimLimit } from "@/lib/n8nEvents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/internal/n8n-events/claim
 *
 * Batch 04 Phase 2 (C8): the events n8n picks up. Today one type,
 * `brief_area_updated`: a long-paused Lead Brief customer's area was
 * recalculated and is waiting for them to confirm. n8n sends the WhatsApp,
 * whose wording Zac approves; this app never holds it.
 *
 * Pulled, never pushed: n8n calls this on a schedule. Each event is handed out
 * ONCE (claim_n8n_events stamps it in the same statement that returns it), and
 * never after N8N_EVENT_MAX_AGE_HOURS, so a message about a return that has
 * already happened is not sent late. A claimed event that n8n then fails to
 * send is not re-offered: the email is the message of record, and the
 * dashboard shows the area whether or not either lands.
 *
 * Auth: Bearer N8N_WEBHOOK_SECRET, the secret n8n already presents to this app
 * (/api/webhook/n8n, /api/funnel/session). Fails CLOSED when it is unset.
 *
 * Body (optional): { "limit": 1–100 }, default 25. Response:
 *   { "events": [{ id, event_type, customer_id, payload, created_at }] }
 */
export async function POST(request: NextRequest) {
  const secret = process.env.N8N_WEBHOOK_SECRET;
  const auth = request.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown = null;
  try {
    const text = await request.text();
    body = text ? JSON.parse(text) : null;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const limit = n8nClaimLimit(body);
  if (limit === null) {
    return NextResponse.json({ error: "limit must be a whole number from 1 to 100" }, { status: 400 });
  }

  const { data, error } = await createAdminClient().rpc("claim_n8n_events", {
    p_limit: limit,
    p_max_age_hours: N8N_EVENT_MAX_AGE_HOURS,
  });
  if (error) {
    console.error("[n8n-events/claim] claim failed", error.code, error.message);
    return NextResponse.json({ error: "Could not read events" }, { status: 500 });
  }
  return NextResponse.json(
    { events: Array.isArray(data) ? data : [] },
    { headers: { "Cache-Control": "no-store" } }
  );
}
