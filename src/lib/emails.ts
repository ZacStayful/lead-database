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
    ["Estimated monthly income", lead.estimated_monthly_income ?? "—"],
    ["Lead profile", lead.lead_profile ?? "—"],
  ]
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 0;color:#6b706a;font-size:13px;width:180px;vertical-align:top">${k}</td><td style="padding:6px 0;font-size:14px">${v}</td></tr>`
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

/** Low credits warning — triggered when leads_received_this_month reaches 18. */
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
