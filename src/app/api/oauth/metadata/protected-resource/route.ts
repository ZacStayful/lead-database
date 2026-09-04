/**
 * RFC 9728 protected resource metadata.
 *
 * Reached through a rewrite in next.config.js, not from an app/.well-known/
 * directory — see that file for why. The document itself is built by
 * src/lib/oauth/metadata.ts so its exact bytes are unit-testable.
 *
 * PUBLIC AND UNAUTHENTICATED, necessarily: this is what a client reads BEFORE it
 * has any credential, and it is the one thing here that must be reachable with
 * nothing at all. It contains no secret — only URLs and the scope vocabulary
 * already printed on /dashboard/api.
 *
 * `dynamic = "force-dynamic"` is load-bearing: the kill switch is read from the
 * database on every request, and a statically prerendered copy would freeze it
 * at build time and ignore it for ever.
 */
import { NextResponse } from "next/server";
import { protectedResourceMetadata } from "@/lib/oauth/metadata";
import { oauthEnabled } from "@/lib/oauth/enabled";
import { withCors } from "@/lib/api/cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await oauthEnabled())) {
    // A 404, not a 503 — indistinguishable from the world before OAuth existed,
    // which is exactly the behaviour a client should fall back to.
    return new NextResponse(null, { status: 404, headers: withCors() });
  }

  return NextResponse.json(protectedResourceMetadata(), {
    headers: withCors({
      // Short on purpose. A longer cache would let a 404 outlive the switch
      // being turned on, and the document is a handful of static URLs.
      "Cache-Control": "public, max-age=300",
    }),
  });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: withCors() });
}
