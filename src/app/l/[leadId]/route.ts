import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { UUID_RE, leadPagePath } from "@/lib/leadLink";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `/l/<leadId>` — the link inside the new-lead email and text (§63.4).
 *
 * Signed in → 302 to the lead page. Signed out → 302 to `/login` carrying
 * `redirectedFrom`, which the login page already honours for same-site paths
 * (login/page.tsx), so the customer lands on the lead after signing in rather
 * than on the dashboard home.
 *
 * ⚠️ This exists because the dashboard layout's own redirect carries no return
 * path and cannot: the root middleware.ts that used to set `redirectedFrom`
 * never ran (§45.15) and is now deleted, and the live src/middleware.ts
 * matches /api/ paths only (§62). A Route Handler may refresh the session
 * cookie, which is why the Supabase client is created here rather than in a
 * Server Component.
 *
 * No ownership check: the lead page itself 404s a lead this customer does not
 * hold (loadLeadWorkspace), so an id in a forwarded text discloses nothing.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { leadId: string } }
) {
  const leadId = params.leadId;
  if (!UUID_RE.test(leadId)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const target = leadPagePath(leadId);
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const destination = user
    ? new URL(target, request.url)
    : new URL(`/login?redirectedFrom=${encodeURIComponent(target)}`, request.url);

  const res = NextResponse.redirect(destination, 302);
  // A redirect keyed on the session must never be cached for the next visitor.
  res.headers.set("Cache-Control", "no-store, private");
  return res;
}
