/**
 * Who is calling /api/v1 or /api/mcp, and may they.
 *
 * ONE RESOLVER, TWO CREDENTIALS. The dashboard authenticates from a cookie
 * session; an integration authenticates with a bearer API key. Both arrive here
 * and both leave as the same `Caller`, which is what lets the service layer take
 * a customer id and know nothing about how it was proved.
 *
 * That shape is also what makes the OAuth work in the next phase additive
 * rather than a rewrite: an access token becomes a third branch producing the
 * same `Caller` against the same scopes, and nothing downstream changes.
 */
import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentCustomer } from "@/lib/auth";
import { keysMatch, parseKeyPrefix } from "@/lib/api/keys";
import {
  OAUTH_ACCESS_PREFIX,
  tokenMatches,
  tokenPrefixOf,
} from "@/lib/oauth/tokens";
import { ALL_SCOPES, type ApiScope } from "@/lib/api/scopes";
import { fail, type ApiFailure } from "@/lib/api/errors";
import {
  KILL_SWITCH_CACHE_MS,
  LAST_USED_COALESCE_MINUTES,
  RATE_LIMIT_DAY_SECONDS,
  RATE_LIMIT_PER_DAY,
  RATE_LIMIT_PER_MINUTE,
  RATE_LIMIT_WINDOW_SECONDS,
} from "@/lib/api/limits";
import type { Customer } from "@/lib/types";

type Admin = ReturnType<typeof createAdminClient>;

export type CallerVia = "session" | "api_key" | "oauth";

export interface Caller {
  customerId: string;
  customer: Customer;
  via: CallerVia;
  scopes: readonly ApiScope[];
  /** Null for a session caller — there is no key to attribute usage to. */
  keyId: string | null;
  /**
   * Set for an OAuth caller. A SEPARATE FIELD rather than a reuse of keyId,
   * because api_request_log.key_id carries an FK to customer_api_keys and an
   * OAuth token id would violate it.
   */
  tokenId: string | null;
  /** The grant an OAuth token hangs off, for attributing and revoking usage. */
  grantId: string | null;
  /** Requests used in the current minute window, for the rate-limit headers. */
  minuteCount: number;
}

export interface ResolveOptions {
  /** Which credentials this surface accepts. MCP passes ["api_key","oauth"]. */
  allow?: readonly CallerVia[];
  /** Injected for tests; defaults to the service-role client. */
  admin?: Admin;
}

export type ResolveResult = { ok: true; caller: Caller } | ApiFailure;

/* ------------------------------------------------------------------ *
 * Kill switch
 * ------------------------------------------------------------------ */

let killSwitchCache: { enabled: boolean; readAt: number } | null = null;

/** Exported for tests, which must not inherit a cached value between cases. */
export function resetKillSwitchCache(): void {
  killSwitchCache = null;
}

async function apiEnabled(admin: Admin): Promise<boolean> {
  const now = Date.now();
  if (killSwitchCache && now - killSwitchCache.readAt < KILL_SWITCH_CACHE_MS) {
    return killSwitchCache.enabled;
  }

  const { data, error } = await admin
    .from("system_settings")
    .select("value")
    .eq("key", "api_enabled")
    .maybeSingle();

  // FAIL OPEN on a read error, and only on a read error. An unreachable
  // settings table would otherwise take the whole API down for a reason
  // unrelated to the API — whereas a row that genuinely says "false" is an
  // instruction we must obey. The `?? "true"` matches the sweep's reading of
  // pool_enabled: an unseeded key means enabled.
  if (error) {
    console.error("[api] api_enabled read failed, treating as enabled", error);
    return true;
  }

  const enabled = ((data as { value?: string } | null)?.value ?? "true").trim() === "true";
  killSwitchCache = { enabled, readAt: now };
  return enabled;
}

/* ------------------------------------------------------------------ *
 * Resolution
 * ------------------------------------------------------------------ */

interface KeyRow {
  id: string;
  customer_id: string;
  key_hash: string;
  scopes: string[];
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  customers: Customer | null;
}

export async function resolveCaller(
  request: NextRequest,
  options: ResolveOptions = {}
): Promise<ResolveResult> {
  const admin = options.admin ?? createAdminClient();
  const allow = options.allow ?? (["session", "api_key", "oauth"] as const);

  if (!(await apiEnabled(admin))) {
    return fail(
      "service_unavailable",
      "The API is temporarily unavailable. Please try again shortly."
    );
  }

  const authHeader = request.headers.get("authorization");

  // ANY Authorization header at all takes the key path, and failing it is
  // TERMINAL — it must never fall through to the cookie session.
  //
  // Not just `Bearer sfl_`: a Basic header, a stray JWT or a truncated paste is
  // still somebody explicitly presenting a credential. Preferring an ambient
  // cookie over an explicit credential would show a customer testing a key
  // their own SESSION'S data, and make a revoked key look like it still works —
  // which is the most dangerous possible false negative here.
  if (authHeader) {
    const bearer = parseBearer(authHeader);
    if (!bearer) {
      return fail("invalid_api_key", "Expected an `Authorization: Bearer` header.");
    }

    // Discriminated on the PREFIX, before either verifier runs. The two
    // credential kinds have distinct, non-overlapping prefixes precisely so
    // this decision needs no lookup and cannot be ambiguous — and so a caller
    // is told about the kind of credential they actually presented.
    if (bearer.startsWith(OAUTH_ACCESS_PREFIX)) {
      if (!allow.includes("oauth")) {
        return fail("unauthorized", "This endpoint does not accept OAuth tokens.");
      }
      return resolveOauthToken(admin, bearer);
    }

    if (!allow.includes("api_key")) {
      return fail("unauthorized", "This endpoint does not accept API keys.");
    }
    return resolveApiKey(admin, bearer);
  }

  if (!allow.includes("session")) {
    return fail("unauthorized", "An API key is required.");
  }
  return resolveSession();
}

async function resolveSession(): Promise<ResolveResult> {
  const { customer } = await getCurrentCustomer();
  if (!customer) {
    return fail("unauthorized", "Not signed in.");
  }
  if (!customer.is_active) {
    return fail("unauthorized", "This account is not active.");
  }

  // Session callers hold every scope: they are the owner, in a browser, holding
  // the owner's cookie. They are also NOT rate limited — there is no key to
  // count against, and our own dashboard is not the threat model.
  return {
    ok: true,
    caller: {
      customerId: customer.id,
      customer,
      via: "session",
      scopes: ALL_SCOPES,
      keyId: null,
      tokenId: null,
      grantId: null,
      minuteCount: 0,
    },
  };
}

/** The bearer value from an Authorization header, or null if it is not one. */
function parseBearer(authHeader: string): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return match ? match[1].trim() : null;
}

async function resolveApiKey(
  admin: Admin,
  raw: string
): Promise<ResolveResult> {
  const prefix = parseKeyPrefix(raw);
  if (!prefix) {
    return fail("invalid_api_key", "That does not look like a Stayful API key.");
  }

  // One query for the key AND its customer: the embedded select saves a round
  // trip on the hot path of every single request.
  const { data, error } = await admin
    .from("customer_api_keys")
    .select(
      "id, customer_id, key_hash, scopes, expires_at, revoked_at, last_used_at, customers(*)"
    )
    .eq("key_prefix", prefix)
    .maybeSingle();

  if (error) {
    console.error("[api] key lookup failed", error);
    return fail("internal_error", "Could not verify that API key.");
  }

  const row = data as unknown as KeyRow | null;
  if (!row) {
    return fail("invalid_api_key", "That API key is not valid.");
  }

  if (row.revoked_at) {
    return fail("revoked_api_key", "That API key has been revoked.");
  }

  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
    return fail("expired_api_key", "That API key has expired.");
  }

  // Hash comparison AFTER the cheap rejections, so a revoked key does not pay
  // for a digest — but before anything is loaded on the customer's behalf.
  if (!keysMatch(raw, row.key_hash)) {
    return fail("invalid_api_key", "That API key is not valid.");
  }

  const customer = row.customers;
  if (!customer) {
    // A key whose customer has vanished is an invalid key, not a 404: there is
    // no resource being asked for yet, only a credential that no longer means
    // anything.
    return fail("invalid_api_key", "That API key is not valid.");
  }

  // ARCHIVED IS NOT CANCELLED (§18D). `is_active = false` means the row was
  // superseded by a duplicate signup and should be out of circulation
  // entirely — both candidate functions already refuse it — so its keys stop.
  //
  // A CANCELLED customer is a different thing and is deliberately NOT blocked
  // here: they keep working keys. Nothing else in this system withdraws what a
  // customer has paid for (reject does not refund, §18E leaves unused credits
  // intact), and cutting their integration on the day they leave would also
  // remove their ability to export their own history.
  if (!customer.is_active) {
    return fail("invalid_api_key", "That API key is not valid.");
  }

  const scopes = (row.scopes ?? []).filter((s): s is ApiScope =>
    (ALL_SCOPES as readonly string[]).includes(s)
  );

  const limit = await consumeRateLimit(admin, row.id, row.customer_id);
  if (!limit.ok) return limit;

  await touchLastUsed(admin, row.id, row.last_used_at);

  return {
    ok: true,
    caller: {
      customerId: row.customer_id,
      customer,
      via: "api_key",
      scopes,
      keyId: row.id,
      tokenId: null,
      grantId: null,
      minuteCount: limit.minuteCount,
    },
  };
}

/* ------------------------------------------------------------------ *
 * OAuth access tokens
 * ------------------------------------------------------------------ */

interface OauthTokenRow {
  id: string;
  grant_id: string;
  token_hash: string;
  scopes: string[];
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  oauth_grants: {
    id: string;
    customer_id: string;
    revoked_at: string | null;
    customers: Customer | null;
  } | null;
}

/**
 * The third credential, producing the same `Caller` as the other two.
 *
 * The order of the checks mirrors resolveApiKey deliberately — cheap rejections
 * first, the digest comparison after them, and nothing loaded on the customer's
 * behalf until every one has passed.
 *
 * WHAT IS DIFFERENT is the grant. A token is only as live as the grant it hangs
 * off, so revoking a connected app in Settings stamps ONE row and every token
 * under it stops working on the next request. Checking only the token would
 * leave a revoked app working until its access token expired.
 */
async function resolveOauthToken(
  admin: Admin,
  raw: string
): Promise<ResolveResult> {
  const prefix = tokenPrefixOf(raw, OAUTH_ACCESS_PREFIX);
  if (!prefix) {
    return fail("invalid_token", "That access token is not valid.");
  }

  const { data, error } = await admin
    .from("oauth_tokens")
    .select(
      "id, grant_id, token_hash, scopes, expires_at, revoked_at, last_used_at, oauth_grants!inner(id, customer_id, revoked_at, customers(*))"
    )
    .eq("token_prefix", prefix)
    .eq("kind", "access")
    .maybeSingle();

  if (error) {
    console.error("[api] oauth token lookup failed", error);
    return fail("internal_error", "Could not verify that access token.");
  }

  const row = data as unknown as OauthTokenRow | null;
  if (!row) {
    return fail("invalid_token", "That access token is not valid.");
  }

  if (row.revoked_at) {
    return fail("revoked_token", "That access token has been revoked.");
  }

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    // Its own code, not invalid_token: a client that cannot tell expiry from a
    // bad token will re-run the whole authorization flow when a refresh was all
    // it needed — and will show the customer a consent screen to fix it.
    return fail("expired_token", "That access token has expired.");
  }

  if (!tokenMatches(raw, row.token_hash)) {
    return fail("invalid_token", "That access token is not valid.");
  }

  const grant = row.oauth_grants;
  if (!grant || grant.revoked_at) {
    // Revoking the app in Settings lands here. Reported as revoked rather than
    // invalid, because that is what happened and the client should stop
    // retrying and ask for consent again.
    return fail("revoked_token", "That connection has been disconnected.");
  }

  const customer = grant.customers;
  if (!customer) {
    return fail("invalid_token", "That access token is not valid.");
  }

  // 0095's rule, unchanged: ARCHIVED IS NOT CANCELLED. is_active = false means
  // the row was superseded by a duplicate signup and should be out of
  // circulation entirely. A CANCELLED customer keeps working credentials —
  // nothing else in this system withdraws what a customer has paid for.
  if (!customer.is_active) {
    return fail("invalid_token", "That access token is not valid.");
  }

  // Intersected with the vocabulary we know, exactly as a key's scopes are. A
  // scope granted before it was retired must not keep working by accident.
  const scopes = (row.scopes ?? []).filter((s): s is ApiScope =>
    (ALL_SCOPES as readonly string[]).includes(s)
  );

  const limit = await consumeRateLimit(admin, row.id, grant.customer_id, "oauth_token");
  if (!limit.ok) return limit;

  await touchOauthLastUsed(admin, row.id, grant.id, row.last_used_at);

  return {
    ok: true,
    caller: {
      customerId: grant.customer_id,
      customer,
      via: "oauth",
      scopes,
      keyId: null,
      tokenId: row.id,
      grantId: grant.id,
      minuteCount: limit.minuteCount,
    },
  };
}

/**
 * Stamp the token and its grant, at most once every five minutes.
 *
 * The grant's stamp is what the Connected apps panel shows as "last used", and
 * it is the only reason this writes two rows rather than one — a customer
 * deciding whether to revoke an app wants to know when it last did anything.
 */
async function touchOauthLastUsed(
  admin: Admin,
  tokenId: string,
  grantId: string,
  lastUsedAt: string | null
): Promise<void> {
  const staleAfter = Date.now() - LAST_USED_COALESCE_MINUTES * 60_000;
  if (lastUsedAt && new Date(lastUsedAt).getTime() > staleAfter) return;

  const now = new Date().toISOString();
  const cutoff = new Date(staleAfter).toISOString();

  const [tokenResult, grantResult] = await Promise.all([
    admin
      .from("oauth_tokens")
      .update({ last_used_at: now })
      .eq("id", tokenId)
      .or(`last_used_at.is.null,last_used_at.lt.${cutoff}`),
    admin
      .from("oauth_grants")
      .update({ last_used_at: now })
      .eq("id", grantId)
      .or(`last_used_at.is.null,last_used_at.lt.${cutoff}`),
  ]);

  // Swallowed, as the API key path swallows its own: losing a usage timestamp
  // must never cost a customer their data.
  if (tokenResult.error) console.error("[api] oauth token last_used_at failed", tokenResult.error);
  if (grantResult.error) console.error("[api] oauth grant last_used_at failed", grantResult.error);
}

/* ------------------------------------------------------------------ *
 * Rate limiting and usage
 * ------------------------------------------------------------------ */

async function consumeRateLimit(
  admin: Admin,
  subjectId: string,
  customerId: string,
  subjectKind: "key" | "oauth_token" = "key"
): Promise<{ ok: true; minuteCount: number } | ApiFailure> {
  // The five-argument signature. 0125 keeps the four-argument form as a shim so
  // this could be deployed either side of the migration, but naming the subject
  // kind explicitly is what keeps an OAuth token's window separate from a key's
  // — sharing one would let a customer's key and their connected app eat each
  // other's allowance.
  const { data, error } = await admin.rpc("consume_api_rate_limit", {
    p_subject_id: subjectId,
    p_customer_id: customerId,
    p_subject_kind: subjectKind,
    p_minute_seconds: RATE_LIMIT_WINDOW_SECONDS,
    p_day_seconds: RATE_LIMIT_DAY_SECONDS,
  });

  // FAIL CLOSED. Letting a request through because the limiter itself broke
  // turns the one defence against a runaway integration into a no-op at exactly
  // the moment it is under load, which is when it is needed.
  if (error) {
    console.error("[api] rate limit rpc failed", error);
    return fail("rate_limited", "Rate limiting is unavailable; try again shortly.");
  }

  const row = Array.isArray(data) ? data[0] : data;
  const minuteCount = Number((row as { minute_count?: number })?.minute_count ?? 0);
  const dayCount = Number((row as { day_count?: number })?.day_count ?? 0);

  if (minuteCount > RATE_LIMIT_PER_MINUTE) {
    return fail(
      "rate_limited",
      `Rate limit exceeded: at most ${RATE_LIMIT_PER_MINUTE} requests per minute per credential.`
    );
  }
  if (dayCount > RATE_LIMIT_PER_DAY) {
    return fail(
      "rate_limited",
      `Daily limit exceeded: at most ${RATE_LIMIT_PER_DAY} requests per day per account.`
    );
  }

  return { ok: true, minuteCount };
}

async function touchLastUsed(
  admin: Admin,
  keyId: string,
  lastUsedAt: string | null
): Promise<void> {
  // Decided from the row already in memory, so the common case costs no round
  // trip at all. The `where` clause below is kept as well, as the race guard
  // for two concurrent requests both deciding to write.
  const staleAfter = Date.now() - LAST_USED_COALESCE_MINUTES * 60_000;
  if (lastUsedAt && new Date(lastUsedAt).getTime() > staleAfter) return;

  const cutoff = new Date(staleAfter).toISOString();
  const { error } = await admin
    .from("customer_api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", keyId)
    .or(`last_used_at.is.null,last_used_at.lt.${cutoff}`);

  // Swallowed: losing a usage timestamp must never cost a customer their data.
  if (error) console.error("[api] last_used_at update failed", error);
}

/* ------------------------------------------------------------------ *
 * Scopes
 * ------------------------------------------------------------------ */

export function hasScope(caller: Caller, scope: ApiScope): boolean {
  return caller.scopes.includes(scope);
}
