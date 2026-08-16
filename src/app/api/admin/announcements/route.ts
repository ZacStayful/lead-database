import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminRequest } from "@/lib/trainingAdmin";
import { validateAnnouncementWrite } from "@/lib/announcements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Create an announcement. Admin only; writes on the service role.
 *
 * Always created as a draft — `status` is not readable from the body, so there
 * is no shape of request that creates something already sent. Sending is a
 * separate, explicitly confirmed call to .../[id]/send.
 */
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

  const parsed = validateAnnouncementWrite(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("announcements")
    .insert({ ...parsed.value, status: "draft" })
    .select("id")
    .single();

  if (error) {
    console.error("admin announcement create failed", error);
    return NextResponse.json(
      { error: "Could not create announcement." },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, id: data.id });
}
