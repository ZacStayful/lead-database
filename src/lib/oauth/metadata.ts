/**
 * The two OAuth discovery documents, and the three URLs everything else derives
 * from.
 *
 * WHY THIS EXISTS AT ALL. /api/mcp answers an unauthenticated request with 401
 * and a `WWW-Authenticate: Bearer` challenge. A client reads that, works out
 * that it needs to authenticate, and then goes looking for these two documents
 * to find out HOW. Measured against production before this was written, all four
 * paths it probes returned 404 — so it correctly detected that authentication
 * was required and then had nowhere to go. That is the whole bug.
 *
 * PURE BUILDERS, so the exact bytes are unit-testable. A discovery document is a
 * contract read by software we do not control and cannot debug, so "it looks
 * right" is not a standard that survives contact with a strict client.
 */
import { APP_URL } from "@/lib/env";
import { API_SCOPES } from "@/lib/api/scopes";

/**
 * ⚠️ THE TRAILING SLASH IS NORMALISED ONCE, HERE, AND NOWHERE ELSE.
 *
 * If NEXT_PUBLIC_APP_URL is ever set with one, `${APP_URL}/api/mcp` becomes
 * `…co.uk//api/mcp`. Then the `resource` we publish stops matching the
 * `resource` a client sends, the issuer stops matching the URL the client
 * derived the document from, and the callback URL is wrong — three failures at
 * once, none of which names a trailing slash. Anything comparing an incoming
 * URL against these must normalise it the same way; `sameResource()` below is
 * that comparison and is the only one anybody should need.
 */
const BASE = APP_URL.replace(/\/+$/, "");

/** The authorization server's identity. Has no path component — see below. */
export const OAUTH_ISSUER = BASE;

/** The protected resource these tokens are for: the MCP endpoint itself. */
export const MCP_RESOURCE = `${BASE}/api/mcp`;

/**
 * Where the 401 challenge points. RFC 9728 lets a client derive this either
 * from the bare well-known path or with the resource's path inserted, and Claude
 * probes both, so both are served — but the challenge names this one explicitly
 * so no derivation is needed.
 */
export const RESOURCE_METADATA_URL = `${BASE}/.well-known/oauth-protected-resource/api/mcp`;

export const AUTHORIZE_URL = `${BASE}/oauth/authorize`;
export const TOKEN_URL = `${BASE}/api/oauth/token`;
export const REGISTER_URL = `${BASE}/api/oauth/register`;
export const REVOKE_URL = `${BASE}/api/oauth/revoke`;
export const DOCS_URL = `${BASE}/dashboard/api`;

/**
 * Is this the resource we serve? RFC 8707 resource indicators are compared as
 * URIs, and a trailing slash is the difference that would otherwise reject a
 * perfectly good request from a client that normalises differently to us.
 */
export function sameResource(candidate: string | null | undefined): boolean {
  if (!candidate) return false;
  return candidate.replace(/\/+$/, "") === MCP_RESOURCE.replace(/\/+$/, "");
}

/** RFC 9728 protected resource metadata. */
export function protectedResourceMetadata(): Record<string, unknown> {
  return {
    resource: MCP_RESOURCE,
    authorization_servers: [OAUTH_ISSUER],
    scopes_supported: [...API_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Stayful Lead Marketplace",
    resource_documentation: DOCS_URL,
  };
}

/**
 * RFC 8414 authorization server metadata.
 *
 * ⚠️ SERVED AT THE BARE WELL-KNOWN PATH ONLY. Our issuer has no path component,
 * so RFC 8414's path-insertion form does not apply to us. Answering at
 * `/.well-known/oauth-authorization-server/api/mcp` as well would hand a strict
 * client an `issuer` that does not match the URL it derived the document from —
 * and that fails AFTER the client has committed to us, which is worse than the
 * 404 it would otherwise have got and moved on from.
 *
 * `code_challenge_methods_supported` is S256 and nothing else. OAuth 2.1 removes
 * `plain`, and advertising it is how a client comes to pick it.
 */
export function authorizationServerMetadata(): Record<string, unknown> {
  return {
    issuer: OAUTH_ISSUER,
    authorization_endpoint: AUTHORIZE_URL,
    token_endpoint: TOKEN_URL,
    registration_endpoint: REGISTER_URL,
    revocation_endpoint: REVOKE_URL,
    scopes_supported: [...API_SCOPES],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    service_documentation: DOCS_URL,
  };
}
