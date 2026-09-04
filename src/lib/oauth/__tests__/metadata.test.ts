/**
 * The discovery documents are a contract read by software we do not control and
 * cannot debug. These cases pin the exact bytes, including the two properties a
 * strict client will reject us for getting wrong.
 */
import { describe, expect, it } from "vitest";
import {
  AUTHORIZE_URL,
  MCP_RESOURCE,
  OAUTH_ISSUER,
  RESOURCE_METADATA_URL,
  authorizationServerMetadata,
  protectedResourceMetadata,
  sameResource,
} from "@/lib/oauth/metadata";

describe("protected resource metadata (RFC 9728)", () => {
  const doc = protectedResourceMetadata();

  it("publishes exactly the expected key set", () => {
    // A literal, duplicated on purpose. A test deriving this from the source
    // would pass whatever changed, which is not a test.
    expect(Object.keys(doc).sort()).toEqual([
      "authorization_servers",
      "bearer_methods_supported",
      "resource",
      "resource_documentation",
      "resource_name",
      "scopes_supported",
    ]);
  });

  it("names the MCP endpoint as the resource and us as the issuer", () => {
    expect(doc.resource).toBe(MCP_RESOURCE);
    expect(doc.resource).toMatch(/\/api\/mcp$/);
    expect(doc.authorization_servers).toEqual([OAUTH_ISSUER]);
  });

  it("advertises only the header bearer method", () => {
    expect(doc.bearer_methods_supported).toEqual(["header"]);
  });
});

describe("authorization server metadata (RFC 8414)", () => {
  const doc = authorizationServerMetadata();

  it("publishes exactly the expected key set", () => {
    expect(Object.keys(doc).sort()).toEqual([
      "authorization_endpoint",
      "code_challenge_methods_supported",
      "grant_types_supported",
      "issuer",
      "registration_endpoint",
      "response_types_supported",
      "revocation_endpoint",
      "scopes_supported",
      "service_documentation",
      "token_endpoint",
      "token_endpoint_auth_methods_supported",
    ]);
  });

  it("has an issuer with NO path component and no trailing slash", () => {
    // Both are why the document is served at the bare well-known path only:
    // a path-inserted copy would carry an issuer that fails the client's check.
    expect(doc.issuer).toBe(OAUTH_ISSUER);
    expect(String(doc.issuer)).not.toMatch(/\/$/);
    expect(new URL(String(doc.issuer)).pathname).toBe("/");
  });

  it("offers S256 and NOTHING else — OAuth 2.1 removes plain", () => {
    // Advertising `plain` is how a client comes to pick it.
    expect(doc.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("offers the authorization code and refresh flows only", () => {
    expect(doc.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(doc.response_types_supported).toEqual(["code"]);
  });

  it("accepts public clients, which is what every MCP client is", () => {
    expect(doc.token_endpoint_auth_methods_supported).toContain("none");
  });

  it("points every endpoint at our own origin", () => {
    for (const key of [
      "authorization_endpoint",
      "token_endpoint",
      "registration_endpoint",
      "revocation_endpoint",
    ]) {
      expect(String(doc[key]).startsWith(OAUTH_ISSUER + "/")).toBe(true);
    }
  });
});

describe("URL derivation", () => {
  it("derives every URL from one normalised base", () => {
    expect(MCP_RESOURCE).toBe(`${OAUTH_ISSUER}/api/mcp`);
    expect(AUTHORIZE_URL).toBe(`${OAUTH_ISSUER}/oauth/authorize`);
    expect(RESOURCE_METADATA_URL).toBe(
      `${OAUTH_ISSUER}/.well-known/oauth-protected-resource/api/mcp`
    );
  });

  it("never emits a doubled slash", () => {
    // The trailing-slash trap: an APP_URL ending in "/" would make every one of
    // these `…co.uk//api/mcp`, breaking the resource match, the issuer check and
    // the callback at once, with nothing naming the cause.
    for (const url of [MCP_RESOURCE, AUTHORIZE_URL, RESOURCE_METADATA_URL]) {
      expect(url.replace(/^https?:\/\//, "")).not.toContain("//");
    }
  });
});

describe("sameResource", () => {
  it("matches the resource a client sends", () => {
    expect(sameResource(MCP_RESOURCE)).toBe(true);
  });

  it("tolerates a trailing slash on either side", () => {
    expect(sameResource(`${MCP_RESOURCE}/`)).toBe(true);
  });

  it("refuses a different resource, and refuses nothing at all", () => {
    expect(sameResource(`${MCP_RESOURCE}/other`)).toBe(false);
    expect(sameResource("https://evil.test/api/mcp")).toBe(false);
    expect(sameResource(null)).toBe(false);
    expect(sameResource("")).toBe(false);
  });
});
