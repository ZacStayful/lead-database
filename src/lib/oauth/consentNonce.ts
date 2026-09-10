/**
 * The consent screen's CSRF nonce.
 *
 * ⚠️ THIS LIVES IN ITS OWN MODULE BECAUSE THREE PLACES NEED IT and none of them
 * should have to import a page to get it. It used to be exported from
 * src/app/oauth/authorize/page.tsx, which meant the POST route pulled the whole
 * page module — getCurrentCustomer, supabase-js, the card components — into its
 * graph to read one string.
 *
 * The cookie half is written by GET /api/oauth/consent-nonce and read by
 * POST /api/oauth/authorize. It is deliberately NOT written by the page:
 * cookies() is read-only in a Server Component on Next 14 and .set() throws
 * there, which is what took the consent screen down with a 500 on every VALID
 * request while every error path kept rendering correctly.
 */

/** The cookie half of the double-submit CSRF pair. */
export const CONSENT_NONCE_COOKIE = "sf_oauth_consent";

/**
 * How long a consent form stays usable. Ten minutes is the whole life of the
 * screen — long enough to read it, short enough that a nonce left in a
 * forgotten tab is not a standing credential.
 */
export const CONSENT_NONCE_MAX_AGE_SECONDS = 600;

/**
 * The cookie options, written once so the route that sets it and any future
 * reader cannot disagree about scope. `path: "/"` matters: the nonce is set
 * from /api/oauth/consent-nonce and read from /api/oauth/authorize.
 */
export function consentNonceCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: CONSENT_NONCE_MAX_AGE_SECONDS,
  };
}
