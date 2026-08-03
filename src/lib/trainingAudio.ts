import { createAdminClient } from "@/lib/supabase/admin";

export const TRAINING_AUDIO_BUCKET = "training-audio";

/** 100 MB, matching the bucket's own file_size_limit set in migration 0056. */
export const MAX_AUDIO_BYTES = 104_857_600;

/**
 * Audio types the player can actually play, and that we are willing to store.
 *
 * An allowlist rather than a "not executable" denylist: the set of things a
 * browser will happily execute is open-ended, and the set of audio formats
 * worth accepting is three entries long.
 */
export const ALLOWED_AUDIO_MIME = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
]);

/** Seconds a signed playback URL stays valid. */
const SIGNED_URL_TTL_SECONDS = 60 * 60;

/**
 * Strip a filename down to something safe to place in an object path.
 *
 * The stored name is cosmetic — the module id is what makes the path unique —
 * so it can be reduced hard without losing anything that matters.
 */
export function safeAudioFileName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9.\-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+/, "")
    .slice(-120);
  return cleaned || "recording.mp3";
}

/** Object path for a module's recording: <module_id>/<filename>. */
export function audioObjectPath(moduleId: string, fileName: string): string {
  return `${moduleId}/${safeAudioFileName(fileName)}`;
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
 * Returns null rather than throwing — a module whose audio will not sign
 * should render without a player, not take the page down.
 */
export async function signedAudioUrl(
  storagePath: string | null
): Promise<string | null> {
  if (!storagePath) return null;

  const admin = createAdminClient();
  const { data, error } = await admin.storage
    .from(TRAINING_AUDIO_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);

  if (error || !data?.signedUrl) {
    console.error("training audio: could not sign url", error);
    return null;
  }
  return data.signedUrl;
}
