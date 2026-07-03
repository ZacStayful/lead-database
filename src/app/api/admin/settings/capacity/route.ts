import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Authorise an admin request. Accepts either the x-admin-key header (for
 * programmatic use) or an authenticated admin session (so the browser admin UI
 * can call this with cookies, without embedding the secret client-side).
 */
async function isAdminRequest(req: NextRequest): Promise<boolean> {
  const key = req.headers.get("x-admin-key");
  if (key && process.env.ADMIN_SECRET_KEY && key === process.env.ADMIN_SECRET_KEY) {
    return true;
  }
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return isAdminUser(user);
}

/** Update max_active_customers in system_settings. */
export async function POST(req: NextRequest) {
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let capacity: unknown;
  try {
    ({ capacity } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof capacity !== "number" || capacity < 1) {
    return NextResponse.json({ error: "Invalid capacity value" }, { status: 400 });
  }

  const value = Math.floor(capacity);
  const admin = createAdminClient();
  const { error } = await admin
    .from("system_settings")
    .update({ value: value.toString(), updated_at: new Date().toISOString() })
    .eq("key", "max_active_customers");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, capacity: value });
}
