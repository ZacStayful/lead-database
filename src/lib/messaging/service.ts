/**
 * Server-side messaging state: what a customer has connected, and what the two
 * buttons on a lead should therefore do (§28).
 *
 * ONE DEFINITION OF SEND ELIGIBILITY, shared by the send route and the button —
 * the same discipline customer_can_see_pool_lead uses for the pool (§19.4) and
 * announcementTargetsCustomer for announcements (§22). Two readings of "can this
 * be sent" would eventually disagree, and the failure is silent both ways.
 *
 * Everything here runs on the service role. The connection tables are deny-all
 * to the browser and hold credentials, so nothing may reach them any other way.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  EMAIL_DOMAIN_PUBLIC_COLUMNS,
  WHATSAPP_PUBLIC_COLUMNS,
  type ChannelAvailability,
  type EmailDomainPublic,
  type MessageChannel,
  type WhatsappConnectionPublic,
} from "./types";

/** Matches the convention in src/lib/announcements.ts and filterPrediction.ts. */
type Admin = SupabaseClient;

/** Is the whole surface switched on? Fails CLOSED — an unreadable flag is off. */
export async function messagingEnabled(admin: Admin): Promise<boolean> {
  const { data, error } = await admin
    .from("system_settings")
    .select("value")
    .eq("key", "messaging_enabled")
    .maybeSingle();
  if (error) return false;
  return (data as { value?: string } | null)?.value === "true";
}

export async function getEmailDomain(
  admin: Admin,
  customerId: string
): Promise<EmailDomainPublic | null> {
  const { data } = await admin
    .from("customer_email_domains")
    .select(EMAIL_DOMAIN_PUBLIC_COLUMNS)
    .eq("customer_id", customerId)
    .maybeSingle();
  return (data as EmailDomainPublic | null) ?? null;
}

export async function getWhatsappConnection(
  admin: Admin,
  customerId: string
): Promise<WhatsappConnectionPublic | null> {
  const { data } = await admin
    .from("customer_whatsapp_connections")
    .select(WHATSAPP_PUBLIC_COLUMNS)
    .eq("customer_id", customerId)
    .maybeSingle();
  return (data as WhatsappConnectionPublic | null) ?? null;
}

/**
 * Whether this assignment may be MESSAGED at all.
 *
 * §5E/§6A make `rejected` a settled, chargeable outcome and the PATCH route
 * already refuses to reopen it in one guard. §18's close reasons describe the
 * LANDLORD — selling to someone who has said no is the exact outcome close
 * exists to prevent. Both are refused here.
 *
 * `won` is allowed: an ongoing relationship, already terminal for escalation and
 * already barred from the pool. There is nothing left to protect.
 *
 * NOTE the deliberate asymmetry with inbound: a landlord replying to a settled
 * thread is always STORED (refusing to store evidence loses it, and they know
 * nothing about our state machine) but writes no engagement event, so a settled
 * outcome can never be revived by an incoming message.
 */
export function assignmentSendable(assignment: {
  status?: string | null;
  closed_at?: string | null;
  closed_reason?: string | null;
}): { sendable: boolean; reason: string | null } {
  if (assignment?.status === "rejected") {
    return {
      sendable: false,
      reason:
        "You passed on this lead, so it is settled and cannot be messaged. You can still read anything already sent.",
    };
  }
  if (assignment?.closed_at || assignment?.closed_reason) {
    return {
      sendable: false,
      reason:
        "This lead was closed because the landlord is no longer interested. Messaging them again is exactly what closing prevents.",
    };
  }
  return { sendable: true, reason: null };
}

/** Counts for the button badges, in one query per channel. */
async function threadCounts(
  admin: Admin,
  assignmentId: string
): Promise<Record<MessageChannel, { messages: number; unread: number }>> {
  const empty = {
    email: { messages: 0, unread: 0 },
    whatsapp: { messages: 0, unread: 0 },
  };

  const { data } = await admin
    .from("lead_message_threads")
    .select("channel, unread_inbound_count, lead_messages(count)")
    .eq("assignment_id", assignmentId);

  for (const row of (data ?? []) as {
    channel: MessageChannel;
    unread_inbound_count: number;
    lead_messages: { count: number }[];
  }[]) {
    const bucket = empty[row.channel];
    if (!bucket) continue;
    bucket.messages += row.lead_messages?.[0]?.count ?? 0;
    bucket.unread += row.unread_inbound_count ?? 0;
  }
  return empty;
}

/**
 * Everything the lead page needs to render the two buttons and decide which of
 * the modal's states to show.
 *
 * The buttons are ALWAYS rendered (§18E: a hidden button reads as a missing
 * feature). What varies is what the modal says when it opens.
 */
export async function channelAvailability(
  admin: Admin,
  p: {
    customerId: string;
    assignment: {
      id: string;
      status?: string | null;
      closed_at?: string | null;
      closed_reason?: string | null;
    };
    lead: { email?: string | null; phone?: string | null };
    /**
     * Show the buttons even while `messaging_enabled` is false. Admin-only, and
     * the reason the kill switch can stay off during rollout: the feature can be
     * exercised end to end on production without a single customer seeing a
     * button for something they cannot yet use.
     */
    preview?: boolean;
  }
): Promise<ChannelAvailability[]> {
  const [enabled, domain, whatsapp, counts] = await Promise.all([
    messagingEnabled(admin),
    getEmailDomain(admin, p.customerId),
    getWhatsappConnection(admin, p.customerId),
    threadCounts(admin, p.assignment.id),
  ]);

  // Nothing renders at all for an ordinary customer until the switch is on.
  if (!enabled && !p.preview) return [];

  const { sendable, reason } = assignmentSendable(p.assignment);

  const emailConnected = enabled && domain?.status === "verified";
  const waConnected = enabled && whatsapp?.status === "connected";

  return [
    {
      channel: "email",
      connected: Boolean(emailConnected),
      // "Started but not finished" is a DIFFERENT state from "not connected":
      // somebody half-way through DNS must not be sent back to step one.
      setupStarted: Boolean(domain && domain.status !== "verified"),
      hasRecipient: Boolean(p.lead.email && p.lead.email.trim()),
      sendable,
      reason,
      messageCount: counts.email.messages,
      unreadInbound: counts.email.unread,
    },
    {
      channel: "whatsapp",
      connected: Boolean(waConnected),
      setupStarted: Boolean(whatsapp && whatsapp.status === "pending"),
      hasRecipient: Boolean(p.lead.phone && p.lead.phone.trim()),
      sendable,
      reason,
      messageCount: counts.whatsapp.messages,
      unreadInbound: counts.whatsapp.unread,
    },
  ];
}

/**
 * Validate a `return` path before redirecting to it.
 *
 * ⚠️ An unvalidated redirect parameter is an open redirect, and this one is
 * reachable from a link in the setup flow. Only same-origin dashboard paths.
 */
export function safeReturnPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Reject anything that could be read as an absolute or protocol-relative URL.
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("://")) {
    return null;
  }
  if (!raw.startsWith("/dashboard/")) return null;
  if (raw.includes("\\") || raw.includes("\n") || raw.includes("\r")) return null;
  return raw;
}
