/**
 * Admin "view as customer" — the read-only copy of a customer's dashboard (§62).
 *
 * ⚠️ IMPORT-FREE ON PURPOSE. Two callers cannot carry a dependency: the Edge
 * middleware (`src/middleware.ts`), which must not pull supabase-js into the
 * edge bundle, and the "use client" banner. The same discipline as
 * `dashboardNav.ts` and `featureRequest.ts` (§21.8).
 *
 * The cookie is honoured in exactly ONE place — `getCurrentCustomer()` — and
 * only when the session user is an admin. The middleware never trusts it: it
 * only REFUSES writes while it is present, which is harmless to anybody who
 * set it by hand on themselves.
 */

/** The cookie naming the customer an admin is viewing. HttpOnly; value is a uuid. */
export const VIEW_AS_COOKIE = "sf_view_as";

/**
 * A forgotten view must not persist for days. Eight hours is a working day —
 * long enough for a support session, short enough that a laptop left signed in
 * is not read-only tomorrow morning.
 */
export const VIEW_AS_MAX_AGE_SECONDS = 8 * 60 * 60;

/** Where the picker lives, and where Exit returns to. */
export const VIEW_AS_PICKER_PATH = "/admin/portal";

/** The one route that sets (POST) and clears (DELETE) the cookie. */
export const VIEW_AS_ROUTE = "/api/admin/view-as";

/**
 * The sentence every refused write carries. It sits under the `error` key
 * because that is what the client components render on a failed response.
 */
export const READ_ONLY_MESSAGE =
  "You're viewing this account read-only. Nothing you do here changes it.";

export const READ_ONLY_CODE = "read_only_view";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Strict: the value reaches a service-role `.eq("id", …)`, so nothing else may. */
export function isViewAsId(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function viewAsCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: VIEW_AS_MAX_AGE_SECONDS,
  };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The middleware's whole decision, pure so it is testable without Next.
 *
 * Refuse when a view is selected AND the request would change something AND it
 * is not an admin route. `/api/admin/*` stays writable so the Exit button and
 * the admin screens keep working while a view is selected; every admin route
 * checks its own session and never resolves the viewed customer.
 */
export function viewAsRefusal(
  method: string,
  pathname: string,
  hasCookie: boolean
): { status: 403; body: { error: string; code: string } } | null {
  if (!hasCookie) return null;
  if (SAFE_METHODS.has(method.toUpperCase())) return null;
  if (pathname.startsWith("/api/admin/")) return null;
  return { status: 403, body: { error: READ_ONLY_MESSAGE, code: READ_ONLY_CODE } };
}

/** What the layout hands the shell. `label` is what the banner prints. */
export interface ViewAs {
  customerId: string;
  label: string;
}
