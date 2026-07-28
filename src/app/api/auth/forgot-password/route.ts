import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { APP_URL } from "@/lib/env";
import { sendPasswordResetEmail } from "@/lib/emails/passwordReset";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Password reset, sent via Resend instead of Supabase's auth mailer.
 *
 * The browser used to call `supabase.auth.resetPasswordForEmail()` directly,
 * which hits Supabase's built-in email service. That sender is a shared test
 * relay with a project-wide cap of roughly two emails per hour, so one customer
 * retrying a few times exhausted the quota for every customer and every flow —
 * the "email rate limit exceeded" 429s. `generateLink` mints the same recovery
 * token without sending anything, leaving delivery to Resend, which is what the
 * invite and provisioning paths already do.
 */

/**
 * Per-address cooldown so the endpoint can't be used to flood someone's inbox.
 *
 * Best-effort only: this lives in the memory of a single serverless instance, so
 * a request routed elsewhere can slip through. That is an accepted limit — the
 * endpoint only ever emails an address that already has an account, and Resend
 * enforces its own account-level limits underneath. Worth replacing with a
 * durable store if this is ever actually abused.
 */
const COOLDOWN_MS = 60_000;
const lastRequestByEmail = new Map<string, number>();

function withinCooldown(email: string): boolean {
  const now = Date.now();
  // Drop expired entries so the map can't grow without bound. forEach rather
  // than for..of: the project's TS target predates Map iteration.
  const expired: string[] = [];
  lastRequestByEmail.forEach((at, key) => {
    if (now - at > COOLDOWN_MS) expired.push(key);
  });
  expired.forEach((key) => lastRequestByEmail.delete(key));

  const last = lastRequestByEmail.get(email);
  if (last !== undefined && now - last < COOLDOWN_MS) return true;
  lastRequestByEmail.set(email, now);
  return false;
}

export async function POST(req: NextRequest) {
  // Never reveal whether an account exists: a missing address, an unknown
  // address and a throttled repeat all return this same body.
  const generic = NextResponse.json({ ok: true });

  let email = "";
  try {
    const body = (await req.json()) as { email?: unknown };
    if (typeof body.email === "string") email = body.email.trim().toLowerCase();
  } catch {
    return generic;
  }

  if (!email || !email.includes("@")) return generic;
  if (withinCooldown(email)) return generic;

  const admin = createAdminClient();

  // Mint a recovery token. This sends no email — it only returns the link.
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: "recovery",
    email,
    options: { redirectTo: `${APP_URL}/reset-password` },
  });

  // No auth user for this address is the ordinary case, not a fault worth
  // surfacing — stay silent so the response can't be used to probe for accounts.
  if (linkError || !link) return generic;

  // Route through /auth/confirm with the token hash (verifyOtp) rather than the
  // raw action_link. The PKCE `?code` exchange needs a code-verifier cookie from
  // the browser that began the flow, which breaks the common case of requesting
  // on a laptop and opening the link on a phone. Same reasoning as the invite path.
  const hashedToken = link.properties?.hashed_token;
  const resetUrl = hashedToken
    ? `${APP_URL}/auth/confirm?token_hash=${hashedToken}&type=recovery&next=/reset-password`
    : link.properties?.action_link;

  if (!resetUrl) {
    console.error("forgot-password: generateLink returned no usable link");
    return NextResponse.json(
      { error: "We couldn't generate a reset link. Please contact support." },
      { status: 500 }
    );
  }

  // Look up the contact name for the greeting. Absence is fine — the email
  // falls back to a plain "Hi,".
  const { data: customer } = await admin
    .from("customers")
    .select("contact_name")
    .eq("email", email)
    .maybeSingle();

  try {
    await sendPasswordResetEmail({
      to: email,
      resetUrl,
      contactName: customer?.contact_name ?? null,
    });
  } catch (err) {
    // A transport failure is surfaced rather than swallowed. Showing "check your
    // inbox" when nothing was sent is the exact failure this route exists to end,
    // and it is worth more than the sliver of account-existence this leaks.
    console.error("forgot-password: Resend send failed", err);
    return NextResponse.json(
      { error: "We couldn't send the reset email. Please contact support." },
      { status: 500 }
    );
  }

  return generic;
}
