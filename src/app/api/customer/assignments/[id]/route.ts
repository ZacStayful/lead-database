import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { PIPELINE_STAGES } from "@/components/dashboard/pipelineStage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PIPELINE_VALUES = new Set(PIPELINE_STAGES.map((s) => s.value));

/**
 * Update the authenticated customer's own lead assignment.
 * Supports: mark viewed (viewed_at), mark contacted (status), set the
 * pipeline_stage, and set/clear the due_to_call_date.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    viewed?: boolean;
    contacted?: boolean;
    pipeline_stage?: string;
    due_to_call_date?: string | null;
    income_estimate?: number | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (
    body.income_estimate !== undefined &&
    body.income_estimate !== null &&
    !Number.isFinite(body.income_estimate)
  ) {
    return NextResponse.json(
      { error: "income_estimate must be a number" },
      { status: 400 }
    );
  }

  if (
    body.pipeline_stage !== undefined &&
    !PIPELINE_VALUES.has(body.pipeline_stage as never)
  ) {
    return NextResponse.json(
      { error: "Invalid pipeline_stage" },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  // Confirm ownership before mutating.
  const { data: assignment } = await admin
    .from("lead_assignments")
    .select("id, customer_id, viewed_at, customers!inner(user_id)")
    .eq("id", params.id)
    .maybeSingle();

  const ownerId = (assignment as { customers?: { user_id?: string } } | null)
    ?.customers?.user_id;

  if (!assignment || ownerId !== user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const update: Record<string, unknown> = {};
  if (body.viewed && !(assignment as { viewed_at?: string }).viewed_at) {
    update.viewed_at = new Date().toISOString();
  }
  if (body.contacted) {
    update.status = "contacted";
  }
  if (body.pipeline_stage !== undefined) {
    update.pipeline_stage = body.pipeline_stage;
  }
  if (body.due_to_call_date !== undefined) {
    // Empty string clears the date.
    update.due_to_call_date = body.due_to_call_date || null;
  }
  if (body.income_estimate !== undefined) {
    update.income_estimate =
      body.income_estimate === null ? null : Number(body.income_estimate);
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ status: "noop" });
  }

  const { data, error } = await admin
    .from("lead_assignments")
    .update(update)
    .eq("id", params.id)
    .select(
      "id, viewed_at, status, pipeline_stage, due_to_call_date, income_estimate"
    )
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true, assignment: data });
}
