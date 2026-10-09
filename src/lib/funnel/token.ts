import { createHash, createHmac, timingSafeEqual } from "node:crypto";
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

/* ------------------------------------------------------------------ *
 * The "Send to my partner" link (02 Phase 3)
 * ------------------------------------------------------------------ */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * ⚠️ A SECOND, READ-ONLY TOKEN, NEVER THE FUNNEL TOKEN. The funnel token can
 * save answers, spend previews and (Phase 4) start a checkout, so a link
 * forwarded to a business partner must not carry it. The summary token opens
 * the summary page and nothing else.
 *
 * Shape `<session id>.<HMAC of "funnel-summary:<session id>">`, so no column is
 * needed to look it up: the id says which session, the HMAC proves we issued
 * it. Domain-separated from `funnel:`, so neither token can be turned into the
 * other, and the funnel route refuses this shape outright (it is not 43
 * characters of base64url).
 */
export function deriveFunnelSummaryToken(sessionId: string, secret: string | null | undefined): string | null {
  if (!secret || !UUID.test(sessionId)) return null;
  const mac = createHmac("sha256", secret).update(`funnel-summary:${sessionId}`).digest("base64url");
  return `${sessionId}.${mac}`;
}

/** The session id a summary token opens, or null. Compared in constant time. */
export function verifyFunnelSummaryToken(raw: string, secret: string | null | undefined): string | null {
  if (!secret || typeof raw !== "string") return null;
  const dot = raw.indexOf(".");
  if (dot < 0) return null;
  const id = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  if (!UUID.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(mac)) return null;
  const expected = deriveFunnelSummaryToken(id, secret);
  if (!expected) return null;
  const a = Buffer.from(raw);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? id : null;
}

/** The partner page's path: the doc's `/start/[token]/summary`, with the summary token. */
export function funnelSummaryPath(summaryToken: string): string {
  return `/start/${summaryToken}/summary`;
}
