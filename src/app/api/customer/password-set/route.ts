import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/customer/password-set — stamps customers.password_set_at (0165)
 * after /reset-password has set a password (batch 02 Phase 5, C2). That stamp
 * is what takes a funnel customer's "set a password" card away.
 *
 * SESSION ONLY, and it takes no body: whose row is decided by the signed-in
 * user and nothing the browser sends. Under an admin's view-as (§62) the
 * middleware refuses it like every other write, so viewing a customer can
 * never stamp them. First stamp wins.
 */
export async function POST() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { error } = await createAdminClient()
    .from("customers")
    .update({ password_set_at: new Date().toISOString() })
    .eq("user_id", user.id)
    .is("password_set_at", null);
  if (error) {
    console.error("[password-set] stamp failed", error.message);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
