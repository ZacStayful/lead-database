import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";
import { APP_URL } from "@/lib/env";
import { sendPasswordResetEmail } from "@/lib/emails/passwordReset";
import { generateTemporaryPassword } from "@/lib/password";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function isAdminRequest(req: NextRequest): Promise<boolean> {
  const key = req.headers.get("x-admin-key");
  if (key && process.env.ADMIN_SECRET_KEY && key === process.env.ADMIN_SECRET_KEY) {
    return true;
  }
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return isAdminUser(user);
}

/**
 * Restore account access for a customer who cannot log in.
 *
 * Two modes, because the first one has a failure this cannot see:
 *
 *   * `link`     — mint a recovery token and email it through Resend. The
 *                  normal path, and the one that leaves the customer choosing
 *                  their own password.
 *   * `password` — generate a password, set it, and return it to the admin to
 *                  pass on by hand. The failsafe for when the email never
 *                  arrives: a spam filter, a scanner that consumes the
 *                  single-use link before the customer clicks it, or an inbox
 *                  the customer has lost access to. Nothing on this side can
 *                  distinguish "delivered and ignored" from "never seen", so
 *                  the fallback cannot be automatic — it is a judgement the
 *                  admin makes after the link has failed.
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * `resend-invite` refuses anybody whose account_status is not 'invited', so
 * there was no admin action that could help a paying, active customer who had
 * lost their password. The only remaining options were the customer's own
 * /forgot-password form and a hand-written UPDATE against auth.users.
 *
 * Both modes deliberately avoid Supabase's auth mailer. `generateLink` mints a
 * token and sends nothing; `updateUserById` sends nothing either. Every email
 * leaves through Resend. See CLAUDE.md §15 — the built-in sender is a shared
 * test relay capped at roughly two emails an hour for the entire project, and
 * reaching for it once locked a paying customer out for a week.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  // Only the mode is read from the body. The password itself is never accepted
  // from the caller — see generateTemporaryPassword.
  let mode: "link" | "password" = "link";
  try {
    const body = (await req.json()) as { mode?: unknown };
    if (body.mode === "password") mode = "password";
  } catch {
    // No body is the ordinary case for the link mode.
  }

  const admin = createAdminClient();

  const { data: customer, error: fetchError } = await admin
    .from("customers")
    .select("id, email, contact_name, user_id")
    .eq("id", params.id)
    .single();

  if (fetchError || !customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  // No auth user means there is no password to reset and no account to recover
  // into. That is the invite flow's job, and it creates the login as a side
  // effect — sending a recovery link here would mint a token for nobody.
  if (!customer.user_id) {
    return NextResponse.json(
      {
        error:
          "This customer has no login yet. Use the invite action, which creates one.",
      },
      { status: 400 }
    );
  }

  if (mode === "password") {
    const password = generateTemporaryPassword();

    const { error: updateError } = await admin.auth.admin.updateUserById(
      customer.user_id,
      { password }
    );

    if (updateError) {
      console.error("admin reset-password: updateUserById failed", updateError);
      return NextResponse.json(
        { error: "Could not set a password for this customer." },
        { status: 500 }
      );
    }

    // Existing sessions are left alone on purpose. A customer in the middle of
    // being helped may already have a live session from a recovery link, and
    // signing them out mid-rescue is the opposite of the point. The account was
    // not compromised — it was inaccessible.
    //
    // The password is returned to the admin and never logged. It is the only
    // copy: nothing stores it, and the next read of the row is a bcrypt hash.
    return NextResponse.json({
      ok: true,
      mode: "password",
      email: customer.email,
      password,
    });
  }

  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: "recovery",
    email: customer.email,
    options: { redirectTo: `${APP_URL}/reset-password` },
  });

  if (linkError || !link) {
    console.error("admin reset-password: generateLink failed", linkError);
    return NextResponse.json(
      { error: "Could not generate a reset link for this customer." },
      { status: 500 }
    );
  }

  // Token hash through /auth/confirm, not the raw action_link. The PKCE `?code`
  // exchange needs a code-verifier cookie belonging to the browser that started
  // the flow, and a link minted here never has one — so the ordinary case of an
  // admin triggering it and the customer opening it on their own phone would
  // break. verifyOtp needs no verifier and works across devices.
  const hashedToken = link.properties?.hashed_token;
  const resetUrl = hashedToken
    ? `${APP_URL}/auth/confirm?token_hash=${hashedToken}&type=recovery&next=/reset-password`
    : link.properties?.action_link;

  if (!resetUrl) {
    console.error("admin reset-password: generateLink returned no usable link");
    return NextResponse.json(
      { error: "Could not generate a reset link for this customer." },
      { status: 500 }
    );
  }

  try {
    await sendPasswordResetEmail({
      to: customer.email,
      resetUrl,
      contactName: customer.contact_name ?? null,
    });
  } catch (err) {
    console.error("admin reset-password: Resend send failed", err);
    // Name the fallback in the error itself. This is the exact moment the
    // admin needs to know the other mode exists, and it is the one failure the
    // link mode cannot recover from on its own.
    return NextResponse.json(
      {
        error:
          "Could not send the reset email. Use “Create a password” instead and pass it on directly.",
      },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, mode: "link", email: customer.email });
}
