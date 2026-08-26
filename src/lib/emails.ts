import { Resend } from "resend";
import { APP_URL, LOGIN_URL } from "@/lib/env";
import { extractCity } from "@/lib/utils";
import { pauseMonthsWords } from "@/lib/pauseOptions";
import { keepCrmBulletsHtml } from "@/lib/retentionCopy";
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

/** Where customer support requests are delivered. */
function supportTo(): string {
  return process.env.SUPPORT_EMAIL ?? "zac@stayful.co.uk";
}

/** Customer support request emailed to the Stayful team. */
export async function sendSupportEmail(params: {
  name: string;
  email: string;
  business?: string | null;
  subject: string;
  message: string;
  account?: {
    customer_id: string;
    business_name: string;
    contact_name: string;
    email: string;
    phone: string | null;
  } | null;
}): Promise<{ id: string | null; error: unknown }> {
  const subject = `[Support] ${params.subject}`;

  const row = (k: string, v: string) =>
    `<tr><td style="padding:6px 0;color:#6b706a;font-size:13px;width:150px;vertical-align:top">${k}</td><td style="padding:6px 0;font-size:14px">${v}</td></tr>`;

  const submitterRows = [
    row("Name", esc(params.name)),
    row("Email", esc(params.email)),
    params.business ? row("Business", esc(params.business)) : "",
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
    <h1 style="margin:0 0 4px;font-size:18px">Support request: ${esc(params.subject)}</h1>
    <table style="width:100%;border-collapse:collapse;margin-top:8px">${submitterRows}</table>
    <h2 style="margin:20px 0 6px;font-size:14px">Message</h2>
    <div style="white-space:pre-wrap;font-size:14px;line-height:1.6">${esc(params.message)}</div>
    ${accountRows}
  `;

  try {
    const { data, error } = await getResend().emails.send({
      from: fromAddress(),
      to: supportTo(),
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

/**
 * Account-ready email — sent once when someone who paid via a Payment Link is
 * auto-provisioned a portal account. Unlike the invite/activation email, there's
 * no "subscribe" step (they've already paid); it just gives them a working
 * set-password link so they can log in.
 */
export async function sendAccountReadyEmail(params: {
  to: string;
  contactName: string;
  setPasswordUrl: string;
}): Promise<{ id: string | null; error: unknown }> {
  const { to, contactName, setPasswordUrl } = params;
  const firstName = contactName.trim().split(/\s+/)[0] || contactName;
  const subject = "Your Stayful Lead Marketplace account is ready";
  const inner = `
    <h1 style="margin:0 0 4px;font-size:18px">You're all set, ${esc(firstName)}</h1>
    <p style="margin:0 0 12px;color:#6b706a;font-size:14px">Thanks for subscribing — your payment is confirmed and your Stayful portal is ready. Set your password to log in and start receiving your pre-screened landlord leads.</p>
    ${button(setPasswordUrl, "Set your password")}
    <p style="margin:18px 0 0;color:#8a8f88;font-size:12px">If the button doesn't work, copy this link into your browser:<br>${esc(setPasswordUrl)}</p>
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
    ${button(LOGIN_URL, "Log in to view this lead")}
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
    ${button(LOGIN_URL, "Log in to view your leads")}
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
 * Filter-lift scheduled — sent when a customer requests that their lead filter
 * be lifted at their next billing cycle.
 */
export async function sendFilterLiftScheduledEmail(params: {
  to: string;
  effectiveDate: string;
}): Promise<{ id: string | null; error: unknown }> {
  const { to, effectiveDate } = params;
  const subject = `Your lead filter will lift on ${effectiveDate}`;
  const inner = `
    <h1 style="margin:0 0 4px;font-size:18px">Filter lift scheduled</h1>
    <p style="margin:0 0 18px;color:#6b706a;font-size:14px">Your filter will lift at the start of your next billing cycle on <strong>${esc(effectiveDate)}</strong>. Until then, you'll continue to receive only leads matching your current filter. You can cancel this request anytime before then.</p>
    ${button(`${APP_URL}/dashboard/filtering`, "Manage lead filtering")}
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
 * Filter-lift completed — sent when a scheduled lift executes at renewal and the
 * customer returns to the standard guaranteed lead allocation.
 */
export async function sendFilterLiftCompletedEmail(params: {
  to: string;
}): Promise<{ id: string | null; error: unknown }> {
  const { to } = params;
  const subject = `Your lead filter has been lifted`;
  const inner = `
    <h1 style="margin:0 0 4px;font-size:18px">Filter lifted</h1>
    <p style="margin:0 0 18px;color:#6b706a;font-size:14px">Your filter has been lifted. You're now back on the standard guaranteed lead allocation.</p>
    ${button(`${APP_URL}/dashboard`, "View your dashboard")}
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
 * Inactivity nudge — a (Monday) reminder that the customer has leads still
 * awaiting a first follow-up. Grouped: one email covering all N waiting leads,
 * listing up to a handful by name/address and summarising the rest.
 */
export async function sendInactivityNudgeEmail(params: {
  to: string;
  contactName: string;
  count: number;
  leads: { name: string; address: string | null }[];
  /**
   * Leads this customer still holds that have already been escalated to another
   * operator. Not listed individually — they are past the point where naming
   * them is a useful instruction, and listing them alongside live leads would
   * bury the ones still worth a call today.
   */
  coldCount?: number;
  /**
   * Leads that reached a meeting and then went quiet. Asked about by name,
   * because "did this one sign?" is only answerable if we say which one.
   */
  awaitingOutcome?: string[];
}): Promise<{ id: string | null; error: unknown }> {
  const {
    to,
    contactName,
    count,
    leads,
    coldCount = 0,
    awaitingOutcome = [],
  } = params;
  const firstName = contactName.trim().split(/\s+/)[0] || contactName;
  const noun = count === 1 ? "lead" : "leads";
  const subject = `You have ${count} ${noun} waiting for follow-up`;

  const more = count - leads.length;
  const items = leads
    .map(
      (l) =>
        `<li>${esc(l.name)}${l.address ? ` — <span style="color:#6b706a">${esc(l.address)}</span>` : ""}</li>`
    )
    .join("");
  const moreItem =
    more > 0
      ? `<li style="color:#6b706a">…and ${more} more in your dashboard</li>`
      : "";
  const list = leads.length
    ? `<ul style="margin:0 0 18px;padding-left:18px;font-size:14px;line-height:1.7">${items}${moreItem}</ul>`
    : "";

  // The older leads are mentioned as a group and framed as the customer's
  // judgement call, not an instruction. They are still theirs to work and
  // occasionally one of them lands — but they are past the point where chasing
  // them is the best use of the next hour, and saying so is more useful than
  // silently dropping them off the list.
  // Asking beats hoping. Three wins are recorded against 298 delivered leads,
  // and 93% of assignments have never moved off the default pipeline stage —
  // the field is not wrong, it is simply never filled in, because nothing has
  // ever prompted anybody. Named individually so the question is answerable.
  const outcomeAsk =
    awaitingOutcome.length > 0
      ? `<div style="margin:0 0 18px;padding:14px 16px;border:1px solid #d8dcd4;border-radius:8px">
           <p style="margin:0 0 6px;font-size:14px;font-weight:600">Did any of these sign?</p>
           <p style="margin:0 0 10px;color:#6b706a;font-size:13px">You had a meeting and things have gone quiet. Marking the outcome takes a second and keeps your conversion rate honest.</p>
           <ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.7">${awaitingOutcome
             .slice(0, 5)
             .map((name) => `<li>${esc(name)}</li>`)
             .join("")}</ul>
         </div>`
      : "";

  const coldNote =
    coldCount > 0
      ? `<p style="margin:0 0 18px;color:#6b706a;font-size:13px">You also have <strong>${coldCount}</strong> older ${coldCount === 1 ? "lead" : "leads"} that ${coldCount === 1 ? "has" : "have"} had no activity for some time and ${coldCount === 1 ? "has" : "have"} likely gone cold. ${coldCount === 1 ? "It is" : "They are"} still in your dashboard if you want ${coldCount === 1 ? "it" : "them"}, but the ${count === 1 ? "lead" : "leads"} above ${count === 1 ? "is" : "are"} where a call will count for most today.</p>`
      : "";

  const inner = `
    <h1 style="margin:0 0 4px;font-size:18px">A quick nudge, ${esc(firstName)}</h1>
    <p style="margin:0 0 18px;color:#6b706a;font-size:14px">You have <strong>${count}</strong> ${noun} that haven't moved in over 48 hours and are waiting for their next step. A quick follow-up is often what turns an enquiry into a signed landlord.</p>
    ${list}
    ${outcomeAsk}
    ${coldNote}
    <p style="margin:0 0 18px;color:#6b706a;font-size:13px">If a lead sits untouched for ten days we offer it to another operator, and again at twenty. Opening it or getting in touch resets that clock and keeps it yours.</p>
    ${button(`${APP_URL}/dashboard/leads`, "Follow up now")}
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

/** Format a date as e.g. "23 October 2026" (UK long form). */
function ukLongDate(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/London",
  }).format(new Date(iso));
}

/**
 * Confirmation that a management subscription has been paused. States the exact
 * resume date and reassures the customer that their lead balance is preserved.
 * Tone matches the brand: professional, direct, no exclamation marks.
 */
export async function sendSubscriptionPausedEmail(params: {
  to: string;
  contactName: string;
  resumeDateIso: string;
  /** The duration the customer chose, so the prose matches the date below it. */
  months: number;
}): Promise<{ id: string | null; error: unknown }> {
  const { to, contactName, resumeDateIso, months } = params;
  const firstName = contactName.trim().split(/\s+/)[0] || contactName;
  const resumeDate = ukLongDate(resumeDateIso);
  const subject = "Your Stayful subscription is paused";

  const inner = `
    <h1 style="margin:0 0 4px;font-size:18px">Your subscription is paused, ${esc(firstName)}</h1>
    <p style="margin:0 0 14px;color:#6b706a;font-size:14px">Your Stayful subscription is now paused for ${esc(pauseMonthsWords(months))}. Here is what that means:</p>
    <ul style="margin:0 0 18px;padding-left:18px;font-size:14px;line-height:1.7;color:#6b706a">
      <li>You will not be billed during the pause.</li>
      <li>You will not receive new leads during the pause.</li>
      <li>Any lead credits you have left are preserved and will be waiting for you.</li>
      <li>Your subscription resumes automatically on <strong style="color:#1a1a1a">${esc(resumeDate)}</strong>, when billing and leads restart.</li>
    </ul>
    <p style="margin:0 0 8px;font-size:14px"><strong style="color:#1a1a1a">Your database stays open the whole time</strong></p>
    <ul style="margin:0 0 18px;padding-left:18px;font-size:14px;line-height:1.7;color:#6b706a">
      ${keepCrmBulletsHtml(esc)}
    </ul>
    <p style="margin:0 0 18px;color:#6b706a;font-size:14px">There is nothing you need to do. We will email you again when your subscription resumes.</p>
    ${button(`${APP_URL}/dashboard/settings`, "View settings")}
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
 * Notification that a paused management subscription has resumed — billing has
 * restarted and the customer is eligible to receive leads again.
 */
export async function sendSubscriptionResumedEmail(params: {
  to: string;
  contactName: string;
}): Promise<{ id: string | null; error: unknown }> {
  const { to, contactName } = params;
  const firstName = contactName.trim().split(/\s+/)[0] || contactName;
  const subject = "Your Stayful subscription has resumed";

  const inner = `
    <h1 style="margin:0 0 4px;font-size:18px">You're back, ${esc(firstName)}</h1>
    <p style="margin:0 0 14px;color:#6b706a;font-size:14px">Your pause has ended and your Stayful subscription is active again. Billing has restarted and you are back in line to receive leads, with any preserved credits ready to spend.</p>
    <p style="margin:0 0 18px;color:#6b706a;font-size:14px">New leads will start arriving as they are matched to you. A quick call is often what turns an enquiry into a signed landlord, so it is worth being ready to follow up.</p>
    ${button(`${APP_URL}/dashboard/leads`, "View your leads")}
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
 * Confirmation that a subscription is scheduled to cancel at period end.
 *
 * THIS EMAIL IS THE EVIDENCE TRAIL. It states, in writing, on the day the
 * customer asked: that they cancelled, that they will not be billed again, and
 * the exact date service ends. "You said you'd cancelled but kept billing me"
 * is the complaint the whole cancellation feature exists to make unanswerable,
 * and this message plus the subscription_cancellations row is the answer.
 * When endDateIso is null (Stripe returned no period end) the copy falls back
 * to "at the end of your current billing period" rather than guessing a date —
 * a wrong stated date is worse than an unstated one.
 */
export async function sendSubscriptionCancelledEmail(params: {
  to: string;
  contactName: string;
  /** Product as the customer knows it, e.g. "Management leads". */
  productName: string;
  endDateIso: string | null;
}): Promise<{ id: string | null; error: unknown }> {
  const { to, contactName, productName, endDateIso } = params;
  const firstName = contactName.trim().split(/\s+/)[0] || contactName;
  const endPhrase = endDateIso
    ? `<strong style="color:#1a1a1a">${esc(ukLongDate(endDateIso))}</strong>`
    : "the end of your current billing period";
  const subject = "Your Stayful cancellation is confirmed";

  const inner = `
    <h1 style="margin:0 0 4px;font-size:18px">Your cancellation is confirmed, ${esc(firstName)}</h1>
    <p style="margin:0 0 14px;color:#6b706a;font-size:14px">Your ${esc(productName)} subscription is scheduled to cancel. Here is what that means:</p>
    <ul style="margin:0 0 18px;padding-left:18px;font-size:14px;line-height:1.7;color:#6b706a">
      <li><strong style="color:#1a1a1a">You will not be billed again.</strong></li>
      <li>Your subscription ends on ${endPhrase} — you keep your access and any remaining leads until then.</li>
      <li>Nothing else is charged and there is nothing more you need to do.</li>
      <li>Changed your mind? Choose <strong style="color:#1a1a1a">Keep my subscription</strong> in Settings any time before your end date and everything continues as it was.</li>
    </ul>
    <p style="margin:0 0 8px;font-size:14px"><strong style="color:#1a1a1a">Your database stays open, and it is free</strong></p>
    <ul style="margin:0 0 18px;padding-left:18px;font-size:14px;line-height:1.7;color:#6b706a">
      ${keepCrmBulletsHtml(esc)}
    </ul>
    <p style="margin:0 0 18px;color:#6b706a;font-size:14px">We are sorry to see you go. If anything about the service fell short, replying to this email goes straight to us.</p>
    ${button(`${APP_URL}/dashboard/settings`, "View settings")}
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
 * Confirmation that a pending cancellation has been withdrawn — the evidence
 * trail in the other direction, so "I never asked to stay" is answerable too.
 */
export async function sendSubscriptionKeptEmail(params: {
  to: string;
  contactName: string;
  productName: string;
}): Promise<{ id: string | null; error: unknown }> {
  const { to, contactName, productName } = params;
  const firstName = contactName.trim().split(/\s+/)[0] || contactName;
  const subject = "Your Stayful subscription will continue";

  const inner = `
    <h1 style="margin:0 0 4px;font-size:18px">Good to have you staying, ${esc(firstName)}</h1>
    <p style="margin:0 0 14px;color:#6b706a;font-size:14px">Your cancellation has been withdrawn. Your ${esc(productName)} subscription continues as it was — billing carries on at your usual date and your leads keep arriving.</p>
    <p style="margin:0 0 18px;color:#6b706a;font-size:14px">If you did not ask for this change, reply to this email and we will put it right.</p>
    ${button(`${APP_URL}/dashboard/settings`, "View settings")}
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
 * Advance warning that a pause is about to end and billing will resume — sent
 * ~7 days ahead by the resume cron, once per pause.
 *
 * This is the direct fix for the complaint the pause design invites: billing
 * restarting automatically on someone who had decided they were done. The
 * customer is told the exact date and given every exit while there is still
 * time to take one — including cancelling so billing never restarts.
 */
export async function sendPauseEndingSoonEmail(params: {
  to: string;
  contactName: string;
  resumeDateIso: string;
}): Promise<{ id: string | null; error: unknown }> {
  const { to, contactName, resumeDateIso } = params;
  const firstName = contactName.trim().split(/\s+/)[0] || contactName;
  const resumeDate = ukLongDate(resumeDateIso);
  const subject = `Your Stayful pause ends on ${resumeDate}`;

  const inner = `
    <h1 style="margin:0 0 4px;font-size:18px">Your pause ends soon, ${esc(firstName)}</h1>
    <p style="margin:0 0 14px;color:#6b706a;font-size:14px">Your Stayful subscription is due to resume on <strong style="color:#1a1a1a">${esc(resumeDate)}</strong>. From that date billing restarts and new leads begin arriving again, with any preserved credits ready to spend.</p>
    <p style="margin:0 0 14px;color:#6b706a;font-size:14px">If that suits you, there is nothing to do. If not, everything is in Settings:</p>
    <ul style="margin:0 0 18px;padding-left:18px;font-size:14px;line-height:1.7;color:#6b706a">
      <li><strong style="color:#1a1a1a">Carry on</strong> — do nothing, and leads restart on ${esc(resumeDate)}.</li>
      <li><strong style="color:#1a1a1a">Change plan</strong> — drop to a smaller package before billing restarts.</li>
      <li><strong style="color:#1a1a1a">Cancel</strong> — cancel before ${esc(resumeDate)} and billing never restarts. Nothing further is charged.</li>
    </ul>
    ${button(`${APP_URL}/dashboard/settings`, "Review your subscription")}
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

/** Join phrases as "a", "a and b", or "a, b and c". */
function joinWithAnd(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * Friday weekly progress report — a positive summary of the leads a customer
 * moved forward this week. Deliberately upbeat and celebratory, distinct in
 * tone from the inactivity nudge (which is a prompt to act). Only sent to
 * customers with activity in the window.
 */
export async function sendProgressReportEmail(params: {
  to: string;
  contactName: string;
  contacted: number;
  inDiscussion: number;
  won: number;
}): Promise<{ id: string | null; error: unknown }> {
  const { to, contactName, contacted, inDiscussion, won } = params;
  const firstName = contactName.trim().split(/\s+/)[0] || contactName;

  const parts: string[] = [];
  if (contacted)
    parts.push(`${contacted} lead${contacted === 1 ? "" : "s"} contacted`);
  if (inDiscussion) parts.push(`${inDiscussion} moved into discussion`);
  if (won) parts.push(`${won} won`);
  const summaryLine = joinWithAnd(parts);
  const subject = `Your week with Stayful — ${summaryLine}`;

  const tile = (n: number, label: string) =>
    `<td style="padding:0 6px;width:33%;text-align:center">
       <div style="background:#f5f6f5;border:0.5px solid #d9dbd8;border-radius:10px;padding:16px 8px">
         <div style="font-size:26px;font-weight:700;color:${BRAND}">${n}</div>
         <div style="font-size:12px;color:#6b706a;margin-top:2px">${label}</div>
       </div>
     </td>`;

  const inner = `
    <h1 style="margin:0 0 4px;font-size:18px">Nice work this week, ${esc(firstName)}</h1>
    <p style="margin:0 0 18px;color:#6b706a;font-size:14px">Here's how your leads moved forward over the last 7 days.</p>
    <table style="width:100%;border-collapse:separate;border-spacing:0;margin-bottom:20px">
      <tr>
        ${tile(contacted, "Contacted")}
        ${tile(inDiscussion, "In discussion")}
        ${tile(won, "Won")}
      </tr>
    </table>
    <p style="margin:0 0 18px;color:#6b706a;font-size:14px">Every conversation you start is momentum toward a signed landlord. Keep it going.</p>
    ${button(`${APP_URL}/dashboard/analytics`, "See your analytics")}
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

/** Format an integer pence amount as GBP, dropping ".00" for whole pounds. */
function formatGbp(pence: number): string {
  const pounds = pence / 100;
  return Number.isInteger(pounds) ? `£${pounds}` : `£${pounds.toFixed(2)}`;
}

/**
 * Credits exhausted — the customer's balance for a product has hit zero.
 *
 * When `topup` is supplied (both products, once the one-off top-up is offered)
 * the email leads with a "buy N more leads" call-to-action pointing at the
 * single-use, time-limited confirmation link; the card on file is charged with
 * no checkout redirect. Without `topup` it falls back to the original
 * renewal-only message. The product name keeps Management and GR wording
 * distinct, per the parallel-column invariant.
 */
export async function sendCreditsExhaustedEmail(params: {
  to: string;
  topup?: {
    url: string;
    product: "management" | "guaranteed_rent";
    credits: number;
    pricePence: number;
  };
}): Promise<{ id: string | null; error: unknown }> {
  const { to, topup } = params;

  if (topup) {
    const productLabel =
      topup.product === "guaranteed_rent" ? "Guaranteed Rent" : "Management";
    const price = formatGbp(topup.pricePence);
    const subject = `You're out of ${productLabel} leads — top up in one tap`;
    const inner = `
      <h1 style="margin:0 0 4px;font-size:18px">You're out of leads</h1>
      <p style="margin:0 0 16px;color:#6b706a;font-size:14px">Your <strong>${esc(productLabel)}</strong> lead balance has reached zero. To keep the leads flowing before your next renewal, buy a one-off top-up now — it's charged to the card already on file, with no checkout to fill in.</p>
      <div style="background:#f5f6f5;border:0.5px solid #d9dbd8;border-radius:10px;padding:18px;text-align:center;margin:0 0 18px">
        <div style="font-size:22px;font-weight:700;color:${BRAND}">${topup.credits} more leads</div>
        <div style="font-size:14px;color:#6b706a;margin-top:2px">${price} — a one-off charge</div>
      </div>
      ${button(topup.url, `Buy ${topup.credits} leads for ${price}`)}
      <p style="margin:18px 0 0;color:#8a8f88;font-size:12px">This link is single-use and expires in 48 hours. If the button doesn't work, copy this into your browser:<br>${esc(topup.url)}</p>
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

  const subject = `Your lead allocation is full for this month`;
  const inner = `
    <h1 style="margin:0 0 4px;font-size:18px">Allocation reached</h1>
    <p style="margin:0 0 18px;color:#6b706a;font-size:14px">You have received all the leads included in your plan this month. Your balance will top up automatically when your subscription renews, and any shortfall carries forward.</p>
    ${button(LOGIN_URL, "Log in to view your leads")}
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
 * Monthly insights — the Leaderboard, sent.
 *
 * Same four rows the customer would see at /dashboard/leaderboard, with their
 * own figures beside the two cohorts, plus ONE thing to do next chosen from
 * their own numbers (see composeInsight in lib/monthlyInsights.ts).
 *
 * The comparison table sits BELOW the ask, deliberately. Leading with a table
 * in which the reader is behind makes the rest of the email an argument they
 * have already lost; leading with a specific, achievable next step makes the
 * table the evidence for it. Same figures, opposite message.
 *
 * There is no "you are underperforming" sentence anywhere in here and there
 * should never be one. The gap speaks for itself to anyone who wants to look,
 * and saying it out loud converts a useful nudge into a rebuke from a supplier.
 */
export async function sendMonthlyInsightsEmail(params: {
  to: string;
  heading: string;
  subject: string;
  ask: string;
  evidence: string | null;
  buttonLabel: string;
  rows: {
    label: string;
    you: string;
    signed: string;
    others: string;
  }[];
  asOf: string | null;
}): Promise<{ id: string | null; error: unknown }> {
  const { to, heading, subject, ask, evidence, buttonLabel, rows, asOf } = params;

  const headerCell =
    "padding:8px 6px;font-size:11px;color:#6b706a;font-weight:600;text-align:right";
  const bodyCell = "padding:10px 6px;font-size:13px;text-align:right";

  const table = `
    <table style="width:100%;border-collapse:collapse;margin:20px 0 8px">
      <tr>
        <th style="padding:8px 6px;font-size:11px;color:#6b706a;font-weight:600;text-align:left">&nbsp;</th>
        <th style="${headerCell}">You</th>
        <th style="${headerCell}">Signed a client</th>
        <th style="${headerCell}">Not yet</th>
      </tr>
      ${rows
        .map(
          (r) => `<tr style="border-top:0.5px solid #e3e5e2">
        <td style="padding:10px 6px;font-size:13px">${esc(r.label)}</td>
        <td style="${bodyCell};font-weight:700;color:${BRAND}">${esc(r.you)}</td>
        <td style="${bodyCell};color:#6b706a">${esc(r.signed)}</td>
        <td style="${bodyCell};color:#6b706a">${esc(r.others)}</td>
      </tr>`
        )
        .join("")}
    </table>`;

  const inner = `
    <h1 style="margin:0 0 10px;font-size:18px">${esc(heading)}</h1>
    <p style="margin:0 0 14px;font-size:14px;line-height:1.5">${esc(ask)}</p>
    ${
      evidence
        ? `<p style="margin:0 0 4px;color:#6b706a;font-size:13px;line-height:1.5">${esc(evidence)}</p>`
        : ""
    }
    ${table}
    <p style="margin:0 0 18px;color:#8a8f88;font-size:11px">
      Management leads only${asOf ? `, as of ${esc(asOf)}` : ""}. Figures are averages across operators on the platform — nobody is named or ranked, and no one else can see yours.
    </p>
    ${button(`${APP_URL}/dashboard/leaderboard`, buttonLabel)}
    <p style="margin:18px 0 0;color:#8a8f88;font-size:11px">
      You can turn these monthly summaries off under Notifications in your dashboard.
    </p>
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
 * An admin-written announcement, sent to a customer.
 *
 * The first email in this file that carries content nobody computed. Everything
 * else here is assembled from figures; this is a person writing to the customer
 * book, so the template's whole job is to stay out of the way: the heading, the
 * words, an optional button, and nothing else.
 *
 * ESCAPING IS LOAD-BEARING. The body arrives as free text typed into an admin
 * form and is dropped into an HTML email, so every paragraph goes through esc()
 * — the same treatment the training article page gives its body, and for the
 * same reason: no markdown renderer is installed and nothing should be able to
 * turn stored content into markup. Paragraphs are split by lib/announcements'
 * `paragraphs()` before they get here, so the email and the dashboard banner
 * break the text in exactly the same places.
 *
 * The opt-out line is not decoration. This is unsolicited mail to a paying
 * customer; shell()'s footer already says why they received it, and this says
 * how to stop it. An announcement channel without a visible way out is how a
 * sending domain gets itself marked as spam.
 */
export async function sendAnnouncementEmail(params: {
  to: string;
  contactName: string | null;
  subject: string;
  title: string;
  paragraphs: string[];
  linkUrl: string | null;
  linkLabel: string | null;
}): Promise<{ id: string | null; error: unknown }> {
  const { to, contactName, subject, title, paragraphs, linkUrl, linkLabel } =
    params;

  const greeting = contactName?.trim()
    ? `<p style="margin:0 0 14px;font-size:14px;line-height:1.6">Hi ${esc(
        contactName.trim().split(/\s+/)[0]
      )},</p>`
    : "";

  const bodyHtml = paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 14px;font-size:14px;line-height:1.6;white-space:pre-line">${esc(
          p
        )}</p>`
    )
    .join("");

  // esc() on the label because button() drops it into the anchor unescaped, and
  // every other caller in this file passes a hard-coded string where this one
  // passes whatever an admin typed. The URL needs no escaping here: the write
  // route runs it through new URL().toString(), which percent-encodes the quote
  // that would otherwise break out of the href attribute.
  const cta =
    linkUrl && linkLabel
      ? `<div style="margin-top:4px">${button(linkUrl, esc(linkLabel))}</div>`
      : "";

  const inner = `
    <h1 style="margin:0 0 14px;font-size:18px">${esc(title)}</h1>
    ${greeting}
    ${bodyHtml}
    ${cta}
    <p style="margin:22px 0 0;color:#8a8f88;font-size:11px">
      You can turn announcements off under Notifications in your
      <a href="${APP_URL}/dashboard/settings" style="color:#8a8f88">dashboard settings</a>.
      Billing and account emails will still reach you.
    </p>
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
 * A paid analysis batch has finished.
 *
 * Sent once per job, by the worker, because the customer paid up front and then
 * waited: 200 leads at three in flight is around half an hour, and "we'll email
 * you" is the promise the purchase screen makes. Saying nothing would leave
 * them refreshing a page.
 *
 * The refund is stated plainly rather than buried. A customer who paid for
 * twelve and got nine should learn the difference from us, in the same message,
 * not from their statement a week later.
 */
export async function sendAnalysisReadyEmail(params: {
  to: string;
  succeeded: number;
  failed: number;
  refundPence: number;
}): Promise<{ id: string | null; error: unknown }> {
  const { to, succeeded, failed, refundPence } = params;
  const leadWord = (n: number) => `${n} lead${n === 1 ? "" : "s"}`;

  const allFailed = succeeded === 0;
  const subject = allFailed
    ? "We couldn't run the figures on those leads"
    : `The figures are ready on ${leadWord(succeeded)}`;

  const headline = allFailed
    ? "We couldn't run those figures"
    : `Your figures are ready`;

  const body = allFailed
    ? `We weren't able to produce trustworthy figures for any of those properties, so nothing has been added to them and you have been refunded in full.`
    : `${leadWord(succeeded)} now show projected occupancy, nightly rate, gross income and your management fee — with the full Stayful analysis attached, exactly like a lead that came from us.`;

  const refundLine =
    refundPence > 0 && !allFailed
      ? `<div style="background:#f5f6f5;border:0.5px solid #d9dbd8;border-radius:10px;padding:14px;margin:0 0 18px;font-size:14px;color:#6b706a">We couldn't get trustworthy figures for ${leadWord(
          failed
        )}, so <strong>${formatGbp(refundPence)}</strong> has been refunded to your card. You are only charged for figures you actually got.</div>`
      : refundPence > 0
        ? `<div style="background:#f5f6f5;border:0.5px solid #d9dbd8;border-radius:10px;padding:14px;margin:0 0 18px;font-size:14px;color:#6b706a"><strong>${formatGbp(
            refundPence
          )}</strong> has been refunded to your card.</div>`
        : "";

  const inner = `
    <h1 style="margin:0 0 4px;font-size:18px">${esc(headline)}</h1>
    <p style="margin:0 0 16px;color:#6b706a;font-size:14px">${body}</p>
    ${refundLine}
    ${button(`${APP_URL}/dashboard/leads`, "See your leads")}
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
