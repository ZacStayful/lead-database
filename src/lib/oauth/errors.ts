/**
 * The RFC 6749 error envelope.
 *
 * DELIBERATELY NOT the app's `{ error: { code, message } }`. That shape is our
 * contract for /api/v1 and the MCP surface; this one is the OAuth
 * specification's, and a client library parses it without knowing anything about
 * us. Two envelopes on one server is right when they answer to two different
 * standards.
 */
import { NextResponse } from "next/server";
import { withCors } from "@/lib/api/cors";

export type OauthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "invalid_scope"
  | "invalid_target"
  | "server_error"
  | "temporarily_unavailable"
  | "invalid_redirect_uri"
  | "invalid_client_metadata";

export function oauthError(
  code: OauthErrorCode,
  description: string,
  status = 400
): NextResponse {
  return NextResponse.json(
    { error: code, error_description: description },
    {
      status,
      // `no-store` is required by RFC 6749 §5.1 on anything token-shaped, and
      // is right for an error too: a cached invalid_grant would outlive the
      // condition that caused it.
      headers: withCors({ "Cache-Control": "no-store", Pragma: "no-cache" }),
    }
  );
}
