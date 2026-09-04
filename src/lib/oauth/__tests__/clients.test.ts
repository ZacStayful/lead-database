/**
 * The redirect-URI policy is the open-redirector defence AND the reason Cursor
 * and mcp-remote can connect at all. Those two pull in opposite directions, so
 * the boundary between them is worth pinning precisely.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_REDIRECT_URIS,
  isAllowedRedirectUri,
  matchRedirectUri,
  normaliseGrantTypes,
  parseScopeString,
  redirectUriMatches,
  registrationSchema,
} from "@/lib/oauth/clients";

describe("which redirect URIs may be registered", () => {
  it("accepts the real callbacks the clients we care about use", () => {
    expect(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isAllowedRedirectUri("https://chatgpt.com/connector_platform_oauth_redirect")).toBe(true);
    expect(isAllowedRedirectUri("http://localhost:53422/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:8080/oauth/callback")).toBe(true);
  });

  it("refuses plain http anywhere but loopback", () => {
    expect(isAllowedRedirectUri("http://example.com/cb")).toBe(false);
    expect(isAllowedRedirectUri("http://evil.test/cb")).toBe(false);
  });

  it("refuses every other scheme", () => {
    expect(isAllowedRedirectUri("javascript:alert(1)")).toBe(false);
    expect(isAllowedRedirectUri("data:text/html,x")).toBe(false);
    expect(isAllowedRedirectUri("file:///etc/passwd")).toBe(false);
    expect(isAllowedRedirectUri("myapp://callback")).toBe(false);
  });

  it("refuses a fragment, which cannot round-trip a query response", () => {
    expect(isAllowedRedirectUri("https://claude.ai/cb#frag")).toBe(false);
  });

  it("refuses junk, empties and over-long values", () => {
    expect(isAllowedRedirectUri("not a url")).toBe(false);
    expect(isAllowedRedirectUri("")).toBe(false);
    expect(isAllowedRedirectUri(null)).toBe(false);
    expect(isAllowedRedirectUri("https://x.test/" + "a".repeat(600))).toBe(false);
  });
});

describe("matching a presented redirect against a registered one", () => {
  it("is EXACT for a non-loopback URI", () => {
    const reg = "https://claude.ai/api/mcp/auth_callback";
    expect(redirectUriMatches(reg, reg)).toBe(true);
    expect(redirectUriMatches(reg, reg + "/")).toBe(false);
    expect(redirectUriMatches(reg, reg + "?x=1")).toBe(false);
    expect(redirectUriMatches(reg, "https://evil.test/api/mcp/auth_callback")).toBe(false);
  });

  it("ignores the PORT on loopback — this is what makes Cursor work", () => {
    // A native client binds a random port each run. Exact matching here would
    // refuse every reconnection.
    expect(
      redirectUriMatches("http://localhost:53422/callback", "http://localhost:61199/callback")
    ).toBe(true);
    expect(
      redirectUriMatches("http://127.0.0.1:1/cb", "http://127.0.0.1:65535/cb")
    ).toBe(true);
  });

  it("still requires the loopback HOST to match", () => {
    // localhost and 127.0.0.1 are different registrations; treating them as one
    // would widen the relaxation past the port.
    expect(
      redirectUriMatches("http://localhost:53422/callback", "http://127.0.0.1:53422/callback")
    ).toBe(false);
  });

  it("still requires the loopback PATH and QUERY to match", () => {
    expect(
      redirectUriMatches("http://localhost:1/callback", "http://localhost:2/other")
    ).toBe(false);
    expect(
      redirectUriMatches("http://localhost:1/cb?a=1", "http://localhost:2/cb?a=2")
    ).toBe(false);
  });

  it("does NOT relax the port for a public host", () => {
    // The case that proves the relaxation is loopback-only rather than global.
    expect(
      redirectUriMatches("https://example.com:443/cb", "https://example.com:8443/cb")
    ).toBe(false);
    expect(
      redirectUriMatches("https://claude.ai/cb", "https://claude.ai:8443/cb")
    ).toBe(false);
  });

  it("refuses a scheme downgrade on loopback", () => {
    expect(
      redirectUriMatches("https://localhost:1/cb", "http://localhost:2/cb")
    ).toBe(false);
  });

  it("matchRedirectUri returns the presented URI or null", () => {
    const registered = ["https://claude.ai/cb", "http://localhost:1/cb"];
    expect(matchRedirectUri(registered, "http://localhost:9999/cb")).toBe("http://localhost:9999/cb");
    expect(matchRedirectUri(registered, "https://evil.test/cb")).toBeNull();
    expect(matchRedirectUri(registered, null)).toBeNull();
    expect(matchRedirectUri(registered, undefined)).toBeNull();
  });
});

describe("the registration request shape", () => {
  const valid = { redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] };

  it("accepts the minimum a real client sends", () => {
    expect(registrationSchema.safeParse(valid).success).toBe(true);
  });

  it("IGNORES unknown fields rather than refusing them", () => {
    // RFC 7591 permits ignoring unrecognised metadata; refusing would turn a
    // more thorough client into a failed connection.
    const r = registrationSchema.safeParse({
      ...valid,
      contacts: ["a@b.test"],
      jwks_uri: "https://x.test/jwks",
      some_future_field: 42,
    });
    expect(r.success).toBe(true);
  });

  it("refuses a request with no redirect_uris at all", () => {
    expect(registrationSchema.safeParse({ redirect_uris: [] }).success).toBe(false);
    expect(registrationSchema.safeParse({}).success).toBe(false);
  });

  it("refuses more than the cap", () => {
    const many = Array.from({ length: MAX_REDIRECT_URIS + 1 }, (_, i) => `https://x.test/${i}`);
    expect(registrationSchema.safeParse({ redirect_uris: many }).success).toBe(false);
  });

  it("refuses the whole request if ANY redirect_uri is disallowed", () => {
    const r = registrationSchema.safeParse({
      redirect_uris: ["https://claude.ai/cb", "http://evil.test/cb"],
    });
    expect(r.success).toBe(false);
  });

  it("refuses an unknown token_endpoint_auth_method", () => {
    expect(
      registrationSchema.safeParse({ ...valid, token_endpoint_auth_method: "magic" }).success
    ).toBe(false);
    expect(
      registrationSchema.safeParse({ ...valid, token_endpoint_auth_method: "none" }).success
    ).toBe(true);
  });
});

describe("scope handling", () => {
  it("defaults to everything we offer when the client asks for nothing", () => {
    // An absent scope must never resolve to the empty set: the connection would
    // authorise perfectly and then fail every tool call.
    expect(parseScopeString(undefined)).toEqual(["profile:read", "leads:read"]);
  });

  it("narrows to what we know", () => {
    expect(parseScopeString("leads:read")).toEqual(["leads:read"]);
    expect(parseScopeString("leads:read profile:read")).toEqual(["profile:read", "leads:read"]);
  });

  it("drops scopes we do not have rather than granting them", () => {
    expect(parseScopeString("leads:read leads:write admin")).toEqual(["leads:read"]);
  });

  it("returns nothing when the client asked ONLY for scopes we lack", () => {
    // The caller refuses with invalid_scope. Falling back to everything would
    // grant more than was requested.
    expect(parseScopeString("leads:write")).toEqual([]);
  });
});

describe("grant types", () => {
  it("always registers authorization_code", () => {
    expect(normaliseGrantTypes(["refresh_token"])).toContain("authorization_code");
    expect(normaliseGrantTypes(undefined)).toContain("authorization_code");
  });

  it("drops what we do not implement rather than refusing the registration", () => {
    expect(normaliseGrantTypes(["authorization_code", "implicit", "password"])).toEqual([
      "authorization_code",
    ]);
  });

  it("does not duplicate", () => {
    expect(normaliseGrantTypes(["authorization_code", "authorization_code"])).toEqual([
      "authorization_code",
    ]);
  });
});
