/**
 * OAuth credentials: authorization codes, access tokens, refresh tokens, and
 * the PKCE check.
 *
 * OPAQUE TOKENS AND A DATABASE LOOKUP, not JWTs. This repository has no `jose`
 * or `jsonwebtoken` dependency and adding one buys nothing here: a JWT's appeal
 * is stateless verification, and we look the credential up anyway to check it
 * has not been revoked. 0095's argument for sha256 over a slow KDF applies
 * unchanged — the secret is CSPRNG output with no dictionary behind it, and the
 * lookup runs on every request.
 *
 * The generator, the hash and the constant-time comparison are all IMPORTED from
 * src/lib/api/keys.ts rather than reimplemented. Two alphabets or two sampling
 * routines is two places for them to drift, and the drift would be silent.
 */
import { randomBytes, createHash, timingSafeEqual } from "crypto";
import { base62, hashApiKey, hashMatches } from "@/lib/api/keys";

/**
 * ⚠️ NONE OF THESE MAY COLLIDE WITH `sfl_live_`, and none may be a prefix of
 * another. `resolveCaller` discriminates an OAuth token from an API key on the
 * prefix alone, so an overlap would route a credential to the wrong verifier —
 * which fails closed, but fails with a message describing the wrong kind of
 * credential entirely.
 */
export const OAUTH_CODE_PREFIX = "sfl_ac_";
export const OAUTH_ACCESS_PREFIX = "sfl_at_";
export const OAUTH_REFRESH_PREFIX = "sfl_rt_";

const PREFIX_CHARS = 8;
const SECRET_CHARS = 40;

/**
 * Five minutes. A code is exchanged within seconds of being issued in every
 * real flow; the window only has to cover a slow browser redirect and a cold
 * serverless start. RFC 6749 permits up to ten minutes and recommends less.
 */
export const CODE_TTL_MS = 5 * 60 * 1000;

/** One hour. Short because a refresh token backs it and rotation is cheap. */
export const ACCESS_TTL_MS = 60 * 60 * 1000;

/** Sixty days, and rotated on every use, so an unused one dies of old age. */
export const REFRESH_TTL_MS = 60 * 24 * 60 * 60 * 1000;

/**
 * ⚠️ THE REFRESH RACE GRACE WINDOW, and the reason it is not zero.
 *
 * A refresh token is rotated on every use, and a rotated token presented again
 * is the textbook signal of a stolen credential — the correct response to which
 * is to revoke the entire grant.
 *
 * That rule breaks a working MCP client. An assistant issues tool calls in
 * PARALLEL, so two in-flight requests routinely find the access token expired at
 * the same instant and both refresh. One wins; the other presents a token that
 * was rotated microseconds ago and is, on the strict rule, a thief. The
 * connection then dies at random under exactly the load the feature exists to
 * serve — and reconnecting fixes it often enough to read as a flaky network
 * rather than a bug.
 *
 * So a token rotated within this window is treated as the loser of a race and
 * handed the same successor pair. Outside it, the strict rule stands. Sixty
 * seconds is far longer than any race and far shorter than a useful replay
 * window for an attacker who must also hold the client id.
 */
export const REFRESH_REUSE_GRACE_MS = 60 * 1000;

export interface MintedToken {
  /** Shown once, in one HTTP response, and never recoverable. */
  raw: string;
  /** Stored lookup handle. Authenticates nothing. */
  prefix: string;
  /** sha256 hex of the whole token. The only thing that authenticates. */
  hash: string;
}

/** Mint a credential with the given prefix, in the shape API keys already use. */
export function mintToken(kindPrefix: string): MintedToken {
  const prefix = kindPrefix + base62(PREFIX_CHARS);
  const raw = prefix + base62(SECRET_CHARS);
  return { raw, prefix, hash: hashApiKey(raw) };
}

export const mintAuthorizationCode = () => mintToken(OAUTH_CODE_PREFIX);
export const mintAccessToken = () => mintToken(OAUTH_ACCESS_PREFIX);
export const mintRefreshToken = () => mintToken(OAUTH_REFRESH_PREFIX);

/** sha256 hex, for looking a presented credential up. */
export const hashToken = hashApiKey;

/** Constant-time comparison of a presented token against its stored digest. */
export const tokenMatches = hashMatches;

/** Is this string shaped like one of ours, with the given prefix? */
export function isOauthToken(raw: string, kindPrefix: string): boolean {
  return (
    typeof raw === "string" &&
    raw.length === kindPrefix.length + PREFIX_CHARS + SECRET_CHARS &&
    raw.startsWith(kindPrefix) &&
    /^[0-9A-Za-z]+$/.test(raw.slice(kindPrefix.length))
  );
}

/** The stored lookup handle for a raw token, or null if it is malformed. */
export function tokenPrefixOf(raw: string, kindPrefix: string): string | null {
  if (!isOauthToken(raw, kindPrefix)) return null;
  return raw.slice(0, kindPrefix.length + PREFIX_CHARS);
}

/* ------------------------------------------------------------------ *
 * PKCE
 * ------------------------------------------------------------------ */

/**
 * RFC 7636 §4.1: the verifier is 43–128 characters of the unreserved set.
 *
 * The bounds are enforced rather than assumed. A short verifier is guessable,
 * and this is the ONLY thing standing between an intercepted authorization code
 * and a working token for a public client, which is every MCP client.
 */
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

export function isValidCodeVerifier(verifier: unknown): verifier is string {
  return typeof verifier === "string" && VERIFIER_RE.test(verifier);
}

/** BASE64URL(SHA256(verifier)) — the S256 transform, and the only one we allow. */
export function s256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * Does this verifier produce the challenge the authorization was issued for?
 *
 * Constant time, because the challenge is stored and the comparison is against
 * attacker-supplied input. A malformed verifier is rejected before hashing so a
 * caller cannot use the length check as an oracle for anything else.
 */
export function verifyPkce(verifier: unknown, challenge: string): boolean {
  if (!isValidCodeVerifier(verifier)) return false;
  if (typeof challenge !== "string" || challenge.length === 0) return false;
  const computed = Buffer.from(s256Challenge(verifier), "utf8");
  const stored = Buffer.from(challenge, "utf8");
  if (computed.length !== stored.length) return false;
  return timingSafeEqual(computed, stored);
}

/** A random opaque value for the CSRF double-submit nonce on the consent form. */
export function mintNonce(): string {
  return randomBytes(24).toString("base64url");
}
