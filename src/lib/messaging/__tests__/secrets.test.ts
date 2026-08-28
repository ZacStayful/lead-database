/**
 * The reversible-secret primitive and the reply-address token.
 *
 * These two are the security boundary of §28: one holds credentials to a
 * customer's email account and WhatsApp number, the other decides which
 * conversation an inbound reply belongs to. Both are tested for their FAILURE
 * behaviour first — §23.10's lesson that a happy-path suite reports "verified"
 * on code whose failure modes are all silent.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import {
  encryptSecret,
  decryptSecret,
  cryptoConfigured,
  activeKeyVersion,
  secretFingerprint,
  fingerprintsMatch,
  secretLast4,
  mintWebhookToken,
  timelinesTokenAad,
  resendKeyAad,
  SecretError,
} from "../../crypto/secretBox";
import {
  mintThreadToken,
  verifyThreadToken,
  handleFor,
  tokenFromAddress,
  threadAddressFor,
} from "../threadAddress";

const KEY_V1 = randomBytes(32).toString("base64");
const KEY_V2 = randomBytes(32).toString("base64");
const CUST_A = "11111111-1111-1111-1111-111111111111";
const CUST_B = "22222222-2222-2222-2222-222222222222";
const TOKEN = "tl_live_a_real_looking_token_9f3b";

const saved = { ...process.env };
beforeEach(() => {
  process.env.MESSAGING_ENCRYPTION_KEY_V1 = KEY_V1;
  process.env.MESSAGING_ENCRYPTION_ACTIVE_VERSION = "1";
  process.env.MESSAGING_TOKEN_SECRET = "thread-hmac-secret";
  delete process.env.MESSAGING_ENCRYPTION_KEY_V2;
});
afterEach(() => {
  process.env = { ...saved };
});

describe("secretBox — AES-256-GCM", () => {
  it("round-trips under its own AAD", () => {
    const { ciphertext } = encryptSecret(TOKEN, timelinesTokenAad(CUST_A));
    expect(decryptSecret(ciphertext, timelinesTokenAad(CUST_A))).toBe(TOKEN);
  });

  it("CUSTOMER B CANNOT DECRYPT CUSTOMER A'S CIPHERTEXT", () => {
    // The AAD binding. A row lifted between customers must fail, not silently work.
    const { ciphertext } = encryptSecret(TOKEN, timelinesTokenAad(CUST_A));
    expect(() => decryptSecret(ciphertext, timelinesTokenAad(CUST_B))).toThrow(
      SecretError
    );
  });

  it("a Resend ciphertext cannot be read as a TimelinesAI one", () => {
    // Same customer, different purpose — the AAD separates them too.
    const { ciphertext } = encryptSecret(TOKEN, resendKeyAad(CUST_A));
    expect(() => decryptSecret(ciphertext, timelinesTokenAad(CUST_A))).toThrow();
  });

  it("rejects a tampered ciphertext", () => {
    const { ciphertext } = encryptSecret(TOKEN, timelinesTokenAad(CUST_A));
    const parts = ciphertext.split(".");
    parts[3] = Buffer.from("evil payload").toString("base64url");
    expect(() =>
      decryptSecret(parts.join("."), timelinesTokenAad(CUST_A))
    ).toThrow(/bad_key/);
  });

  it("rejects a tampered auth tag", () => {
    const { ciphertext } = encryptSecret(TOKEN, timelinesTokenAad(CUST_A));
    const parts = ciphertext.split(".");
    parts[2] = Buffer.from(randomBytes(16)).toString("base64url");
    expect(() =>
      decryptSecret(parts.join("."), timelinesTokenAad(CUST_A))
    ).toThrow(/bad_key/);
  });

  it("fails CLEANLY on an unknown key version, not as a raw crash", () => {
    const { ciphertext } = encryptSecret(TOKEN, timelinesTokenAad(CUST_A));
    const bumped = ciphertext.replace(/^v1\./, "v9.");
    try {
      decryptSecret(bumped, timelinesTokenAad(CUST_A));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as SecretError).code).toBe("unknown_version");
    }
  });

  it.each(["", "not-a-token", "v1.only.three", "v1.a.b.c.d"])(
    "rejects malformed input %s",
    (bad) => {
      expect(() => decryptSecret(bad, timelinesTokenAad(CUST_A))).toThrow();
    }
  );

  it("produces a different ciphertext each time (random IV)", () => {
    const a = encryptSecret(TOKEN, timelinesTokenAad(CUST_A)).ciphertext;
    const b = encryptSecret(TOKEN, timelinesTokenAad(CUST_A)).ciphertext;
    expect(a).not.toBe(b);
    expect(decryptSecret(a, timelinesTokenAad(CUST_A))).toBe(
      decryptSecret(b, timelinesTokenAad(CUST_A))
    );
  });

  it("never leaks the plaintext into the token", () => {
    const { ciphertext } = encryptSecret(TOKEN, timelinesTokenAad(CUST_A));
    expect(ciphertext).not.toContain(TOKEN);
    expect(ciphertext).not.toContain("tl_live");
  });

  it("supports rotation: a v1 ciphertext still reads after v2 becomes active", () => {
    const old = encryptSecret(TOKEN, timelinesTokenAad(CUST_A)).ciphertext;
    process.env.MESSAGING_ENCRYPTION_KEY_V2 = KEY_V2;
    process.env.MESSAGING_ENCRYPTION_ACTIVE_VERSION = "2";
    expect(activeKeyVersion()).toBe(2);
    // New writes use v2...
    expect(encryptSecret(TOKEN, timelinesTokenAad(CUST_A)).ciphertext).toMatch(/^v2\./);
    // ...and the old one still decrypts, which is what makes rotation two
    // deploys and no migration.
    expect(decryptSecret(old, timelinesTokenAad(CUST_A))).toBe(TOKEN);
  });

  it("reports not-configured rather than throwing at import time", () => {
    delete process.env.MESSAGING_ENCRYPTION_KEY_V1;
    expect(cryptoConfigured()).toBe(false);
    expect(() => encryptSecret(TOKEN, timelinesTokenAad(CUST_A))).toThrow(
      /not_configured/
    );
  });

  it("rejects a key of the wrong length instead of silently truncating", () => {
    process.env.MESSAGING_ENCRYPTION_KEY_V1 = Buffer.from("short").toString("base64");
    expect(cryptoConfigured()).toBe(false);
  });

  it("accepts a hex key as well as base64", () => {
    process.env.MESSAGING_ENCRYPTION_KEY_V1 = randomBytes(32).toString("hex");
    expect(cryptoConfigured()).toBe(true);
    const { ciphertext } = encryptSecret(TOKEN, timelinesTokenAad(CUST_A));
    expect(decryptSecret(ciphertext, timelinesTokenAad(CUST_A))).toBe(TOKEN);
  });

  it("fingerprints identify a re-paste without decrypting", () => {
    expect(fingerprintsMatch(secretFingerprint(TOKEN), secretFingerprint(TOKEN))).toBe(true);
    expect(fingerprintsMatch(secretFingerprint(TOKEN), secretFingerprint(TOKEN + "x"))).toBe(false);
    expect(secretFingerprint(TOKEN)).not.toContain(TOKEN);
  });

  it("last4 shows the customer which credential is stored, and no more", () => {
    expect(secretLast4(TOKEN)).toBe(TOKEN.slice(-4));
    expect(secretLast4(TOKEN)).toHaveLength(4);
  });

  it("mints webhook tokens with enough entropy to be unguessable", () => {
    const a = mintWebhookToken();
    expect(a).not.toBe(mintWebhookToken());
    expect(a.length).toBeGreaterThanOrEqual(40);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/); // url-safe: it goes in a path
  });
});

describe("threadAddress — reply-address tokens", () => {
  const THREAD = "3f2a1b4c-5d6e-7f80-91a2-b3c4d5e6f708";
  const OTHER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const lookup = (h: string) => (h === handleFor(THREAD) ? THREAD : null);

  it("round-trips to the right thread", () => {
    const token = mintThreadToken(THREAD)!;
    expect(verifyThreadToken(token, lookup)).toBe(THREAD);
  });

  it("REJECTS a forged MAC against a real thread handle", () => {
    // The attack: guess a thread handle, append anything.
    const forged = `${handleFor(THREAD)}z${"0".repeat(12)}`;
    expect(verifyThreadToken(forged, lookup)).toBeNull();
  });

  it("rejects a valid MAC for a DIFFERENT thread", () => {
    const token = mintThreadToken(OTHER)!;
    expect(verifyThreadToken(token, lookup)).toBeNull();
  });

  it.each(["", "garbage", "short", "zzzz"])("rejects %s", (bad) => {
    expect(verifyThreadToken(bad, lookup)).toBeNull();
  });

  it("rejects a truncated token", () => {
    const token = mintThreadToken(THREAD)!;
    expect(verifyThreadToken(token.slice(0, 10), lookup)).toBeNull();
  });

  it("IS CASE-INSENSITIVE — mail servers may case-fold the local part", () => {
    // Caught in testing: an uppercased token failed until normalised.
    const token = mintThreadToken(THREAD)!;
    expect(verifyThreadToken(token.toUpperCase(), lookup)).toBe(THREAD);
  });

  it("extracts the token from a real reply address, any case", () => {
    const domain = { domain: "leads.theiragency.co.uk", reply_local_prefix: "reply" };
    const token = mintThreadToken(THREAD)!;
    const address = threadAddressFor(domain, token);
    expect(address).toBe(`reply-${token}@leads.theiragency.co.uk`);
    expect(tokenFromAddress(address, "reply")).toBe(token);
    expect(tokenFromAddress(address.toUpperCase(), "reply")).toBe(token);
  });

  it("returns null for an address that is not a reply address", () => {
    expect(tokenFromAddress("hello@leads.theiragency.co.uk", "reply")).toBeNull();
    expect(tokenFromAddress("reply-notatoken@x.example.com", "reply")).toBeNull();
    expect(tokenFromAddress("", "reply")).toBeNull();
  });

  it("mints nothing when the secret is unset, rather than an unsigned token", () => {
    delete process.env.MESSAGING_TOKEN_SECRET;
    expect(mintThreadToken(THREAD)).toBeNull();
    expect(verifyThreadToken("anything", lookup)).toBeNull();
  });
});
