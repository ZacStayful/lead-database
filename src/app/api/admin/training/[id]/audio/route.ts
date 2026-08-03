import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminRequest } from "@/lib/trainingAdmin";
import {
  TRAINING_AUDIO_BUCKET,
  MAX_AUDIO_BYTES,
  ALLOWED_AUDIO_MIME,
  audioObjectPath,
} from "@/lib/trainingAudio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Recordings run to tens of megabytes; the default limit is not enough to
// finish the upload to Storage on a slow connection.
export const maxDuration = 60;

/**
 * Upload a recording for a module.
 *
 * Multipart rather than JSON because the payload is a file, and the upload
 * goes through the server on the service role rather than direct from the
 * browser: the bucket has no INSERT policy for authenticated users at all
 * (migration 0056), so there is exactly one way in and it is gated by the
 * admin check.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected a file upload" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  if (file.size === 0) {
    return NextResponse.json({ error: "That file is empty." }, { status: 400 });
  }
  if (file.size > MAX_AUDIO_BYTES) {
    return NextResponse.json(
      { error: "Recordings must be 100 MB or smaller." },
      { status: 400 }
    );
  }
  if (!ALLOWED_AUDIO_MIME.has(file.type)) {
    return NextResponse.json(
      { error: "That file type is not supported. Upload MP3, M4A, WAV or WebM." },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  const { data: existing } = await admin
    .from("training_modules")
    .select("id, audio_storage_path")
    .eq("id", params.id)
    .maybeSingle();

  if (!existing) {
    return NextResponse.json({ error: "Module not found" }, { status: 404 });
  }

  const path = audioObjectPath(params.id, file.name);

  const { error: uploadError } = await admin.storage
    .from(TRAINING_AUDIO_BUCKET)
    .upload(path, file, { contentType: file.type, upsert: true });

  if (uploadError) {
    console.error("training audio upload failed", uploadError);
    return NextResponse.json({ error: "Could not upload the file." }, { status: 500 });
  }

  const { error: updateError } = await admin
    .from("training_modules")
    .update({ audio_storage_path: path, updated_at: new Date().toISOString() })
    .eq("id", params.id);

  if (updateError) {
    console.error("training audio: uploaded but row not updated", updateError);
    return NextResponse.json(
      { error: "Uploaded, but the module could not be updated." },
      { status: 500 }
    );
  }

  // Replacing a recording with one under a different filename leaves the old
  // object behind. Remove it, but only after the row points at the new one —
  // in that order, a failure here costs storage rather than playback.
  if (existing.audio_storage_path && existing.audio_storage_path !== path) {
    const { error: removeError } = await admin.storage
      .from(TRAINING_AUDIO_BUCKET)
      .remove([existing.audio_storage_path]);
    if (removeError) {
      console.error("training audio: orphaned previous object", removeError);
    }
  }

  return NextResponse.json({ ok: true, path });
}
