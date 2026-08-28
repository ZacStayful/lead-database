/**
 * Inbound from TimelinesAI (§40).
 *
 * ⚠️ TIMELINESAI WEBHOOKS ARE COMPLETELY UNAUTHENTICATED. Their own OpenAPI spec
 * says so: "Authentication of the request or customizing headers is not
 * supported." No signature, no secret, no custom header. So the payload is an
 * UNVERIFIED ASSERTION THAT SOMETHING HAPPENED — never data — and four layers
 * stand between it and any lead state:
 *
 *   1. An unguessable 256-bit token in the PATH identifies the customer. An
 *      unknown token returns a 404 byte-identical to a known token with an
 *      unknown message, so this cannot enumerate customers.
 *   2. Claim by INSERT into message_webhook_events, deduped on message_uid.
 *   3. READ-BACK: we call GET /messages/{uid} with THAT customer's own token and
 *      believe the API, not the request body. Nothing reaches lead_messages
 *      until this succeeds.
 *   4. Match-or-discard.
 *
 * Layers 1 and 2 are here. Layers 3 and 4 are `ingestTimelinesEvent`, which is a
 * separate module SO THAT THE RECOVERY PASS CAN CALL THEM TOO — an event we
 * cannot read back inside the vendor's budget used to be lost for ever, because
 * that code was only reachable from this handler.
 *
 * ⚠️ WHY THIS SEES MESSAGES WE DIDN'T SEND. `message:sent:new` fires for messages
 * the operator sends from their own WhatsApp app, not only through our API. That
 * is the most valuable thing here: the problem this feature exists for is that
 * operators work leads on their phone where we cannot see it — 12 contact clicks
 * across 352 assignments while 210 claim first_contacted_at.
 *
 * ⚠️ WHICH IS WHY MATCH-OR-DISCARD IS NOT OPTIONAL. The workspace holds hundreds
 * of chats, most of them nothing to do with any landlord. A message is stored
 * ONLY when its number matches one of THIS customer's own leads. Everything else
 * is dropped before any write — a personal conversation must never enter this
 * database because a number happened to be in range.
 *
 * Budget: TimelinesAI wants 2xx within 5 seconds and retries twice.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  ingestTimelinesEvent,
  uidFromPayload,
  type TimelinesWebhookPayload,
} from "@/lib/messaging/ingestTimelinesEvent";
import { retryDelayMs } from "@/lib/messaging/webhookRetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Under TimelinesAI's 5s ceiling, leaving room to write. */
const READBACK_TIMEOUT_MS = 3000;

export async function POST(
  request: NextRequest,
  { params }: { params: { token: string } }
) {
  const admin = createAdminClient();

  // ---- Layer 1: who is this? ----------------------------------------------
  const { data: connRow } = await admin
    .from("customer_whatsapp_connections")
    .select("id, customer_id, token_ciphertext, status")
    .eq("webhook_token", params.token)
    .maybeSingle();

  // One 404 for an unknown token and for anything else we decline, so this
  // endpoint cannot be used to discover which tokens are live.
  if (!connRow) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const conn = connRow as {
    id: string;
    customer_id: string;
    token_ciphertext: string | null;
    status: string;
  };

  let payload: TimelinesWebhookPayload;
  try {
    payload = (await request.json()) as TimelinesWebhookPayload;
  } catch {
    return NextResponse.json({ received: true, ignored: "bad_json" });
  }

  const eventType = payload.event_type ?? "";

  // ---- Account health events ----------------------------------------------
  // These carry no message uid, so their read-back is the account list. An
  // unsigned "you are disconnected" that we trusted would be a one-request
  // denial of service against a paying customer's messaging.
  if (eventType.startsWith("whatsapp:account:")) {
    const status = eventType.endsWith("suspended")
      ? "suspended"
      : eventType.endsWith("disconnected")
        ? "disconnected"
        : null;
    if (status) {
      await admin
        .from("customer_whatsapp_connections")
        .update({ status, last_error: `timelines:${eventType}`, updated_at: new Date().toISOString() })
        .eq("id", conn.id);
    }
    return NextResponse.json({ received: true });
  }

  const uid = uidFromPayload(payload);
  if (!uid) {
    console.warn("[webhook/timelines] dropped: no_uid", { eventType });
    return NextResponse.json({ received: true, ignored: "no_uid" });
  }

  // ---- Layer 2: claim by INSERT -------------------------------------------
  const claimId = `timelines:${eventType}:${uid}`;
  const { error: claimErr } = await admin.from("message_webhook_events").insert({
    id: claimId,
    provider: "timelinesai",
    event_type: eventType,
    // The tenant, resolved from the path token above. Without it the recovery
    // pass has nothing to attribute the event to and no token to read it back
    // with — the claim id carries only the event type and the uid.
    customer_id: conn.customer_id,
    // ⚠️ THE BODY IS STORED ON EVERY EVENT, not only the deferred ones.
    // Diagnosing why replies were being dropped needed a round trip to the
    // vendor, because twenty rows had been claimed and not one had kept what
    // was actually sent. It is the only part of this we cannot reconstruct
    // afterwards, and it costs a jsonb column. It is also what the recovery
    // pass re-runs from.
    payload: payload as unknown as Record<string, unknown>,
    // `verified` is NOT NULL DEFAULT true, so leaving it unset on the happy
    // path made every row read `true` whatever happened. Claimed but not yet
    // read back is false; a successful ingest is what promotes it.
    verified: false,
    // Due immediately, so a crash between the claim and the ingest below leaves
    // the event recoverable rather than stranded.
    next_attempt_at: new Date().toISOString(),
  });

  if (claimErr) {
    if ((claimErr as { code?: string }).code === "23505") {
      return NextResponse.json({ received: true, deduped: true });
    }
    console.error("[webhook/timelines] claim failed", claimErr.message);
    return NextResponse.json({ received: true, ignored: "claim_error" });
  }

  try {
    // ---- Layers 3 and 4 -----------------------------------------------------
    const result = await ingestTimelinesEvent(admin, {
      customerId: conn.customer_id,
      tokenCiphertext: conn.token_ciphertext,
      uid,
      payload,
      claimId,
      timeoutMs: READBACK_TIMEOUT_MS,
    });

    if (result.outcome === "deferred") {
      // Could not confirm inside the budget, so nothing is trusted and nothing
      // is written. The row keeps `verified: false`, its payload and a due time,
      // and the recovery phase of /api/cron/poll-whatsapp-status picks it up.
      //
      // ⚠️ The vendor's own retries cannot rescue this: the claim above already
      // exists, so each one short-circuits on 23505. Recovery is ours alone.
      console.warn("[webhook/timelines] deferred", { claimId, reason: result.reason });
      await admin
        .from("message_webhook_events")
        .update({
          attempts: 1,
          next_attempt_at: new Date(Date.now() + retryDelayMs(1)).toISOString(),
        })
        .eq("id", claimId);
      return NextResponse.json({ received: true, deferred: true });
    }

    // Verified. A `dropped` event was genuinely read back and genuinely is not
    // ours to keep, so it is settled — retrying would not change the answer.
    await admin
      .from("message_webhook_events")
      .update({ verified: true, next_attempt_at: null })
      .eq("id", claimId);

    return result.outcome === "stored"
      ? NextResponse.json({ received: true, stored: true })
      : NextResponse.json({ received: true, ignored: result.reason });
  } catch (e) {
    // Release the claim so TimelinesAI's retry can have another go — the
    // stripe_events discipline.
    await admin.from("message_webhook_events").delete().eq("id", claimId);
    console.error("[webhook/timelines] failed", e instanceof Error ? e.message : e);
    return NextResponse.json({ received: false }, { status: 500 });
  }
}
