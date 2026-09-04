/**
 * The challenge string is the whole discovery chain. A client reads it, follows
 * `resource_metadata`, and finds out OAuth exists. A character wrong here breaks
 * that with no error anybody can see.
 */
import { describe, expect, it } from "vitest";
import { bearerChallenge } from "@/lib/oauth/challenge";
import { RESOURCE_METADATA_URL } from "@/lib/oauth/metadata";

describe("bearerChallenge", () => {
  it("always points at the protected-resource metadata, quoted", () => {
    for (const code of [null, "unauthorized", "invalid_token", "insufficient_scope"] as const) {
      expect(bearerChallenge(code)).toContain(
        `resource_metadata="${RESOURCE_METADATA_URL}"`
      );
    }
  });

  it("always starts with the Bearer scheme", () => {
    expect(bearerChallenge(null).startsWith("Bearer ")).toBe(true);
  });

  it("carries NO error when no credential was presented", () => {
    // RFC 6750 reserves `error` for a request that presented something wrong. A
    // client probing with no credential — which is how discovery starts — that
    // reads invalid_token may throw away a good stored token.
    const bare = bearerChallenge(null);
    expect(bare).not.toContain("error=");
    expect(bare).toBe(`Bearer resource_metadata="${RESOURCE_METADATA_URL}"`);
    expect(bearerChallenge("unauthorized")).not.toContain("error=");
  });

  it("reports a bad, expired or revoked credential as invalid_token", () => {
    for (const code of ["invalid_token", "expired_token", "revoked_token"] as const) {
      expect(bearerChallenge(code)).toContain('error="invalid_token"');
    }
  });

  it("gives an API-key failure the same treatment", () => {
    // The two credential kinds share this block. Advertising where to learn
    // about OAuth asserts nothing about the key that just failed.
    for (const code of ["invalid_api_key", "expired_api_key", "revoked_api_key"] as const) {
      const c = bearerChallenge(code);
      expect(c).toContain('error="invalid_token"');
      expect(c).toContain("resource_metadata=");
    }
  });

  it("names the scopes on an insufficient_scope refusal", () => {
    const c = bearerChallenge("insufficient_scope");
    expect(c).toContain('error="insufficient_scope"');
    expect(c).toContain('scope="profile:read leads:read"');
  });

  it("does NOT send a client to re-authenticate over a rate limit", () => {
    // A 429 is not an authentication problem. An `error` here would make a
    // client tear down a perfectly good token over something a retry fixes.
    const c = bearerChallenge("rate_limited");
    expect(c).not.toContain("error=");
    expect(c).toContain("resource_metadata=");
  });

  it("emits comma-separated parameters, as RFC 9110 requires", () => {
    const c = bearerChallenge("invalid_token");
    expect(c).toMatch(/^Bearer [^ ]+="[^"]*"(, [^ ]+="[^"]*")+$/);
  });
});
