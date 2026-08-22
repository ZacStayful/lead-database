/**
 * Revoking one of the caller's own API keys.
 *
 * Session-only, for the reason given in ../route.ts.
 *
 * A STAMP, NEVER A DELETE. The row is what says this key existed, when it was
 * last used and which prefix it carried — which is exactly the evidence wanted
 * if it turns out to have leaked. Deleting it would destroy the audit trail at
 * the moment the audit trail becomes interesting.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const admin = createAdminClient();

  // Scoped by customer_id — that eq IS the ownership check — and guarded on
  // revoked_at so a second click reports honestly rather than re-stamping a
  // later date over the real revocation time.
  const { data, error } = await admin
    .from("customer_api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", params.id)
    .eq("customer_id", customer.id)
    .is("revoked_at", null)
    .select("id, name, key_prefix, revoked_at")
    .maybeSingle();

  if (error) {
    // An invalid uuid arrives as a cast failure. Same 404 as a foreign id: this
    // route must not confirm which key ids exist.
    if (error.code === "22P02") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    console.error("[api-keys] revoke failed", error);
    return NextResponse.json({ error: "Could not revoke the key" }, { status: 500 });
  }

  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ ok: true, key: data });
}
