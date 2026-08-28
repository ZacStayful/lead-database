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
 *   4. Match-or-discard (below).
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
import { decryptSecret, timelinesTokenAad } from "@/lib/crypto/secretBox";
import { getMessage, mapStatus } from "@/lib/messaging/timelines";
import { normalisePhone, resolveWebhookIdentity } from "@/lib/messaging/whatsappIdentity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Under TimelinesAI's 5s ceiling, leaving room to write. */
const READBACK_TIMEOUT_MS = 3000;

/**
 * ⚠️ WRITTEN FROM THE DOCS, AND THE DOCS ARE NOT THE WIRE. Every field here is
 * optional and every one is treated as a HINT, because the shape that actually
 * arrives has already been wrong once: `chat.jid` was assumed and is not there,
 * which silently discarded twenty events. Nothing load-bearing may be read from
 * this — the read-back is the source of truth. Both nestings of the uid are
 * accepted for the same reason.
 */
interface Payload {
  event_type?: string;
  chat?: { chat_id?: number | string; phone?: string | null; jid?: string | null };
  message?: {
    message_uid?: string;
    uid?: string;
    text?: string | null;
    direction?: string;
    timestamp?: string;
  };
  message_uid?: string;
  uid?: string;
  whatsapp_account?: { phone?: string | null };
}

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

  let payload: Payload;
  try {
    payload = (await request.json()) as Payload;
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

  const uid =
    payload.message?.message_uid ??
    payload.message?.uid ??
    payload.message_uid ??
    payload.uid;
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
    // ⚠️ THE BODY IS STORED ON EVERY EVENT, not only the deferred ones.
    // Diagnosing why replies were being dropped needed a round trip to the
    // vendor, because twenty rows had been claimed and not one had kept what
    // was actually sent. It is the only part of this we cannot reconstruct
    // afterwards, and it costs a jsonb column.
    payload: payload as unknown as Record<string, unknown>,
    // `verified` is NOT NULL DEFAULT true, so leaving it unset on the happy
    // path made every row read `true` whatever happened. Claimed but not yet
    // read back is false; the read-back below is what promotes it.
    verified: false,
  });

  if (claimErr) {
    if ((claimErr as { code?: string }).code === "23505") {
      return NextResponse.json({ received: true, deduped: true });
    }
    console.error("[webhook/timelines] claim failed", claimErr.message);
    return NextResponse.json({ received: true, ignored: "claim_error" });
  }

  try {
    if (!conn.token_ciphertext) {
      return NextResponse.json({ received: true, ignored: "no_credential" });
    }

    // ---- Layer 3: read back. Believe the API, not the body. ---------------
    const token = decryptSecret(conn.token_ciphertext, timelinesTokenAad(conn.customer_id));
    const verified = await getMessage(token, uid, READBACK_TIMEOUT_MS);

    if (!verified.ok) {
      // Could not confirm inside the budget, so nothing is trusted and nothing
      // is written. The row keeps `verified: false` and its payload.
      //
      // ⚠️ KNOWN GAP: nothing promotes it afterwards. An earlier comment here
      // claimed a maintenance pass would; there is none, so an event that
      // cannot be read back inside 3 seconds is lost. Recovering it means
      // extracting the match-and-store below into something the poller cron can
      // re-run. Recorded in CLAUDE.md §40.8 rather than built here.
      console.warn("[webhook/timelines] deferred: read-back failed", {
        claimId,
        code: verified.code,
      });
      return NextResponse.json({ received: true, deferred: true });
    }

    await admin
      .from("message_webhook_events")
      .update({ verified: true })
      .eq("id", claimId);

    // ---- Layer 4: match to one of THIS customer's leads, or discard --------
    //
    // ⚠️ BOTH FACTS COME FROM THE READ-BACK, NOT THE BODY. This is the bug that
    // stopped every reply reaching the system for a day: the counterparty was
    // read from `payload.chat.jid`, which is not in the shape the body actually
    // arrives in, so all 20 events were dropped here with a 200. See
    // resolveWebhookIdentity for the full account.
    const { direction, rawPhone } = resolveWebhookIdentity({
      message: verified.data,
      bodyJid: payload.chat?.jid ?? null,
      bodyPhone: payload.chat?.phone ?? null,
      bodyDirection: payload.message?.direction ?? null,
    });

    const key = normalisePhone(rawPhone);
    if (!key) {
      // Logged, because a silent 200 is what made this invisible: twenty events
      // arrived, every one was discarded, and nothing anywhere said so.
      console.warn("[webhook/timelines] dropped: not_dialable", { claimId });
      return NextResponse.json({ received: true, ignored: "not_dialable" });
    }

    // PostgREST cannot call normalised_phone in a filter, so the comparison is
    // done here over this customer's OWN assignments only. Scoping the query by
    // customer_id first is what makes "match one of their leads" true rather
    // than "match any lead in the database".
    //
    // !inner so an assignment whose lead is missing drops out rather than
    // arriving with a null lead (the §27.8 embedded-filter trap).
    const { data: mine } = await admin
      .from("lead_assignments")
      .select("id, lead_id, leads!inner(phone)")
      .eq("customer_id", conn.customer_id)
      .not("leads.phone", "is", null)
      .order("assigned_at", { ascending: false })
      .limit(500);

    type Row = { id: string; lead_id: string; leads: { phone: string | null }[] | { phone: string | null } | null };
    const hit = ((mine ?? []) as unknown as Row[]).find((r) => {
      const lead = Array.isArray(r.leads) ? r.leads[0] : r.leads;
      return normalisePhone(lead?.phone ?? null) === key;
    });
    const assignmentId: string | null = hit?.id ?? null;
    const leadId: string | null = hit?.lead_id ?? null;

    // Not one of their leads — drop it. This is the containment rule, and it is
    // the reason capturing phone-sent messages is safe to do at all.
    if (!assignmentId) {
      console.warn("[webhook/timelines] dropped: no_matching_lead", { claimId });
      return NextResponse.json({ received: true, ignored: "no_matching_lead" });
    }

    // Thread per (customer, channel, counterparty).
    const { data: existingThread } = await admin
      .from("lead_message_threads")
      .select("id")
      .eq("customer_id", conn.customer_id)
      .eq("channel", "whatsapp")
      .eq("counterparty_phone", rawPhone)
      .maybeSingle();

    let threadId = (existingThread as { id: string } | null)?.id ?? null;
    if (!threadId) {
      const { data: made } = await admin
        .from("lead_message_threads")
        .insert({
          customer_id: conn.customer_id,
          assignment_id: assignmentId,
          lead_id: leadId,
          channel: "whatsapp",
          counterparty_phone: rawPhone,
          provider_chat_id: payload.chat?.chat_id ? String(payload.chat.chat_id) : null,
        })
        .select("id")
        .maybeSingle();
      threadId = (made as { id: string } | null)?.id ?? null;
    }
    if (!threadId) return NextResponse.json({ received: true, ignored: "no_thread" });

    const occurred = verified.data.timestamp ?? payload.message?.timestamp ?? new Date().toISOString();

    // Unique on (provider, provider_message_id): a message we sent ourselves is
    // already here, so this is an upsert-shaped no-op for our own sends and an
    // insert for anything sent from the operator's phone.
    const { error: insertErr } = await admin.from("lead_messages").insert({
      thread_id: threadId,
      customer_id: conn.customer_id,
      assignment_id: assignmentId,
      lead_id: leadId,
      channel: "whatsapp",
      direction,
      status: direction === "inbound" ? "received" : mapStatus(verified.data.status) ?? "sent",
      provider: "timelinesai",
      provider_message_id: uid,
      to_phone: rawPhone,
      body_text: verified.data.text ?? payload.message?.text ?? null,
      generated_by: "human",
      sent_at: direction === "outbound" ? occurred : null,
      created_at: occurred,
    });

    // 23505 means we already have it (our own send). Not an error.
    if (insertErr && (insertErr as { code?: string }).code !== "23505") {
      console.error("[webhook/timelines] message insert failed", insertErr.message);
    }

    const nowIso = new Date().toISOString();
    await admin
      .from("lead_message_threads")
      .update(
        direction === "inbound"
          ? { last_inbound_at: occurred, last_message_at: occurred, updated_at: nowIso }
          : { last_outbound_at: occurred, last_message_at: occurred, updated_at: nowIso }
      )
      .eq("id", threadId);

    if (direction === "inbound") {
      // Bump the unread badge. Deliberately NOT an engagement event: a landlord
      // replying is their act, not the operator's (§3's nudge_sent rule), and an
      // operator who gets an eager reply and ignores it for three weeks is
      // exactly who escalation exists to take the lead from.
      const { data: cur } = await admin
        .from("lead_message_threads")
        .select("unread_inbound_count")
        .eq("id", threadId)
        .maybeSingle();
      await admin
        .from("lead_message_threads")
        .update({
          unread_inbound_count:
            ((cur as { unread_inbound_count?: number } | null)?.unread_inbound_count ?? 0) + 1,
        })
        .eq("id", threadId);
    }

    return NextResponse.json({ received: true, stored: true });
  } catch (e) {
    // Release the claim so TimelinesAI's retry can have another go — the
    // stripe_events discipline.
    await admin.from("message_webhook_events").delete().eq("id", claimId);
    console.error("[webhook/timelines] failed", e instanceof Error ? e.message : e);
    return NextResponse.json({ received: false }, { status: 500 });
  }
}
