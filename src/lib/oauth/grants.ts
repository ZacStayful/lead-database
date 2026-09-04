/**
 * Grants, codes and tokens: the database side of the authorization server.
 *
 * Everything here runs on the SERVICE ROLE. All four oauth_* tables have RLS on
 * with no policies, following customer_api_keys (0095) and subscription_pauses
 * (0084) — deny-all to the browser, with every read and write going through a
 * server route.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import type { ApiScope } from "@/lib/api/scopes";
import {
  ACCESS_TTL_MS,
  CODE_TTL_MS,
  OAUTH_REFRESH_PREFIX,
  REFRESH_REUSE_GRACE_MS,
  REFRESH_TTL_MS,
  hashToken,
  mintAccessToken,
  mintAuthorizationCode,
  mintRefreshToken,
  tokenMatches,
  tokenPrefixOf,
} from "@/lib/oauth/tokens";

type Admin = ReturnType<typeof createAdminClient>;

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  scopes: ApiScope[];
}

/* ------------------------------------------------------------------ *
 * Grants
 * ------------------------------------------------------------------ */

/**
 * The open grant for this (customer, client), created if there is none.
 *
 * ⚠️ UPSERT, NOT INSERT. oauth_grants carries a partial unique index on
 * (customer_id, client_id) where revoked_at is null, and RE-CONSENTING TO A
 * CLIENT YOU HAVE ALREADY CONNECTED IS THE ORDINARY CASE — every reconnect does
 * it. A plain insert fails there with a constraint error, after the consent
 * screen, at the very last step of a flow the customer has already completed.
 *
 * Scopes are WIDENED rather than replaced. A customer who granted both scopes
 * and later reconnects a client asking for one should not silently lose the
 * other on a grant they can see in Settings; and narrowing is what revoking is
 * for.
 */
export async function upsertGrant(
  admin: Admin,
  customerId: string,
  clientId: string,
  scopes: ApiScope[]
): Promise<{ id: string } | null> {
  const { data: existing, error: readError } = await admin
    .from("oauth_grants")
    .select("id, scopes")
    .eq("customer_id", customerId)
    .eq("client_id", clientId)
    .is("revoked_at", null)
    .maybeSingle();

  if (readError) {
    console.error("[oauth] grant lookup failed", readError);
    return null;
  }

  if (existing) {
    const row = existing as { id: string; scopes: string[] };
    const widened = Array.from(new Set([...(row.scopes ?? []), ...scopes]));
    const { error } = await admin
      .from("oauth_grants")
      .update({ scopes: widened })
      .eq("id", row.id);
    if (error) {
      console.error("[oauth] grant widen failed", error);
      return null;
    }
    return { id: row.id };
  }

  const { data, error } = await admin
    .from("oauth_grants")
    .insert({ customer_id: customerId, client_id: clientId, scopes })
    .select("id")
    .single();

  if (error) {
    console.error("[oauth] grant insert failed", error);
    return null;
  }
  return data as { id: string };
}

/**
 * Revoke a grant and everything under it, in that order.
 *
 * The grant first: it is what `resolveOauthToken` checks, so stamping it is what
 * actually stops requests. The tokens are stamped afterwards for the record, and
 * a failure there leaves the connection already dead rather than half alive.
 */
export async function revokeGrant(admin: Admin, grantId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const { error } = await admin
    .from("oauth_grants")
    .update({ revoked_at: now })
    .eq("id", grantId)
    .is("revoked_at", null);

  if (error) {
    console.error("[oauth] grant revoke failed", error);
    return false;
  }

  const { error: tokenError } = await admin
    .from("oauth_tokens")
    .update({ revoked_at: now })
    .eq("grant_id", grantId)
    .is("revoked_at", null);

  if (tokenError) console.error("[oauth] token revoke failed", tokenError);
  return true;
}

/* ------------------------------------------------------------------ *
 * Authorization codes
 * ------------------------------------------------------------------ */

export interface CodeRequest {
  clientId: string;
  customerId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: ApiScope[];
  resource: string | null;
}

/** Mint a code, store only its hash, and hand back the raw value once. */
export async function issueAuthorizationCode(
  admin: Admin,
  req: CodeRequest
): Promise<string | null> {
  const code = mintAuthorizationCode();
  const { error } = await admin.from("oauth_authorization_codes").insert({
    code_hash: code.hash,
    client_id: req.clientId,
    customer_id: req.customerId,
    redirect_uri: req.redirectUri,
    code_challenge: req.codeChallenge,
    scopes: req.scopes,
    resource: req.resource,
    expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
  });

  if (error) {
    console.error("[oauth] code insert failed", error);
    return null;
  }
  return code.raw;
}

export interface ConsumedCode {
  id: string;
  client_id: string;
  customer_id: string;
  redirect_uri: string;
  code_challenge: string;
  scopes: string[];
  resource: string | null;
}

/**
 * Redeem a code, exactly once.
 *
 * Delegates to `consume_oauth_authorization_code`, whose UPDATE … WHERE is the
 * check: it matches only an unused, unexpired row and stamps used_at in the same
 * statement. Reading the row here and marking it used afterwards would leave a
 * window two concurrent redemptions both pass through — the same claim-by-write
 * discipline credit_invoice() uses against Stripe redelivery.
 *
 * ⚠️ §27.4 applies with full force: this is an RPC called for its SIDE EFFECT,
 * which is exactly the shape Next's fetch cache broke silently once before.
 * createAdminClient()'s `cache: "no-store"` is what stops it, and must not be
 * removed.
 */
export async function consumeAuthorizationCode(
  admin: Admin,
  rawCode: string
): Promise<ConsumedCode | null> {
  const { data, error } = await admin.rpc("consume_oauth_authorization_code", {
    p_code_hash: hashToken(rawCode),
  });

  if (error) {
    console.error("[oauth] code consume failed", error);
    return null;
  }
  return (data as ConsumedCode | null) ?? null;
}

/* ------------------------------------------------------------------ *
 * Access and refresh tokens
 * ------------------------------------------------------------------ */

/** Issue a fresh access/refresh pair against a grant. */
export async function issueTokens(
  admin: Admin,
  grantId: string,
  scopes: ApiScope[]
): Promise<IssuedTokens | null> {
  const access = mintAccessToken();
  const refresh = mintRefreshToken();
  const now = Date.now();

  const { error } = await admin.from("oauth_tokens").insert([
    {
      grant_id: grantId,
      kind: "access",
      token_prefix: access.prefix,
      token_hash: access.hash,
      scopes,
      expires_at: new Date(now + ACCESS_TTL_MS).toISOString(),
    },
    {
      grant_id: grantId,
      kind: "refresh",
      token_prefix: refresh.prefix,
      token_hash: refresh.hash,
      scopes,
      expires_at: new Date(now + REFRESH_TTL_MS).toISOString(),
    },
  ]);

  if (error) {
    console.error("[oauth] token insert failed", error);
    return null;
  }

  return {
    accessToken: access.raw,
    refreshToken: refresh.raw,
    expiresInSeconds: Math.floor(ACCESS_TTL_MS / 1000),
    scopes,
  };
}

/**
 * What a presented refresh token that has ALREADY been rotated means.
 *
 * Extracted as a pure function so both sides of the boundary can be tested
 * without a database — this is the single most consequential decision in the
 * OAuth flow, and the failure it guards against (a connector that disconnects at
 * random under parallel load) is close to undiagnosable in production.
 */
export type ReuseVerdict = "race" | "replay";

export function classifyRotatedToken(
  rotatedAt: string | null,
  rotatedTo: string | null,
  now: number = Date.now()
): ReuseVerdict {
  // No successor recorded means we cannot hand anything back even if this were
  // a race, so it is treated as a replay — the safe direction.
  if (!rotatedTo || !rotatedAt) return "replay";
  const at = new Date(rotatedAt).getTime();
  if (Number.isNaN(at)) return "replay";
  // A clock that says the rotation is in the future is not evidence of a race.
  if (at > now) return "replay";
  return now - at <= REFRESH_REUSE_GRACE_MS ? "race" : "replay";
}

export type RefreshOutcome =
  | { status: "ok"; tokens: IssuedTokens; grantId: string }
  /** A genuine replay: the grant has been revoked and everything under it. */
  | { status: "reuse_detected" }
  | { status: "invalid" }
  | { status: "error" };

interface RefreshRow {
  id: string;
  grant_id: string;
  token_hash: string;
  scopes: string[];
  expires_at: string;
  revoked_at: string | null;
  rotated_at: string | null;
  rotated_to: string | null;
  oauth_grants: { id: string; client_id: string; revoked_at: string | null } | null;
}

/**
 * Exchange a refresh token for a new pair, rotating the old one.
 *
 * ⚠️ THE GRACE WINDOW IS THE POINT OF THIS FUNCTION, and omitting it is the
 * single most likely way to ship a connector that "keeps disconnecting".
 *
 * An MCP client issues tool calls in PARALLEL. Two in-flight requests routinely
 * find the access token expired at the same instant and both refresh. One wins
 * and rotates; the other then presents a token that was rotated microseconds ago
 * and, on the textbook rule, is a stolen credential — so the grant is revoked and
 * a working connection dies, under exactly the load the feature exists to serve.
 * Worse, reconnecting fixes it, so it reads as a flaky network rather than a bug.
 *
 * So a token rotated INSIDE the window is the loser of a race: it is handed the
 * same successor pair the winner got. Outside the window the strict rule stands
 * and the whole chain goes.
 *
 * The rotation itself is a claim-by-write — `update … where revoked_at is null`
 * — so two racers cannot both rotate the same row.
 */
export async function rotateRefreshToken(
  admin: Admin,
  rawToken: string,
  clientId: string
): Promise<RefreshOutcome> {
  const prefix = tokenPrefixOf(rawToken, OAUTH_REFRESH_PREFIX);
  if (!prefix) return { status: "invalid" };

  const { data, error } = await admin
    .from("oauth_tokens")
    .select(
      "id, grant_id, token_hash, scopes, expires_at, revoked_at, rotated_at, rotated_to, oauth_grants!inner(id, client_id, revoked_at)"
    )
    .eq("token_prefix", prefix)
    .eq("kind", "refresh")
    .maybeSingle();

  if (error) {
    console.error("[oauth] refresh lookup failed", error);
    return { status: "error" };
  }

  const row = data as unknown as RefreshRow | null;
  if (!row || !tokenMatches(rawToken, row.token_hash)) return { status: "invalid" };

  const grant = row.oauth_grants;
  // The client that presents a refresh token must be the one it was issued to.
  if (!grant || grant.revoked_at || grant.client_id !== clientId) {
    return { status: "invalid" };
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) return { status: "invalid" };

  if (row.revoked_at) {
    const verdict = classifyRotatedToken(row.rotated_at, row.rotated_to);

    if (verdict === "race" && row.rotated_to) {
      // The loser of a refresh race. Hand back the pair the winner was given
      // rather than treating a millisecond of concurrency as an attack.
      const replay = await tokensForRotation(admin, row.rotated_to, row.grant_id, row.scopes);
      if (replay) return { status: "ok", tokens: replay, grantId: row.grant_id };
      // The successor is gone, so there is nothing safe to hand back.
      return { status: "invalid" };
    }

    // A genuine replay, outside any plausible race.
    await revokeGrant(admin, row.grant_id);
    return { status: "reuse_detected" };
  }

  const scopes = (row.scopes ?? []) as ApiScope[];
  const issued = await issueTokens(admin, row.grant_id, scopes);
  if (!issued) return { status: "error" };

  const successorPrefix = tokenPrefixOf(issued.refreshToken, OAUTH_REFRESH_PREFIX);
  const { data: successor } = await admin
    .from("oauth_tokens")
    .select("id")
    .eq("token_prefix", successorPrefix)
    .maybeSingle();

  const now = new Date().toISOString();
  const { error: rotateError, count } = await admin
    .from("oauth_tokens")
    .update(
      {
        revoked_at: now,
        rotated_at: now,
        rotated_to: (successor as { id: string } | null)?.id ?? null,
      },
      { count: "exact" }
    )
    .eq("id", row.id)
    .is("revoked_at", null);

  if (rotateError) {
    console.error("[oauth] refresh rotate failed", rotateError);
    return { status: "error" };
  }

  // Zero rows means another request rotated it between our read and our write.
  // That request has already issued a pair; ours is surplus, so it is revoked
  // rather than left live, and the caller retries into the grace path above.
  if (count === 0) {
    await admin
      .from("oauth_tokens")
      .update({ revoked_at: now })
      .eq("grant_id", row.grant_id)
      .gte("created_at", new Date(Date.now() - 5000).toISOString())
      .is("revoked_at", null);
    return { status: "invalid" };
  }

  await admin
    .from("oauth_grants")
    .update({ last_used_at: now })
    .eq("id", row.grant_id);

  return { status: "ok", tokens: issued, grantId: row.grant_id };
}

/**
 * The pair a rotation produced, for replaying to the loser of a race.
 *
 * ⚠️ IT CANNOT RETURN THE RAW TOKENS — only their hashes were stored, which is
 * the whole point of storing them that way. So the loser is given a NEW pair
 * against the same grant instead: functionally identical from the client's side,
 * and it costs one extra row rather than a plaintext token in the database.
 */
async function tokensForRotation(
  admin: Admin,
  successorId: string,
  grantId: string,
  scopes: string[]
): Promise<IssuedTokens | null> {
  const { data } = await admin
    .from("oauth_tokens")
    .select("id, revoked_at")
    .eq("id", successorId)
    .maybeSingle();

  const successor = data as { id: string; revoked_at: string | null } | null;
  if (!successor || successor.revoked_at) return null;

  return issueTokens(admin, grantId, scopes as ApiScope[]);
}
