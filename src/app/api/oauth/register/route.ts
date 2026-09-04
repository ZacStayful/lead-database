/**
 * RFC 7591 dynamic client registration.
 *
 * UNAUTHENTICATED AND OPEN, because MCP clients require it: nobody is going to
 * paste a client id into Claude's connector dialog. That is safe because A
 * CLIENT IS NOT A CREDENTIAL — registering one grants nothing at all. Every
 * request it can subsequently make still needs a customer to have sat in front
 * of the consent screen and pressed Allow, and the only thing an attacker gets
 * from registering is the ability to ask.
 *
 * §27.1's standing rule is satisfied by src/lib/oauth/clients.ts: a fixed
 * allow-list of named fields with declared shapes, no query, no filter, no path.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { oauthEnabled } from "@/lib/oauth/enabled";
import { oauthError } from "@/lib/oauth/errors";
import { withCors } from "@/lib/api/cors";
import { clientIp, logApiRequest, resolveRequestId } from "@/lib/api/log";
import { base62, hashApiKey } from "@/lib/api/keys";
import {
  normaliseGrantTypes,
  parseScopeString,
  registrationSchema,
} from "@/lib/oauth/clients";
import { createHash } from "crypto";
import { RATE_LIMIT_WINDOW_SECONDS, RATE_LIMIT_DAY_SECONDS } from "@/lib/api/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Registrations per IP per minute. Generous for a real client, which registers
 *  once; tight enough that filling the table takes deliberate effort. */
const REGISTRATIONS_PER_MINUTE = 5;

export async function POST(request: NextRequest) {
  const requestId = resolveRequestId(request);
  const ip = clientIp(request);
  const admin = createAdminClient();

  const log = (status: number, code: string | null) =>
    logApiRequest({
      requestId,
      surface: "oauth",
      operation: "register",
      statusCode: status,
      errorCode: code,
      ip,
      userAgent: request.headers.get("user-agent"),
    });

  if (!(await oauthEnabled())) {
    await log(404, "oauth_disabled");
    return new NextResponse(null, { status: 404, headers: withCors() });
  }

  // Rate limited on the IP, since there is no customer to attribute this to.
  // md5(ip)::uuid fits the existing api_rate_limits shape without a schema
  // change and cannot collide with a real row id.
  if (ip) {
    const subject = ipSubjectId(ip);
    const { data, error } = await admin.rpc("consume_api_rate_limit", {
      p_subject_id: subject,
      p_customer_id: null,
      p_subject_kind: "ip",
      p_minute_seconds: RATE_LIMIT_WINDOW_SECONDS,
      p_day_seconds: RATE_LIMIT_DAY_SECONDS,
    });
    // FAILS CLOSED, as the API limiter does: letting registrations through when
    // the limiter is broken removes the only defence on an open endpoint at
    // exactly the moment it is under load.
    if (error) {
      console.error("[oauth] registration rate limit failed", error);
      await log(429, "rate_limited");
      return oauthError("temporarily_unavailable", "Try again shortly.", 429);
    }
    const minute = Number((data as { minute_count?: number })?.minute_count ?? 0);
    if (minute > REGISTRATIONS_PER_MINUTE) {
      await log(429, "rate_limited");
      return oauthError("temporarily_unavailable", "Too many registrations. Try again shortly.", 429);
    }
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    await log(400, "invalid_request");
    return oauthError("invalid_client_metadata", "Expected a JSON body.");
  }

  const parsed = registrationSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const isRedirect = issue?.path?.[0] === "redirect_uris";
    await log(400, "invalid_request");
    return oauthError(
      isRedirect ? "invalid_redirect_uri" : "invalid_client_metadata",
      issue?.message ?? "That client metadata is not acceptable.",
    );
  }

  const meta = parsed.data;
  const scopes = parseScopeString(meta.scope);
  if (scopes.length === 0) {
    await log(400, "invalid_scope");
    return oauthError("invalid_client_metadata", "None of the requested scopes exist here.");
  }

  const authMethod = meta.token_endpoint_auth_method ?? "none";
  const confidential = authMethod !== "none";
  const clientId = `sfl_c_${base62(24)}`;
  const clientSecret = confidential ? base62(48) : null;

  const { error } = await admin.from("oauth_clients").insert({
    client_id: clientId,
    client_name: meta.client_name ?? "Unnamed application",
    redirect_uris: meta.redirect_uris,
    grant_types: normaliseGrantTypes(meta.grant_types),
    response_types: ["code"],
    token_endpoint_auth_method: authMethod,
    client_secret_hash: clientSecret ? hashApiKey(clientSecret) : null,
    scope: scopes,
    client_uri: meta.client_uri ?? null,
    logo_uri: meta.logo_uri ?? null,
    software_id: meta.software_id ?? null,
    software_version: meta.software_version ?? null,
    created_ip: ip,
  });

  if (error) {
    console.error("[oauth] client registration failed", error);
    await log(500, "internal_error");
    return oauthError("server_error", "Could not register that client.", 500);
  }

  await log(201, null);

  return NextResponse.json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
      client_name: meta.client_name ?? "Unnamed application",
      redirect_uris: meta.redirect_uris,
      grant_types: normaliseGrantTypes(meta.grant_types),
      response_types: ["code"],
      token_endpoint_auth_method: authMethod,
      scope: scopes.join(" "),
    },
    { status: 201, headers: withCors({ "Cache-Control": "no-store" }) }
  );
}

/** A stable uuid for an IP, so it fits api_rate_limits.subject_id. */
function ipSubjectId(ip: string): string {
  const h = createHash("md5").update(ip).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: withCors() });
}
