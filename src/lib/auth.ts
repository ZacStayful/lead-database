import { requestCache } from "@/lib/requestCache";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { User } from "@supabase/supabase-js";
import type { Customer } from "@/lib/types";
import { VIEW_AS_COOKIE, isViewAsId, type ViewAs } from "@/lib/viewAs";

export function isAdminUser(user: User | null): boolean {
  if (!user) return false;
  // Only app_metadata is trustworthy: users can edit their own user_metadata
  // from the browser via supabase.auth.updateUser, so it must never grant admin.
  return (user.app_metadata?.role as string | undefined) === "admin";
}

/**
 * Current authenticated user, or null.
 *
 * ⚠️ REQUEST-MEMOISED, AND THE `cache()` IS LOAD-BEARING — do not unwrap it.
 * dashboard/layout.tsx and dashboard/page.tsx both call getCurrentCustomer(),
 * and Next renders a layout and its page CONCURRENTLY. Without this, both
 * reach supabase.auth.getUser() with the same expired access token, both
 * redeem the same refresh token, GoTrue rotates it for the winner and rejects
 * the loser with `refresh_token_already_used` — and the catch below turns that
 * into "signed out", bouncing a signed-in customer to /login at random.
 * Production carried exactly that on /dashboard as late as 2026-09-22, four
 * days after the catch shipped: catching harder cannot fix a race, only
 * calling once can. It also halves the auth calls and `customers` reads on
 * every one of the 31 dashboard routes that resolve identity this way.
 */
export const getUser = requestCache(async function getUser(): Promise<User | null> {
  const supabase = createClient();
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return user;
  } catch (err) {
    // A stale cookie whose refresh token Supabase no longer recognises
    // ("Invalid Refresh Token: Refresh Token Not Found") surfaced as a 500 on
    // /dashboard/leads and /dashboard/settings/messaging in production. It is
    // not a fault: the person is simply no longer signed in. Every caller
    // already redirects to /login on null, which is the right outcome.
    const code = (err as { code?: string } | null)?.code;
    const isAuth = Boolean((err as { __isAuthError?: boolean } | null)?.__isAuthError);
    if (isAuth || code === "refresh_token_not_found") return null;
    throw err;
  }
});

/**
 * The view-as cookie, honoured for an ADMIN only (§62). A non-admin carrying
 * one — possible only by hand, it is HttpOnly — gets their own row exactly as
 * before. Pure so it can be unit-tested without a request.
 */
export function resolveViewAs(
  user: User | null,
  cookieValue: string | null | undefined
): string | null {
  if (!isAdminUser(user)) return null;
  return isViewAsId(cookieValue) ? cookieValue : null;
}

/**
 * ⚠️ A faithful copy of what the customer sees needs every downstream
 * `isAdminUser(user)` to answer FALSE. Two dozen pages and routes ask it to
 * decide what an admin previews — `messagingActiveFor(admin, isAdmin)` shows
 * the Follow-ups tab and enables the composer for an admin while the switch is
 * off (§40.3). Stripping the claim once here does that with no edit at any call
 * site. The admin layout and the view-as route read `getUser()` directly, so
 * admin access itself is untouched.
 */
export function withoutAdminClaim(user: User): User {
  const { role: _role, ...rest } = user.app_metadata ?? {};
  void _role;
  return { ...user, app_metadata: rest };
}

/**
 * Current authenticated user's customer row. Uses the service role so the
 * customer record is always resolvable even before subscription is active.
 *
 * While an admin is VIEWING A CUSTOMER (§62) this returns that customer's row
 * and a `user` with the admin claim removed, plus `viewAs` so the dashboard
 * frame can say so. Every read on the dashboard and every `/api/customer`
 * route resolves identity here, which is what makes one swap cover them all;
 * writes are refused upstream by `src/middleware.ts` before any route runs.
 */
export const getCurrentCustomer = requestCache(async function getCurrentCustomer(): Promise<{
  user: User | null;
  customer: Customer | null;
  viewAs: ViewAs | null;
}> {
  const user = await getUser();
  if (!user) return { user: null, customer: null, viewAs: null };

  const admin = createAdminClient();
  const viewAsId = resolveViewAs(user, cookies().get(VIEW_AS_COOKIE)?.value);

  if (viewAsId) {
    const { data } = await admin.from("customers").select("*").eq("id", viewAsId).maybeSingle();
    const viewed = (data as Customer | null) ?? null;
    return {
      user: withoutAdminClaim(user),
      customer: viewed,
      viewAs: {
        customerId: viewAsId,
        label: viewed?.business_name || viewed?.contact_name || viewed?.email || "this account",
      },
    };
  }

  const { data } = await admin
    .from("customers")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  return { user, customer: (data as Customer | null) ?? null, viewAs: null };
});
