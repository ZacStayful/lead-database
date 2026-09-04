/**
 * Validating an /oauth/authorize request.
 *
 * ⚠️ THE ORDER OF THE CHECKS IS THE SECURITY OF THE WHOLE FLOW, and it is why
 * this is a pure function rather than inline in the page: the GET that renders
 * the consent screen and the POST that acts on it must reach identical verdicts,
 * and two copies would eventually not.
 *
 * The rule the order encodes:
 *
 *   Until the client and its redirect_uri are BOTH verified, we may not redirect
 *   anywhere. An error sent to an unvalidated redirect_uri is an open redirector,
 *   and an open redirector on an authorization endpoint is how authorization
 *   codes get stolen.
 *
 * So the first two failures render a page. Everything after them redirects to a
 * destination we have just proved the client registered.
 */
import { API_SCOPES, type ApiScope } from "@/lib/api/scopes";
import { matchRedirectUri } from "@/lib/oauth/clients";
import { MCP_RESOURCE, sameResource } from "@/lib/oauth/metadata";

export interface AuthorizeParams {
  client_id?: string | null;
  redirect_uri?: string | null;
  response_type?: string | null;
  code_challenge?: string | null;
  code_challenge_method?: string | null;
  scope?: string | null;
  state?: string | null;
  resource?: string | null;
}

export interface ClientRecord {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  scope: string[];
  disabled_at: string | null;
}

export interface ValidAuthorizeRequest {
  kind: "valid";
  client: ClientRecord;
  redirectUri: string;
  codeChallenge: string;
  scopes: ApiScope[];
  state: string | null;
  resource: string;
}

/** Fatal: we cannot trust a redirect target, so nothing may be redirected. */
export interface FatalAuthorizeError {
  kind: "fatal";
  title: string;
  detail: string;
}

/** Reportable: the client and its redirect are verified, so OAuth says redirect. */
export interface RedirectAuthorizeError {
  kind: "redirect";
  redirectUri: string;
  error: string;
  description: string;
  state: string | null;
}

export type AuthorizeVerdict =
  | ValidAuthorizeRequest
  | FatalAuthorizeError
  | RedirectAuthorizeError;

export function validateAuthorizeRequest(
  params: AuthorizeParams,
  client: ClientRecord | null
): AuthorizeVerdict {
  // 1 — The client. No client, nowhere to send anything.
  if (!params.client_id) {
    return {
      kind: "fatal",
      title: "Something is missing from this request",
      detail: "The application did not identify itself, so we cannot continue.",
    };
  }
  if (!client || client.disabled_at) {
    return {
      kind: "fatal",
      title: "We do not recognise this application",
      detail:
        "It may have been disconnected, or the link may be out of date. Try connecting again from the application itself.",
    };
  }

  // 2 — The redirect. THIS IS THE ONE THAT MATTERS. Everything below is allowed
  // to redirect only because this has passed.
  const redirectUri = matchRedirectUri(client.redirect_uris, params.redirect_uri);
  if (!redirectUri) {
    return {
      kind: "fatal",
      title: "That return address is not registered",
      detail:
        "The application asked us to send you somewhere it has not registered, so we have stopped here rather than following it.",
    };
  }

  const state = params.state ?? null;
  const bad = (error: string, description: string): RedirectAuthorizeError => ({
    kind: "redirect",
    redirectUri,
    error,
    description,
    state,
  });

  // 3 — Everything else is now reportable to a destination we trust.
  if (params.response_type !== "code") {
    return bad("unsupported_response_type", "Only the authorization code flow is supported.");
  }

  // PKCE is REQUIRED, and only S256. OAuth 2.1 removes `plain`, and every MCP
  // client is a public client for which PKCE is the entire defence against a
  // stolen authorization code.
  if (!params.code_challenge) {
    return bad("invalid_request", "A PKCE code_challenge is required.");
  }
  if (params.code_challenge_method !== "S256") {
    return bad("invalid_request", "code_challenge_method must be S256.");
  }

  // ⚠️ AN ABSENT SCOPE MEANS EVERYTHING WE OFFER, NOT NOTHING. `scope` is
  // optional in OAuth 2.1 and several clients omit it. Granting the empty set
  // produces a connection that authorises perfectly and then fails every single
  // tool call — which reads as a permissions bug in our tools rather than as a
  // scope default, and is the worst shape of failure available here.
  let scopes: ApiScope[];
  if (!params.scope) {
    scopes = [...API_SCOPES];
  } else {
    const asked = new Set(params.scope.split(/\s+/).filter(Boolean));
    const unknown = Array.from(asked).filter((s) => !(API_SCOPES as readonly string[]).includes(s));
    if (unknown.length > 0) {
      return bad("invalid_scope", `Unknown scope: ${unknown.join(", ")}.`);
    }
    scopes = API_SCOPES.filter((s) => asked.has(s));
    if (scopes.length === 0) {
      return bad("invalid_scope", "No scopes were requested.");
    }
  }

  // The client may not be granted more than it registered for.
  const registered = new Set(client.scope ?? []);
  const overreach = scopes.filter((s) => !registered.has(s));
  if (overreach.length > 0) {
    return bad("invalid_scope", `This application is not registered for: ${overreach.join(", ")}.`);
  }

  // ⚠️ RFC 8707 `resource`: ABSENT IS ACCEPTED and defaults to our one resource.
  // The MCP specification tells CLIENTS to send it; a server that hard-fails
  // without it turns a client's omission into a dead end nobody can diagnose,
  // and we have exactly one protected resource for it to have meant. A
  // MISMATCHED one is refused, because that is a client asking for a token it
  // intends to present somewhere else.
  if (params.resource && !sameResource(params.resource)) {
    return bad("invalid_target", "That resource is not served here.");
  }

  return {
    kind: "valid",
    client,
    redirectUri,
    codeChallenge: params.code_challenge,
    scopes,
    state,
    resource: MCP_RESOURCE,
  };
}

/** Build the redirect for a reportable failure, preserving `state` if there was one. */
export function errorRedirectUrl(err: RedirectAuthorizeError): string {
  const url = new URL(err.redirectUri);
  url.searchParams.set("error", err.error);
  url.searchParams.set("error_description", err.description);
  if (err.state !== null) url.searchParams.set("state", err.state);
  return url.toString();
}

/** Build the success redirect. */
export function successRedirectUrl(
  redirectUri: string,
  code: string,
  state: string | null
): string {
  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  if (state !== null) url.searchParams.set("state", state);
  return url.toString();
}
