import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminRequest } from "@/lib/trainingAdmin";
import { validateCaseStudy, validateCaseEvents } from "@/lib/caseStudyAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Update a case study and replace its timeline wholesale.
 *
 * The events array is authoritative: whatever the form sends becomes the stored
 * set. The replacement runs inside replace_case_study_events, a single
 * transaction, so a failure cannot leave a case study with its old events
 * deleted and its new ones not yet written.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = validateCaseStudy(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const events = validateCaseEvents(body.events);
  if (!events.ok) {
    return NextResponse.json({ error: events.error }, { status: 400 });
  }

  const admin = createAdminClient();

  const { data: existing } = await admin
    .from("case_studies")
    .select("id")
    .eq("id", params.id)
    .maybeSingle();

  if (!existing) {
    return NextResponse.json({ error: "Case study not found" }, { status: 404 });
  }

  const { error } = await admin
    .from("case_studies")
    .update({ ...parsed.value, updated_at: new Date().toISOString() })
    .eq("id", params.id);

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json(
        { error: "That slug is already in use." },
        { status: 409 }
      );
    }
    console.error("case study update failed", error);
    return NextResponse.json({ error: "Could not save case study." }, { status: 500 });
  }

  const { error: eventsError } = await admin.rpc("replace_case_study_events", {
    p_case_study_id: params.id,
    p_events: events.value,
  });

  if (eventsError) {
    console.error("case study events replace failed", eventsError);
    return NextResponse.json(
      { error: "Fields were saved but the timeline could not be updated." },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}

/** Delete a case study. Its events cascade — the FK carries ON DELETE CASCADE. */
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const admin = createAdminClient();

  const { data: existing } = await admin
    .from("case_studies")
    .select("id")
    .eq("id", params.id)
    .maybeSingle();

  if (!existing) {
    return NextResponse.json({ error: "Case study not found" }, { status: 404 });
  }

  const { error } = await admin.from("case_studies").delete().eq("id", params.id);

  if (error) {
    console.error("case study delete failed", error);
    return NextResponse.json({ error: "Could not delete case study." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
