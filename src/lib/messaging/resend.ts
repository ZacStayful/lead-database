/**
 * Resend, called with the CUSTOMER'S OWN key (§40).
 *
 * Raw fetch, no SDK — the src/lib/sms.ts rule. Two extra reasons here: the repo
 * pins resend ^4.0.0, which predates parts of this surface, and the module-level
 * singleton in emails.ts is the wrong shape entirely when the key varies per
 * request.
 *
 * ⚠️ VERIFIED LIVE: RESEND RETURNS 400 FOR AN INVALID API KEY, NOT 401.
 *   {"statusCode":400,"message":"API key is invalid","name":"validation_error"}
 * Only a MISSING Authorization header gives 401. So an invalid key and a
 * malformed request share a status code, and error handling must branch on the
 * `name` field. Getting this wrong tells a customer with a bad key that the app
 * sent a bad request.
 *
 * ⚠️ The User-Agent header is MANDATORY. Omit it and Resend returns 403 even
 * with a valid key.
 *
 * This module must never be used for Stayful's own transactional mail, which
 * stays on emails.ts with the Stayful key and Stayful branding. The whole point
 * of the customer's own domain is that the landlord sees the operator.
 */
import type { DnsRecord, VendorResult } from "./types";

const BASE = "https://api.resend.com";
const TIMEOUT_MS = 10_000;
const UA = "Stayful-Lead-Database/1.0";

async function call<T>(
  key: string,
  path: string,
  init: { method: string; body?: unknown; idempotencyKey?: string }
): Promise<VendorResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "User-Agent": UA, // mandatory — a missing UA is a 403
    };
    if (init.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;

    const res = await fetch(`${BASE}${path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
      cache: "no-store",
    });

    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body: fall through to the status-based branch */
    }

    if (!res.ok) {
      const name =
        (parsed as { name?: string } | null)?.name ?? `http_${res.status}`;
      const message =
        (parsed as { message?: string } | null)?.message ?? text.slice(0, 300);
      // Branch on `name`, never on status — see the header note.
      const code =
        name === "validation_error" && /api key/i.test(message)
          ? "invalid_api_key"
          : name === "missing_api_key"
            ? "missing_api_key"
            : res.status === 429
              ? "rate_limited"
              : name;
      return { ok: false, code, detail: message };
    }

    return { ok: true, data: parsed as T };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    return { ok: false, code: msg.includes("abort") ? "timeout" : "network_error", detail: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** Verify a pasted key does something, before we ever store it. */
export async function verifyApiKey(key: string): Promise<VendorResult<unknown>> {
  return call(key, "/domains", { method: "GET" });
}

interface RawDomain {
  id: string;
  name: string;
  status: string;
  region?: string;
  records?: DnsRecord[];
}

/**
 * Create the sending domain in the customer's account, with receiving enabled
 * so landlord replies reach our webhook, and tracking so we can report opens
 * and clicks. All three in one call — `capabilities` is settable via the API,
 * which removes the dashboard step the docs imply.
 */
export async function createSendingDomain(
  key: string,
  p: { domain: string; region?: string; trackingSubdomain?: string }
): Promise<VendorResult<RawDomain>> {
  return call<RawDomain>(key, "/domains", {
    method: "POST",
    body: {
      name: p.domain,
      region: p.region ?? "eu-west-1",
      capabilities: { sending: "enabled", receiving: "enabled" },
    },
  });
}

export async function getSendingDomain(
  key: string,
  domainId: string
): Promise<VendorResult<RawDomain>> {
  return call<RawDomain>(key, `/domains/${domainId}`, { method: "GET" });
}

/**
 * Open and click tracking are OFF by default per domain and need a verified
 * tracking subdomain. We can set this because the key is full-access — which is
 * the whole reason the wizard asks for one.
 */
export async function enableTracking(
  key: string,
  domainId: string,
  trackingSubdomain = "links"
): Promise<VendorResult<RawDomain>> {
  return call<RawDomain>(key, `/domains/${domainId}`, {
    method: "PATCH",
    body: {
      open_tracking: true,
      click_tracking: true,
      tracking_subdomain: trackingSubdomain,
    },
  });
}

export async function triggerVerification(
  key: string,
  domainId: string
): Promise<VendorResult<unknown>> {
  return call(key, `/domains/${domainId}/verify`, { method: "POST" });
}

export async function deleteSendingDomain(
  key: string,
  domainId: string
): Promise<VendorResult<unknown>> {
  return call(key, `/domains/${domainId}`, { method: "DELETE" });
}

interface RawWebhook {
  id: string;
  signing_secret?: string;
  endpoint?: string;
}

/**
 * One webhook per customer, pointing at a URL carrying their own token. Resend
 * payloads carry NO tenant identifier, so a per-customer URL is the only way to
 * know whose mail an event describes — and it makes the per-endpoint Svix
 * secret meaningful rather than something to trial against every tenant.
 */
export async function createWebhook(
  key: string,
  p: { endpoint: string; events: string[] }
): Promise<VendorResult<RawWebhook>> {
  return call<RawWebhook>(key, "/webhooks", {
    method: "POST",
    body: { endpoint: p.endpoint, events: p.events },
  });
}

export async function deleteWebhook(
  key: string,
  webhookId: string
): Promise<VendorResult<unknown>> {
  return call(key, `/webhooks/${webhookId}`, { method: "DELETE" });
}

export const WEBHOOK_EVENTS = [
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
  "email.opened",
  "email.clicked",
  "email.failed",
  "email.received",
];

/** Send one message as the customer. */
export async function sendEmail(
  key: string,
  p: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html: string;
    replyTo: string;
    headers?: Record<string, string>;
    tags?: { name: string; value: string }[];
    idempotencyKey: string;
  }
): Promise<VendorResult<{ id: string }>> {
  return call<{ id: string }>(key, "/emails", {
    method: "POST",
    idempotencyKey: p.idempotencyKey,
    body: {
      from: p.from,
      to: [p.to],
      subject: p.subject,
      text: p.text,
      html: p.html,
      reply_to: p.replyTo,
      headers: p.headers,
      tags: p.tags,
    },
  });
}

/** Fetch a received email's body — email.received carries metadata only. */
export async function getEmail(
  key: string,
  emailId: string
): Promise<VendorResult<{ text?: string; html?: string; subject?: string }>> {
  return call(key, `/emails/${emailId}`, { method: "GET" });
}

/**
 * Label each record with what it is FOR, so the wizard can group them and put
 * the MX warning where it belongs. Resend's own `record` field describes the
 * mechanism ("SPF", "DKIM"); this describes the job.
 */
export function groupRecords(records: DnsRecord[]): DnsRecord[] {
  return (records ?? []).map((r) => {
    const name = (r.name ?? "").toLowerCase();
    const record = (r.record ?? "").toUpperCase();
    let purpose: DnsRecord["purpose"] = "sending";
    if (name.startsWith("inbound") || (r.type === "MX" && !name.startsWith("send"))) {
      purpose = "receiving";
    } else if (record.includes("TRACK") || name.startsWith("links")) {
      purpose = "tracking";
    }
    return { ...r, purpose };
  });
}
