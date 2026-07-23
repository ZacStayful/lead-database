/**
 * Instant new-lead SMS alert.
 *
 * Fires the moment a lead is assigned, so an operator can win the speed race
 * to the landlord before their inbox even loads. Reuses the Twilio account
 * already configured for contact verification — no new vendor.
 *
 * Deliberately inert until a sender is configured: with no credentials or
 * sender set, sendNewLeadSms() is a no-op, so shipping this code changes
 * nothing until TWILIO_SMS_FROM (or TWILIO_MESSAGING_SERVICE_SID) is set.
 *
 * Privacy: the SMS carries no landlord PII beyond the town — just enough to
 * make the operator open the portal, where the full lead lives behind auth.
 */
import { APP_URL } from "@/lib/env";
import { extractCity } from "@/lib/utils";
import type { Customer, Lead } from "@/lib/types";

const SMS_TIMEOUT_MS = 8000;

/** Best-effort UK phone → E.164 (self-contained; no external dependency). */
function toE164UK(rawPhone: string): string {
  const cleaned = rawPhone.replace(/[\s\-()]/g, "");
  return cleaned.startsWith("+") ? cleaned : cleaned.replace(/^0/, "+44");
}

export type SmsResult = { sent: boolean; skipped?: string; error?: string };

/** Sender config: a Messaging Service wins over a bare From number if both set. */
function senderParam(): Record<string, string> | null {
  const service = process.env.TWILIO_MESSAGING_SERVICE_SID;
  if (service) return { MessagingServiceSid: service };
  const from = process.env.TWILIO_SMS_FROM;
  if (from) return { From: from };
  return null;
}

/** Short, PII-light alert that drives the operator into the portal to call. */
function composeMessage(lead: Lead): string {
  const city = extractCity(lead.address);
  const beds = lead.bedrooms ? `, ${lead.bedrooms} bed` : "";
  const where = city ? ` in ${city}${beds}` : beds ? ` (${lead.bedrooms} bed)` : "";
  // The lead detail route resolves its [id] param as the lead_id, so the deep
  // link must use lead.id — NOT the assignment id.
  const link = `${APP_URL}/dashboard/leads/${lead.id}`;
  return `Stayful: a new lead just landed${where}. Be first to call — open your dashboard: ${link}`;
}

export async function sendNewLeadSms(params: {
  customer: Customer;
  lead: Lead;
}): Promise<SmsResult> {
  const { customer, lead } = params;

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const sender = senderParam();
  if (!sid || !token || !sender) return { sent: false, skipped: "not_configured" };

  // Respect the customer's opt-out (default true; === false is an explicit opt-out).
  if (customer.sms_alerts_enabled === false) {
    return { sent: false, skipped: "opted_out" };
  }

  if (!customer.phone || !customer.phone.trim()) {
    return { sent: false, skipped: "no_phone" };
  }
  const to = toE164UK(customer.phone);

  try {
    const auth = Buffer.from(`${sid}:${token}`).toString("base64");
    const form = new URLSearchParams({
      ...sender,
      To: to,
      Body: composeMessage(lead),
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SMS_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: form.toString(),
          signal: controller.signal,
        }
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { sent: false, error: `twilio_${res.status}: ${detail.slice(0, 200)}` };
    }
    return { sent: true };
  } catch (e) {
    // Network error or timeout abort — never let a failed text break ingest.
    return { sent: false, error: e instanceof Error ? e.message : "unknown" };
  }
}
