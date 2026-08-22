import { Resend } from "resend";
import { APP_URL } from "@/lib/env";

// Lazily constructed so the module can be imported at build time without
// RESEND_API_KEY set (the Resend constructor throws on a missing key).
let _resend: Resend | null = null;
function getResend(): Resend {
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY);
  return _resend;
}

/**
 * "A new API key was created on your account."
 *
 * THIS IS HOW A COMPROMISED ACCOUNT IS CAUGHT, as distinct from a compromised
 * key. If somebody else can sign in as this customer, the first thing they can
 * do quietly is mint themselves a key that outlives a password change — so the
 * only person who can tell us that was not them needs to hear about it
 * unprompted.
 *
 * Deliberately not gated on notification_preferences. Every key in that jsonb is
 * a preference about lead activity; this is a security notice, and somebody who
 * turned off progress reports has not asked to stop being told when a
 * credential is issued in their name.
 */
export async function sendApiKeyCreatedEmail({
  to,
  contactName = null,
  keyName,
  keyPrefix,
}: {
  to: string;
  contactName?: string | null;
  keyName: string;
  keyPrefix: string;
}) {
  const greeting = contactName ? `Hi ${contactName},` : "Hi,";

  // The prefix identifies the key without being able to authenticate as it, so
  // it is safe in an inbox and is exactly what the customer needs to find the
  // right row in Settings.
  await getResend().emails.send({
    from: process.env.RESEND_FROM_EMAIL!,
    to,
    subject: "A new API key was created on your Stayful account",
    html: `
      <p>${greeting}</p>
      <p>A new API key was just created on your Stayful Lead Marketplace account.</p>
      <p style="margin:16px 0;padding:12px 16px;background:#f5f5f4;border-radius:8px;">
        <strong>${escapeHtml(keyName)}</strong><br />
        <span style="font-family:monospace;color:#555;">${escapeHtml(keyPrefix)}…</span>
      </p>
      <p>If this was you, there is nothing to do — the key is ready to use.</p>
      <p><strong>If it wasn't you</strong>, revoke it now and change your password.</p>
      <p><a href="${APP_URL}/dashboard/settings" style="background:#3B6D11;color:#ffffff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">Manage your API keys</a></p>
      <p style="color:#666;font-size:14px;">API keys are read-only. They can see your leads and your account, and cannot change anything, spend credits or alter your subscription.</p>
      <p>Stayful Lead Marketplace</p>
    `,
  });
}

/** The key name is customer-supplied, so it is escaped before reaching markup. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
