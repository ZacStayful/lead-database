import { Resend } from "resend";
import { PRODUCT_COPY } from "@/lib/products";
import type { LeadType } from "@/lib/types";

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
  product = "management",
}: {
  to: string;
  contactName: string;
  checkoutUrl: string;
  leads?: number;
  priceGbp?: number;
  setPasswordUrl?: string | null;
  /** Which product the checkout link bills for. Defaults to management. */
  product?: LeadType;
}) {
  const setPasswordBlock = setPasswordUrl
    ? `<p style="margin-top:24px;">Once you've subscribed, set your password to access your dashboard:</p>
       <p><a href="${setPasswordUrl}" style="color:#3B6D11;font-weight:600;">Set your password</a></p>`
    : "";

  // Name the product in the email. The two products are the same price for the
  // same number of leads, so a generic "landlord leads" line gives the customer
  // nothing to check the invoice against — which is precisely how a Guaranteed
  // Rent buyer can be signed up to management without either side noticing.
  const copy = PRODUCT_COPY[product];
  const isGr = product === "guaranteed_rent";
  const leadDescription = isGr
    ? `${leads} financially modelled Guaranteed Rent leads per month — landlords open to letting you take their property on a fixed monthly rent`
    : `${leads} financially modelled landlord leads per month`;

  await getResend().emails.send({
    from: process.env.RESEND_FROM_EMAIL!,
    to,
    subject: `Your place on the Stayful Lead Marketplace is ready — ${copy.name}`,
    html: `
      <p>Hi ${contactName},</p>
      <p>Your account has been approved. You can now subscribe to <strong>${copy.name}</strong> on the Stayful Lead Marketplace and begin receiving ${leadDescription}.</p>
      <p><a href="${checkoutUrl}" style="background:#3B6D11;color:#ffffff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">Start your subscription — £${priceGbp}/month</a></p>
      ${setPasswordBlock}
      <p>If you have any questions before subscribing, reply to this email and Zac will get back to you directly.</p>
      <p>Stayful Lead Marketplace</p>
    `,
  });
}
