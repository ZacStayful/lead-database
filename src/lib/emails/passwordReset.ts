import { Resend } from "resend";

// Lazily constructed so the module can be imported at build time without
// RESEND_API_KEY set (the Resend constructor throws on a missing key).
let _resend: Resend | null = null;
function getResend(): Resend {
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY);
  return _resend;
}

/**
 * Password-reset email — sent when a customer uses /forgot-password.
 *
 * Deliberately goes through Resend rather than Supabase's built-in auth mailer.
 * Supabase's default sender is a shared test service capped at a couple of
 * emails per hour *for the whole project*, so a handful of reset attempts by one
 * customer locked out everybody else. The link itself is minted by
 * `generateLink`, which produces a token without sending anything — the same
 * split already used by the invite and provisioning paths.
 */
export async function sendPasswordResetEmail({
  to,
  resetUrl,
  contactName = null,
}: {
  to: string;
  resetUrl: string;
  contactName?: string | null;
}) {
  const greeting = contactName ? `Hi ${contactName},` : "Hi,";

  await getResend().emails.send({
    from: process.env.RESEND_FROM_EMAIL!,
    to,
    subject: "Reset your Stayful Lead Marketplace password",
    html: `
      <p>${greeting}</p>
      <p>Use the link below to set a new password for your Stayful Lead Marketplace account.</p>
      <p><a href="${resetUrl}" style="background:#3B6D11;color:#ffffff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">Set a new password</a></p>
      <p style="color:#666;font-size:14px;">This link can only be used once and expires in 1 hour. If you didn't ask to reset your password, you can ignore this email — nothing has changed.</p>
      <p>Stayful Lead Marketplace</p>
    `,
  });
}
