import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";
import { capacitySettingKey, toCapacityProduct } from "@/lib/capacity";

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

/**
 * Update a product's subscriber cap in system_settings.
 *
 * `product` selects which key is written — `max_active_customers` for
 * management (the default, so existing callers are unaffected) or
 * `gr_max_active_customers` for Guaranteed Rent. The mapping lives in
 * `lib/capacity` beside the code that reads these keys, so a request can never
 * name a key the reader does not know about.
 *
 * Upsert rather than update: an `update` against a key that was never seeded
 * matches zero rows and still returns success, which would report a saved
 * capacity that is not stored anywhere.
 */
export async function POST(req: NextRequest) {
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let capacity: unknown;
  let product: unknown;
  try {
    ({ capacity, product } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof capacity !== "number" || capacity < 1) {
    return NextResponse.json({ error: "Invalid capacity value" }, { status: 400 });
  }

  const leadType = toCapacityProduct(product ?? "management");
  if (!leadType) {
    return NextResponse.json({ error: "Invalid product" }, { status: 400 });
  }

  const value = Math.floor(capacity);
  const admin = createAdminClient();
  const { error } = await admin.from("system_settings").upsert(
    {
      key: capacitySettingKey(leadType),
      value: value.toString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" }
  );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, capacity: value, product: leadType });
}
