/**
 * Reversible secret storage — the first in this codebase (§40).
 *
 * Every other credential here is a ONE-WAY sha256 hash (customer_api_keys.key_hash,
 * src/lib/api/keys.ts) or a process env var. A customer's Resend key and
 * TimelinesAI token must be decrypted to be used, so they need something new.
 *
 * WHY APP-LAYER AES-256-GCM AND NOT SUPABASE VAULT. The threat model is a leaked
 * database, and Vault does not defend against it here: every credentialed read in
 * this codebase runs on the SERVICE ROLE, which can select
 * vault.decrypted_secrets — so the credential that dumps the ciphertext dumps the
 * plaintext too. Encrypting in the application puts the key in Vercel's
 * environment, a DIFFERENT trust domain from Postgres. That separation is the
 * whole value, and it also means the plaintext never exists inside the database
 * at any point, so no future RPC, RLS mistake or `select *` can emit it.
 *
 * THE AAD BINDING IS NOT DECORATION. Every ciphertext is bound to
 * "<purpose>:<customer_id>", so a row lifted from customer A into customer B
 * fails to decrypt rather than silently working.
 *
 * ROTATION. The version is encoded in the token itself, so the stored
 * *_version column is a convenience index for a backfill, not the source of
 * truth. Add MESSAGING_ENCRYPTION_KEY_V2, flip
 * MESSAGING_ENCRYPTION_ACTIVE_VERSION, deploy; the maintenance cron re-encrypts
 * on next successful use. Two deploys, no migration.
 *
 * NEVER LOG, NEVER RETURN. No route may select a ciphertext column into a
 * response — see the *_PUBLIC_COLUMNS lists in src/lib/messaging/columns.ts,
 * which follow LIST_COLUMNS in api-keys/route.ts never selecting key_hash.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;

export type SecretErrorCode =
  | "not_configured"
  | "unknown_version"
  | "malformed"
  | "bad_key";

export class SecretError extends Error {
  code: SecretErrorCode;
  constructor(code: SecretErrorCode, message?: string) {
    super(message ?? code);
    this.name = "SecretError";
    this.code = code;
  }
}

function keyForVersion(version: number): Buffer | null {
  const raw = process.env[`MESSAGING_ENCRYPTION_KEY_V${version}`];
  if (!raw) return null;
  // Accept base64 or hex so a key can be pasted in either shape without a
  // silent truncation to the wrong length.
  const buf = /^[0-9a-fA-F]{64}$/.test(raw.trim())
    ? Buffer.from(raw.trim(), "hex")
    : Buffer.from(raw.trim(), "base64");
  return buf.length === KEY_BYTES ? buf : null;
}

export function activeKeyVersion(): number {
  const raw = process.env.MESSAGING_ENCRYPTION_ACTIVE_VERSION;
  const n = raw ? Number(raw) : 1;
  return Number.isInteger(n) && n > 0 ? n : 1;
}

/**
 * Whether encryption is usable at all. Every entry point checks this and
 * returns a "not_configured" skip rather than throwing — the src/lib/sms.ts
 * posture, so shipping this code with no env set changes nothing.
 */
export function cryptoConfigured(): boolean {
  return keyForVersion(activeKeyVersion()) !== null;
}

/** Token shape: v<n>.<iv>.<tag>.<ciphertext>, each base64url. Self-describing. */
export function encryptSecret(
  plaintext: string,
  aad: string
): { ciphertext: string; version: number } {
  const version = activeKeyVersion();
  const key = keyForVersion(version);
  if (!key) throw new SecretError("not_configured");

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  const token = [
    `v${version}`,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ct.toString("base64url"),
  ].join(".");

  return { ciphertext: token, version };
}

export function decryptSecret(token: string, aad: string): string {
  const parts = (token ?? "").split(".");
  if (parts.length !== 4) throw new SecretError("malformed");

  const [vRaw, ivRaw, tagRaw, ctRaw] = parts;
  if (!/^v\d+$/.test(vRaw)) throw new SecretError("malformed");

  const key = keyForVersion(Number(vRaw.slice(1)));
  if (!key) throw new SecretError("unknown_version");

  try {
    const decipher = createDecipheriv(ALGO, key, Buffer.from(ivRaw, "base64url"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
    return (
      decipher.update(Buffer.from(ctRaw, "base64url"), undefined, "utf8") +
      decipher.final("utf8")
    );
  } catch {
    // A wrong key, a wrong AAD and a tampered ciphertext are indistinguishable
    // here by design — GCM authenticates all three together.
    throw new SecretError("bad_key");
  }
}

/** AAD builders. Keep them here so a caller cannot invent an unbound variant. */
export function resendKeyAad(customerId: string): string {
  return `resend_api_key:${customerId}`;
}
export function resendWebhookAad(customerId: string): string {
  return `resend_webhook_secret:${customerId}`;
}
export function timelinesTokenAad(customerId: string): string {
  return `timelinesai_token:${customerId}`;
}

/**
 * A stable, non-reversible identity for a secret, so we can tell "they pasted
 * the same token again" from "they pasted a new one" without decrypting.
 */
export function secretFingerprint(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

export function fingerprintsMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Last four characters, for showing the customer which credential is stored. */
export function secretLast4(plaintext: string): string {
  return plaintext.slice(-4);
}

/** High-entropy URL path segment for a per-customer webhook endpoint. */
export function mintWebhookToken(): string {
  return randomBytes(32).toString("base64url");
}
