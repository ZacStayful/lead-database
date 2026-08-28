/**
 * Shared types and the PUBLIC COLUMN LISTS for §40 messaging.
 *
 * The column lists are the discipline LIST_COLUMNS uses in
 * src/app/api/customer/api-keys/route.ts, which never selects key_hash: no route
 * may `select("*")` from a connection table, because these rows hold a
 * customer's Resend key, their Resend webhook signing secret and their
 * TimelinesAI token. A test asserts the emitted key set against a duplicated
 * literal (§27.2) — deriving it from this file would pass whatever changed.
 */

export type MessageChannel = "email" | "whatsapp";
export type MessageDirection = "outbound" | "inbound";

export type MessageStatus =
  | "queued" | "sent" | "delivered" | "read" | "received"
  | "bounced" | "complained" | "failed" | "skipped";

export type MessageEventType =
  | "queued" | "sent" | "delivered" | "delivery_delayed" | "opened"
  | "clicked" | "bounced" | "complained" | "failed" | "read" | "replied";

export type EmailDomainStatus =
  | "pending" | "verifying" | "verified" | "failed" | "disabled";

export type WhatsappStatus =
  | "pending" | "connected" | "disconnected" | "suspended" | "revoked" | "error";

/** NEVER includes api_key_ciphertext or webhook_secret_ciphertext. */
export const EMAIL_DOMAIN_PUBLIC_COLUMNS =
  "id, customer_id, domain, parent_domain, status, dns_records, " +
  "tracking_configured, receiving_configured, from_local_part, from_display_name, " +
  "reply_local_prefix, api_key_last4, verified_at, last_checked_at, last_error, created_at";

/** NEVER includes token_ciphertext, token_fingerprint or webhook_token. */
export const WHATSAPP_PUBLIC_COLUMNS =
  "id, customer_id, status, workspace_label, whatsapp_account_phone, token_last4, " +
  "daily_send_cap, min_send_interval_secs, risk_acknowledged_at, " +
  "messaging_quota_total, messaging_quota_used, quota_checked_at, " +
  "connected_at, last_verified_at, last_error, created_at";

export interface EmailDomainPublic {
  id: string;
  customer_id: string;
  domain: string;
  parent_domain: string | null;
  status: EmailDomainStatus;
  dns_records: DnsRecord[];
  tracking_configured: boolean;
  receiving_configured: boolean;
  from_local_part: string;
  from_display_name: string | null;
  reply_local_prefix: string;
  api_key_last4: string | null;
  verified_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface WhatsappConnectionPublic {
  id: string;
  customer_id: string;
  status: WhatsappStatus;
  workspace_label: string | null;
  whatsapp_account_phone: string | null;
  token_last4: string | null;
  daily_send_cap: number;
  min_send_interval_secs: number;
  risk_acknowledged_at: string | null;
  messaging_quota_total: number | null;
  messaging_quota_used: number | null;
  quota_checked_at: string | null;
  connected_at: string | null;
  last_verified_at: string | null;
  last_error: string | null;
  created_at: string;
}

/** A DNS record exactly as the provider described it, for display. */
export interface DnsRecord {
  record: string;
  name: string;
  type: string;
  value: string;
  ttl?: string;
  priority?: number;
  status?: string;
  /** Our grouping for the wizard: what this record is FOR. */
  purpose?: "sending" | "tracking" | "receiving";
}

export interface LeadMessage {
  id: string;
  thread_id: string;
  customer_id: string;
  assignment_id: string | null;
  lead_id: string | null;
  channel: MessageChannel;
  direction: MessageDirection;
  status: MessageStatus;
  provider: string;
  provider_message_id: string | null;
  subject: string | null;
  from_address: string | null;
  to_address: string | null;
  to_phone: string | null;
  body_text: string | null;
  body_fetch_pending: boolean;
  template_key: string | null;
  variant_key: string | null;
  generated_by: "human" | "llm" | "system";
  error_code: string | null;
  error_detail: string | null;
  created_at: string;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  first_opened_at: string | null;
  first_clicked_at: string | null;
  replied_at: string | null;
}

export interface LeadMessageThread {
  id: string;
  customer_id: string;
  assignment_id: string | null;
  channel: MessageChannel;
  counterparty_email: string | null;
  counterparty_phone: string | null;
  match_status: "matched" | "unmatched" | "ambiguous";
  opted_out_at: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  last_message_at: string | null;
  unread_inbound_count: number;
}

/** What the lead page needs to decide what the two buttons do. */
export interface ChannelAvailability {
  channel: MessageChannel;
  /** Is the customer connected and ready to send on this channel? */
  connected: boolean;
  /** Connected-but-unfinished, e.g. DNS still verifying. */
  setupStarted: boolean;
  /** Does the LEAD have somewhere to send to? */
  hasRecipient: boolean;
  /** Is sending allowed on this assignment at all (rejected/closed)? */
  sendable: boolean;
  reason: string | null;
  messageCount: number;
  unreadInbound: number;
}

/**
 * The vendor-call result shape used by every outbound module here, copied from
 * src/lib/sms.ts: a failed send must never throw into the caller, and
 * "not_configured" must be distinguishable from "it broke".
 */
export type SendResult =
  | { sent: true; providerMessageId: string | null }
  | { sent: false; skipped: string }
  | { sent: false; error: string };

export type VendorResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; detail?: string };
