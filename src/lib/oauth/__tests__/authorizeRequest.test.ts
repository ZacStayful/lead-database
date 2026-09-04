/**
 * The authorize validator.
 *
 * The first two cases are the security of the flow: until the client AND its
 * redirect_uri are verified, nothing may be redirected anywhere. Everything
 * after that is about not failing a conformant client for omitting an optional
 * parameter.
 */
import { describe, expect, it } from "vitest";
import {
  errorRedirectUrl,
  successRedirectUrl,
  validateAuthorizeRequest,
  type ClientRecord,
} from "@/lib/oauth/authorizeRequest";
import { MCP_RESOURCE } from "@/lib/oauth/metadata";

const client: ClientRecord = {
  client_id: "sfl_c_abc",
  client_name: "Claude",
  redirect_uris: ["https://claude.ai/api/mcp/auth_callback", "http://localhost:1/cb"],
  scope: ["profile:read", "leads:read"],
  disabled_at: null,
};

const base = {
  client_id: "sfl_c_abc",
  redirect_uri: "https://claude.ai/api/mcp/auth_callback",
  response_type: "code",
  code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  code_challenge_method: "S256",
  state: "xyz",
};

describe("nothing is redirected until the destination is proved", () => {
  it("is FATAL when the client is unknown — never a redirect", () => {
    const v = validateAuthorizeRequest(base, null);
    expect(v.kind).toBe("fatal");
  });

  it("is FATAL when client_id is missing entirely", () => {
    expect(validateAuthorizeRequest({ ...base, client_id: null }, null).kind).toBe("fatal");
  });

  it("is FATAL when the client is disabled", () => {
    const v = validateAuthorizeRequest(base, { ...client, disabled_at: "2026-01-01" });
    expect(v.kind).toBe("fatal");
  });

  it("is FATAL when the redirect_uri is not registered — the open-redirector case", () => {
    const v = validateAuthorizeRequest(
      { ...base, redirect_uri: "https://evil.test/steal" },
      client
    );
    expect(v.kind).toBe("fatal");
  });

  it("is FATAL when the redirect_uri is missing", () => {
    expect(validateAuthorizeRequest({ ...base, redirect_uri: null }, client).kind).toBe("fatal");
  });

  it("accepts a loopback redirect on a DIFFERENT port than registered", () => {
    // The Cursor / mcp-remote case: a random port each run.
    const v = validateAuthorizeRequest(
      { ...base, redirect_uri: "http://localhost:61199/cb" },
      client
    );
    expect(v.kind).toBe("valid");
  });
});

describe("reportable failures redirect to the proved destination", () => {
  const asRedirect = (params: Record<string, unknown>) =>
    validateAuthorizeRequest({ ...base, ...params }, client);

  it("refuses a response_type other than code", () => {
    const v = asRedirect({ response_type: "token" });
    expect(v).toMatchObject({ kind: "redirect", error: "unsupported_response_type" });
  });

  it("REQUIRES PKCE", () => {
    expect(asRedirect({ code_challenge: null })).toMatchObject({
      kind: "redirect",
      error: "invalid_request",
    });
  });

  it("requires S256 and refuses plain", () => {
    expect(asRedirect({ code_challenge_method: "plain" })).toMatchObject({
      kind: "redirect",
      error: "invalid_request",
    });
  });

  it("refuses an unknown scope", () => {
    expect(asRedirect({ scope: "leads:write" })).toMatchObject({
      kind: "redirect",
      error: "invalid_scope",
    });
  });

  it("refuses a scope the client did not register for", () => {
    const narrow = { ...client, scope: ["profile:read"] };
    const v = validateAuthorizeRequest({ ...base, scope: "leads:read" }, narrow);
    expect(v).toMatchObject({ kind: "redirect", error: "invalid_scope" });
  });

  it("refuses a resource we do not serve", () => {
    expect(asRedirect({ resource: "https://evil.test/api/mcp" })).toMatchObject({
      kind: "redirect",
      error: "invalid_target",
    });
  });

  it("preserves state on the error redirect, and omits it when absent", () => {
    const withState = asRedirect({ response_type: "token" });
    if (withState.kind !== "redirect") throw new Error("expected redirect");
    expect(errorRedirectUrl(withState)).toContain("state=xyz");

    const noState = validateAuthorizeRequest(
      { ...base, state: null, response_type: "token" },
      client
    );
    if (noState.kind !== "redirect") throw new Error("expected redirect");
    expect(errorRedirectUrl(noState)).not.toContain("state=");
  });
});

describe("optional parameters must not fail a conformant client", () => {
  it("an ABSENT scope grants everything we offer, never nothing", () => {
    // The empty set would authorise perfectly and then fail every tool call.
    const v = validateAuthorizeRequest({ ...base, scope: null }, client);
    if (v.kind !== "valid") throw new Error("expected valid");
    expect(v.scopes).toEqual(["profile:read", "leads:read"]);
    expect(v.scopes.length).toBeGreaterThan(0);
  });

  it("an ABSENT state is accepted — PKCE replaces its role in OAuth 2.1", () => {
    const v = validateAuthorizeRequest({ ...base, state: null }, client);
    expect(v.kind).toBe("valid");
    if (v.kind === "valid") expect(v.state).toBeNull();
  });

  it("an ABSENT resource defaults to ours rather than failing", () => {
    const v = validateAuthorizeRequest({ ...base, resource: null }, client);
    if (v.kind !== "valid") throw new Error("expected valid");
    expect(v.resource).toBe(MCP_RESOURCE);
  });

  it("a MATCHING resource is accepted, trailing slash and all", () => {
    expect(validateAuthorizeRequest({ ...base, resource: MCP_RESOURCE }, client).kind).toBe("valid");
    expect(validateAuthorizeRequest({ ...base, resource: MCP_RESOURCE + "/" }, client).kind).toBe("valid");
  });

  it("a narrower scope is honoured as asked", () => {
    const v = validateAuthorizeRequest({ ...base, scope: "leads:read" }, client);
    if (v.kind !== "valid") throw new Error("expected valid");
    expect(v.scopes).toEqual(["leads:read"]);
  });
});

describe("the success redirect", () => {
  it("carries the code and state", () => {
    const url = successRedirectUrl("https://claude.ai/cb", "sfl_ac_x", "xyz");
    expect(url).toContain("code=sfl_ac_x");
    expect(url).toContain("state=xyz");
  });

  it("omits state when the client sent none", () => {
    expect(successRedirectUrl("https://claude.ai/cb", "sfl_ac_x", null)).not.toContain("state=");
  });

  it("preserves a query string the redirect_uri already had", () => {
    const url = successRedirectUrl("https://claude.ai/cb?tenant=7", "c", null);
    expect(url).toContain("tenant=7");
    expect(url).toContain("code=c");
  });
});
