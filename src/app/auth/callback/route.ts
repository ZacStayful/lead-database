import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * OAuth / PKCE callback. Supabase redirects here with a `?code=` after the
 * user follows an email link (password recovery, magic link, email change)
 * that was initiated from *this* browser. We exchange the code for a session
 * server-side and set the auth cookies, then forward the user on.
 *
 * `next` controls the final destination (defaults to the dashboard). Password
 * recovery links pass `next=/reset-password` so the user lands on the
 * set-a-new-password form with a live recovery session.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = safeNext(searchParams.get("next"));
  const errorDescription =
    searchParams.get("error_description") ?? searchParams.get("error");

  if (errorDescription) {
    return NextResponse.redirect(invalidLinkUrl(origin, errorDescription));
  }

  if (code) {
    const supabase = createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(new URL(next, origin));
    }
  }

  return NextResponse.redirect(invalidLinkUrl(origin));
}

/** Only allow same-origin relative paths as the post-auth destination. */
function safeNext(value: string | null): string {
  if (value && value.startsWith("/") && !value.startsWith("//")) return value;
  return "/dashboard";
}

function invalidLinkUrl(origin: string, message?: string): URL {
  const url = new URL("/reset-password", origin);
  url.searchParams.set(
    "error",
    message ||
      "This link is invalid or has expired. Please request a new one."
  );
  return url;
}
