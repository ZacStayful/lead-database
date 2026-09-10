/**
 * Mints the consent screen's CSRF nonce.
 *
 * ⚠️ THIS ROUTE EXISTS BECAUSE A SERVER COMPONENT CANNOT SET A COOKIE. The
 * consent page used to call cookies().set() itself, which throws on Next 14 —
 * "Cookies can only be modified in a Server Action or Route Handler" — so every
 * VALID authorization request 500'd while every error path rendered correctly,
 * because the error paths return before the write. A Route Handler may set
 * cookies, so the form asks this for its nonce instead.
 *
 * Middleware would have been the smaller change and is not available: this
 * project keeps its app in src/ while middleware.ts sits at the repository
 * root, so Next never loads it. The production build prints no Middleware line.
 *
 * The value is returned in the body AND set as the cookie; the POST requires
 * them to match. Handing it back is not a leak — the point of a double-submit
 * pair is that a page on another origin can send the cookie but cannot read
 * this response to learn the value that goes with it.
 */
import { NextResponse } from "next/server";
import { getUser } from "@/lib/auth";
import { oauthEnabled } from "@/lib/oauth/enabled";
import { mintNonce } from "@/lib/oauth/tokens";
import {
  CONSENT_NONCE_COOKIE,
  consentNonceCookieOptions,
} from "@/lib/oauth/consentNonce";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await oauthEnabled())) {
    return NextResponse.json(
      { error: "Connections are not available right now." },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }

  // A nonce is only meaningful paired with a session, and an open minter is a
  // needless endpoint. Same posture as the consent screen itself.
  const user = await getUser();
  if (!user) {
    return NextResponse.json(
      { error: "You are not signed in." },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }

  const nonce = mintNonce();

  // ⚠️ no-store is load-bearing, not hygiene. A cached response would hand one
  // customer's nonce to the next visitor, and the pair would then match for
  // somebody who never saw the consent screen.
  const response = NextResponse.json(
    { nonce },
    { headers: { "Cache-Control": "no-store, private" } }
  );
  response.cookies.set(CONSENT_NONCE_COOKIE, nonce, consentNonceCookieOptions());
  return response;
}
