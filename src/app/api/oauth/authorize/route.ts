/**
 * The consent submit: the customer pressed Allow.
 *
 * A ROUTE HANDLER RATHER THAN A SERVER ACTION, because this ends in a 302 to a
 * third-party origin and a server action makes that awkward.
 *
 * ⚠️ NOTHING IN THE POSTED FORM IS TRUSTED. Every parameter is re-validated
 * against the database with the SAME function the page used, so a tampered form
 * can only produce a request that would have been valid anyway. What that leaves
 * is silent authorisation by CSRF — a page on another origin POSTing this with
 * the customer's cookie attached — and two guards close it, neither of which
 * needs a new env var:
 *
 *   1. Origin must be our own.
 *   2. A double-submit nonce: the consent page set a cookie, the form carries
 *      the same value, and they must match.
 */
import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentCustomer } from "@/lib/auth";
import { oauthEnabled } from "@/lib/oauth/enabled";
import { holdsProduct } from "@/lib/products";
import { APP_URL } from "@/lib/env";
import { clientIp, logApiRequest, resolveRequestId } from "@/lib/api/log";
import { issueAuthorizationCode, upsertGrant } from "@/lib/oauth/grants";
import {
  errorRedirectUrl,
  successRedirectUrl,
  validateAuthorizeRequest,
  type ClientRecord,
} from "@/lib/oauth/authorizeRequest";
import { CONSENT_NONCE_COOKIE } from "@/app/oauth/authorize/page";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function refuse(message: string, status = 400): NextResponse {
  // Deliberately NOT a redirect. If we got here without a verified request there
  // is no destination we are entitled to send anybody to.
  return new NextResponse(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function POST(request: NextRequest) {
  const requestId = resolveRequestId(request);

  if (!(await oauthEnabled())) return refuse("Connections are not available.", 404);

  // Guard 1 — same-origin. A cross-site form POST carries the customer's cookie
  // and would otherwise authorise an application they never saw.
  const origin = request.headers.get("origin");
  if (!origin || new URL(origin).origin !== new URL(APP_URL).origin) {
    return refuse("This request did not come from Stayful.", 403);
  }

  const form = await request.formData().catch(() => null);
  if (!form) return refuse("Expected a form submission.");
  const field = (k: string): string | null => {
    const v = form.get(k);
    return typeof v === "string" && v.length > 0 ? v : null;
  };

  // Guard 2 — the double-submit nonce.
  const nonce = field("consent_nonce");
  const cookieNonce = cookies().get(CONSENT_NONCE_COOKIE)?.value ?? null;
  if (!nonce || !cookieNonce || nonce !== cookieNonce) {
    return refuse("This consent form has expired. Please start again.", 403);
  }

  const { user, customer } = await getCurrentCustomer();
  if (!user || !customer) return refuse("You are not signed in.", 401);
  if (!customer.is_active) return refuse("This account cannot connect applications.", 403);
  if (!holdsProduct(customer, "management") && !holdsProduct(customer, "guaranteed_rent")) {
    return refuse("An active subscription is needed to connect an application.", 403);
  }

  const admin = createAdminClient();
  const clientId = field("client_id");

  let client: ClientRecord | null = null;
  if (clientId) {
    const { data } = await admin
      .from("oauth_clients")
      .select("client_id, client_name, redirect_uris, scope, disabled_at")
      .eq("client_id", clientId)
      .maybeSingle();
    client = (data as ClientRecord | null) ?? null;
  }

  const verdict = validateAuthorizeRequest(
    {
      client_id: clientId,
      redirect_uri: field("redirect_uri"),
      response_type: field("response_type"),
      code_challenge: field("code_challenge"),
      code_challenge_method: field("code_challenge_method"),
      scope: field("scope"),
      state: field("state"),
      resource: field("resource"),
    },
    client
  );

  if (verdict.kind === "fatal") return refuse(verdict.detail, 400);
  if (verdict.kind === "redirect") {
    return NextResponse.redirect(errorRedirectUrl(verdict), 303);
  }

  // UPSERT, not insert: re-consenting to an app you already connected is the
  // ordinary case, and oauth_grants carries a partial unique index that a plain
  // insert would violate at the very last step of the flow.
  const grant = await upsertGrant(
    admin,
    customer.id,
    verdict.client.client_id,
    verdict.scopes
  );
  if (!grant) return refuse("Could not record that connection. Please try again.", 500);

  const code = await issueAuthorizationCode(admin, {
    clientId: verdict.client.client_id,
    customerId: customer.id,
    redirectUri: verdict.redirectUri,
    codeChallenge: verdict.codeChallenge,
    scopes: verdict.scopes,
    resource: verdict.resource,
  });
  if (!code) return refuse("Could not complete that connection. Please try again.", 500);

  await logApiRequest({
    requestId,
    surface: "oauth",
    operation: "authorize:granted",
    statusCode: 303,
    customerId: customer.id,
    ip: clientIp(request),
    userAgent: request.headers.get("user-agent"),
  });

  // The nonce is single use.
  cookies().delete(CONSENT_NONCE_COOKIE);

  // 303 so the browser follows with a GET; a 302 after a POST is re-POSTed by
  // some clients, which would land a form body on the client's callback.
  return NextResponse.redirect(
    successRedirectUrl(verdict.redirectUri, code, verdict.state),
    303
  );
}
