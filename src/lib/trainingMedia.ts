import { createAdminClient } from "@/lib/supabase/admin";

// Formats, limits and mime resolution live in lib/training.ts because the
// admin upload form is a client component and needs them, and this module
// imports the service-role client. Re-exported so server callers still have a
// single import site for everything training-media.
export {
  ALLOWED_MEDIA_MIME,
  isVideoMime,
  maxBytesForMime,
  formatMediaBytes,
  resolveMediaMime,
  MAX_AUDIO_BYTES,
  MAX_VIDEO_BYTES,
} from "@/lib/training";

export const TRAINING_MEDIA_BUCKET = "training-media";


/**
 * Seconds a signed playback URL stays valid.
 *
 * An hour was shorter than the content. A 40-minute meeting watched with a
 * couple of pauses outlives it, and the URL then 400s mid-session with nothing
 * to explain it. Six hours covers any realistic sitting; a tab left open past
 * that recovers through /api/customer/training/[moduleId]/play-url, which
 * re-checks entitlement and mints a fresh one.
 */
const PLAYBACK_URL_TTL_SECONDS = 6 * 60 * 60;

/** Seconds an admin has to complete an upload once the URL is minted. */
const UPLOAD_URL_TTL_SECONDS = 60 * 60 * 2;


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
): Promise<{ path: string; token: string; signedUrl: string } | null> {
  const admin = createAdminClient();

  // Replacing an existing recording at the same path needs the old object gone
  // first — createSignedUploadUrl refuses a path that is already occupied.
  await admin.storage.from(TRAINING_MEDIA_BUCKET).remove([storagePath]);

  const { data, error } = await admin.storage
    .from(TRAINING_MEDIA_BUCKET)
    .createSignedUploadUrl(storagePath, { upsert: true });

  if (error || !data?.token || !data?.signedUrl) {
    console.error("training media: could not sign upload url", error);
    return null;
  }
  // signedUrl is handed to the browser so it can PUT with XHR and report real
  // progress. supabase-js `uploadToSignedUrl` would take the token instead,
  // but it offers no upload progress — and on a 40-minute video that means a
  // bar sitting at 0% for several minutes, which reads as a hang.
  return {
    path: data.path ?? storagePath,
    token: data.token,
    signedUrl: data.signedUrl,
  };
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
