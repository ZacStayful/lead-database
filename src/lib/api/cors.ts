/**
 * CORS for the credential-only surfaces: /api/mcp and the OAuth endpoints.
 *
 * ⚠️ THIS REVERSES A DELIBERATE DECISION, and the reasoning is worth keeping
 * rather than replacing. Both this file's callers used to send no CORS header at
 * all, and src/app/api/mcp/route.ts argued for it: "a page on another origin can
 * POST `application/json` with the visitor's cookies attached; it cannot read the
 * reply (we send no CORS headers)".
 *
 * That argument was sound and no longer bites. Those surfaces are
 * CREDENTIAL-ONLY — /api/mcp takes `allow: ["api_key", "oauth"]` and has no
 * cookie-session fallback — and `Access-Control-Allow-Origin: *` FORBIDS
 * credentialed requests by specification. So a cross-origin page can only ever
 * make an UNAUTHENTICATED request and read the same 401 anybody gets by curling
 * the URL. What changed is not our appetite for risk; it is that the endpoint
 * stopped being able to honour an ambient credential at all.
 *
 * THE STANDING RULE THAT REPLACES THE OLD ONE: never add
 * `Access-Control-Allow-Credentials`. It is what would let a browser attach the
 * visitor's cookies to a cross-origin request, and it is the single header that
 * would make the original objection true again. `*` and `Allow-Credentials` are
 * mutually exclusive in the fetch spec, so adding it would also require naming
 * origins — treat any change in that direction as a redesign, not a tweak.
 *
 * Browser-based OAuth clients are why this is needed: a connector running in a
 * page has to read `WWW-Authenticate` to discover where our metadata lives,
 * which is impossible unless the header is exposed.
 */

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, content-type, mcp-protocol-version, x-request-id",
  // Without this a browser client cannot read the challenge that tells it where
  // the protected-resource metadata is, which is the whole discovery mechanism.
  "Access-Control-Expose-Headers":
    "mcp-protocol-version, www-authenticate, x-request-id, retry-after",
  "Access-Control-Max-Age": "86400",
};

/** Merge the CORS headers into a header bag, without mutating the input. */
export function withCors(headers: Record<string, string> = {}): Record<string, string> {
  return { ...CORS_HEADERS, ...headers };
}
