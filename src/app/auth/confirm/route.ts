import { type EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Token-hash email confirmation. Supabase redirects here with
 * `?token_hash=...&type=...` when the email template uses the `{{ .TokenHash }}`
 * link format. Unlike the PKCE `?code` flow, verifying a token hash needs no
 * code-verifier, so it works even when the link is opened on a *different*
 * device or browser than the one that requested it — which is the common
 * real-world case for a password reset (request on a laptop, open on a phone).
 *
 * On success the session cookies are set and the user is forwarded on:
 * recovery links land on `/reset-password` to set a new password; everything
 * else goes to `next` (default dashboard).
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = safeNext(
    searchParams.get("next"),
    type === "recovery" ? "/reset-password" : "/dashboard"
  );

  if (tokenHash && type) {
    const supabase = createClient();
    const { error } = await supabase.auth.verifyOtp({
      type,
      token_hash: tokenHash,
    });
    if (!error) {
      return NextResponse.redirect(new URL(next, origin));
    }
  }

  const url = new URL("/reset-password", origin);
  url.searchParams.set(
    "error",
    "This link is invalid or has expired. Please request a new one."
  );
  return NextResponse.redirect(url);
}

/** Only allow same-origin relative paths as the post-auth destination. */
function safeNext(value: string | null, fallback: string): string {
  if (value && value.startsWith("/") && !value.startsWith("//")) return value;
  return fallback;
}
