import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminRequest } from "@/lib/trainingAdmin";
import { validateCaseStudy, validateCaseEvents } from "@/lib/caseStudyAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Create a case study, with its timeline. Admin only; service-role writes. */
export async function POST(req: NextRequest) {
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

  const { data, error } = await admin
    .from("case_studies")
    .insert(parsed.value)
    .select("id, slug")
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json(
        { error: "That slug is already in use." },
        { status: 409 }
      );
    }
    console.error("case study create failed", error);
    return NextResponse.json({ error: "Could not create case study." }, { status: 500 });
  }

  if (events.value.length > 0) {
    const { error: eventsError } = await admin.rpc("replace_case_study_events", {
      p_case_study_id: data.id,
      p_events: events.value,
    });

    if (eventsError) {
      // The parent exists but has no timeline, which is a half-made record.
      // Remove it rather than leave the admin with a case study that looks
      // saved and is not.
      await admin.from("case_studies").delete().eq("id", data.id);
      console.error("case study events insert failed", eventsError);
      return NextResponse.json(
        { error: "Could not save the timeline. Nothing was created." },
        { status: 500 }
      );
    }
  }

  return NextResponse.json({ ok: true, id: data.id, slug: data.slug });
}
