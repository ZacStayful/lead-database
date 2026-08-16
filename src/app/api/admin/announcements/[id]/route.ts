import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminRequest } from "@/lib/trainingAdmin";
import { validateAnnouncementWrite } from "@/lib/announcements";
import type { Announcement } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Both handlers refuse once the announcement has been sent.
 *
 * A sent announcement is already in inboxes. Editing it would leave the
 * dashboard banner saying something nobody was emailed, and the delivery log
 * describing the delivery of different words — the record would quietly stop
 * being a record. Deleting it would take the banner away from customers who are
 * still reading it and destroy the only evidence of what was sent to whom.
 *
 * The right way to correct a sent announcement is another announcement.
 */
async function loadEditable(
  id: string
): Promise<
  | { ok: true; announcement: Announcement }
  | { ok: false; status: number; error: string }
> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("announcements")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  const announcement = data as Announcement | null;
  if (!announcement) {
    return { ok: false, status: 404, error: "Announcement not found." };
  }
  if (announcement.status === "sent") {
    return {
      ok: false,
      status: 409,
      error:
        "This announcement has already been sent and cannot be changed. Write a new one instead.",
    };
  }
  return { ok: true, announcement };
}

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

  const loaded = await loadEditable(params.id);
  if (!loaded.ok) {
    return NextResponse.json({ error: loaded.error }, { status: loaded.status });
  }

  const parsed = validateAnnouncementWrite(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("announcements")
    .update({ ...parsed.value, updated_at: new Date().toISOString() })
    .eq("id", params.id);

  if (error) {
    console.error("admin announcement update failed", error);
    return NextResponse.json({ error: "Could not save." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const loaded = await loadEditable(params.id);
  if (!loaded.ok) {
    return NextResponse.json({ error: loaded.error }, { status: loaded.status });
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("announcements")
    .delete()
    .eq("id", params.id);

  if (error) {
    console.error("admin announcement delete failed", error);
    return NextResponse.json({ error: "Could not delete." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
