/**
 * The customer's connected applications.
 *
 * ⚠️ AUTHENTICATED WITH getCurrentCustomer() DIRECTLY, NEVER resolveCaller —
 * the rule /api/customer/api-keys already states, for the same reason: a
 * credential that can manage credentials can grant itself scopes. An OAuth token
 * must never be able to list or revoke OAuth grants.
 *
 * It deliberately ignores the oauth_enabled kill switch. A customer must be able
 * to disconnect an application while OAuth is switched off — exactly as key
 * management ignores api_enabled.
 */
import { NextResponse } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { customer } = await getCurrentCustomer();
  if (!customer) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("oauth_grants")
    .select("id, scopes, created_at, last_used_at, oauth_clients!inner(client_name, client_uri)")
    .eq("customer_id", customer.id)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[oauth] grant list failed", error);
    return NextResponse.json({ error: "Could not load your connections." }, { status: 500 });
  }

  return NextResponse.json({ grants: data ?? [] });
}
