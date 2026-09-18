/**
 * The read-only gate for an admin viewing a customer's dashboard (§62).
 *
 * This is the ONE middleware file. The repo-root `middleware.ts` that §45.15
 * records as never having run is gone, and so is the `updateSession` helper
 * only it imported — this file does not wake either: it matches `/api/` paths
 * only and never touches a page.
 *
 * The rule is `viewAsRefusal()` in src/lib/viewAs.ts, pure and unit-tested:
 * with the view-as cookie present, any method that could change something is
 * answered 403 unless the path is under /api/admin/. No Supabase call — the
 * cookie's presence is the whole test, because refusing is harmless to anyone
 * who set it on themselves and `getCurrentCustomer()` ignores it for a
 * non-admin anyway.
 *
 * ⚠️ THE MATCHER EXCLUDES THE STRIPE WEBHOOK, THE CRONS AND THE MONDAY SYNCS.
 * None of them carries a browser cookie, so they could never be refused — the
 * exclusion is so a fault here can never sit in front of a credited invoice.
 */
import { NextResponse, type NextRequest } from "next/server";
import { VIEW_AS_COOKIE, viewAsRefusal } from "@/lib/viewAs";

export function middleware(request: NextRequest) {
  const refusal = viewAsRefusal(
    request.method,
    request.nextUrl.pathname,
    request.cookies.has(VIEW_AS_COOKIE)
  );
  if (!refusal) return NextResponse.next();
  return NextResponse.json(refusal.body, {
    status: refusal.status,
    headers: { "Cache-Control": "no-store, private" },
  });
}

export const config = {
  matcher: ["/api/((?!webhook|cron|monday).*)"],
};
