import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { signedMediaUrl } from "@/lib/trainingMedia";
import type { TrainingModule } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Issue a fresh signed playback URL for one module's recording.
 *
 * The module page already renders with a signed URL baked in, so this is not
 * the normal path — it is how a player recovers when its URL has expired under
 * a tab left open longer than the TTL. The alternative, pointing the media
 * element at a route that redirects per request, would re-enter serverless on
 * every seek through a 40-minute video.
 *
 * Entitlement is re-checked rather than trusted from the original render: the
 * page could have been rendered before a subscription lapsed. It mirrors the
 * scope filter on /dashboard/training — a module scoped to one product is only
 * for customers who hold it.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { moduleId: string } }
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  const { data: customer } = await admin
    .from("customers")
    .select("subscription_status, gr_subscription_status")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!customer) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { data } = await admin
    .from("training_modules")
    .select("*")
    .eq("id", params.moduleId)
    .maybeSingle();

  const module = data as TrainingModule | null;

  const scopeOk =
    module?.lead_type_scope === "both" ||
    (module?.lead_type_scope === "management" &&
      customer.subscription_status === "active") ||
    (module?.lead_type_scope === "guaranteed_rent" &&
      customer.gr_subscription_status === "active");

  // A single 404 covers "no such module", "not published", "not for your
  // product" and "no recording attached", so this cannot be used to enumerate
  // training the caller is not entitled to.
  if (!module || !module.is_published || !scopeOk || !module.media_storage_path) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const url = await signedMediaUrl(module.media_storage_path);
  if (!url) {
    return NextResponse.json({ error: "Could not sign URL" }, { status: 400 });
  }

  return NextResponse.json({ ok: true, url });
}
