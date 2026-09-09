/**
 * Revoking one of the caller's own inbound lead webhooks (§48).
 *
 * Session-only, for the reason given in ../route.ts.
 *
 * A STAMP, NEVER A DELETE, following the API keys route. The row is what says
 * this webhook existed and when it was last used, which is exactly the evidence
 * wanted if the URL turns out to have leaked — and `customer_lead_webhook_claims`
 * carries an FK to it, so deleting would either fail or orphan the idempotency
 * record of everything it ever created.
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
    .from("customer_lead_webhooks")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", params.id)
    .eq("customer_id", customer.id)
    .is("revoked_at", null)
    .select("id, name, revoked_at")
    .maybeSingle();

  if (error) {
    // An invalid uuid arrives as a cast failure. Same 404 as a foreign id: this
    // route must not confirm which webhook ids exist.
    if (error.code === "22P02") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    console.error("[lead-webhooks] revoke failed", error);
    return NextResponse.json({ error: "Could not revoke the webhook" }, { status: 500 });
  }

  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ ok: true, webhook: data });
}
