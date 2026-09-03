/**
 * Turning one VERIFIED Resend event into stored state (§40.8).
 *
 * A separate module for the same reason `ingestTimelinesEvent` is one: code
 * that only exists inside a route handler cannot be re-run, and an event we
 * failed to process is then lost for ever. Everything here is safe to call
 * twice on the same event.
 *
 * ⚠️ NO READ-BACK, AND THAT IS THE DIFFERENCE FROM THE TIMELINESAI RECEIVER.
 * The signature has already been checked against this customer's own signing
 * secret by the time we are called, so the payload is evidence rather than an
 * assertion. TimelinesAI cannot sign, which is why that path calls the API back
 * before believing anything. Do not add a read-back here to make the two look
 * alike, and do not remove the one over there.
 *
 * ⚠️ EVERY LOOKUP IS SCOPED BY `customer_id`, WITHOUT EXCEPTION. 0116 calls the
 * leading customer_id in every key "the containment guarantee: one customer's
 * conversation is structurally unreachable from another's". A webhook is the
 * one place an id arrives from outside, so an unscoped match on `email_id` is
 * exactly how customer A's event would touch customer B's message.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  advanceStatus,
  bodyFrom,
  emailIdFrom,
  failureDetailFrom,
  occurredAtFrom,
  recipientsFrom,
  senderFrom,
  statusRuleFor,
  subjectFrom,
  type ResendWebhookPayload,
} from "./resendEvents";
import { tokenFromAddress, verifyThreadToken } from "./threadAddress";
import { stopRunsForAssignment } from "./sequences";

type Admin = SupabaseClient;

export type ResendIngestOutcome =
  /** Written, or already present. */
  | { outcome: "stored"; kind: "status" | "inbound" }
  /** Genuinely not ours to keep. Terminal — never retried. */
  | { outcome: "dropped"; reason: string }
  /** OUR failure, not a verdict about the event. Retryable. */
  | { outcome: "deferred"; reason: string };

export interface DomainRow {
  domain: string;
  reply_local_prefix: string;
}

export async function ingestResendEvent(
  admin: Admin,
  p: {
    customerId: string;
    domain: DomainRow;
    payload: ResendWebhookPayload;
    /** The svix id. Doubles as the per-event dedupe key on lead_message_events. */
    claimId: string;
  }
): Promise<ResendIngestOutcome> {
  const type = p.payload.type ?? "";

  if (type === "email.received") return ingestInbound(admin, p);

  const rule = statusRuleFor(type);
  if (!rule) {
    // domain.*, contact.*, suppression.*, email.scheduled, email.suppressed —
    // real events we did not subscribe to and have nowhere to put. Terminal.
    return { outcome: "dropped", reason: `unhandled_type:${type || "none"}` };
  }

  return ingestStatus(admin, p, rule);
}

// ---------------------------------------------------------------------------
// Status events — something happened to a message WE sent.
// ---------------------------------------------------------------------------
async function ingestStatus(
  admin: Admin,
  p: { customerId: string; payload: ResendWebhookPayload; claimId: string },
  rule: NonNullable<ReturnType<typeof statusRuleFor>>
): Promise<ResendIngestOutcome> {
  const emailId = emailIdFrom(p.payload);
  if (!emailId) {
    console.warn("[resend/ingest] dropped: no_email_id", { claimId: p.claimId });
    return { outcome: "dropped", reason: "no_email_id" };
  }

  const { data: found, error: findErr } = await admin
    .from("lead_messages")
    .select(
      "id, assignment_id, status, sent_at, delivered_at, first_opened_at, first_clicked_at"
    )
    .eq("customer_id", p.customerId)
    .eq("provider", "resend")
    .eq("provider_message_id", emailId)
    .maybeSingle();

  // A read that failed is OUR failure and must not be reported as "not ours".
  if (findErr) {
    console.error("[resend/ingest] message lookup failed", findErr.message);
    return { outcome: "deferred", reason: "lookup_failed" };
  }

  const msg = found as {
    id: string;
    assignment_id: string | null;
    status: string;
    sent_at: string | null;
    delivered_at: string | null;
    first_opened_at: string | null;
    first_clicked_at: string | null;
  } | null;

  // Not a message we hold. The customer's Resend account is THEIRS and may send
  // mail that has nothing to do with a landlord — the same containment rule the
  // WhatsApp receiver applies to the hundreds of chats in an operator's
  // workspace. Terminal: retrying cannot change the answer.
  if (!msg) {
    console.warn("[resend/ingest] dropped: no_matching_message", {
      claimId: p.claimId,
      type: p.payload.type,
    });
    return { outcome: "dropped", reason: "no_matching_message" };
  }

  const occurred = occurredAtFrom(p.payload);

  // The honest record of a repeatable act. An open or a click can happen many
  // times and each one is its own row — only the *_at stamps below are
  // first-observation-wins. Unique on provider_event_id, so a redelivery of the
  // same svix id collides rather than double-counting.
  const { error: eventErr } = await admin.from("lead_message_events").insert({
    message_id: msg.id,
    event_type: rule.event,
    occurred_at: occurred,
    provider_event_id: p.claimId,
    metadata: metadataFor(p.payload),
  });
  if (eventErr && (eventErr as { code?: string }).code !== "23505") {
    console.error("[resend/ingest] event insert failed", eventErr.message);
    return { outcome: "deferred", reason: "event_insert_failed" };
  }

  // ---- Advance the message ------------------------------------------------
  const patch: Record<string, unknown> = {};

  const nextStatus = advanceStatus(msg.status, rule.status);
  if (nextStatus) patch.status = nextStatus;

  // First observation wins, permanently — the `first_contacted_at` discipline
  // (§6), and what stops an out-of-order redelivery rewriting when something
  // happened.
  if (rule.stamp && !msg[rule.stamp]) patch[rule.stamp] = occurred;

  // A bounce message is the most useful thing a customer will ever be told
  // about a bad address. Only written on a status that is actually a failure,
  // so an open cannot clear it and a delay cannot invent one.
  if (rule.status === "bounced" || rule.status === "complained" || rule.status === "failed") {
    patch.error_code = rule.event;
    const detail = failureDetailFrom(p.payload);
    if (detail) patch.error_detail = detail;
  }

  if (Object.keys(patch).length > 0) {
    const { error: updErr } = await admin
      .from("lead_messages")
      .update(patch)
      .eq("id", msg.id)
      .eq("customer_id", p.customerId);
    if (updErr) {
      console.error("[resend/ingest] message update failed", updErr.message);
      return { outcome: "deferred", reason: "update_failed" };
    }
  }

  return { outcome: "stored", kind: "status" };
}

function metadataFor(payload: ResendWebhookPayload): Record<string, unknown> | null {
  const d = payload.data;
  if (d?.click?.link) return { link: String(d.click.link).slice(0, 500) };
  if (d?.bounce) return { bounce: d.bounce };
  return null;
}

// ---------------------------------------------------------------------------
// email.received — the landlord replied.
// ---------------------------------------------------------------------------
async function ingestInbound(
  admin: Admin,
  p: {
    customerId: string;
    domain: DomainRow;
    payload: ResendWebhookPayload;
    claimId: string;
  }
): Promise<ResendIngestOutcome> {
  const threadId = await resolveThread(admin, p);

  // Match-or-discard, and it is not optional. Anyone can send mail to a public
  // address, so an inbound that correlates to nothing is somebody else's mail
  // arriving at the operator's domain — a delivery failure notice, a
  // newsletter, a stranger. Storing it would put mail nobody asked for in front
  // of an operator inside a landlord CRM.
  if (!threadId) {
    console.warn("[resend/ingest] dropped: no_matching_thread", {
      claimId: p.claimId,
      from: senderFrom(p.payload),
    });
    return { outcome: "dropped", reason: "no_matching_thread" };
  }

  const { data: threadRow } = await admin
    .from("lead_message_threads")
    .select("id, assignment_id, lead_id, counterparty_email, unread_inbound_count")
    .eq("id", threadId)
    .eq("customer_id", p.customerId)
    .maybeSingle();

  const thread = threadRow as {
    id: string;
    assignment_id: string | null;
    lead_id: string | null;
    counterparty_email: string | null;
    unread_inbound_count: number | null;
  } | null;

  if (!thread) return { outcome: "deferred", reason: "thread_vanished" };

  const occurred = occurredAtFrom(p.payload);
  const body = bodyFrom(p.payload);
  const emailId = emailIdFrom(p.payload);

  // ⚠️ `to_address` HOLDS THE COUNTERPARTY, NOT THE ENVELOPE RECIPIENT. 0116 is
  // explicit: "for direction='inbound' these are the landlord's address and
  // number rather than ours", and the WhatsApp path already stores the
  // landlord's number in `to_phone` on an inbound message. Storing our own
  // reply address here instead would make every inbound row look addressed to
  // us and break the shape the thread view reads.
  const counterparty = senderFrom(p.payload) ?? thread.counterparty_email;
  if (!counterparty) {
    // The shape CHECK requires to_address on an email row, so there is nothing
    // valid to write. Terminal — a payload with no sender will not grow one.
    console.warn("[resend/ingest] dropped: no_sender", { claimId: p.claimId });
    return { outcome: "dropped", reason: "no_sender" };
  }

  const { error: insertErr } = await admin.from("lead_messages").insert({
    thread_id: thread.id,
    customer_id: p.customerId,
    assignment_id: thread.assignment_id,
    lead_id: thread.lead_id,
    channel: "email",
    direction: "inbound",
    status: "received",
    provider: "resend",
    provider_message_id: emailId,
    to_address: counterparty,
    subject: subjectFrom(p.payload),
    body_text: body.text,
    body_html: body.html,
    // 0116 records that this payload is metadata only. There is no published
    // shape to check that against, so the flag follows what actually arrived
    // rather than what we expect to arrive.
    //
    // ⚠️ NOTHING DRAINS THIS YET. It marks a reply whose text we do not hold;
    // the message, its thread and the sequence stop below are all correct
    // regardless, so the operator sees that the landlord replied even in the
    // worst case. Draining it needs an inbound-body endpoint confirmed against
    // the real wire, which is a thing to do once real inbound mail exists.
    body_fetch_pending: !body.text && !body.html,
    generated_by: "human",
    created_at: occurred,
  });

  const alreadyHad = (insertErr as { code?: string } | null)?.code === "23505";

  if (insertErr && !alreadyHad) {
    console.error("[resend/ingest] inbound insert failed", insertErr.message);
    return { outcome: "deferred", reason: "insert_failed" };
  }

  // ⚠️ GUARDED, AND THAT IS THE PRICE OF BEING RETRYABLE. The message insert
  // dedupes itself on (provider, provider_message_id); the unread counter and
  // the thread stamps do not. Running this twice would show the operator two
  // unread replies where the landlord sent one.
  if (!alreadyHad) {
    await admin
      .from("lead_message_threads")
      .update({
        last_inbound_at: occurred,
        last_message_at: occurred,
        unread_inbound_count: (thread.unread_inbound_count ?? 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", thread.id);
  }

  // ⚠️ THE LANDLORD ANSWERED. STOP TALKING (§40.13).
  //
  // Outside the guard on purpose, exactly as on the WhatsApp side: stopping a
  // run twice is a no-op because stopRun filters on status = 'active', where
  // MISSING a reply would leave a ladder of scheduled follow-ups running at
  // somebody who has already answered. The two directions are not symmetric.
  //
  // Deliberately NOT an engagement event either. A reply is the landlord's act,
  // not the operator's, so it must never shield an ignored lead from
  // escalation (§40.7) — and it must absolutely stop us messaging them again.
  await stopRunsForAssignment(admin, thread.assignment_id, "replied");

  return { outcome: "stored", kind: "inbound" };
}

/**
 * Which conversation is this?
 *
 * Two routes, in this order and for the reasons threadAddress.ts gives.
 */
async function resolveThread(
  admin: Admin,
  p: { customerId: string; domain: DomainRow; payload: ResendWebhookPayload }
): Promise<string | null> {
  // ---- 1. The reply-address token — the PRIMARY route ----------------------
  // Our own construct, HMAC'd, and it survives what headers do not: the
  // landlord replying from a different address, forwarding the mail on, or a
  // client that strips threading headers.
  for (const address of recipientsFrom(p.payload)) {
    const token = tokenFromAddress(address, p.domain.reply_local_prefix);
    if (!token) continue;

    const { data } = await admin
      .from("lead_message_threads")
      .select("id")
      .eq("customer_id", p.customerId)
      .eq("channel", "email")
      .eq("thread_token", token)
      .maybeSingle();

    const id = (data as { id: string } | null)?.id;
    if (!id) continue;

    // ⚠️ PARSING IS NOT AUTHORISATION, and neither is finding a row. The
    // `customer_id` filter above is what makes cross-customer mis-binding
    // impossible; this re-checks the MAC so a token that somehow reached the
    // column without being minted by us is still refused.
    if (verifyThreadToken(token, () => id)) return id;
  }

  // ---- 2. An EXISTING thread with that sender — the fallback ---------------
  //
  // ⚠️ IT MAY ONLY EVER FIND, NEVER CREATE. A `From` header is trivially
  // forged, so this must not be able to bring a thread into existence or bind
  // a message to a lead on the strength of it. All it can do is file a reply
  // into a conversation this customer demonstrably already has — which is the
  // case it exists for: a landlord who replies to the plain `hello@` address
  // rather than to the tokenised one.
  const sender = senderFrom(p.payload);
  if (!sender) return null;

  const { data } = await admin
    .from("lead_message_threads")
    .select("id")
    .eq("customer_id", p.customerId)
    .eq("channel", "email")
    .eq("counterparty_email", sender)
    .maybeSingle();

  return (data as { id: string } | null)?.id ?? null;
}
