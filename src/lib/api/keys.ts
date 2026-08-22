/**
 * API key generation, hashing and comparison.
 *
 * A key looks like `sfl_live_<8 char prefix><40 char secret>`. Only the prefix
 * and a sha256 of the whole string are stored (0095); the raw key exists in the
 * single HTTP response that creates it and is never recoverable, which is the
 * same arrangement `lead_topup_tokens` uses for its confirmation links.
 *
 * WHY SHA-256 AND NOT BCRYPT/ARGON2, since this is the first question anyone
 * asks: the secret is 40 characters drawn from a CSPRNG, so there is no
 * dictionary behind it and nothing to brute force from the digest. A password
 * hash exists to buy time against guessing a human-chosen string; there is no
 * guessing to slow down here. Meanwhile the lookup runs on EVERY request, so a
 * deliberately slow KDF would tax every call in the system to defend against an
 * attack that does not apply. This is what Stripe and GitHub do with keys of
 * this shape.
 */
import { createHash, randomBytes, timingSafeEqual } from "crypto";

/** Marks the key as belonging to the live environment. A `sfl_test_` sibling
 *  would slot in beside it if test keys are ever wanted. */
export const API_KEY_PREFIX = "sfl_live_";
const PREFIX_CHARS = 8;
const SECRET_CHARS = 40;

/** Total stored prefix length, e.g. `sfl_live_a1B2c3D4`. */
export const KEY_PREFIX_LENGTH = API_KEY_PREFIX.length + PREFIX_CHARS;
const FULL_KEY_LENGTH = KEY_PREFIX_LENGTH + SECRET_CHARS;

const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Base62 by rejection sampling.
 *
 * NOT `randomBytes(n).toString("base64url")`, which is what the top-up token
 * uses: base64url emits `-` and `_`, and these keys are pasted into URLs, shell
 * history, n8n credential fields and JSON config files where a stray symbol is
 * an easy thing to mangle.
 *
 * 62 does not divide 256, so a plain `byte % 62` would draw the first eight
 * letters of the alphabet slightly more often than the rest. At 40 characters
 * the bias is worth nothing to an attacker, but discarding the 8 values at the
 * top of the range (248 = 62 x 4) costs one extra draw in thirty and removes
 * the question entirely.
 */
function base62(length: number): string {
  let out = "";
  while (out.length < length) {
    const bytes = randomBytes(length - out.length + 8);
    for (let i = 0; i < bytes.length && out.length < length; i += 1) {
      const b = bytes[i];
      if (b < 248) out += ALPHABET[b % 62];
    }
  }
  return out;
}

/** sha256 hex of a raw key. The only thing ever stored alongside the prefix. */
export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Mint a key: the raw string to show once, its stored prefix and its hash. */
export function generateApiKey(): {
  raw: string;
  prefix: string;
  hash: string;
} {
  const prefix = API_KEY_PREFIX + base62(PREFIX_CHARS);
  const raw = prefix + base62(SECRET_CHARS);
  return { raw, prefix, hash: hashApiKey(raw) };
}

/**
 * The lookup handle for a raw key, or null if it is not shaped like one of
 * ours. Length is checked as well as the prefix so a truncated paste is
 * rejected here rather than failing a hash comparison later for a reason the
 * customer cannot see.
 */
export function parseKeyPrefix(raw: string): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length !== FULL_KEY_LENGTH) return null;
  if (!raw.startsWith(API_KEY_PREFIX)) return null;
  const prefix = raw.slice(0, KEY_PREFIX_LENGTH);
  // Reject anything outside the alphabet so a crafted prefix cannot reach the
  // database as a wildcard or an injection attempt.
  if (!/^[0-9A-Za-z]+$/.test(raw.slice(API_KEY_PREFIX.length))) return null;
  return prefix;
}

/**
 * Constant-time comparison of two hex digests.
 *
 * `timingSafeEqual` throws on a length mismatch, so the lengths are compared
 * first — that comparison is not itself constant time, but the length of a
 * sha256 digest is public.
 */
export function keysMatch(rawKey: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashApiKey(rawKey), "utf8");
  const stored = Buffer.from(storedHash ?? "", "utf8");
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}
