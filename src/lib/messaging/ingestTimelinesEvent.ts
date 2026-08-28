/**
 * Turning one verified TimelinesAI event into a stored message (§40.8).
 *
 * ⚠️ THIS EXISTS SO IT CAN BE CALLED TWICE. It was inline in the webhook route,
 * which made it unreachable from anywhere else — and that is precisely why an
 * event we could not read back inside the vendor's 3-second budget was lost for
 * ever. The vendor's own retries cannot rescue it either: our claim row already
 * exists, so each retry short-circuits on 23505 and does nothing. Recovery is
 * ours alone, and it needs this code to be a function.
 *
 * Two callers, differing only in how long they will wait:
 *
 *   - the webhook receiver, at 3s, inside TimelinesAI's 5s ceiling;
 *   - the recovery phase of /api/cron/poll-whatsapp-status, at its leisure.
 *
 * ⚠️ IT MUST BE SAFE TO RUN TWICE ON THE SAME MESSAGE. That is what makes retry
 * possible at all, and it is not free — see the unread counter below.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptSecret, timelinesTokenAad } from "@/lib/crypto/secretBox";
import { getMessage, mapStatus } from "./timelines";
import { normalisePhone, resolveWebhookIdentity } from "./whatsappIdentity";

type Admin = SupabaseClient;

/**
 * ⚠️ WRITTEN FROM THE DOCS, AND THE DOCS ARE NOT THE WIRE. Every field is a
 * HINT: `chat.jid` was assumed here once and is not actually sent, which
 * silently discarded twenty events. Nothing load-bearing is read from this — the
 * read-back is the source of truth and this is only its fallback.
 */
export interface TimelinesWebhookPayload {
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

export type IngestOutcome =
  /** Written, or already present from our own send. */
  | { outcome: "stored"; direction: "inbound" | "outbound" }
  /** Deliberately not ours to keep. Terminal — never retried. */
  | { outcome: "dropped"; reason: "not_dialable" | "no_matching_lead" | "no_thread" }
  /** OUR failure, not a verdict about the event. Retryable. */
  | { outcome: "deferred"; reason: string };

/** The uid, from whichever nesting this body happens to use. */
export function uidFromPayload(payload: TimelinesWebhookPayload): string | undefined {
  return (
    payload.message?.message_uid ?? payload.message?.uid ?? payload.message_uid ?? payload.uid
  );
}

export async function ingestTimelinesEvent(
  admin: Admin,
  p: {
    customerId: string;
    tokenCiphertext: string | null;
    uid: string;
    payload: TimelinesWebhookPayload;
    /** For logs only, so a dropped event can be traced to its claim row. */
    claimId: string;
    timeoutMs: number;
  }
): Promise<IngestOutcome> {
  if (!p.tokenCiphertext) {
    // Retryable on purpose: a customer who reconnects should have the events
    // that arrived while they were disconnected picked up, not discarded.
    return { outcome: "deferred", reason: "no_credential" };
  }

  let token: string;
  try {
    token = decryptSecret(p.tokenCiphertext, timelinesTokenAad(p.customerId));
  } catch {
    return { outcome: "deferred", reason: "credential_unreadable" };
  }

  // ---- Read back. Believe the API, not the body. ---------------------------
  const verified = await getMessage(token, p.uid, p.timeoutMs);
  if (!verified.ok) {
    return { outcome: "deferred", reason: verified.code };
  }

  // ---- Match to one of THIS customer's leads, or discard --------------------
  //
  // ⚠️ BOTH FACTS COME FROM THE READ-BACK. Taking the counterparty from
  // `payload.chat.jid` is what stopped every reply reaching the system for a
  // day; see resolveWebhookIdentity for the full account.
  const { direction, rawPhone } = resolveWebhookIdentity({
    message: verified.data,
    bodyJid: p.payload.chat?.jid ?? null,
    bodyPhone: p.payload.chat?.phone ?? null,
    bodyDirection: p.payload.message?.direction ?? null,
  });

  const key = normalisePhone(rawPhone);
  if (!key) {
    // Logged, because a silent 200 is what made this invisible: twenty events
    // arrived, every one was discarded, and nothing anywhere said so.
    console.warn("[timelines/ingest] dropped: not_dialable", { claimId: p.claimId });
    return { outcome: "dropped", reason: "not_dialable" };
  }

  // PostgREST cannot call normalised_phone in a filter, so the comparison is
  // done here over this customer's OWN assignments only. Scoping by customer_id
  // first is what makes "match one of their leads" true rather than "match any
  // lead in the database".
  //
  // !inner so an assignment whose lead is missing drops out rather than arriving
  // with a null lead (the §27.8 embedded-filter trap).
  const { data: mine } = await admin
    .from("lead_assignments")
    .select("id, lead_id, leads!inner(phone)")
    .eq("customer_id", p.customerId)
    .not("leads.phone", "is", null)
    .order("assigned_at", { ascending: false })
    .limit(500);

  type Row = {
    id: string;
    lead_id: string;
    leads: { phone: string | null }[] | { phone: string | null } | null;
  };
  const hit = ((mine ?? []) as unknown as Row[]).find((r) => {
    const lead = Array.isArray(r.leads) ? r.leads[0] : r.leads;
    return normalisePhone(lead?.phone ?? null) === key;
  });

  // Not one of their leads — drop it. This is the containment rule, and it is
  // the reason capturing phone-sent messages is safe to do at all. Terminal:
  // retrying would not change the answer.
  if (!hit) {
    console.warn("[timelines/ingest] dropped: no_matching_lead", { claimId: p.claimId });
    return { outcome: "dropped", reason: "no_matching_lead" };
  }

  const assignmentId = hit.id;
  const leadId = hit.lead_id;

  // Thread per (customer, channel, counterparty).
  const { data: existingThread } = await admin
    .from("lead_message_threads")
    .select("id")
    .eq("customer_id", p.customerId)
    .eq("channel", "whatsapp")
    .eq("counterparty_phone", rawPhone)
    .maybeSingle();

  let threadId = (existingThread as { id: string } | null)?.id ?? null;
  if (!threadId) {
    const { data: made } = await admin
      .from("lead_message_threads")
      .insert({
        customer_id: p.customerId,
        assignment_id: assignmentId,
        lead_id: leadId,
        channel: "whatsapp",
        counterparty_phone: rawPhone,
        provider_chat_id: p.payload.chat?.chat_id ? String(p.payload.chat.chat_id) : null,
      })
      .select("id")
      .maybeSingle();
    threadId = (made as { id: string } | null)?.id ?? null;
  }
  if (!threadId) return { outcome: "dropped", reason: "no_thread" };

  const occurred =
    verified.data.timestamp ?? p.payload.message?.timestamp ?? new Date().toISOString();

  // Unique on (provider, provider_message_id): a message we sent ourselves is
  // already here, so this is a no-op for our own sends and an insert for
  // anything sent from the operator's phone.
  const { error: insertErr } = await admin.from("lead_messages").insert({
    thread_id: threadId,
    customer_id: p.customerId,
    assignment_id: assignmentId,
    lead_id: leadId,
    channel: "whatsapp",
    direction,
    status: direction === "inbound" ? "received" : mapStatus(verified.data.status) ?? "sent",
    provider: "timelinesai",
    provider_message_id: p.uid,
    to_phone: rawPhone,
    body_text: verified.data.text ?? p.payload.message?.text ?? null,
    generated_by: "human",
    sent_at: direction === "outbound" ? occurred : null,
    created_at: occurred,
  });

  const alreadyHad = (insertErr as { code?: string } | null)?.code === "23505";

  if (insertErr && !alreadyHad) {
    // A write we could not do is OUR failure, so it defers rather than
    // reporting a message we do not actually hold.
    console.error("[timelines/ingest] message insert failed", insertErr.message);
    return { outcome: "deferred", reason: "insert_failed" };
  }

  // ⚠️ EVERYTHING BELOW IS GUARDED ON `!alreadyHad`, AND THAT IS THE PRICE OF
  // BEING RETRYABLE. The message insert dedupes itself; the unread counter and
  // the thread timestamps do not. Running this twice on one message — which a
  // retry guarantees, and which was already reachable because the claim id
  // carries the EVENT TYPE and one message can arrive under two of them — would
  // show the operator two unread replies where the landlord sent one.
  if (!alreadyHad) {
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
      // Deliberately NOT an engagement event: a landlord replying is their act,
      // not the operator's (§3's nudge_sent rule), and an operator who gets an
      // eager reply and ignores it for three weeks is exactly who escalation
      // exists to take the lead from.
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
  }

  return { outcome: "stored", direction };
}
