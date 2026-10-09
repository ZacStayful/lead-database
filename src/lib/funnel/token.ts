import { createHash, createHmac } from "node:crypto";
import { APP_URL } from "@/lib/env";

/**
 * The funnel link token (batch 02, decision C6).
 *
 * ⚠️ DERIVED, NEVER STORED. The token is an HMAC of the session id under
 * MESSAGING_TOKEN_SECRET, domain-separated as `funnel:` (the
 * landlordReferralToken.ts rule for sharing that secret). Only its SHA-256 is
 * stored, in funnel_sessions.token_hash (0165). Deriving it is what lets n8n
 * ask twice for the same enquirer and get the same URL back without the raw
 * token sitting in the database: the batch-review link does the same (§73.4).
 *
 * No expiry goes into the HMAC. A funnel link stays good for as long as the
 * session is open; a paid session sends the visitor to log in instead.
 *
 * Null when no secret is configured. Both routes then refuse, which fails
 * closed: no funnel link can be minted or opened without the secret.
 */
export function deriveFunnelToken(sessionId: string, secret: string | null | undefined): string | null {
  if (!secret || !sessionId) return null;
  return createHmac("sha256", secret).update(`funnel:${sessionId}`).digest("base64url");
}

/** SHA-256 hex of the raw token. The only form of it that is ever stored. */
export function hashFunnelToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function funnelTokenSecret(): string | null {
  return process.env.MESSAGING_TOKEN_SECRET || null;
}

/** An HMAC-SHA256 as base64url is 43 characters. Anything else is not ours. */
export function looksLikeFunnelToken(raw: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(raw);
}

/** The link n8n sends the enquirer. */
export function funnelUrl(token: string): string {
  return `${APP_URL}/start/${token}`;
}

/** Where somebody who already holds Management is sent instead (02 Phase 2). */
export const ALREADY_SET_UP_LOGIN_PATH = "/login?notice=already_set_up";

export function alreadySetUpLoginUrl(): string {
  return `${APP_URL}${ALREADY_SET_UP_LOGIN_PATH}`;
}
