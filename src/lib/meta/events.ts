/**
 * Conversions API event payload builders. Pure — no I/O, no env reads.
 */
import { randomUUID } from "node:crypto";
import type { MetaUserData } from "./userData";

export type MetaEvent = {
  event_name: "Lead" | "Purchase";
  event_time: number;
  event_id: string;
  action_source: "website";
  event_source_url?: string;
  user_data: MetaUserData;
  custom_data?: Record<string, string | number>;
};

/** Unix SECONDS. ⚠️ Date.now() is milliseconds — see the note in buildLeadEvent. */
function nowInSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Validate a browser-supplied deduplication id.
 *
 * The value is inert — it is only echoed back to Meta — but it must not be
 * pasted unvalidated into an outbound JSON body, where a megabyte of text or a
 * control character would break the request.
 *
 * ⚠️ FALLS BACK TO A FRESH ID RATHER THAN REJECTING, and that is the whole
 * point of the server-side event: an ad blocker that stops `fbevents.js` does
 * NOT stop our own same-origin fetch, so the body normally still carries the
 * id. But if it ever does not, the Lead must still reach Meta — just with no
 * browser twin to dedupe against, which is the blocked case working correctly.
 */
export function coerceEventId(raw: unknown): string {
  if (typeof raw === "string") {
    const cleaned = raw.trim();
    if (/^[A-Za-z0-9._:-]{8,64}$/.test(cleaned)) return cleaned;
  }
  return randomUUID();
}

/**
 * The enquiry-form conversion.
 *
 * `eventId` is shared with the browser's `fbq('track','Lead', …, { eventID })`
 * so Meta counts ONE Lead however many copies arrive. Deduplication is on
 * event_name + event_id within a 48-hour window; nothing else is needed.
 *
 * ⚠️ `event_time` is Unix SECONDS. Passing milliseconds reads as roughly the
 * year 57,000 and Meta rejects the event in the response BODY, not the status
 * code — which is why `capi.ts` logs `messages` and not just `res.status`.
 */
export function buildLeadEvent(p: {
  eventId: string;
  userData: MetaUserData;
  sourceUrl?: string | null;
  /** Which plan the enquirer picked, so a custom conversion can split on it later. */
  contentName?: string | null;
  eventTime?: number;
}): MetaEvent {
  const event: MetaEvent = {
    event_name: "Lead",
    event_time: p.eventTime ?? nowInSeconds(),
    event_id: p.eventId,
    action_source: "website",
    user_data: p.userData,
  };
  if (p.sourceUrl) event.event_source_url = p.sourceUrl;
  if (p.contentName) event.custom_data = { content_name: p.contentName };
  return event;
}

/**
 * The paid-subscription conversion, sent server-side only.
 *
 * `event_id` is derived from the Stripe invoice id, mirroring how
 * `credit_invoice` is idempotent per invoice. There are TWO layers of
 * protection against double-counting and neither is redundant:
 *
 *   1. The `stripe_events` claim in the webhook stops a redelivery reaching
 *      the branch at all — and it is the one that covers a retry arriving
 *      MORE than 48 hours later.
 *   2. This event_id is Meta's own dedup, covering everything inside that
 *      window.
 *
 * Do not remove either thinking the other has it covered.
 */
export function buildPurchaseEvent(p: {
  invoiceId: string;
  amountPaidPence: number;
  currency?: string | null;
  userData: MetaUserData;
  sourceUrl?: string | null;
  /** "management" | "guaranteed_rent" */
  contentName?: string | null;
  eventTime?: number;
}): MetaEvent {
  const event: MetaEvent = {
    event_name: "Purchase",
    event_time: p.eventTime ?? nowInSeconds(),
    event_id: `stripe_invoice_${p.invoiceId}`,
    action_source: "website",
    user_data: p.userData,
    custom_data: {
      value: p.amountPaidPence / 100,
      currency: (p.currency ?? "gbp").toUpperCase(),
      order_id: p.invoiceId,
    },
  };
  if (p.sourceUrl) event.event_source_url = p.sourceUrl;
  if (p.contentName && event.custom_data) {
    event.custom_data.content_name = p.contentName;
  }
  return event;
}
