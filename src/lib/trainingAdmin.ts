import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isAdminUser } from "@/lib/auth";
import {
  isAllowedEmbedUrl,
  isValidSlug,
  publishBlocker,
  CONTENT_TYPES,
  LEAD_TYPE_SCOPES,
  VIDEO_PROVIDERS,
} from "@/lib/training";
import type {
  TrainingContentType,
  TrainingLeadTypeScope,
  TrainingVideoProvider,
} from "@/lib/types";

/**
 * Admin gate for the training write routes.
 *
 * Same shape as every other admin route (see
 * api/admin/customers/[id]/resend-invite): an ADMIN_SECRET_KEY header for
 * scripted callers, otherwise an admin session. Copied rather than shared
 * because that is how the existing routes do it, and a divergent wrapper on
 * one route is worse than a duplicated one.
 */
export async function isAdminRequest(req: NextRequest): Promise<boolean> {
  const key = req.headers.get("x-admin-key");
  if (key && process.env.ADMIN_SECRET_KEY && key === process.env.ADMIN_SECRET_KEY) {
    return true;
  }
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return isAdminUser(user);
}

export type TrainingWrite = {
  slug: string;
  title: string;
  summary: string;
  content_type: TrainingContentType;
  sort_order: number;
  video_provider: TrainingVideoProvider | null;
  video_url: string | null;
  video_duration_seconds: number | null;
  media_duration_seconds: number | null;
  body_markdown: string | null;
  lead_type_scope: TrainingLeadTypeScope;
  is_published: boolean;
};

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNullableInt(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * Validate an admin-submitted module.
 *
 * Everything here is enforced server-side regardless of what the form did.
 * The form's job is to make the rules visible early; this is the one that
 * counts, because a form is a suggestion and a route is a boundary.
 *
 * `media_storage_path` is deliberately absent: it is never set from a JSON
 * body, only by the upload route, so a caller cannot point a module at an
 * arbitrary object in the bucket.
 */
export function validateTrainingWrite(
  body: Record<string, unknown>
): { ok: true; value: TrainingWrite } | { ok: false; error: string } {
  const slug = asTrimmedString(body.slug).toLowerCase();
  const title = asTrimmedString(body.title);
  const summary = asTrimmedString(body.summary);

  if (!title) return { ok: false, error: "Title is required." };
  if (!summary) return { ok: false, error: "Summary is required." };
  if (!slug) return { ok: false, error: "Slug is required." };
  if (!isValidSlug(slug)) {
    return {
      ok: false,
      error: "Slug may contain only lowercase letters, numbers and hyphens.",
    };
  }

  const contentType = asTrimmedString(body.content_type) as TrainingContentType;
  if (!CONTENT_TYPES.includes(contentType)) {
    return { ok: false, error: "Content type must be video, recording or article." };
  }

  const scope = asTrimmedString(body.lead_type_scope) as TrainingLeadTypeScope;
  if (!LEAD_TYPE_SCOPES.includes(scope)) {
    return { ok: false, error: "Lead type scope is not valid." };
  }

  const sortOrder = asNullableInt(body.sort_order);
  if (sortOrder === null) return { ok: false, error: "Sort order must be a number." };

  let videoProvider: TrainingVideoProvider | null = null;
  let videoUrl: string | null = null;

  if (contentType === "video") {
    const provider = asTrimmedString(body.video_provider);
    if (provider) {
      if (!(VIDEO_PROVIDERS as readonly string[]).includes(provider)) {
        return { ok: false, error: "Video provider must be Loom, YouTube or Vimeo." };
      }
      videoProvider = provider as TrainingVideoProvider;
    }

    const url = asTrimmedString(body.video_url);
    if (url) {
      // The allowlist. Refusing here is what stops an arbitrary iframe ever
      // reaching a subscriber's browser — the render-time check is a second
      // line, not the first.
      if (!isAllowedEmbedUrl(url)) {
        return {
          ok: false,
          error:
            "Video URL must be an https embed link on Loom, YouTube or Vimeo.",
        };
      }
      videoUrl = url;
    }
  }

  const isPublished = body.is_published === true;
  const bodyMarkdown = asTrimmedString(body.body_markdown) || null;

  const value: TrainingWrite = {
    slug,
    title,
    summary,
    content_type: contentType,
    sort_order: sortOrder,
    video_provider: videoProvider,
    video_url: videoUrl,
    video_duration_seconds: asNullableInt(body.video_duration_seconds),
    media_duration_seconds: asNullableInt(body.media_duration_seconds),
    body_markdown: bodyMarkdown,
    lead_type_scope: scope,
    is_published: isPublished,
  };

  return { ok: true, value };
}

/**
 * Publish-time check for a write, given whatever media the row already has.
 *
 * The path comes from the stored row rather than the request because the
 * upload is a separate step: an admin publishes a recording whose file was
 * uploaded earlier, and the body never carries the path.
 */
export function publishError(
  value: TrainingWrite,
  existingMediaPath: string | null
): string | null {
  return publishBlocker({
    content_type: value.content_type,
    is_published: value.is_published,
    video_url: value.video_url,
    video_provider: value.video_provider,
    media_storage_path: existingMediaPath,
    body_markdown: value.body_markdown,
  });
}
