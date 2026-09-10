import { Resend } from "resend";
import { APP_URL } from "@/lib/env";
import { extractCity } from "@/lib/utils";
import type { Lead } from "@/lib/types";

const BRAND = "#5D8156";
const FROM_NAME = "Stayful";

function fromAddress(): string {
  const email = process.env.RESEND_FROM_EMAIL ?? "zac@stayful.co.uk";
  return `${FROM_NAME} <${email}>`;
}

let _resend: Resend | null = null;
function getResend(): Resend {
  if (!_resend) {
    _resend = new Resend(process.env.RESEND_API_KEY!);
  }
  return _resend;
}

function button(href: string, label: string): string {
  return `<a href="${href}" style="display:inline-block;background:${BRAND};color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:600;font-size:14px;margin-top:8px">${label}</a>`;
}

function shell(inner: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f5f6f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a1a">
  <div style="max-width:560px;margin:0 auto;padding:32px 16px">
    <div style="font-weight:700;font-size:20px;color:${BRAND};margin-bottom:16px">Stayful</div>
    <div style="background:#ffffff;border:0.5px solid #d9dbd8;border-radius:10px;padding:28px">
      ${inner}
    </div>
    <div style="color:#8a8f88;font-size:12px;margin-top:20px">Stayful lead marketplace · You are receiving this because you have an active subscription.</div>
  </div>
</body></html>`;
}

/** Where feature requests / bug reports are delivered. */
function feedbackTo(): string {
  return process.env.FEEDBACK_EMAIL ?? "zac@stayful.co.uk";
}

function esc(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Feature request / bug report email sent to the Stayful team. */
export async function sendFeedbackEmail(params: {
  type: "feature" | "bug";
  name: string;
  email: string;
  business?: string | null;
  subject: string;
  details: string;
  page?: string | null;
  account?: {
    customer_id: string;
    business_name: string;
    contact_name: string;
    email: string;
    phone: string | null;
  } | null;
}): Promise<{ id: string | null; error: unknown }> {
  const label = params.type === "bug" ? "Bug report" : "Feature request";
  const subject = `[${label}] ${params.subject}`;

  const row = (k: string, v: string) =>
    `<tr><td style="padding:6px 0;color:#6b706a;font-size:13px;width:150px;vertical-align:top">${k}</td><td style="padding:6px 0;font-size:14px">${v}</td></tr>`;

  const submitterRows = [
    row("Type", label),
    row("Name", esc(params.name)),
    row("Email", esc(params.email)),
    params.business ? row("Business", esc(params.business)) : "",
    params.page ? row("Page", esc(params.page)) : "",
  ].join("");

  const accountRows = params.account
    ? [
        `<h2 style="margin:20px 0 6px;font-size:14px">Account on file</h2>`,
        `<table style="width:100%;border-collapse:collapse">`,
        row("Business", esc(params.account.business_name)),
        row("Contact", esc(params.account.contact_name)),
        row("Account email", esc(params.account.email)),
        params.account.phone ? row("Phone", esc(params.account.phone)) : "",
        row("Customer ID", params.account.customer_id),
        `</table>`,
      ].join("")
    : `<p style="margin:16px 0 0;color:#6b706a;font-size:13px">Submitted while signed out — no account attached.</p>`;

  const inner = `
    <h1 style="margin:0 0 4px;font-size:18px">${label}: ${esc(params.subject)}</h1>
    <table style="width:100%;border-collapse:collapse;margin-top:8px">${submitterRows}</table>
    <h2 style="margin:20px 0 6px;font-size:14px">Details</h2>
    <div style="white-space:pre-wrap;font-size:14px;line-height:1.6">${esc(params.details)}</div>
    ${accountRows}
  `;

  try {
    const { data, error } = await getResend().emails.send({
      from: fromAddress(),
      to: feedbackTo(),
      replyTo: params.email,
      subject,
      html: shell(inner),
    });
    return { id: data?.id ?? null, error };
  } catch (error) {
    return { id: null, error };
  }
}

/**
 * Welcome / first-login confirmation email — sent exactly once, the first time
 * a customer signs in to the portal after their account is activated. Triggered
 * from the dashboard layout via the atomic first_login_at flip so it can never
 * fire twice, even across concurrent tabs.
 */
export async function sendWelcomeEmail(params: {
  to: string;
  contactName: string;
}): Promise<{ id: string | null; error: unknown }> {
  const { to, contactName } = params;
  const firstName = contactName.trim().split(/\s+/)[0] || contactName;
  const subject = "Welcome to the Stayful Lead Marketplace";
  const inner = `
    <h1 style="margin:0 0 4px;font-size:18px">You're in, ${esc(firstName)}</h1>
    <p style="margin:0 0 12px;color:#6b706a;font-size:14px">Thanks for signing in for the first time — your Stayful portal is ready. Every pre-screened, financially modelled landlord lead assigned to you will appear here, and we'll email you the moment a new one lands.</p>
    <p style="margin:0 0 18px;color:#6b706a;font-size:14px">From your dashboard you can review each lead, track it through your pipeline and export your data whenever you need it.</p>
    ${button(`${APP_URL}/dashboard`, "Go to your dashboard")}
  `;
  try {
    const { data, error } = await getResend().emails.send({
      from: fromAddress(),
      to,
      subject,
      html: shell(inner),
    });
    return { id: data?.id ?? null, error };
  } catch (error) {
    return { id: null, error };
  }
}

/**
 * Post-call discount reminder — sent at the 12h / 4h / 1h thresholds while a
 * prospect's single-use 10%-off code remains unredeemed. Shows the time
 * remaining as a relative duration (never an absolute time — we don't know the
 * prospect's timezone), the code, and both plan checkout links so they can use
 * whichever tier was agreed on the call.
 */
export async function sendPostCallReminderEmail(params: {
  to: string;
  prospectName: string | null;
  promoCode: string;
  remaining: string;
  checkoutUrl10: string;
  checkoutUrl20: string;
}): Promise<{ id: string | null; error: unknown }> {
  const { to, prospectName, promoCode, remaining, checkoutUrl10, checkoutUrl20 } =
    params;
  const firstName = prospectName?.trim().split(/\s+/)[0];
  const greeting = firstName ? `, ${esc(firstName)}` : "";
  const subject = `Your 10% Stayful discount expires in ${remaining}`;
  const inner = `
    <h1 style="margin:0 0 4px;font-size:18px">Your discount is still waiting${greeting}</h1>
    <p style="margin:0 0 12px;color:#6b706a;font-size:14px">Following our web meeting, we set aside a one-time <strong>10% off your first month</strong>. It's single-use and expires in <strong>${esc(remaining)}</strong>.</p>
    <p style="margin:0 0 6px;color:#6b706a;font-size:14px">Your discount code:</p>
    <div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:20px;font-weight:700;letter-spacing:1px;background:#f5f6f5;border:0.5px solid #d9dbd8;border-radius:8px;padding:12px 16px;text-align:center;margin:0 0 18px">${esc(promoCode)}</div>
    <p style="margin:0 0 10px;color:#6b706a;font-size:14px">The code is already applied when you use the link for the plan we discussed:</p>
    <div style="margin:0 0 8px">${button(checkoutUrl10, "Activate — 10-lead plan (£150/mo)")}</div>
    <div>${button(checkoutUrl20, "Activate — 20-lead plan (£300/mo)")}</div>
  `;
  try {
    const { data, error } = await getResend().emails.send({
      from: fromAddress(),
      to,
      subject,
      html: shell(inner),
    });
    return { id: data?.id ?? null, error };
  } catch (error) {
    return { id: null, error };
  }
}

/** New lead notification email. */
export async function sendNewLeadEmail(params: {
  to: string;
  lead: Lead;
}): Promise<{ id: string | null; error: unknown }> {
  const { to, lead } = params;
  const city = extractCity(lead.address);
  const subject = `New lead — ${lead.lead_name}${city ? `, ${city}` : ""}`;

  const rows = [
    ["Name", lead.lead_name],
    ["Address", lead.address ?? "—"],
    ["Bedrooms", lead.bedrooms ?? "—"],
    ["Lead profile", lead.lead_profile ?? "—"],
  ]
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 0;color:#6b706a;font-size:13px;width:180px;vertical-align:top">${esc(k)}</td><td style="padding:6px 0;font-size:14px">${esc(v)}</td></tr>`
    )
    .join("");

  const inner = `
    <h1 style="margin:0 0 4px;font-size:18px">A new lead is ready</h1>
    <p style="margin:0 0 18px;color:#6b706a;font-size:14px">A pre-screened landlord enquiry has just been assigned to you.</p>
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px">${rows}</table>
    ${button(`${APP_URL}/dashboard`, "View lead in portal")}
  `;

  try {
    const { data, error } = await getResend().emails.send({
      from: fromAddress(),
      to,
      subject,
      html: shell(inner),
    });
    return { id: data?.id ?? null, error };
  } catch (error) {
    return { id: null, error };
  }
}

/** Low credits warning — triggered when a customer's lead_balance runs low. */
export async function sendLowCreditsEmail(params: {
  to: string;
  remaining: number;
}): Promise<{ id: string | null; error: unknown }> {
  const { to, remaining } = params;
  const subject = `${remaining} lead${remaining === 1 ? "" : "s"} remaining this month`;
  const inner = `
    <h1 style="margin:0 0 4px;font-size:18px">Your allocation is almost full</h1>
    <p style="margin:0 0 18px;color:#6b706a;font-size:14px">You have <strong>${remaining}</strong> lead${remaining === 1 ? "" : "s"} left in your monthly allocation. Any leads you do not receive this cycle carry forward automatically.</p>
    ${button(`${APP_URL}/dashboard`, "View your leads")}
  `;
  try {
    const { data, error } = await getResend().emails.send({
      from: fromAddress(),
      to,
      subject,
      html: shell(inner),
    });
    return { id: data?.id ?? null, error };
  } catch (error) {
    return { id: null, error };
  }
}

/** Credits exhausted — triggered when leads_received_this_month reaches allocation. */
export async function sendCreditsExhaustedEmail(params: {
  to: string;
}): Promise<{ id: string | null; error: unknown }> {
  const { to } = params;
  const subject = `Your lead allocation is full for this month`;
  const inner = `
    <h1 style="margin:0 0 4px;font-size:18px">Allocation reached</h1>
    <p style="margin:0 0 18px;color:#6b706a;font-size:14px">You have received all the leads included in your plan this month. Your balance will top up automatically when your subscription renews, and any shortfall carries forward.</p>
    ${button(`${APP_URL}/dashboard`, "View your leads")}
  `;
  try {
    const { data, error } = await getResend().emails.send({
      from: fromAddress(),
      to,
      subject,
      html: shell(inner),
    });
    return { id: data?.id ?? null, error };
  } catch (error) {
    return { id: null, error };
  }
}
