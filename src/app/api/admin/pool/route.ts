import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/pool — force a lead into or out of the expired leads pool.
 *
 * Body: { lead_id, action: "in" | "out" }
 *
 * Both directions are sticky in the sense that matters: forcing a lead out sets
 * pool_excluded_at so the next morning's sweep does not simply undo it, and
 * forcing one in clears that marker. Every rule lives in the two RPCs — a
 * claimed lead cannot be returned to the pool, a withdrawn lead cannot be
 * pooled at all — so this route authenticates and relays.
 */
export async function POST(req: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!isAdminUser(user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let lead_id: string | undefined;
  let action: string | undefined;
  try {
    ({ lead_id, action } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!lead_id) {
    return NextResponse.json({ error: "lead_id required" }, { status: 400 });
  }
  if (action !== "in" && action !== "out") {
    return NextResponse.json(
      { error: 'action must be "in" or "out"' },
      { status: 400 }
    );
  }

  const admin = createAdminClient();
  const { error } = await admin.rpc(
    action === "in" ? "admin_pool_force_in" : "admin_pool_force_out",
    { p_lead_id: lead_id }
  );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true, action });
}
