import { createAdminClient } from "@/lib/supabase/admin";

export const TRAINING_MEDIA_BUCKET = "training-media";

/** 500 MB, matching the bucket's file_size_limit set in migration 0057. */
export const MAX_MEDIA_BYTES = 524_288_000;

/**
 * Formats the player can actually play, and that we are willing to store.
 *
 * An allowlist rather than a "not executable" denylist: the set of things a
 * browser will happily execute is open-ended, and the set of recording formats
 * worth accepting is short.
 *
 * video/quicktime is here because a .mov straight off a Mac is the single most
 * likely thing to be dragged into this form, and rejecting it would look like a
 * bug rather than a policy.
 */
export const ALLOWED_MEDIA_MIME = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);

/** Seconds a signed playback URL stays valid. */
const PLAYBACK_URL_TTL_SECONDS = 60 * 60;

/** Seconds an admin has to complete an upload once the URL is minted. */
const UPLOAD_URL_TTL_SECONDS = 60 * 60 * 2;

/** True when this recording should render in a video element rather than an audio bar. */
export function isVideoMime(mime: string | null | undefined): boolean {
  return Boolean(mime && mime.startsWith("video/"));
}

/**
 * Strip a filename down to something safe to place in an object path.
 *
 * The stored name is cosmetic — the module id is what makes the path unique —
 * so it can be reduced hard without losing anything that matters.
 */
export function safeMediaFileName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9.\-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+/, "")
    .slice(-120);
  return cleaned || "recording";
}

/** Object path for a module's recording: <module_id>/<filename>. */
export function mediaObjectPath(moduleId: string, fileName: string): string {
  return `${moduleId}/${safeMediaFileName(fileName)}`;
}

/**
 * Mint a short-lived upload URL so the browser can send the file straight to
 * Storage.
 *
 * This is not an optimisation. A Vercel serverless function caps its request
 * body at 4.5 MB, so a file routed through the API would fail well below the
 * size of any real web meeting capture — and would fail as an opaque platform
 * error rather than a message the admin could act on. Signing the upload keeps
 * Vercel out of the data path entirely, which is also why the bucket needs no
 * INSERT policy: the signature is the authorisation.
 */
export async function createMediaUploadUrl(
  storagePath: string
): Promise<{ path: string; token: string } | null> {
  const admin = createAdminClient();

  // Replacing an existing recording at the same path needs the old object gone
  // first — createSignedUploadUrl refuses a path that is already occupied.
  await admin.storage.from(TRAINING_MEDIA_BUCKET).remove([storagePath]);

  const { data, error } = await admin.storage
    .from(TRAINING_MEDIA_BUCKET)
    .createSignedUploadUrl(storagePath, { upsert: true });

  if (error || !data?.token) {
    console.error("training media: could not sign upload url", error);
    return null;
  }
  return { path: data.path ?? storagePath, token: data.token };
}

/**
 * Mint a short-lived playback URL for a stored recording.
 *
 * The bucket is private and stays private: these are recordings of real,
 * identifiable people, and a public object URL would work for anyone who has
 * it, forever, with no login. A signed URL is minted per page render on the
 * server, only for a customer who has already passed the page's auth check,
 * and expires within the hour.
 *
 * Returns null rather than throwing — a module whose recording will not sign
 * should render without a player, not take the page down.
 */
export async function signedMediaUrl(
  storagePath: string | null
): Promise<string | null> {
  if (!storagePath) return null;

  const admin = createAdminClient();
  const { data, error } = await admin.storage
    .from(TRAINING_MEDIA_BUCKET)
    .createSignedUrl(storagePath, PLAYBACK_URL_TTL_SECONDS);

  if (error || !data?.signedUrl) {
    console.error("training media: could not sign playback url", error);
    return null;
  }
  return data.signedUrl;
}

export { UPLOAD_URL_TTL_SECONDS };
