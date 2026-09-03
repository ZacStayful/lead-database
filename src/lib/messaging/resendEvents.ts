/**
 * Reading a Resend webhook payload (§40.8).
 *
 * Pure, so the shape of the wire can be tested without a network or a database.
 *
 * ⚠️ EVERY FIELD HERE IS A HINT. The §40.8 lesson stands even with a signature
 * on the request: a verified payload proves it came from Resend, not that we
 * guessed its field names right. `chat.jid` was read from the TimelinesAI docs,
 * is not actually sent, and silently discarded twenty events — so every
 * accessor below reads several plausible locations and the caller stores the
 * whole payload regardless.
 *
 * The documented shape is `{ type, created_at, data }` with the email keyed on
 * `data.email_id`. `email.received` has NO published payload at all, which is
 * why the inbound accessors are the most forgiving ones here.
 */

export interface ResendWebhookPayload {
  type?: string;
  created_at?: string;
  data?: {
    email_id?: string;
    id?: string;
    message_id?: string;
    from?: string | null;
    to?: string | string[] | null;
    subject?: string | null;
    created_at?: string;
    text?: string | null;
    html?: string | null;
    headers?: Record<string, string> | { name: string; value: string }[] | null;
    bounce?: { message?: string; type?: string; subType?: string } | null;
    click?: { link?: string } | null;
    failed?: { reason?: string } | null;
    [key: string]: unknown;
  } | null;
}

/** Every event that describes something happening to a message WE sent. */
export type ResendStatusEvent =
  | "email.sent"
  | "email.delivered"
  | "email.delivery_delayed"
  | "email.opened"
  | "email.clicked"
  | "email.bounced"
  | "email.complained"
  | "email.failed";

/** The stamp a status event advances, if any. First observation wins (§6). */
type Stamp = "sent_at" | "delivered_at" | "first_opened_at" | "first_clicked_at";

interface StatusRule {
  /** The lead_message_events.event_type to record. */
  event: string;
  /**
   * The lead_messages.status this implies, or null for an event that is NOT a
   * change of state.
   *
   * ⚠️ `opened` AND `clicked` ARE DELIBERATELY NULL. 0116 already says an open
   * is never a fact — Apple Mail Privacy Protection loads tracking pixels
   * unconditionally, so a prefetch is indistinguishable from a human. Promoting
   * a message to some "read" state on that would put a claim on the operator's
   * screen that the evidence does not support. They stamp, and they record an
   * event row; they do not move the status.
   *
   * `delivery_delayed` is null for a different reason: the message is still in
   * flight, and a delay is information rather than an outcome.
   */
  status: string | null;
  stamp: Stamp | null;
}

const STATUS_RULES: Record<ResendStatusEvent, StatusRule> = {
  "email.sent": { event: "sent", status: "sent", stamp: "sent_at" },
  "email.delivered": { event: "delivered", status: "delivered", stamp: "delivered_at" },
  "email.delivery_delayed": { event: "delivery_delayed", status: null, stamp: null },
  "email.opened": { event: "opened", status: null, stamp: "first_opened_at" },
  "email.clicked": { event: "clicked", status: null, stamp: "first_clicked_at" },
  "email.bounced": { event: "bounced", status: "bounced", stamp: null },
  "email.complained": { event: "complained", status: "complained", stamp: null },
  "email.failed": { event: "failed", status: "failed", stamp: null },
};

export function statusRuleFor(type: string | undefined): StatusRule | null {
  return STATUS_RULES[(type ?? "") as ResendStatusEvent] ?? null;
}

/**
 * Ordered, so an event can never move a message backwards — the rule §40.9
 * already applies to the WhatsApp poller, for the same reason: providers make
 * no ordering guarantee, and a message must never walk back from Delivered to
 * Sent because two events arrived out of order.
 *
 * ⚠️ THE FAILURE STATES RANK ABOVE `delivered`, WHICH IS NOT A TYPO. An
 * asynchronous bounce genuinely can arrive after a delivery notice, and when it
 * does the bounce is the more important fact — the operator needs to know the
 * landlord never got it. Ranking them below would let a late `delivered` paper
 * over a bounce.
 */
const RANK: Record<string, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  bounced: 3,
  complained: 3,
  failed: 3,
};

/**
 * The status to store, given what is already there.
 *
 * ⚠️ AN UNRANKED CURRENT STATUS IS LEFT ALONE. `received` and `skipped` are not
 * points on this ladder — an inbound message is not a send in progress — so a
 * status event arriving against one of those must not rewrite it into the
 * outbound vocabulary.
 */
export function advanceStatus(current: string, next: string | null): string | null {
  if (!next) return null;
  if (!(current in RANK)) return null;
  const from = RANK[current] ?? -1;
  const to = RANK[next] ?? -1;
  return to > from ? next : null;
}

/** The id of the message this event is about. */
export function emailIdFrom(payload: ResendWebhookPayload): string | null {
  const d = payload.data;
  return d?.email_id ?? d?.id ?? null;
}

/** When it happened, falling back to now rather than writing a null. */
export function occurredAtFrom(payload: ResendWebhookPayload): string {
  return payload.data?.created_at ?? payload.created_at ?? new Date().toISOString();
}

/** `to` is a string in some payloads and an array in others. Always a list. */
export function recipientsFrom(payload: ResendWebhookPayload): string[] {
  const to = payload.data?.to;
  const list = Array.isArray(to) ? to : to ? [to] : [];
  return list
    .map((v) => addressOnly(String(v ?? "")))
    .filter((v): v is string => Boolean(v));
}

export function senderFrom(payload: ResendWebhookPayload): string | null {
  return addressOnly(String(payload.data?.from ?? ""));
}

/**
 * `Name <a@b.com>` -> `a@b.com`, lowercased. A bare address passes through.
 * Anything without an `@` is not an address and comes back null rather than as
 * a string that will silently match nothing.
 */
export function addressOnly(raw: string): string | null {
  const angled = /<([^>]+)>/.exec(raw ?? "");
  const candidate = (angled ? angled[1] : (raw ?? "")).trim().toLowerCase();
  return candidate.includes("@") ? candidate : null;
}

/**
 * The reply body, if the payload carries one.
 *
 * ⚠️ 0116 RECORDS THAT `email.received` IS METADATA ONLY, and there is no
 * published payload to check that against — so this reads optimistically and
 * the caller flags `body_fetch_pending` when it comes back empty, rather than
 * either assuming a body is there or assuming it is not.
 */
export function bodyFrom(payload: ResendWebhookPayload): {
  text: string | null;
  html: string | null;
} {
  const d = payload.data;
  return {
    text: typeof d?.text === "string" && d.text ? d.text : null,
    html: typeof d?.html === "string" && d.html ? d.html : null,
  };
}

export function subjectFrom(payload: ResendWebhookPayload): string | null {
  const s = payload.data?.subject;
  return typeof s === "string" && s ? s.slice(0, 200) : null;
}

/**
 * Why a message failed, for `lead_messages.error_detail`. Bounces carry the
 * most useful text a customer will ever get about a bad address, and throwing
 * it away leaves them with a status and no reason.
 */
export function failureDetailFrom(payload: ResendWebhookPayload): string | null {
  const d = payload.data;
  const raw =
    d?.bounce?.message ??
    d?.failed?.reason ??
    (d?.bounce?.type ? `${d.bounce.type}${d.bounce.subType ? `/${d.bounce.subType}` : ""}` : null);
  return raw ? String(raw).slice(0, 500) : null;
}
