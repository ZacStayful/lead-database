/**
 * Credential shape and PKCE.
 *
 * The prefix cases matter more than they look: resolveCaller discriminates an
 * OAuth token from an API key on the prefix ALONE, before either verifier runs.
 * An overlap would route a credential to the wrong verifier.
 */
import { describe, expect, it } from "vitest";
import { API_KEY_PREFIX, parseKeyPrefix } from "@/lib/api/keys";
import {
  ACCESS_TTL_MS,
  CODE_TTL_MS,
  OAUTH_ACCESS_PREFIX,
  OAUTH_CODE_PREFIX,
  OAUTH_REFRESH_PREFIX,
  REFRESH_REUSE_GRACE_MS,
  REFRESH_TTL_MS,
  isOauthToken,
  isValidCodeVerifier,
  mintAccessToken,
  mintRefreshToken,
  s256Challenge,
  tokenPrefixOf,
  verifyPkce,
} from "@/lib/oauth/tokens";

const ALL = [OAUTH_CODE_PREFIX, OAUTH_ACCESS_PREFIX, OAUTH_REFRESH_PREFIX, API_KEY_PREFIX];

describe("credential prefixes", () => {
  it("are all distinct", () => {
    expect(new Set(ALL).size).toBe(ALL.length);
  });

  it("are mutually non-overlapping — none is a prefix of another", () => {
    for (const a of ALL) {
      for (const b of ALL) {
        if (a !== b) expect(a.startsWith(b)).toBe(false);
      }
    }
  });

  it("keeps an access token from ever being mistaken for an API key", () => {
    const token = mintAccessToken();
    expect(parseKeyPrefix(token.raw)).toBeNull();
  });

  it("keeps an API key from being mistaken for an access token", () => {
    expect(isOauthToken(`${API_KEY_PREFIX}${"a".repeat(48)}`, OAUTH_ACCESS_PREFIX)).toBe(false);
  });
});

describe("minting", () => {
  it("produces a raw token whose stored prefix is a prefix of it", () => {
    const t = mintAccessToken();
    expect(t.raw.startsWith(t.prefix)).toBe(true);
    expect(tokenPrefixOf(t.raw, OAUTH_ACCESS_PREFIX)).toBe(t.prefix);
  });

  it("stores only a sha256 hex, never the token", () => {
    const t = mintRefreshToken();
    expect(t.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(t.hash).not.toContain(t.raw);
  });

  it("uses no URL-hostile characters", () => {
    // Tokens are pasted into config files and shell history; base64url's `-`
    // and `_` are easy to mangle. Same reasoning as API keys.
    for (let i = 0; i < 20; i += 1) {
      expect(mintAccessToken().raw).toMatch(/^sfl_at_[0-9A-Za-z]+$/);
    }
  });

  it("does not repeat itself", () => {
    const seen = new Set(Array.from({ length: 200 }, () => mintAccessToken().raw));
    expect(seen.size).toBe(200);
  });

  it("rejects a truncated or padded token", () => {
    const t = mintAccessToken();
    expect(isOauthToken(t.raw.slice(0, -1), OAUTH_ACCESS_PREFIX)).toBe(false);
    expect(isOauthToken(t.raw + "x", OAUTH_ACCESS_PREFIX)).toBe(false);
    expect(tokenPrefixOf(t.raw.slice(0, -1), OAUTH_ACCESS_PREFIX)).toBeNull();
  });
});

describe("lifetimes", () => {
  it("keeps a code short, an access token medium and a refresh token long", () => {
    expect(CODE_TTL_MS).toBeLessThan(ACCESS_TTL_MS);
    expect(ACCESS_TTL_MS).toBeLessThan(REFRESH_TTL_MS);
  });

  it("keeps a code inside the ten minutes RFC 6749 permits", () => {
    expect(CODE_TTL_MS).toBeLessThanOrEqual(10 * 60 * 1000);
  });

  it("keeps the refresh grace window far shorter than a token's life", () => {
    expect(REFRESH_REUSE_GRACE_MS).toBeGreaterThan(0);
    expect(REFRESH_REUSE_GRACE_MS).toBeLessThan(ACCESS_TTL_MS);
  });
});

describe("PKCE S256", () => {
  it("matches the RFC 7636 appendix B test vector", () => {
    // The published vector, so a refactor of the transform is caught here rather
    // than by a client that silently cannot authenticate.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(s256Challenge(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(verifyPkce(verifier, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")).toBe(true);
  });

  it("refuses a wrong verifier", () => {
    const challenge = s256Challenge("a".repeat(43));
    expect(verifyPkce("b".repeat(43), challenge)).toBe(false);
  });

  it("enforces the 43..128 length bounds", () => {
    // A short verifier is guessable, and this is the ONLY thing between an
    // intercepted code and a working token for a public client.
    expect(isValidCodeVerifier("a".repeat(42))).toBe(false);
    expect(isValidCodeVerifier("a".repeat(43))).toBe(true);
    expect(isValidCodeVerifier("a".repeat(128))).toBe(true);
    expect(isValidCodeVerifier("a".repeat(129))).toBe(false);
  });

  it("enforces the unreserved character set", () => {
    expect(isValidCodeVerifier("a".repeat(42) + "!")).toBe(false);
    expect(isValidCodeVerifier("a".repeat(42) + "~")).toBe(true);
    expect(isValidCodeVerifier("a".repeat(42) + " ")).toBe(false);
  });

  it("refuses a malformed verifier before hashing anything", () => {
    const challenge = s256Challenge("a".repeat(43));
    expect(verifyPkce(null, challenge)).toBe(false);
    expect(verifyPkce(undefined, challenge)).toBe(false);
    expect(verifyPkce(123, challenge)).toBe(false);
    expect(verifyPkce("short", challenge)).toBe(false);
  });

  it("refuses an empty or missing stored challenge", () => {
    expect(verifyPkce("a".repeat(43), "")).toBe(false);
  });
});
