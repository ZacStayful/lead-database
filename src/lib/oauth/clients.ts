/**
 * Dynamic client registration (RFC 7591), and the redirect-URI policy.
 *
 * REGISTRATION IS OPEN AND UNAUTHENTICATED, because that is what MCP clients
 * require: there is no human in the loop to paste a client id into Claude's
 * connector dialog. That is safe only because a client is not a credential — it
 * can ask for consent and nothing else, and every request it can subsequently
 * make still needs a customer to have sat in front of the consent screen.
 *
 * §27.1's standing rule (never an endpoint taking a query, a table name, a
 * column list or an arbitrary filter) is satisfied by the fixed allow-list
 * below. Registration accepts named fields with declared shapes and ignores
 * everything else.
 */
import { z } from "zod";
import { API_SCOPES, type ApiScope } from "@/lib/api/scopes";

export const MAX_REDIRECT_URIS = 5;
const MAX_URI_LENGTH = 512;
const MAX_NAME_LENGTH = 120;

/** Hosts for which RFC 8252 §7.3 requires us to ignore the port. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function isLoopback(url: URL): boolean {
  return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}

/**
 * Is this a redirect URI we will send a customer to?
 *
 * `https` anywhere (claude.ai and ChatGPT both use one), and `http` ONLY on a
 * loopback host, which RFC 8252 permits for a native app that spins up a local
 * listener. Everything else is refused: a custom app scheme is a one-line
 * addition the day a client actually needs one, and guessing at one now is a
 * hole with no user behind it.
 *
 * A fragment is refused outright — the authorization response is appended as a
 * query, and a URI carrying its own fragment cannot round-trip cleanly.
 */
export function isAllowedRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URI_LENGTH) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === "https:") return url.hostname.length > 0;
  if (url.protocol === "http:") return isLoopback(url);
  return false;
}

/**
 * ⚠️ THE PORT IS IGNORED FOR A LOOPBACK REDIRECT, AND ONLY FOR A LOOPBACK ONE.
 *
 * mcp-remote, Cursor and VS Code bind a RANDOM local port each time they run, so
 * a client that registered `http://localhost:53422/callback` comes back on
 * `http://localhost:61199/callback`. Exact string matching refuses it and those
 * three clients can never connect — which is the failure that would have looked
 * like "OAuth just doesn't work in Cursor".
 *
 * RFC 8252 §7.3 requires this relaxation, and confines it to loopback. For every
 * other host the comparison stays exact: that is the open-redirector defence,
 * and loosening it here would loosen it for `https://claude.ai` too.
 */
export function redirectUriMatches(registered: string, presented: string): boolean {
  if (registered === presented) return true;

  let a: URL;
  let b: URL;
  try {
    a = new URL(registered);
    b = new URL(presented);
  } catch {
    return false;
  }

  if (!isLoopback(a) || !isLoopback(b)) return false;
  if (a.protocol !== b.protocol) return false;
  // The host itself must still match: localhost and 127.0.0.1 are different
  // registrations, and treating them as one would widen this beyond the port.
  if (a.hostname.toLowerCase() !== b.hostname.toLowerCase()) return false;
  if (a.pathname !== b.pathname) return false;
  return a.search === b.search;
}

/** The registered URI this presented one matches, or null. */
export function matchRedirectUri(
  registered: readonly string[],
  presented: string | null | undefined
): string | null {
  if (!presented) return null;
  for (const candidate of registered) {
    if (redirectUriMatches(candidate, presented)) return presented;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * The registration request
 * ------------------------------------------------------------------ */

/**
 * ⚠️ UNKNOWN FIELDS ARE IGNORED, NOT REJECTED.
 *
 * RFC 7591 permits a server to ignore metadata it does not understand, and real
 * clients send fields we have never heard of. Rejecting on an unrecognised key
 * would refuse a conformant client for being more thorough than us — the
 * opposite of the containment §27.1 is asking for, which is about not accepting
 * arbitrary INSTRUCTIONS, not about refusing surplus description.
 */
const optionalString = (max: number) => z.string().trim().min(1).max(max).optional();

export const registrationSchema = z
  .object({
    redirect_uris: z
      .array(z.string())
      .min(1)
      .max(MAX_REDIRECT_URIS)
      .refine((uris) => uris.every(isAllowedRedirectUri), {
        message:
          "Every redirect_uri must be https, or http on localhost. No fragments.",
      }),
    client_name: z.string().trim().min(1).max(MAX_NAME_LENGTH).optional(),
    client_uri: optionalString(MAX_URI_LENGTH),
    logo_uri: optionalString(MAX_URI_LENGTH),
    scope: z.string().trim().max(200).optional(),
    grant_types: z.array(z.string()).max(8).optional(),
    response_types: z.array(z.string()).max(8).optional(),
    token_endpoint_auth_method: z
      .enum(["none", "client_secret_post", "client_secret_basic"])
      .optional(),
    software_id: optionalString(120),
    software_version: optionalString(60),
  })
  .passthrough();

export type RegistrationRequest = z.infer<typeof registrationSchema>;

/**
 * A space-delimited scope string, narrowed to the vocabulary we actually know.
 *
 * Returned in API_SCOPES order rather than the order the client asked in, so the
 * stored array is CANONICAL. Two grants for the same scopes then compare equal,
 * which is what lets re-consent decide whether it is widening a grant or leaving
 * it alone — and what stops the Connected apps panel listing the same permissions
 * in a different order each time.
 */
export function parseScopeString(scope: string | undefined): ApiScope[] {
  if (!scope) return [...API_SCOPES];
  const asked = new Set(scope.split(/\s+/).filter(Boolean));
  const known = API_SCOPES.filter((s) => asked.has(s));
  // An empty intersection means the client asked only for scopes we do not
  // have. Falling back to everything we offer would grant more than was asked
  // for, so this returns nothing and the caller refuses with invalid_scope.
  return known;
}

/**
 * Grant types we will register. `authorization_code` is required; a client
 * asking for anything we do not implement gets it dropped rather than refused,
 * since RFC 7591 expects the server to return what it actually registered.
 */
export function normaliseGrantTypes(asked: string[] | undefined): string[] {
  const allowed = new Set(["authorization_code", "refresh_token"]);
  const kept = (asked ?? ["authorization_code", "refresh_token"]).filter((g) =>
    allowed.has(g)
  );
  if (!kept.includes("authorization_code")) kept.unshift("authorization_code");
  return Array.from(new Set(kept));
}
