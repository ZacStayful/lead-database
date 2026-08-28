/**
 * Reply-address tokens — the primary correlation route for inbound email (§40).
 *
 * A landlord's reply is matched back to a thread by the token in the address it
 * was sent to: reply-<handle><sep><mac>@leads.theiragency.co.uk
 *
 * WHY THIS AND NOT HEADERS. In-Reply-To / References are the fallback, not the
 * primary, because the token survives things headers do not: the landlord
 * replying from a different address, forwarding the mail on, or a client that
 * strips threading headers. Address matching is the last resort.
 *
 * ⚠️ LOWERCASE BEFORE MATCHING. Mail servers may case-fold the local part. This
 * was caught in testing — an uppercased token failed to resolve until
 * normalised — so parseThreadToken lowercases first.
 *
 * ⚠️ PARSING IS NOT AUTHORISATION. A parsed handle tells you which thread the
 * sender CLAIMS this is. The caller must additionally assert that the thread
 * belongs to the customer who owns the RECEIVING DOMAIN. That check lives in
 * correlate.ts and is what makes cross-customer mis-binding impossible.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const HANDLE_LEN = 16; // hex chars of the thread uuid used as the lookup handle
const MAC_LEN = 12; // hex chars of the HMAC
const SEP = "z"; // not a hex char, so the split is unambiguous

const TOKEN_RE = new RegExp(
  `^([0-9a-f]{${HANDLE_LEN}})${SEP}([0-9a-f]{${MAC_LEN}})$`
);

function secret(): string | null {
  return process.env.MESSAGING_TOKEN_SECRET || null;
}

export function threadTokensConfigured(): boolean {
  return secret() !== null;
}

function macFor(threadId: string, key: string): string {
  return createHmac("sha256", key).update(threadId).digest("hex").slice(0, MAC_LEN);
}

/** The lookup handle stored on the thread row — first N hex chars of its uuid. */
export function handleFor(threadId: string): string {
  return threadId.replace(/-/g, "").slice(0, HANDLE_LEN).toLowerCase();
}

export function mintThreadToken(threadId: string): string | null {
  const key = secret();
  if (!key) return null;
  return `${handleFor(threadId)}${SEP}${macFor(threadId, key)}`;
}

/** The full reply address a landlord sees and replies to. */
export function threadAddressFor(
  domain: { domain: string; reply_local_prefix: string },
  token: string
): string {
  return `${domain.reply_local_prefix}-${token}@${domain.domain}`;
}

/** Pull the token out of a recipient address. Case-folded on the way in. */
export function tokenFromAddress(
  address: string,
  replyLocalPrefix: string
): string | null {
  const local = (address ?? "").toLowerCase().split("@")[0] ?? "";
  const prefix = `${replyLocalPrefix.toLowerCase()}-`;
  if (!local.startsWith(prefix)) return null;
  const token = local.slice(prefix.length);
  return TOKEN_RE.test(token) ? token : null;
}

/**
 * Verify a token against the thread it claims to be, given a lookup of
 * handle -> thread id. Returns the thread id, or null for anything forged,
 * truncated, unknown or malformed.
 */
export function verifyThreadToken(
  token: string,
  threadIdForHandle: (handle: string) => string | null | undefined
): string | null {
  const key = secret();
  if (!key) return null;

  const m = TOKEN_RE.exec((token ?? "").toLowerCase());
  if (!m) return null;

  const threadId = threadIdForHandle(m[1]);
  if (!threadId) return null;

  const expected = macFor(threadId, key);
  const got = Buffer.from(m[2]);
  const want = Buffer.from(expected);
  if (got.length !== want.length) return null;
  return timingSafeEqual(got, want) ? threadId : null;
}
