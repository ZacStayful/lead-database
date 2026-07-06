import { Resend } from "resend";

// Lazily constructed so the module can be imported at build time without
// RESEND_API_KEY set (the Resend constructor throws on a missing key).
let _resend: Resend | null = null;
function getResend(): Resend {
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY);
  return _resend;
}

/**
 * Activation email — sent when an admin invites a waitlisted customer to
 * subscribe. Contains a fresh Stripe Checkout link for their plan and, for
 * enquiry-form accounts that never chose a password, a set-password link.
 */
export async function sendActivationEmail({
  to,
  contactName,
  checkoutUrl,
  leads = 20,
  priceGbp = 300,
  setPasswordUrl = null,
}: {
  to: string;
  contactName: string;
  checkoutUrl: string;
  leads?: number;
  priceGbp?: number;
  setPasswordUrl?: string | null;
}) {
  const setPasswordBlock = setPasswordUrl
    ? `<p style="margin-top:24px;">Once you've subscribed, set your password to access your dashboard:</p>
       <p><a href="${setPasswordUrl}" style="color:#3B6D11;font-weight:600;">Set your password</a></p>`
    : "";

  await getResend().emails.send({
    from: process.env.RESEND_FROM_EMAIL!,
    to,
    subject: "Your place on the Stayful Lead Marketplace is ready",
    html: `
      <p>Hi ${contactName},</p>
      <p>Your account has been approved. You can now subscribe to the Stayful Lead Marketplace and begin receiving ${leads} financially modelled landlord leads per month.</p>
      <p><a href="${checkoutUrl}" style="background:#3B6D11;color:#ffffff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">Start your subscription — £${priceGbp}/month</a></p>
      ${setPasswordBlock}
      <p>If you have any questions before subscribing, reply to this email and Zac will get back to you directly.</p>
      <p>Stayful Lead Marketplace</p>
    `,
  });
}
