/**
 * Enter and leave "view as customer" (§62).
 *
 * POST { customer_id } — SESSION ADMIN ONLY. Never the `x-admin-key` fallback
 * (§43.3's argument: repointing what a browser sees should need a real admin
 * session). Sets the cookie `getCurrentCustomer()` honours.
 *
 * DELETE — clears it FOR ANY CALLER. Sign-out is client-side and cannot clear
 * an HttpOnly cookie, and a Server Component cannot either (§45.15), so a
 * customer who logs in on a laptop an admin viewed from would otherwise have
 * every write refused for up to eight hours. Clearing is harmless, so it is
 * not gated; SignOutButton and the login page both call it.
 *
 * A Route Handler, never a page: cookies().set() throws in a Server Component
 * on Next 14 (§45.15).
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getUser, isAdminUser } from "@/lib/auth";
import { VIEW_AS_COOKIE, isViewAsId, viewAsCookieOptions } from "@/lib/viewAs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, private" };

export async function POST(request: NextRequest) {
  const user = await getUser();
  if (!user || !isAdminUser(user)) {
    return NextResponse.json({ error: "Admin only" }, { status: 403, headers: NO_STORE });
  }

  let body: { customer_id?: unknown };
  try {
    body = (await request.json()) as { customer_id?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers: NO_STORE });
  }
  const customerId = typeof body.customer_id === "string" ? body.customer_id : null;
  if (!isViewAsId(customerId)) {
    return NextResponse.json({ error: "customer_id must be a uuid" }, { status: 400, headers: NO_STORE });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("customers")
    .select("id, business_name, contact_name, user_id")
    .eq("id", customerId)
    .maybeSingle();
  if (error) {
    console.error("[view-as] customer lookup failed", error);
    return NextResponse.json({ error: "Could not look that customer up" }, { status: 500, headers: NO_STORE });
  }
  if (!data) {
    return NextResponse.json({ error: "No such customer" }, { status: 404, headers: NO_STORE });
  }

  const row = data as { id: string; business_name: string | null; contact_name: string | null; user_id: string | null };

  // The admin's own row is the live dashboard, never a read-only view: picking
  // "Your own account" in the picker clears any cookie instead (§62).
  if (row.user_id === user.id) {
    const response = NextResponse.json({ ok: true, self: true, redirect: "/dashboard" }, { headers: NO_STORE });
    response.cookies.set(VIEW_AS_COOKIE, "", { ...viewAsCookieOptions(), maxAge: 0 });
    return response;
  }

  const response = NextResponse.json(
    { ok: true, self: false, redirect: "/dashboard", label: row.business_name || row.contact_name || "" },
    { headers: NO_STORE }
  );
  response.cookies.set(VIEW_AS_COOKIE, row.id, viewAsCookieOptions());
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true }, { headers: NO_STORE });
  response.cookies.set(VIEW_AS_COOKIE, "", { ...viewAsCookieOptions(), maxAge: 0 });
  return response;
}
