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
  audio_storage_path?: string | null;
  body_markdown?: string | null;
}): string | null {
  if (!module.is_published) return null;

  if (module.content_type === "video") {
    if (!module.video_url || !module.video_provider) {
      return "A published video needs both a provider and an embed URL.";
    }
  }

  if (module.content_type === "audio") {
    if (!module.audio_storage_path) {
      return "A published audio module needs an uploaded recording.";
    }
  }

  if (module.content_type === "article") {
    if (!module.body_markdown || module.body_markdown.trim() === "") {
      return "A published article needs a body.";
    }
  }

  return null;
}

export const CONTENT_TYPES: TrainingContentType[] = ["video", "audio", "article"];
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
