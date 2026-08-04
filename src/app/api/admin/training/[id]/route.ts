import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  isAdminRequest,
  validateTrainingWrite,
  publishError,
} from "@/lib/trainingAdmin";
import { TRAINING_MEDIA_BUCKET } from "@/lib/trainingMedia";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Update a training module. Admin only; writes on the service role. */
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

  const parsed = validateTrainingWrite(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const admin = createAdminClient();

  const { data: existing } = await admin
    .from("training_modules")
    .select("id, media_storage_path")
    .eq("id", params.id)
    .maybeSingle();

  if (!existing) {
    return NextResponse.json({ error: "Module not found" }, { status: 404 });
  }

  // The media path is read from the stored row, never the request body, so a
  // caller cannot point a module at an arbitrary object in the bucket.
  const blocker = publishError(parsed.value, existing.media_storage_path);
  if (blocker) {
    return NextResponse.json({ error: blocker }, { status: 400 });
  }

  const { error } = await admin
    .from("training_modules")
    .update({ ...parsed.value, updated_at: new Date().toISOString() })
    .eq("id", params.id);

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json(
        { error: "That slug is already in use." },
        { status: 409 }
      );
    }
    console.error("admin training update failed", error);
    return NextResponse.json({ error: "Could not save module." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

/** Delete a module, and its recording if it has one. */
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const admin = createAdminClient();

  const { data: existing } = await admin
    .from("training_modules")
    .select("id, media_storage_path")
    .eq("id", params.id)
    .maybeSingle();

  if (!existing) {
    return NextResponse.json({ error: "Module not found" }, { status: 404 });
  }

  const { error } = await admin
    .from("training_modules")
    .delete()
    .eq("id", params.id);

  if (error) {
    console.error("admin training delete failed", error);
    return NextResponse.json({ error: "Could not delete module." }, { status: 500 });
  }

  // Best effort, and after the row is gone. An orphaned object costs storage;
  // a deleted object with a surviving row would be a module that renders a
  // broken player. Failing the request here would report a delete that did
  // happen as a failure.
  if (existing.media_storage_path) {
    const { error: removeError } = await admin.storage
      .from(TRAINING_MEDIA_BUCKET)
      .remove([existing.media_storage_path]);
    if (removeError) {
      console.error("admin training: orphaned media object", removeError);
    }
  }

  return NextResponse.json({ ok: true });
}
