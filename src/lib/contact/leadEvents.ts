/**
 * Recording that an operator went after a lead (§42).
 *
 * ONE DEFINITION, THREE CALLERS: the lead detail page, the pipeline card, and
 * the contact timeline. Until now the fire-and-forget POST lived inline in
 * `LeadDetail.tsx` and the pipeline card had no way to contact anybody at all,
 * which is a large part of why `tel_click` reads 13 against 666 `detail_opened`
 * — operators work from the list, and the list had nothing to click.
 *
 * ⚠️ CLIENT-SAFE, AND IT MUST STAY THAT WAY. Both the card and the timeline are
 * `"use client"`, so this file may not import anything server-only — the same
 * constraint §21.8 records for `featureRequest.ts`.
 */

import type { ClientLeadEventType, LeadEvent, LeadEventType } from "@/lib/types";

/**
 * The events that mean the operator ACTUALLY WENT AFTER the landlord.
 *
 * ⚠️ `detail_opened` IS DELIBERATELY ABSENT, and that is the whole point rather
 * than an oversight. Reading a lead is not contacting it (§6, which is also why
 * `mark_assignment_contacted` ignores it), and 666 opens against 15 contact
 * actions IS the finding this feature exists to name. Folding opens in here
 * would let a customer who has only ever browsed their book look fully worked.
 *
 * ⚠️ ASSERTED AGAINST A LITERAL LIST in the tests rather than derived from
 * `LeadEventType`, so a future addition to that union cannot silently join it
 * (§27.2's rule for the API vocabulary).
 */
export const CONTACT_EVENT_TYPES = [
  "tel_click",
  "whatsapp_click",
  "mailto_click",
  "message_sent",
] as const satisfies readonly LeadEventType[];

export type ContactEventType = (typeof CONTACT_EVENT_TYPES)[number];

/** Whether an event type counts as going after the landlord. */
export function isContactEvent(t: LeadEventType | string): boolean {
  return (CONTACT_EVENT_TYPES as readonly string[]).includes(t);
}

/**
 * How many approaches this assignment has actually had.
 *
 * Scoped to ONE assignment, never to the lead. A lead held by three operators
 * has three independent counts, and one operator's diligence must never be
 * visible to another (§19.7).
 */
export function countAttempts(
  events: Pick<LeadEvent, "event_type">[] | null | undefined
): number {
  if (!events) return 0;
  return events.reduce((n, e) => (isContactEvent(e.event_type) ? n + 1 : n), 0);
}

/**
 * Post a passive telemetry event.
 *
 * DELIBERATELY FIRE-AND-FORGET, carried over verbatim from `LeadDetail.tsx`:
 * the response is never read and a rejected promise is swallowed, so a failed
 * or slow write cannot delay a phone call or block the UI. Repeat sends are
 * collapsed server-side by the route's 60-second dedupe, which is what makes it
 * safe to call on every mount and on every click.
 *
 * `keepalive` matters here specifically: a `tel:` or `wa.me` click navigates
 * away from the page, and without it the browser is free to cancel the request
 * in flight — losing exactly the signal we are trying to capture.
 */
export function recordLeadEvent(
  assignmentId: string,
  eventType: ClientLeadEventType
): void {
  void fetch("/api/customer/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assignment_id: assignmentId, event_type: eventType }),
    keepalive: true,
  }).catch(() => {
    /* telemetry is best-effort */
  });
}
