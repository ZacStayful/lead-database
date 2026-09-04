/**
 * RFC 7009 token revocation.
 *
 * Worth the twenty lines: it lets a client clean up when a customer disconnects
 * at THEIR end — in Claude's connector list rather than ours — so a live token
 * is not left behind for the rest of its hour.
 *
 * ⚠️ IT ALWAYS ANSWERS 200, including for a token that does not exist. The spec
 * requires this, and the reason is worth stating: a 404 for an unknown token
 * turns this endpoint into an oracle for which tokens are live, and anybody can
 * call it.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { oauthEnabled } from "@/lib/oauth/enabled";
import { withCors } from "@/lib/api/cors";
import { clientIp, logApiRequest, resolveRequestId } from "@/lib/api/log";
import { hashToken } from "@/lib/oauth/tokens";
import { revokeGrant } from "@/lib/oauth/grants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const requestId = resolveRequestId(request);

  const ok = () => new NextResponse(null, { status: 200, headers: withCors({ "Cache-Control": "no-store" }) });

  if (!(await oauthEnabled())) {
    return new NextResponse(null, { status: 404, headers: withCors() });
  }

  const form = await request.formData().catch(() => null);
  const raw = typeof form?.get("token") === "string" ? String(form.get("token")) : null;
  if (!raw) return ok();

  const admin = createAdminClient();
  const { data } = await admin
    .from("oauth_tokens")
    .select("id, grant_id, kind")
    .eq("token_hash", hashToken(raw))
    .maybeSingle();

  const row = data as { id: string; grant_id: string; kind: string } | null;
  if (!row) return ok();

  // ⚠️ REVOKING A REFRESH TOKEN REVOKES THE WHOLE GRANT, not just that row.
  // RFC 7009 §2.1 says a server SHOULD invalidate the tokens issued alongside,
  // and a client calling this is disconnecting — leaving its access token live
  // for another hour would be a disconnect that does not disconnect.
  if (row.kind === "refresh") {
    await revokeGrant(admin, row.grant_id);
  } else {
    await admin
      .from("oauth_tokens")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", row.id)
      .is("revoked_at", null);
  }

  await logApiRequest({
    requestId,
    surface: "oauth",
    operation: `revoke:${row.kind}`,
    statusCode: 200,
    ip: clientIp(request),
    userAgent: request.headers.get("user-agent"),
  });

  return ok();
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: withCors() });
}
