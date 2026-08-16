import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentCustomer } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Dismiss an announcement banner for the signed-in customer.
 *
 * The §8 pattern: identity resolved from the SESSION and never from the body,
 * then written on the service role. There is no customer id parameter, so
 * there is no request that dismisses somebody else's banner.
 *
 * Upsert rather than insert: dismissing twice — a double click, or the same
 * account open in two tabs — is an ordinary thing to do and should not be an
 * error the browser has to interpret.
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
    .from("announcement_dismissals")
    .upsert(
      { announcement_id: params.id, customer_id: customer.id },
      { onConflict: "announcement_id,customer_id" }
    );

  if (error) {
    console.error("announcement dismiss failed", error);
    return NextResponse.json({ error: "Could not dismiss." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
