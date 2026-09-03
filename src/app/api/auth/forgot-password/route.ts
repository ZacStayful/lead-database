import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { APP_URL } from "@/lib/env";
import { sendPasswordResetEmail } from "@/lib/emails/passwordReset";
import { clientIp } from "@/lib/api/log";
import {
  classifyGenerateLinkError,
  hashResetSubject,
  resetBudgetRefusal,
  RESET_SHORT_WINDOW_SECONDS,
  RESET_LONG_WINDOW_SECONDS,
  type ResetBudgetCounts,
} from "@/lib/authReset";
import { normaliseEmail } from "@/lib/emailAddress";

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
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ROUTE NOW TELLS YOU WHEN IT DOES NOT KNOW YOUR ADDRESS (§43)
 * ---------------------------------------------------------------------------
 * It used to answer every failure with `{ok:true}`. A missing account, a
 * throttled repeat and a Supabase outage were indistinguishable, and all three
 * rendered as "check your inbox" over an email that was never sent. A paying
 * customer lost a day to exactly that: she had signed up with a personal
 * address, was resetting with her business one, and nothing anywhere could tell
 * her so.
 *
 * The silence was justified as anti-enumeration, but that argument was already
 * lost elsewhere — /api/signup tells any anonymous caller that an address is an
 * active paying account, and the `?email=` prefill on the reset form depends on
 * it. This route was the outlier, and its own comment about the Resend failure
 * below already made the case: showing "check your inbox" when nothing was sent
 * is the exact failure this route exists to end.
 *
 * Three outcomes now, all HTTP 200 because the request itself was fine:
 *
 *   sent          — token minted, Resend accepted it
 *   unknown_email — no auth user and no customers row
 *   no_login      — no auth user but a customers row exists. Seventeen of
 *                   forty-one customers are in this state (waitlisted
 *                   prospects), so folding them into unknown_email would be a
 *                   lie to people who genuinely are on our records.
 *
 * ⚠️ Transport and configuration failures keep their 500s and must NEVER be
 * reported as unknown_email — see classifyGenerateLinkError, which is an
 * allowlist for precisely this reason.
 */

/**
 * Abuse control, now durable (0130) rather than a per-instance Map.
 *
 * The Map this replaces justified itself on the grounds that "the endpoint only
 * ever emails an address that already has an account", which stops being true
 * the moment the route discloses. Disclosure and this limiter are one change:
 * without it the endpoint is an account oracle bounded only by one serverless
 * instance's memory.
 *
 * FAILS CLOSED, like every other caller of a limiter RPC in this codebase. If
 * the limiter is unreachable we refuse rather than wave requests through, since
 * the moment it breaks is exactly when it is under load.
 */
async function refuseForBudget(
  admin: ReturnType<typeof createAdminClient>,
  email: string,
  ip: string | null
): Promise<string | null> {
  const { data, error } = await admin.rpc("consume_reset_budget", {
    p_email_hash: hashResetSubject(email),
    p_ip_hash: ip ? hashResetSubject(ip) : null,
    p_short_seconds: RESET_SHORT_WINDOW_SECONDS,
    p_long_seconds: RESET_LONG_WINDOW_SECONDS,
  });

  if (error || !data) {
    console.error("forgot-password: rate limiter unavailable", error);
    return "We couldn't process that request. Please try again shortly.";
  }

  return resetBudgetRefusal(data as ResetBudgetCounts);
}

export async function POST(req: NextRequest) {
  let rawEmail: unknown = null;
  try {
    const body = (await req.json()) as { email?: unknown };
    rawEmail = body.email;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const email = normaliseEmail(rawEmail);
  if (!email) {
    // The form marks the field `type="email" required`, so this is a malformed
    // client rather than a customer typo. Say so rather than claiming we sent
    // something, which is the behaviour this route exists to stop.
    return NextResponse.json(
      { error: "Enter a valid email address." },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  // Rate limit BEFORE any account lookup, so a probe is refused before it can
  // learn anything about whether the address exists.
  const refusal = await refuseForBudget(admin, email, clientIp(req));
  if (refusal) {
    return NextResponse.json({ error: refusal }, { status: 429 });
  }

  // Mint a recovery token. This sends no email — it only returns the link.
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: "recovery",
    email,
    options: { redirectTo: `${APP_URL}/reset-password` },
  });

  if (linkError || !link) {
    if (linkError && classifyGenerateLinkError(linkError) === "no_user") {
      // Distinguish "we've never heard of you" from "you're on our books but
      // have no login yet" — different problems with different fixes, and the
      // second is the more common one on today's data.
      //
      // `.eq` rather than `.ilike`: an address may legitimately contain `_`,
      // which ilike treats as a single-character wildcard, so ilike would match
      // the wrong row. Measured before this shipped: no customer row carries a
      // mixed-case or untrimmed address, so the exact match is correct for all
      // live data and the wildcard hazard is not worth trading for.
      const { data: customer } = await admin
        .from("customers")
        .select("id")
        .eq("email", email)
        .maybeSingle();

      return NextResponse.json({
        ok: false,
        status: customer ? "no_login" : "unknown_email",
      });
    }

    // Anything we cannot positively identify as a missing user is an outage, a
    // bad key, or a shape we have not seen — never something to tell a customer
    // about their own account.
    console.error("forgot-password: generateLink failed", linkError);
    return NextResponse.json(
      { error: "We couldn't generate a reset link. Please contact support." },
      { status: 500 }
    );
  }

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
    // inbox" when nothing was sent is the exact failure this route exists to end.
    console.error("forgot-password: Resend send failed", err);
    return NextResponse.json(
      { error: "We couldn't send the reset email. Please contact support." },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, status: "sent" });
}
