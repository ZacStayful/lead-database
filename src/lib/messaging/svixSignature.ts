/**
 * Svix webhook signature verification, by hand (§40.8).
 *
 * Resend signs its webhooks through Svix: `svix-id`, `svix-timestamp` and
 * `svix-signature` headers over the RAW request body.
 *
 * ⚠️ THIS IS THE ONE PLACE §40 HAS A REAL AUTHENTICATION BOUNDARY, and the
 * receiver is shaped completely differently because of it. TimelinesAI cannot
 * sign anything — its own spec says "authentication of the request or
 * customizing headers is not supported" — so that receiver treats every payload
 * as an unverified assertion and reads the message back from the API before
 * believing a word of it. Resend CAN sign, so a verified payload IS evidence and
 * no read-back is needed. Do not "harmonise" the two receivers: their trust
 * models are genuinely different and the difference is the signature.
 *
 * NO `svix` DEPENDENCY. The algorithm is thirty lines of node:crypto and the
 * repo already hand-rolls HMAC in threadAddress.ts. Adding a package to a build
 * that runs `vitest run && next build` on every deploy, for this, is not a
 * trade worth making.
 *
 * ⚠️ THE BODY MUST BE THE RAW TEXT, NOT A RE-SERIALISED OBJECT. `JSON.parse`
 * then `JSON.stringify` reorders nothing in V8 but does drop insignificant
 * whitespace, and the signature covers bytes. Callers must read the body once
 * with `request.text()` and parse from that same string.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type SvixFailure =
  | "missing_headers"
  | "bad_secret"
  | "bad_timestamp"
  | "stale"
  | "no_match";

export type SvixVerdict = { ok: true } | { ok: false; reason: SvixFailure };

/**
 * ⚠️ DELIBERATELY WIDE, AND NOT THE 5 MINUTES THE SVIX LIBRARIES USE.
 *
 * Svix retries a failed delivery on a schedule that runs out to ten hours, and
 * every retry re-sends the ORIGINAL signed payload with its ORIGINAL
 * `svix-timestamp`. A five-minute tolerance therefore rejects every retry after
 * the first few — which is precisely the failure that got this endpoint
 * disabled in the first place, and it would reject them in a way that looks
 * exactly like a forged request.
 *
 * The timestamp is not what makes a request trustworthy here; the HMAC is. All
 * the window buys is replay protection, and the claim-by-INSERT on `svix-id`
 * already makes a replayed delivery a no-op. So the window is set to outlive
 * the vendor's retry schedule rather than to police it.
 */
const DEFAULT_TOLERANCE_MS = 48 * 60 * 60 * 1000;

/** Strip the `whsec_` prefix and base64-decode. */
function keyFromSecret(secret: string): Buffer | null {
  const raw = (secret ?? "").trim();
  if (!raw) return null;
  const b64 = raw.startsWith("whsec_") ? raw.slice("whsec_".length) : raw;
  try {
    const buf = Buffer.from(b64, "base64");
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch, so the length is compared
  // first — and a differing length is not a secret worth protecting.
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function verifySvixSignature(p: {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  /** The raw request body, byte for byte as it arrived. */
  body: string;
  /** The per-customer signing secret, `whsec_...`. */
  secret: string;
  nowMs?: number;
  toleranceMs?: number;
}): SvixVerdict {
  if (!p.id || !p.timestamp || !p.signature) {
    return { ok: false, reason: "missing_headers" };
  }

  const key = keyFromSecret(p.secret);
  if (!key) return { ok: false, reason: "bad_secret" };

  const seconds = Number(p.timestamp);
  if (!Number.isFinite(seconds)) return { ok: false, reason: "bad_timestamp" };

  const now = p.nowMs ?? Date.now();
  const tolerance = p.toleranceMs ?? DEFAULT_TOLERANCE_MS;
  // Both directions: a timestamp far in the future is as wrong as one far in
  // the past, and clock skew between us and the vendor is seconds, not hours.
  if (Math.abs(now - seconds * 1000) > tolerance) {
    return { ok: false, reason: "stale" };
  }

  const expected = createHmac("sha256", key)
    .update(`${p.id}.${p.timestamp}.${p.body}`, "utf8")
    .digest("base64");

  // Space-delimited, each entry `v<version>,<base64>`. Only v1 is defined; an
  // unknown version is skipped rather than guessed at, so a future scheme
  // cannot be silently accepted under the v1 rules.
  //
  // EVERY candidate is compared, and the loop does not exit early on a match,
  // so the work done does not depend on which entry matched.
  let matched = false;
  for (const part of p.signature.split(" ")) {
    const comma = part.indexOf(",");
    if (comma < 0) continue;
    if (part.slice(0, comma) !== "v1") continue;
    if (constantTimeEqual(part.slice(comma + 1), expected)) matched = true;
  }

  return matched ? { ok: true } : { ok: false, reason: "no_match" };
}
