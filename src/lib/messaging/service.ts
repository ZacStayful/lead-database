/**
 * Server-side messaging state: what a customer has connected, and what the two
 * buttons on a lead should therefore do (§40).
 *
 * ONE DEFINITION OF SEND ELIGIBILITY, shared by the send route and the button —
 * the same discipline customer_can_see_pool_lead uses for the pool (§19.4) and
 * announcementTargetsCustomer for announcements (§22). Two readings of "can this
 * be sent" would eventually disagree, and the failure is silent both ways.
 *
 * Everything here runs on the service role. The connection tables are deny-all
 * to the browser and hold credentials, so nothing may reach them any other way.
 */
import {
  DEFAULT_QUIET_END_HOUR,
  DEFAULT_QUIET_START_HOUR,
  describeNextWindow,
  withinSendingHours,
} from "@/lib/messaging/sendWindow";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cryptoConfigured, activeKeyVersion } from "@/lib/crypto/secretBox";
import { threadTokensConfigured } from "./threadAddress";
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

/**
 * Is messaging live FOR THIS VIEWER?
 *
 * `messaging_enabled` is a fact about the PLATFORM. Admin preview is the entire
 * reason the switch can stay off during rollout, so it has to mean the same
 * thing on every surface — visibility, connectedness AND sending — or the
 * rehearsal it exists for is impossible.
 *
 * ⚠️ It follows, and is worth saying out loud because nothing else does: while
 * the switch is off, an ADMIN's own customer row sends real WhatsApp messages to
 * real landlords. That is the intent. It is the only way to test the thing.
 */
export async function messagingActiveFor(
  admin: Admin,
  isAdmin: boolean
): Promise<boolean> {
  if (isAdmin) return true;
  return messagingEnabled(admin);
}

/** Fails CLOSED, like messagingEnabled. */
export async function emailChannelEnabled(admin: Admin): Promise<boolean> {
  const { data, error } = await admin
    .from("system_settings")
    .select("value")
    .eq("key", "messaging_email_enabled")
    .maybeSingle();
  if (error) return false;
  return (data as { value?: string } | null)?.value === "true";
}

/**
 * Which channels this viewer may use. WhatsApp first — it is the only one
 * customers see.
 *
 * Email is built and tested but hidden: seven DNS records, three of them
 * 60-character DKIM CNAMEs, is not a thing a property operator completes. The
 * code stays dormant rather than deleted so the four-layer MX-on-apex defence
 * survives for whenever it is wanted again.
 */
export async function enabledChannels(
  admin: Admin,
  isAdmin: boolean
): Promise<MessageChannel[]> {
  const channels: MessageChannel[] = ["whatsapp"];
  if ((await emailChannelEnabled(admin)) || isAdmin) channels.push("email");
  return channels;
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
/**
 * "9am tomorrow" while we are outside sending hours, null while inside.
 *
 * Its own function so the settings read and the window rule live in one place;
 * the send route reads the same two keys and applies the same pure predicate.
 */
async function whatsappQuietUntil(admin: Admin, at: Date): Promise<string | null> {
  const { data } = await admin
    .from("system_settings")
    .select("key, value")
    .in("key", ["messaging_quiet_start_hour", "messaging_quiet_end_hour"]);
  const map = new Map(
    (data ?? []).map((r) => [
      (r as { key: string }).key,
      Number((r as { value: string }).value),
    ])
  );
  const pick = (key: string, fallback: number) => {
    const v = map.get(key);
    return Number.isFinite(v) ? (v as number) : fallback;
  };
  const start = pick("messaging_quiet_start_hour", DEFAULT_QUIET_START_HOUR);
  const end = pick("messaging_quiet_end_hour", DEFAULT_QUIET_END_HOUR);
  return withinSendingHours(at, start, end)
    ? null
    : describeNextWindow(at, start, end);
}

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
  const preview = Boolean(p.preview);
  const now = new Date();
  // Six reads, in parallel. quietUntil joins the Promise.all rather than
  // following it: this function runs on every lead page load, and a serial
  // round trip for one settings row is latency nobody asked for.
  const [enabled, allowed, domain, whatsapp, counts, quietUntil] = await Promise.all([
    messagingEnabled(admin),
    enabledChannels(admin, preview),
    getEmailDomain(admin, p.customerId),
    getWhatsappConnection(admin, p.customerId),
    threadCounts(admin, p.assignment.id),
    whatsappQuietUntil(admin, now),
  ]);

  // Nothing renders at all for an ordinary customer until the switch is on.
  if (!enabled && !preview) return [];

  const { sendable, reason } = assignmentSendable(p.assignment);

  // quietUntil (resolved above) is applied to WhatsApp only: an inbox at 22:00
  // does not buzz a phone on a bedside table, and the email channel is switched
  // off anyway (§40.4). Read from the same settings the send route reads, so
  // the notice and the refusal cannot disagree about the window.

  // ⚠️ Connectedness is a fact about THIS CUSTOMER'S ACCOUNT, and the kill
  // switch is not part of it. The switch decides whether the surface is visible
  // (the early return above) and whether a send may go out (the send route).
  //
  // These two lines used to read `enabled && …`, which was dead logic for a
  // customer — the early return had already caught them — and wrong for an
  // admin: a CONNECTED admin was reported as not connected, so the modal
  // offered setup for ever. That was the bug.
  const emailConnected = domain?.status === "verified";
  const waConnected = whatsapp?.status === "connected";

  const all = [
    {
      channel: "email",
      connected: Boolean(emailConnected),
      // "Started but not finished" is a DIFFERENT state from "not connected":
      // somebody half-way through DNS must not be sent back to step one.
      setupStarted: Boolean(domain && domain.status !== "verified"),
      hasRecipient: Boolean(p.lead.email && p.lead.email.trim()),
      sendable,
      reason,
      quietUntil: null,
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
      quietUntil,
      messageCount: counts.whatsapp.messages,
      unreadInbound: counts.whatsapp.unread,
    },
  ];

  // WhatsApp first, and email only where it is enabled for this viewer.
  return allowed
    .map((c) => all.find((entry) => entry.channel === c))
    .filter((entry): entry is ChannelAvailability => Boolean(entry));
}

/**
 * Why messaging cannot be configured, said usefully.
 *
 * A customer must not be shown our environment variable names, so they get the
 * generic line and a route to support. An ADMIN is the person actually doing the
 * setup, and telling them "contact support" is telling them to contact
 * themselves — so they get the specific missing variable.
 *
 * This exists because the first real test of the flow hit the generic message
 * and it explained nothing to the one person who could act on it.
 */
export function messagingConfigError(isAdmin: boolean): {
  error: string;
  code: string;
  missing?: string[];
} {
  const missing: string[] = [];
  if (!cryptoConfigured()) {
    missing.push(
      process.env[`MESSAGING_ENCRYPTION_KEY_V${activeKeyVersion()}`]
        ? `MESSAGING_ENCRYPTION_KEY_V${activeKeyVersion()} (set, but not a valid 32-byte base64 or hex key)`
        : `MESSAGING_ENCRYPTION_KEY_V${activeKeyVersion()}`
    );
  }
  if (!threadTokensConfigured()) missing.push("MESSAGING_TOKEN_SECRET");

  if (!isAdmin) {
    return {
      error:
        "Messaging is not switched on for your account yet. Please contact support and we will set it up with you.",
      code: "not_configured",
    };
  }

  return {
    code: "not_configured",
    missing,
    error:
      `Messaging env vars are missing on this deployment: ${missing.join(", ")}. ` +
      "Add them in Vercel → Settings → Environment Variables (Production), then REDEPLOY — " +
      "Vercel bakes env vars in at build time, so an existing deployment cannot see a variable added after it was built.",
  };
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
