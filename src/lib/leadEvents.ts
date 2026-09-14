/**
 * What each lead_events row MEANS, in one place (§56).
 *
 * Before this the only label map lived in the admin assignment page, and it
 * had drifted: 0117 added message_sent / message_received and 0123 added
 * whatsapp_click, and none of the three ever reached it, so those rows rendered
 * as raw keys. Two screens now read events back — admin and the customer's own
 * activity timeline — and two hand-written maps would drift the same way again.
 *
 * ⚠️ IMPORT-FREE apart from the type. The customer timeline is rendered in a
 * "use client" component, so nothing here may pull in supabase-js (the same
 * split §21.8 makes for featureRequest.ts).
 */
import type { LeadEventType } from "@/lib/types";

/** Neutral third-person wording, for admin. */
export const LEAD_EVENT_LABEL: Record<LeadEventType, string> = {
  detail_opened: "Opened the lead",
  tel_click: "Clicked the phone number",
  mailto_click: "Clicked the email address",
  whatsapp_click: "Opened a WhatsApp to the landlord from their phone",
  note_added: "Added a note",
  file_added: "Attached a file",
  stage_changed: "Changed the pipeline stage",
  message_sent: "Sent a message through their connected workspace",
  message_received: "The landlord replied",
  nudge_sent: "We sent a nudge",
};

/**
 * Second-person wording, for the operator's own timeline and inbox.
 *
 * ⚠️ A click is an ATTEMPT, never a send (§40.15). The three contact clicks are
 * worded as what the operator did on their own device and never claim the
 * landlord received anything — there is no delivery status to attach, and
 * none must ever be invented for them.
 */
export const OPERATOR_EVENT_COPY: Record<LeadEventType, string> = {
  detail_opened: "You opened this lead",
  tel_click: "You rang them from your phone",
  mailto_click: "You opened an email to them",
  whatsapp_click: "You opened WhatsApp to message them from your phone",
  note_added: "You added a note",
  file_added: "You attached a file",
  stage_changed: "You moved the pipeline stage",
  message_sent: "You sent a message",
  message_received: "They replied",
  nudge_sent: "We sent you a reminder about this lead",
};

/**
 * Events that are something WE did, never the operator. Excluded from every
 * "operator activity" rendering for the reason §3 gives: our own reminders must
 * not read as the customer's work.
 */
export const SYSTEM_LEAD_EVENT_TYPES = ["nudge_sent"] as const satisfies readonly LeadEventType[];

/**
 * Events that are the LANDLORD's act (§40.7). Rendered as theirs, never as
 * engagement by the operator.
 */
export const LANDLORD_LEAD_EVENT_TYPES = ["message_received"] as const satisfies readonly LeadEventType[];

/**
 * The three contact attempts the browser may report. These are what populate
 * the inbox for a customer with no connected channel: every one of them is a
 * real approach to the landlord that left no message row behind.
 */
export const CONTACT_CLICK_EVENT_TYPES = [
  "tel_click",
  "whatsapp_click",
  "mailto_click",
] as const satisfies readonly LeadEventType[];

export type ContactClickEventType = (typeof CONTACT_CLICK_EVENT_TYPES)[number];

export function isContactClick(t: string): t is ContactClickEventType {
  return (CONTACT_CLICK_EVENT_TYPES as readonly string[]).includes(t);
}

export function isSystemEvent(t: string): boolean {
  return (SYSTEM_LEAD_EVENT_TYPES as readonly string[]).includes(t);
}

/** The channel a contact click belongs to, for icons and filters. */
export function clickChannel(t: ContactClickEventType): "call" | "whatsapp" | "email" {
  if (t === "tel_click") return "call";
  if (t === "whatsapp_click") return "whatsapp";
  return "email";
}

/** Short label for an inbox preview line ("Rang them", not a full sentence). */
export function clickPreview(t: ContactClickEventType): string {
  if (t === "tel_click") return "You rang them";
  if (t === "whatsapp_click") return "You messaged them from your phone";
  return "You emailed them from your own mail app";
}
