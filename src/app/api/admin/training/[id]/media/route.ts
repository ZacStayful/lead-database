import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminRequest } from "@/lib/trainingAdmin";
import {
  TRAINING_MEDIA_BUCKET,
  ALLOWED_MEDIA_MIME,
  MAX_MEDIA_BYTES,
  createMediaUploadUrl,
  mediaObjectPath,
} from "@/lib/trainingMedia";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Upload is two calls, and the file passes through neither of them.
 *
 *   POST → validate the intent, mint a signed upload URL, hand back a token.
 *          The browser then sends the bytes directly to Supabase Storage.
 *   PUT  → the browser reports the upload landed; record the path on the row.
 *
 * The file never touches this server on purpose. A Vercel function caps its
 * request body at 4.5 MB, so a captured web meeting routed through the API
 * would fail — and fail as a platform error with no useful message. Signing
 * the upload keeps Vercel out of the data path, and the bucket still grants no
 * write access to anybody: the signature is the authorisation.
 *
 * The row is only updated after the upload is confirmed, so a cancelled or
 * failed upload leaves the module pointing at whatever it pointed at before.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let body: { fileName?: unknown; mimeType?: unknown; size?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const fileName = typeof body.fileName === "string" ? body.fileName : "";
  const mimeType = typeof body.mimeType === "string" ? body.mimeType : "";
  const size = Number(body.size);

  if (!fileName) {
    return NextResponse.json({ error: "No file name provided" }, { status: 400 });
  }
  if (!ALLOWED_MEDIA_MIME.has(mimeType)) {
    return NextResponse.json(
      {
        error:
          "That file type is not supported. Upload MP4, MOV, WebM, MP3, M4A or WAV.",
      },
      { status: 400 }
    );
  }
  // Checked here as well as by the bucket, so an admin who picks a two-hour
  // recording is told before waiting for the upload to fail.
  if (Number.isFinite(size) && size > MAX_MEDIA_BYTES) {
    return NextResponse.json(
      { error: "Recordings must be 500 MB or smaller." },
      { status: 400 }
    );
  }

  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("training_modules")
    .select("id")
    .eq("id", params.id)
    .maybeSingle();

  if (!existing) {
    return NextResponse.json({ error: "Module not found" }, { status: 404 });
  }

  const path = mediaObjectPath(params.id, fileName);
  const signed = await createMediaUploadUrl(path);

  if (!signed) {
    return NextResponse.json(
      { error: "Could not start the upload." },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    bucket: TRAINING_MEDIA_BUCKET,
    path: signed.path,
    token: signed.token,
  });
}

/** Commit a completed upload to the module row. */
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let body: { path?: unknown; mimeType?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const path = typeof body.path === "string" ? body.path : "";
  const mimeType = typeof body.mimeType === "string" ? body.mimeType : "";

  if (!ALLOWED_MEDIA_MIME.has(mimeType)) {
    return NextResponse.json({ error: "Unsupported file type" }, { status: 400 });
  }
  // The path is rebuilt from the module id rather than trusted, so a caller
  // cannot point a module at an arbitrary object elsewhere in the bucket.
  if (!path.startsWith(`${params.id}/`)) {
    return NextResponse.json({ error: "Invalid upload path" }, { status: 400 });
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
    .update({
      media_storage_path: path,
      media_mime_type: mimeType,
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.id);

  if (error) {
    console.error("training media: uploaded but row not updated", error);
    return NextResponse.json(
      { error: "Uploaded, but the module could not be updated." },
      { status: 500 }
    );
  }

  // A replacement under a different filename leaves the old object behind.
  // Remove it only after the row points at the new one — in that order a
  // failure here costs storage rather than playback.
  if (existing.media_storage_path && existing.media_storage_path !== path) {
    const { error: removeError } = await admin.storage
      .from(TRAINING_MEDIA_BUCKET)
      .remove([existing.media_storage_path]);
    if (removeError) {
      console.error("training media: orphaned previous object", removeError);
    }
  }

  return NextResponse.json({ ok: true, path });
}
