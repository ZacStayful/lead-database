import type { TrainingContentType, TrainingLeadTypeScope } from "@/lib/types";

/**
 * Hosts permitted to appear in a training module's embed URL.
 *
 * This list is the ONLY thing standing between an admin form field and an
 * arbitrary iframe rendered inside every subscriber's portal session. It is
 * enforced twice on purpose — once in the write route so bad values never
 * reach the database, and again at render so a row that predates the check (or
 * arrives by any other path) still cannot produce a frame. Never render a
 * stored video_url without calling isAllowedEmbedUrl on it first.
 */
const ALLOWED_EMBED_HOSTS = new Set([
  "loom.com",
  "www.loom.com",
  "youtube.com",
  "www.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
  "player.vimeo.com",
  "vimeo.com",
  "www.vimeo.com",
]);

/**
 * True when the URL is https and its host is on the allowlist.
 *
 * Host equality, never `endsWith` — "notloom.com" and "loom.com.evil.test"
 * both pass a suffix test and neither is Loom. An unparseable URL is refused
 * rather than allowed through as a string.
 */
export function isAllowedEmbedUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  // Credentials in an embed URL are never legitimate. Such a URL does resolve
  // to its stated host — the userinfo is everything before the LAST '@', so
  // this is not a bypass — but it reads like one, and refusing it costs
  // nothing.
  if (url.username || url.password) return false;
  return ALLOWED_EMBED_HOSTS.has(url.hostname.toLowerCase());
}

/** Lowercase letters, digits and single hyphens — the slug used in the URL. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidSlug(value: string): boolean {
  return SLUG_PATTERN.test(value);
}

/** Derive a slug from a title. Editable afterwards — this is only the default. */
export function slugFromTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * The publish-time integrity rules, mirrored from the table CHECK.
 *
 * Duplicated deliberately: the constraint is the real guard, but a raw Postgres
 * violation reaches the admin as an opaque string naming a constraint. This
 * returns the same verdict in words a person can act on. Returns null when the
 * module is publishable.
 */
export function publishBlocker(module: {
  content_type: TrainingContentType;
  is_published: boolean;
  video_url?: string | null;
  video_provider?: string | null;
  media_storage_path?: string | null;
  body_markdown?: string | null;
}): string | null {
  if (!module.is_published) return null;

  if (module.content_type === "video") {
    if (!module.video_url || !module.video_provider) {
      return "A published video needs both a provider and an embed URL.";
    }
  }

  if (module.content_type === "recording") {
    if (!module.media_storage_path) {
      return "A published recording needs an uploaded file.";
    }
  }

  if (module.content_type === "article") {
    if (!module.body_markdown || module.body_markdown.trim() === "") {
      return "A published article needs a body.";
    }
  }

  return null;
}

export const CONTENT_TYPES: TrainingContentType[] = ["video", "recording", "article"];
export const LEAD_TYPE_SCOPES: TrainingLeadTypeScope[] = [
  "both",
  "management",
  "guaranteed_rent",
];
export const VIDEO_PROVIDERS = ["loom", "youtube", "vimeo"] as const;

/** Words per minute used to estimate an article's read time. */
const READING_WPM = 220;

export function readMinutes(body: string | null | undefined): number {
  if (!body) return 1;
  const words = body.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / READING_WPM));
}

/**
 * "6 min" from a duration in seconds. Rounded up, and never to zero — a
 * ninety-second clip reading "0 min" would look broken rather than short.
 */
export function formatDuration(seconds: number | null | undefined): string | null {
  if (!seconds || seconds <= 0) return null;
  return `${Math.max(1, Math.ceil(seconds / 60))} min`;
}

/** Two-digit ordinal for the list — position in the list, not sort_order. */
export function ordinal(index: number): string {
  return String(index + 1).padStart(2, "0");
}

// ---------------------------------------------------------------------------
// Media formats and limits.
//
// These live here rather than in lib/trainingMedia.ts because the admin upload
// form is a client component and needs them, and trainingMedia.ts imports the
// service-role client — nothing reachable from a "use client" file may pull
// that into the browser bundle. trainingMedia.ts re-exports them so server
// callers keep one import site.
// ---------------------------------------------------------------------------

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

/** True when this recording should render in a video element, not an audio bar. */
export function isVideoMime(mime: string | null | undefined): boolean {
  return Boolean(mime && mime.startsWith("video/"));
}

/**
 * Per-kind upload ceilings (0061 raises the bucket to 2 GB to match).
 *
 * One 500 MB limit for everything was the wrong shape. A 10-minute call
 * recording is ~15 MB, so 500 MB let through anything a mistake could produce;
 * a 40-minute web meeting at a high bitrate runs past 500 MB, so the same
 * number rejected the main thing this feature exists to carry — and rejected it
 * only after the admin had waited out the whole upload.
 *
 * Both sit under the bucket's hard limit, so the app refuses first and can say
 * why rather than surfacing a storage error.
 */
export const MAX_AUDIO_BYTES = 100 * 1024 * 1024; // 100 MB
export const MAX_VIDEO_BYTES = 1536 * 1024 * 1024; // 1.5 GB

export function maxBytesForMime(mime: string): number {
  return isVideoMime(mime) ? MAX_VIDEO_BYTES : MAX_AUDIO_BYTES;
}

/** "1.4 GB" / "480 MB" — for limit messages and the admin list. */
export function formatMediaBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Canonical Content-Type for a file, derived from its extension.
 *
 * `File.type` cannot be trusted for this. Browsers report an MP3 as
 * `audio/mpeg`, `audio/mp3` or an empty string depending on platform and OS
 * registry, and an empty string fails the allowlist — so the same recording
 * uploads fine on one machine and is refused as "unsupported" on another. The
 * extension is the one thing that travels with the file.
 *
 * Falls back to the browser's guess for anything not listed, so the allowlist
 * stays the single gate on what is acceptable.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

export function resolveMediaMime(fileName: string, browserType: string): string {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  return MIME_BY_EXTENSION[ext] ?? browserType;
}
