import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ProgressEvent = "started" | "completed" | "uncompleted";

/**
 * Record the authenticated customer's progress against a training module.
 *
 * Auth and ownership follow PATCH /api/customer/assignments/[id]: identity
 * comes from the session client, the write happens on the service role, and
 * the customer id is resolved from auth.uid() here rather than accepted from
 * the body — a customer_id in the request would be a way to write progress
 * onto somebody else's row.
 *
 * training_progress has a SELECT-only policy, so this route is the only way
 * progress is ever written.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { moduleId: string } }
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { event?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const event = body.event;
  if (event !== "started" && event !== "completed" && event !== "uncompleted") {
    return NextResponse.json(
      { error: "event must be started, completed or uncompleted" },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  const { data: customer } = await admin
    .from("customers")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  // Only published modules accrue progress. An unpublished module is invisible
  // to customers everywhere else, and this is the one route that would
  // otherwise confirm a draft's existence by id.
  const { data: module } = await admin
    .from("training_modules")
    .select("id")
    .eq("id", params.moduleId)
    .eq("is_published", true)
    .maybeSingle();

  if (!module) {
    return NextResponse.json({ error: "Module not found" }, { status: 404 });
  }

  const { data: existing } = await admin
    .from("training_progress")
    .select("id, started_at, completed_at")
    .eq("customer_id", customer.id)
    .eq("module_id", params.moduleId)
    .maybeSingle();

  const now = new Date().toISOString();
  const patch = buildPatch(event as ProgressEvent, existing ?? null, now);

  if (existing) {
    const { error } = await admin
      .from("training_progress")
      .update({ ...patch, updated_at: now })
      .eq("id", existing.id);

    if (error) {
      console.error("training progress update failed", error);
      return NextResponse.json({ error: "Could not save progress." }, { status: 500 });
    }
  } else {
    const { error } = await admin.from("training_progress").insert({
      customer_id: customer.id,
      module_id: params.moduleId,
      ...patch,
    });

    if (error) {
      console.error("training progress insert failed", error);
      return NextResponse.json({ error: "Could not save progress." }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true });
}

/**
 * The state change each event implies.
 *
 * `started_at` is written once and never rewritten — it is the first time this
 * customer opened the module, and reopening it does not make that later. That
 * is why `started` on an existing row is a no-op rather than a touch: the
 * detail page fires it on every mount.
 *
 * `uncompleted` clears the completion but keeps `started_at`, because undoing
 * a tick does not mean the module was never opened.
 */
function buildPatch(
  event: ProgressEvent,
  existing: { started_at: string | null; completed_at: string | null } | null,
  now: string
): { started_at?: string | null; completed_at?: string | null } {
  if (event === "started") {
    return existing?.started_at ? {} : { started_at: now };
  }

  if (event === "completed") {
    // Backfill started_at for anyone who reaches completion without the mount
    // event having landed — a fire-and-forget write is allowed to be missing.
    return {
      completed_at: now,
      ...(existing?.started_at ? {} : { started_at: now }),
    };
  }

  return { completed_at: null };
}
