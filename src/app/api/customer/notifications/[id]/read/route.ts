import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentCustomer } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Mark one of the signed-in customer's notifications read (§63.6) — the
 * dismiss on the new-lead card.
 *
 * The §8 pattern: identity resolved from the SESSION and never from the body,
 * then written on the service role. The update is scoped to `customer_id`, so
 * there is no request that reads somebody else's notification. Idempotent: a
 * row already read matches nothing and that is not an error.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { user, customer } = await getCurrentCustomer();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!customer) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", params.id)
    .eq("customer_id", customer.id)
    .is("read_at", null);

  if (error) {
    console.error("notification read failed", error);
    return NextResponse.json({ error: "Could not update." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
