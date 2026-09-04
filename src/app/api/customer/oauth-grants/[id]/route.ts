/**
 * Disconnect an application.
 *
 * Session-only, for the reason the parent route gives. Scoped to the caller's
 * own customer id and to a grant that is still open, so a stale tab retrying a
 * revoke is a no-op rather than an error.
 */
import { NextResponse } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { revokeGrant } from "@/lib/oauth/grants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const { customer } = await getCurrentCustomer();
  if (!customer) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const admin = createAdminClient();

  // Ownership is proved by the lookup, not assumed from the id. A grant that is
  // not this customer's and one that does not exist give the SAME 404, so the
  // endpoint cannot be used to discover which grant ids are real.
  const { data, error } = await admin
    .from("oauth_grants")
    .select("id")
    .eq("id", params.id)
    .eq("customer_id", customer.id)
    .is("revoked_at", null)
    .maybeSingle();

  // 22P02 is an invalid uuid cast: a malformed id is a 404 too, for the same
  // reason — the pattern /api/customer/api-keys/[id] already uses.
  if (error && error.code !== "22P02") {
    console.error("[oauth] grant lookup failed", error);
    return NextResponse.json({ error: "Could not disconnect that application." }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const ok = await revokeGrant(admin, params.id);
  if (!ok) {
    return NextResponse.json({ error: "Could not disconnect that application." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
