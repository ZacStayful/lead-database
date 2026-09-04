/**
 * The `WWW-Authenticate` challenge.
 *
 * ONE BUILDER, so the strings cannot drift between the POST handler, the GET
 * handler and anything added later. A client reads this header to discover where
 * our metadata lives; get a character wrong and the discovery chain breaks with
 * no error anybody can see.
 *
 * The parameter that matters is `resource_metadata` (RFC 9728 §5.1). Before this
 * existed the endpoint answered a bare `Bearer`, which told a client that
 * authentication was needed and nothing whatever about how to obtain it.
 */
import { RESOURCE_METADATA_URL } from "@/lib/oauth/metadata";
import { API_SCOPES } from "@/lib/api/scopes";
import type { ApiErrorCode } from "@/lib/api/errors";

/** Quote and escape a challenge parameter value. */
function quoted(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The challenge for a given failure.
 *
 * ⚠️ THE NO-CREDENTIAL CASE CARRIES NO `error` PARAMETER, deliberately. RFC 6750
 * reserves `error` for a request that presented something wrong. A client that
 * probes the endpoint with no credential — which is exactly how discovery starts
 * — and reads `error="invalid_token"` may conclude that the token it has stored
 * is bad and throw away a perfectly good one.
 *
 * The API-KEY failures share this builder and get the same `resource_metadata`.
 * That is right: it advertises where to learn about OAuth without asserting
 * anything about the credential that just failed, and a key user sees only a
 * header they ignore.
 */
export function bearerChallenge(code: ApiErrorCode | null): string {
  const parts: string[] = [];

  switch (code) {
    case null:
    case "unauthorized":
      // No credential presented. Say where the metadata is and nothing more.
      break;
    case "invalid_api_key":
    case "invalid_token":
      parts.push(`error=${quoted("invalid_token")}`);
      parts.push(`error_description=${quoted("The access token is not valid.")}`);
      break;
    case "expired_api_key":
    case "expired_token":
      parts.push(`error=${quoted("invalid_token")}`);
      parts.push(`error_description=${quoted("The access token has expired.")}`);
      break;
    case "revoked_api_key":
    case "revoked_token":
      parts.push(`error=${quoted("invalid_token")}`);
      parts.push(`error_description=${quoted("The access token has been revoked.")}`);
      break;
    case "insufficient_scope":
      parts.push(`error=${quoted("insufficient_scope")}`);
      parts.push(`scope=${quoted(API_SCOPES.join(" "))}`);
      break;
    default:
      // A rate limit or the kill switch is not an authentication problem, so it
      // gets the bare challenge rather than an `error` that would send a client
      // off to re-authenticate over something a retry would fix.
      break;
  }

  parts.push(`resource_metadata=${quoted(RESOURCE_METADATA_URL)}`);
  return `Bearer ${parts.join(", ")}`;
}
