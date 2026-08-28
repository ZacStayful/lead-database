/**
 * TimelinesAI, called with the CUSTOMER'S OWN workspace token (§28).
 *
 * Raw fetch, no SDK, AbortController timeout, { ok, code } results that never
 * throw into the caller — the src/lib/sms.ts contract.
 *
 * ⚠️ WHAT THIS VENDOR IS. A QR-LINKED DEVICE, like WhatsApp Web — not the
 * official WhatsApp Business API. Confirmed live: the connected account returns
 * "447957516879@s.whatsapp.net", a WhatsApp WID rather than a Meta
 * phone-number-id. That is why there are no templates and no 24-hour window, and
 * equally why sending at volume risks WhatsApp restricting the operator's own
 * number.
 *
 * ⚠️ NO DELIVERED/READ WEBHOOK EXISTS ON THIS ROUTE. Status must be polled via
 * getStatusHistory. That is not an oversight in this file.
 *
 * ⚠️ 30 REQ/S PER IP — and every tenant shares Vercel's egress addresses, so
 * unlike Resend (whose limit is per-account and therefore per-customer here)
 * this genuinely is one shared bucket. Callers go through
 * consume_provider_budget first and FAIL CLOSED.
 */
import type { VendorResult } from "./types";
import type { TimelinesChat } from "./whatsappIdentity";

const BASE = "https://app.timelines.ai/integrations/api";
const TIMEOUT_MS = 8_000;

async function call<T>(
  token: string,
  path: string,
  init: { method: string; body?: unknown; timeoutMs?: number } = { method: "GET" }
): Promise<VendorResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
      cache: "no-store",
    });

    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* fall through */
    }

    if (!res.ok) {
      const detail =
        (parsed as { message?: string; detail?: string } | null)?.message ??
        (parsed as { detail?: string } | null)?.detail ??
        text.slice(0, 300);
      const code =
        res.status === 401 || res.status === 403
          ? "invalid_token"
          : res.status === 429
            ? "rate_limited"
            : `http_${res.status}`;
      return { ok: false, code, detail };
    }

    // The API wraps success as { status: "ok", data: … }.
    const data = (parsed as { data?: unknown } | null)?.data ?? parsed;
    return { ok: true, data: data as T };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    return {
      ok: false,
      code: msg.includes("abort") ? "timeout" : "network_error",
      detail: msg,
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface WhatsappAccount {
  id: string;
  phone: string;
  status?: string;
  account_name?: string;
  owner_email?: string;
}

/**
 * The connection check. Called with a RAW pasted token before we store
 * anything: a token that does not authenticate is rejected rather than saved,
 * because a stored dead credential looks connected and fails silently later.
 */
export async function listWhatsappAccounts(
  token: string
): Promise<VendorResult<{ whatsapp_accounts: WhatsappAccount[] }>> {
  return call(token, "/whatsapp_accounts");
}

export interface WorkspaceQuotas {
  workspace_id?: string;
  display_name?: string;
  plan?: string;
  seats?: { total: number; used: number };
  messaging_quota?: { total: number; used: number };
  api_calls_quota?: { total: number; used: number };
}

/**
 * Read the customer's OWN quota so the panel shows their real remaining sends.
 * Verified live: the Shared Inbox plan is 500 messages/month per workspace,
 * which a busy operator could exhaust.
 */
export async function getWorkspaceQuotas(
  token: string
): Promise<VendorResult<WorkspaceQuotas>> {
  return call(token, "/workspace");
}

export async function listChats(
  token: string,
  p: { phone?: string; page?: number } = {}
): Promise<VendorResult<{ chats: TimelinesChat[]; has_more_pages?: boolean }>> {
  const qs = new URLSearchParams();
  if (p.phone) qs.set("phone", p.phone);
  if (p.page) qs.set("page", String(p.page));
  const q = qs.toString();
  return call(token, `/chats${q ? `?${q}` : ""}`);
}

/** Send to a number with no prior chat — the ordinary first-contact case. */
export async function sendMessage(
  token: string,
  p: { phone: string; text: string; whatsappAccountPhone?: string }
): Promise<VendorResult<{ message_uid: string }>> {
  return call(token, "/messages", {
    method: "POST",
    body: {
      phone: p.phone,
      text: p.text,
      ...(p.whatsappAccountPhone
        ? { whatsapp_account_phone: p.whatsappAccountPhone }
        : {}),
    },
  });
}

export async function sendChatMessage(
  token: string,
  chatId: string | number,
  text: string
): Promise<VendorResult<{ message_uid: string }>> {
  return call(token, `/chats/${chatId}/messages`, { method: "POST", body: { text } });
}

export interface TimelinesMessage {
  message_uid?: string;
  text?: string;
  direction?: string;
  status?: string;
  timestamp?: string;
  chat_id?: number | string;
  failure_reason?: { code?: string; title?: string };
}

/**
 * The read-back. ⚠️ This is the ONLY thing standing between an unauthenticated
 * webhook payload and our lead state — TimelinesAI cannot sign its webhooks, so
 * nothing from one is trusted until this confirms it exists in that customer's
 * own workspace.
 */
export async function getMessage(
  token: string,
  uid: string,
  timeoutMs?: number
): Promise<VendorResult<TimelinesMessage>> {
  return call(token, `/messages/${uid}`, { method: "GET", timeoutMs });
}

export async function getStatusHistory(
  token: string,
  uid: string
): Promise<VendorResult<{ status_history?: { status: string; timestamp: string }[] }>> {
  return call(token, `/messages/${uid}/status_history`);
}

export async function listWebhooks(
  token: string
): Promise<VendorResult<{ webhooks?: { id: string; event_type: string; url: string }[] }>> {
  return call(token, "/webhooks");
}

/** ONE EVENT TYPE PER WEBHOOK — four of the default ten allowance. */
export async function createWebhook(
  token: string,
  p: { eventType: string; url: string }
): Promise<VendorResult<{ id: string }>> {
  return call(token, "/webhooks", {
    method: "POST",
    body: { event_type: p.eventType, url: p.url, enabled: true },
  });
}

export async function deleteWebhook(
  token: string,
  id: string
): Promise<VendorResult<unknown>> {
  return call(token, `/webhooks/${id}`, { method: "DELETE" });
}

export const WEBHOOK_EVENTS = [
  "message:received:new",
  "message:sent:new",
  "whatsapp:account:disconnected",
  "whatsapp:account:suspended",
];

/** Map TimelinesAI's status vocabulary onto ours. Unknown maps to null. */
export function mapStatus(raw: string | null | undefined) {
  switch ((raw ?? "").toLowerCase()) {
    case "sending":
    case "pending":
      return "queued" as const;
    case "sent":
      return "sent" as const;
    case "delivered":
      return "delivered" as const;
    case "read":
      return "read" as const;
    case "failed":
      return "failed" as const;
    default:
      return null;
  }
}
