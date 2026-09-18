/**
 * The one definition of "the link to a lead" (§63.4).
 *
 * The email, the SMS and the dashboard card all point at `/l/<leadId>`, a
 * redirector that sends a signed-in customer straight to the lead page and a
 * signed-out one through login AND BACK to the lead. Before this the email
 * linked to `/login` with no lead id at all, and the SMS linked to the lead
 * page directly — which the dashboard layout bounced to `/login` with no
 * return path: the root middleware.ts that would have set `redirectedFrom`
 * never ran (§45.15) and has since been deleted, and the live
 * src/middleware.ts matches /api/ paths only (§62).
 *
 * ⚠️ Keep this module import-free apart from env: it is read by the email and
 * SMS senders and by the home card builder, and must never pull supabase-js
 * into a client bundle (§21.8's rule).
 */
import { APP_URL } from "@/lib/env";

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The lead page itself. `[id]` is the LEAD id, never the assignment id. */
export function leadPagePath(leadId: string): string {
  return `/dashboard/leads/${leadId}`;
}

/** The redirector: signed in → the lead page; signed out → login, then back. */
export function leadDeepPath(leadId: string): string {
  return `/l/${leadId}`;
}

/** Absolute form for an email or a text. A bare path — no query string. */
export function leadDeepLink(leadId: string): string {
  return `${APP_URL.replace(/\/+$/, "")}${leadDeepPath(leadId)}`;
}
