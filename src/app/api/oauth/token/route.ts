/**
 * The token endpoint: authorization_code and refresh_token.
 *
 * CORS IS OPEN HERE and must stay so. A browser-based connector calls this
 * directly, and it is a public-client exchange carrying no cookie — the security
 * is PKCE, not the origin. See src/lib/api/cors.ts for the rule that replaced
 * the old no-CORS posture.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { oauthEnabled } from "@/lib/oauth/enabled";
import { oauthError } from "@/lib/oauth/errors";
import { withCors } from "@/lib/api/cors";
import { clientIp, logApiRequest, resolveRequestId } from "@/lib/api/log";
import { hashMatches } from "@/lib/api/keys";
import { verifyPkce } from "@/lib/oauth/tokens";
import {
  consumeAuthorizationCode,
  issueTokens,
  rotateRefreshToken,
  type IssuedTokens,
} from "@/lib/oauth/grants";
import { redirectUriMatches } from "@/lib/oauth/clients";
import type { ApiScope } from "@/lib/api/scopes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Both encodings, because clients differ and the spec only mandates one. */
async function readParams(request: NextRequest): Promise<Record<string, string>> {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    try {
      const body = (await request.json()) as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(body ?? {}).map(([k, v]) => [k, typeof v === "string" ? v : String(v)])
      );
    } catch {
      return {};
    }
  }
  const form = await request.formData().catch(() => null);
  if (!form) return {};
  const out: Record<string, string> = {};
  form.forEach((v, k) => {
    if (typeof v === "string") out[k] = v;
  });
  return out;
}

/**
 * The token response.
 *
 * ⚠️ EVERY FIELD HERE IS LOAD-BEARING. A response missing `token_type` is
 * rejected outright by strict clients. One missing `refresh_token` produces a
 * connector that works for exactly one hour and then dies silently — which is
 * the worst kind of report to receive, because nothing about it points at the
 * token endpoint. `scope` is SPACE-DELIMITED, not an array; a JSON array here is
 * a spec violation clients read as an empty grant.
 */
function tokenResponse(tokens: IssuedTokens): NextResponse {
  return NextResponse.json(
    {
      access_token: tokens.accessToken,
      token_type: "Bearer",
      expires_in: tokens.expiresInSeconds,
      refresh_token: tokens.refreshToken,
      scope: tokens.scopes.join(" "),
    },
    {
      // Required by RFC 6749 §5.1. A cached token response is a token handed to
      // whoever asks next.
      headers: withCors({ "Cache-Control": "no-store", Pragma: "no-cache" }),
    }
  );
}

export async function POST(request: NextRequest) {
  const requestId = resolveRequestId(request);
  const admin = createAdminClient();
  const log = (status: number, op: string, code: string | null, customerId?: string | null) =>
    logApiRequest({
      requestId,
      surface: "oauth",
      operation: op,
      statusCode: status,
      errorCode: code,
      customerId: customerId ?? null,
      ip: clientIp(request),
      userAgent: request.headers.get("user-agent"),
    });

  if (!(await oauthEnabled())) {
    await log(404, "token", "oauth_disabled");
    return new NextResponse(null, { status: 404, headers: withCors() });
  }

  const params = await readParams(request);
  const grantType = params.grant_type;

  if (grantType === "authorization_code") return exchangeCode(admin, params, log);
  if (grantType === "refresh_token") return refresh(admin, params, log);

  await log(400, "token", "unsupported_grant_type");
  return oauthError("unsupported_grant_type", "Only authorization_code and refresh_token are supported.");
}

type Log = (status: number, op: string, code: string | null, customerId?: string | null) => Promise<void>;
type Admin = ReturnType<typeof createAdminClient>;

/**
 * Authenticate the client itself.
 *
 * A public client (`none`) is identified by client_id alone — which is not a
 * secret and is not treated as one; PKCE is what actually binds the exchange.
 * A confidential client must present its secret.
 */
async function authenticateClient(
  admin: Admin,
  params: Record<string, string>
): Promise<{ ok: true; clientId: string } | { ok: false; response: NextResponse }> {
  const clientId = params.client_id;
  if (!clientId) {
    return { ok: false, response: oauthError("invalid_client", "client_id is required.", 401) };
  }

  const { data, error } = await admin
    .from("oauth_clients")
    .select("client_id, client_secret_hash, token_endpoint_auth_method, disabled_at")
    .eq("client_id", clientId)
    .maybeSingle();

  if (error) {
    console.error("[oauth] client lookup failed", error);
    return { ok: false, response: oauthError("server_error", "Could not verify that client.", 500) };
  }

  const client = data as {
    client_id: string;
    client_secret_hash: string | null;
    token_endpoint_auth_method: string;
    disabled_at: string | null;
  } | null;

  if (!client || client.disabled_at) {
    return { ok: false, response: oauthError("invalid_client", "Unknown client.", 401) };
  }

  if (client.token_endpoint_auth_method !== "none") {
    const secret = params.client_secret;
    if (!secret || !client.client_secret_hash || !hashMatches(secret, client.client_secret_hash)) {
      return { ok: false, response: oauthError("invalid_client", "Client authentication failed.", 401) };
    }
  }

  return { ok: true, clientId: client.client_id };
}

async function exchangeCode(
  admin: Admin,
  params: Record<string, string>,
  log: Log
): Promise<NextResponse> {
  const auth = await authenticateClient(admin, params);
  if (!auth.ok) {
    await log(401, "token:code", "invalid_client");
    return auth.response;
  }

  if (!params.code) {
    await log(400, "token:code", "invalid_request");
    return oauthError("invalid_request", "code is required.");
  }

  // CLAIM BY WRITE, and everything after this point is verification of a code
  // that has ALREADY been burned. That is correct: a code is single use, and a
  // failed verification must not leave it redeemable for a second attempt.
  const claimed = await consumeAuthorizationCode(admin, params.code);
  if (!claimed) {
    // Unknown, already used and expired are one answer, deliberately.
    // Distinguishing them is an oracle for which codes exist.
    await log(400, "token:code", "invalid_grant");
    return oauthError("invalid_grant", "That authorization code is not valid.");
  }

  if (claimed.client_id !== auth.clientId) {
    await log(400, "token:code", "invalid_grant", claimed.customer_id);
    return oauthError("invalid_grant", "That code was not issued to this client.");
  }

  // The redirect_uri must be the one the authorization was issued for. Without
  // this, a code intercepted by one client can be redeemed by another.
  if (!params.redirect_uri || !redirectUriMatches(claimed.redirect_uri, params.redirect_uri)) {
    await log(400, "token:code", "invalid_grant", claimed.customer_id);
    return oauthError("invalid_grant", "redirect_uri does not match the authorization.");
  }

  if (!verifyPkce(params.code_verifier, claimed.code_challenge)) {
    await log(400, "token:code", "invalid_grant", claimed.customer_id);
    return oauthError("invalid_grant", "The PKCE code_verifier is not valid.");
  }

  const { data: grantRow, error: grantError } = await admin
    .from("oauth_grants")
    .select("id")
    .eq("customer_id", claimed.customer_id)
    .eq("client_id", claimed.client_id)
    .is("revoked_at", null)
    .maybeSingle();

  if (grantError || !grantRow) {
    // The customer revoked the app between consenting and the exchange.
    await log(400, "token:code", "invalid_grant", claimed.customer_id);
    return oauthError("invalid_grant", "That authorization is no longer valid.");
  }

  const tokens = await issueTokens(
    admin,
    (grantRow as { id: string }).id,
    claimed.scopes as ApiScope[]
  );
  if (!tokens) {
    await log(500, "token:code", "internal_error", claimed.customer_id);
    return oauthError("server_error", "Could not issue tokens.", 500);
  }

  await log(200, "token:code", null, claimed.customer_id);
  return tokenResponse(tokens);
}

async function refresh(
  admin: Admin,
  params: Record<string, string>,
  log: Log
): Promise<NextResponse> {
  const auth = await authenticateClient(admin, params);
  if (!auth.ok) {
    await log(401, "token:refresh", "invalid_client");
    return auth.response;
  }

  if (!params.refresh_token) {
    await log(400, "token:refresh", "invalid_request");
    return oauthError("invalid_request", "refresh_token is required.");
  }

  const outcome = await rotateRefreshToken(admin, params.refresh_token, auth.clientId);

  if (outcome.status === "ok") {
    await log(200, "token:refresh", null);
    return tokenResponse(outcome.tokens);
  }
  if (outcome.status === "reuse_detected") {
    // Outside the race window, so this is a replay. The grant is already gone.
    await log(400, "token:refresh", "reuse_detected");
    return oauthError("invalid_grant", "That refresh token has already been used. Please reconnect.");
  }
  if (outcome.status === "error") {
    await log(500, "token:refresh", "internal_error");
    return oauthError("server_error", "Could not refresh those tokens.", 500);
  }

  await log(400, "token:refresh", "invalid_grant");
  return oauthError("invalid_grant", "That refresh token is not valid.");
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: withCors() });
}
