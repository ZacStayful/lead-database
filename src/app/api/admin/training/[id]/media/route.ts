import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminRequest } from "@/lib/trainingAdmin";
import {
  TRAINING_MEDIA_BUCKET,
  ALLOWED_MEDIA_MIME,
  createMediaUploadUrl,
  formatMediaBytes,
  maxBytesForMime,
  mediaObjectPath,
  resolveMediaMime,
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
  const size = Number(body.size);

  if (!fileName) {
    return NextResponse.json({ error: "No file name provided" }, { status: 400 });
  }

  // Re-derived from the name rather than taken from the body, so the row can
  // never describe the object as something it is not, and an MP3 whose
  // File.type came through empty is not rejected as an unsupported format.
  const mimeType = resolveMediaMime(
    fileName,
    typeof body.mimeType === "string" ? body.mimeType : ""
  );

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
  // recording is told before waiting for the upload to fail. Video gets a far
  // larger allowance than audio — see maxBytesForMime.
  const limit = maxBytesForMime(mimeType);
  if (Number.isFinite(size) && size > limit) {
    return NextResponse.json(
      {
        error: `That file is ${formatMediaBytes(size)}. The limit for ${
          mimeType.startsWith("video/") ? "video" : "audio"
        } is ${formatMediaBytes(limit)}.`,
      },
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
    signedUrl: signed.signedUrl,
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

  let body: {
    path?: unknown;
    mimeType?: unknown;
    fileName?: unknown;
    size?: unknown;
    durationSeconds?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const path = typeof body.path === "string" ? body.path : "";
  const fileName = typeof body.fileName === "string" ? body.fileName : "";
  const mimeType = resolveMediaMime(
    fileName || path,
    typeof body.mimeType === "string" ? body.mimeType : ""
  );

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

  // Duration is probed in the browser off the media element before upload, so
  // the admin no longer types it in. Null when the browser would not parse the
  // file — it is a label, never a gate, so a missing value costs nothing.
  const duration = Number(body.durationSeconds);
  const size = Number(body.size);

  const { error } = await admin
    .from("training_modules")
    .update({
      media_storage_path: path,
      media_mime_type: mimeType,
      media_file_name: fileName || null,
      media_size_bytes: Number.isFinite(size) && size > 0 ? Math.round(size) : null,
      ...(Number.isFinite(duration) && duration > 0
        ? { media_duration_seconds: Math.round(duration) }
        : {}),
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
