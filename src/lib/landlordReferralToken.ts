/**
 * The token in a landlord's referral link (§41).
 *
 * An HMAC rather than a row in a tokens table (the lead_topup_tokens /
 * lead_analysis_tokens shape), for three reasons: it needs no write on the send
 * path, which is already doing two network calls under a concurrency limit; it
 * needs no cleanup; and revocation buys nothing here, because the token permits
 * writing three preference fields on one lead and reveals nothing we did not
 * already email that person.
 *
 * Shape follows messaging/threadAddress.ts — handle + truncated MAC +
 * timingSafeEqual — with an expiry folded in.
 *
 * ⚠️ THE HMAC INPUT IS DOMAIN-SEPARATED. MESSAGING_TOKEN_SECRET already signs
 * thread reply addresses; one secret serving two purposes without separation is
 * how a token minted for one becomes valid for the other. Same reasoning as
 * secretBox.ts binding its AAD to `<purpose>:<customer_id>`.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const PURPOSE = "landlord-prefs";
const MAC_LEN = 16; // hex chars
const SEP = "z"; // not a hex char, so the split is unambiguous
const TOKEN_RE = new RegExp(`^([0-9a-f]{32})${SEP}([0-9a-z]{1,10})${SEP}([0-9a-f]{${MAC_LEN}})$`);

/** 30 days. Long enough that a landlord who reads mail weekly still lands. */
export const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function secret(): string | null {
  return process.env.MESSAGING_TOKEN_SECRET || null;
}

export function referralTokensConfigured(): boolean {
  return secret() !== null;
}

function macFor(leadId: string, expiry: string, key: string): string {
  return createHmac("sha256", key)
    .update(`${PURPOSE}:${leadId}:${expiry}`)
    .digest("hex")
    .slice(0, MAC_LEN);
}

/** Bare hex of the lead uuid — the lookup half, not a secret. */
function handleFor(leadId: string): string {
  return leadId.replace(/-/g, "").toLowerCase();
}

/** Null when no secret is configured, so the caller sends no link at all. */
export function mintReferralToken(leadId: string, now = Date.now()): string | null {
  const key = secret();
  if (!key) return null;
  const expiry = Math.floor((now + TOKEN_TTL_MS) / 1000).toString(36);
  return `${handleFor(leadId)}${SEP}${expiry}${SEP}${macFor(leadId, expiry, key)}`;
}

/**
 * The lead id this token is for, or null for anything forged, truncated,
 * malformed or expired. Never throws.
 */
export function verifyReferralToken(token: string, now = Date.now()): string | null {
  const key = secret();
  if (!key) return null;

  const m = TOKEN_RE.exec((token ?? "").toLowerCase());
  if (!m) return null;

  const [, handle, expiry, mac] = m;

  const expiresAtMs = parseInt(expiry, 36) * 1000;
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) return null;

  // Rebuild the uuid from the handle so the MAC is checked against exactly the
  // value the caller will use downstream.
  const leadId = [
    handle.slice(0, 8), handle.slice(8, 12), handle.slice(12, 16),
    handle.slice(16, 20), handle.slice(20, 32),
  ].join("-");

  const want = Buffer.from(macFor(leadId, expiry, key));
  const got = Buffer.from(mac);
  if (got.length !== want.length) return null;
  return timingSafeEqual(got, want) ? leadId : null;
}
