"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  formatMediaBytes,
  isVideoMime,
  maxBytesForMime,
  resolveMediaMime,
  slugFromTitle,
} from "@/lib/training";
import type {
  TrainingContentType,
  TrainingLeadTypeScope,
  TrainingModule,
  TrainingVideoProvider,
} from "@/lib/types";

const INPUT =
  "mt-1 w-full rounded-md border-[0.5px] border-border bg-background px-3 py-2 text-sm disabled:opacity-60";

/**
 * Read a recording's duration in the browser, before it is uploaded.
 *
 * The file is already in memory here, so this costs nothing. Doing it
 * server-side would mean either an ffmpeg dependency or pulling a 40-minute
 * object back down. Resolves null for anything the browser will not parse —
 * duration is a label on the module, never a gate, so a missing value is fine.
 */
function probeDuration(file: File, mimeType: string): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement(
      mimeType.startsWith("video/") ? "video" : "audio"
    );
    let settled = false;
    const done = (value: number | null) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      resolve(value);
    };
    el.preload = "metadata";
    el.onloadedmetadata = () =>
      done(Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null);
    el.onerror = () => done(null);
    // Some browsers fire neither event for a codec they cannot decode.
    setTimeout(() => done(null), 15000);
    el.src = url;
  });
}

/**
 * PUT the file straight at Storage on the signed URL, reporting progress.
 *
 * XHR rather than fetch purely for `upload.onprogress` — fetch still has no
 * upload progress in any shipping browser, and a 40-minute video takes long
 * enough that a static bar reads as a hang. Resolves an error message, or null
 * on success.
 */
function putSignedUpload(
  signedUrl: string,
  file: File,
  contentType: string,
  onProgress: (pct: number) => void
): Promise<string | null> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", signedUrl);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () =>
      resolve(
        xhr.status >= 200 && xhr.status < 300
          ? null
          : "The upload did not complete. Please try again."
      );
    xhr.onerror = () =>
      resolve("The upload did not complete — check the connection.");
    xhr.send(file);
  });
}

/**
 * Create and edit form for a training module.
 *
 * One component in both modes: a create posts to /api/admin/training, an edit
 * patches /api/admin/training/[id]. The fields are identical, and keeping them
 * in one place is what stops the two drifting.
 *
 * The upload only appears in edit mode. A recording is stored under the
 * module's id, so the module has to exist before a file can belong to it —
 * create first, then upload.
 */
export function AdminTrainingForm({
  module,
  existingSlugs,
}: {
  /** Undefined in create mode. */
  module?: TrainingModule;
  /** Every other module's slug, for the non-blocking collision warning. */
  existingSlugs: string[];
}) {
  const router = useRouter();
  const isEdit = Boolean(module);

  const [title, setTitle] = useState(module?.title ?? "");
  const [slug, setSlug] = useState(module?.slug ?? "");
  // Once the slug is edited by hand it stops tracking the title, so a
  // deliberate slug is never overwritten by a later title tweak.
  const [slugTouched, setSlugTouched] = useState(isEdit);
  const [summary, setSummary] = useState(module?.summary ?? "");
  const [contentType, setContentType] = useState<TrainingContentType>(
    module?.content_type ?? "video"
  );
  const [sortOrder, setSortOrder] = useState(String(module?.sort_order ?? 0));
  const [scope, setScope] = useState<TrainingLeadTypeScope>(
    module?.lead_type_scope ?? "both"
  );
  const [published, setPublished] = useState(module?.is_published ?? false);
  const [provider, setProvider] = useState<TrainingVideoProvider | "">(
    module?.video_provider ?? ""
  );
  const [videoUrl, setVideoUrl] = useState(module?.video_url ?? "");
  const [videoDuration, setVideoDuration] = useState(
    module?.video_duration_seconds ? String(module.video_duration_seconds) : ""
  );
  const [mediaDuration, setMediaDuration] = useState(
    module?.media_duration_seconds ? String(module.media_duration_seconds) : ""
  );
  const [bodyMarkdown, setBodyMarkdown] = useState(module?.body_markdown ?? "");

  const [mediaPath, setMediaPath] = useState(module?.media_storage_path ?? null);
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const slugCollides = slug !== "" && existingSlugs.includes(slug);

  function onTitleChange(value: string) {
    setTitle(value);
    if (!slugTouched) setSlug(slugFromTitle(value));
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);

    const payload = {
      title,
      slug,
      summary,
      content_type: contentType,
      sort_order: Number(sortOrder) || 0,
      lead_type_scope: scope,
      is_published: published,
      video_provider: contentType === "video" ? provider || null : null,
      video_url: contentType === "video" ? videoUrl || null : null,
      video_duration_seconds: videoDuration || null,
      media_duration_seconds: mediaDuration || null,
      body_markdown: bodyMarkdown || null,
    };

    try {
      const res = await fetch(
        isEdit ? `/api/admin/training/${module!.id}` : "/api/admin/training",
        {
          method: isEdit ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        setError(data?.error ?? "Could not save this module.");
        return;
      }

      if (!isEdit && data?.id) {
        router.push(`/admin/training/${data.id}`);
        return;
      }

      setNotice("Saved");
      router.refresh();
    } catch {
      setError("Could not save this module.");
    } finally {
      setSaving(false);
    }
  }

  /**
   * Upload in two steps, with the file going straight to Supabase Storage.
   *
   * The bytes deliberately never pass through our API. A Vercel function caps
   * its request body at 4.5 MB, so routing a captured web meeting through the
   * server would fail well below the size of any real recording — and fail as
   * an opaque platform error rather than something the admin could act on.
   *
   * The module row is only updated after the upload lands, so a cancelled or
   * failed upload leaves the module pointing where it pointed before.
   */
  async function uploadMedia(file: File) {
    setUploading(true);
    setUploadPercent(0);
    setError(null);
    setNotice(null);

    // Derived from the extension, not File.type: browsers report an MP3 as
    // audio/mpeg, audio/mp3 or an empty string depending on the machine, and
    // an empty string fails the allowlist on the way in.
    const mimeType = resolveMediaMime(file.name, file.type);

    // Refused here as well as server-side, so a 2 GB export is rejected before
    // the admin sits through the upload rather than after.
    const limit = maxBytesForMime(mimeType);
    if (file.size > limit) {
      setError(
        `That file is ${formatMediaBytes(file.size)}. The limit for ${
          isVideoMime(mimeType) ? "video" : "audio"
        } is ${formatMediaBytes(limit)}.`
      );
      setUploading(false);
      setUploadPercent(null);
      return;
    }

    try {
      const startRes = await fetch(`/api/admin/training/${module!.id}/media`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: file.name,
          mimeType,
          size: file.size,
        }),
      });
      const start = await startRes.json().catch(() => null);
      if (!startRes.ok) {
        setError(start?.error ?? "Could not start the upload.");
        return;
      }

      // Read the duration off the file before sending it, so the admin does
      // not have to type it in and it cannot disagree with the recording.
      const durationSeconds = await probeDuration(file, mimeType);

      const uploadError = await putSignedUpload(
        start.signedUrl as string,
        file,
        mimeType,
        setUploadPercent
      );

      if (uploadError) {
        setError(uploadError);
        return;
      }

      setUploadPercent(100);

      const commitRes = await fetch(`/api/admin/training/${module!.id}/media`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: start.path,
          mimeType,
          fileName: file.name,
          size: file.size,
          durationSeconds,
        }),
      });
      const commit = await commitRes.json().catch(() => null);
      if (!commitRes.ok) {
        setError(commit?.error ?? "Uploaded, but the module could not be updated.");
        return;
      }

      setMediaPath(commit.path as string);
      setNotice("Recording uploaded");
      router.refresh();
    } catch {
      setError("Could not upload the recording.");
    } finally {
      setUploading(false);
      setUploadPercent(null);
    }
  }

  async function remove() {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/training/${module!.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? "Could not delete this module.");
        return;
      }
      router.push("/admin/training");
    } catch {
      setError("Could not delete this module.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-5">
      <div>
        <label htmlFor="title" className="text-sm font-medium">
          Title
        </label>
        <input
          id="title"
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          disabled={saving}
          className={INPUT}
        />
      </div>

      <div>
        <label htmlFor="slug" className="text-sm font-medium">
          Slug
        </label>
        <input
          id="slug"
          value={slug}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(e.target.value);
          }}
          disabled={saving}
          className={INPUT}
        />
        {slugCollides && (
          <p className="mt-1 text-sm text-amber-700">
            Another module already uses this slug. Saving will be refused.
          </p>
        )}
      </div>

      <div>
        <label htmlFor="summary" className="text-sm font-medium">
          Summary
        </label>
        <textarea
          id="summary"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          rows={2}
          disabled={saving}
          className={INPUT}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label htmlFor="content_type" className="text-sm font-medium">
            Content type
          </label>
          <select
            id="content_type"
            value={contentType}
            onChange={(e) => setContentType(e.target.value as TrainingContentType)}
            disabled={saving}
            className={INPUT}
          >
            <option value="video">Video</option>
            <option value="recording">Recording (upload)</option>
            <option value="article">Article</option>
          </select>
        </div>

        <div>
          <label htmlFor="sort_order" className="text-sm font-medium">
            Sort order
          </label>
          <input
            id="sort_order"
            type="number"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
            disabled={saving}
            className={INPUT}
          />
        </div>

        <div>
          <label htmlFor="scope" className="text-sm font-medium">
            Applies to
          </label>
          <select
            id="scope"
            value={scope}
            onChange={(e) => setScope(e.target.value as TrainingLeadTypeScope)}
            disabled={saving}
            className={INPUT}
          >
            <option value="both">Both products</option>
            <option value="management">Management</option>
            <option value="guaranteed_rent">Guaranteed Rent</option>
          </select>
        </div>
      </div>

      {contentType === "video" && (
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label htmlFor="provider" className="text-sm font-medium">
              Provider
            </label>
            <select
              id="provider"
              value={provider}
              onChange={(e) =>
                setProvider(e.target.value as TrainingVideoProvider | "")
              }
              disabled={saving}
              className={INPUT}
            >
              <option value="">Not set</option>
              <option value="loom">Loom</option>
              <option value="youtube">YouTube</option>
              <option value="vimeo">Vimeo</option>
            </select>
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="video_url" className="text-sm font-medium">
              Video link
            </label>
            <input
              id="video_url"
              value={videoUrl}
              onChange={(e) => setVideoUrl(e.target.value)}
              placeholder="https://www.loom.com/share/…"
              disabled={saving}
              className={INPUT}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Paste the link straight from Loom&apos;s Copy link button, or a
              YouTube or Vimeo link. It is converted to the embeddable form on
              save, and the provider is filled in from the link.
            </p>
          </div>
          <div>
            <label htmlFor="video_duration" className="text-sm font-medium">
              Duration (seconds)
            </label>
            <input
              id="video_duration"
              type="number"
              value={videoDuration}
              onChange={(e) => setVideoDuration(e.target.value)}
              disabled={saving}
              className={INPUT}
            />
          </div>
        </div>
      )}

      {contentType === "recording" && (
        <div className="space-y-4 rounded-md border-[0.5px] border-border p-4">
          {!isEdit ? (
            <p className="text-sm text-muted-foreground">
              Save this module first, then upload the recording.
            </p>
          ) : (
            <>
              <div>
                <label htmlFor="media" className="text-sm font-medium">
                  Recording
                </label>
                <input
                  id="media"
                  type="file"
                  accept="audio/*,video/*"
                  disabled={uploading || saving}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void uploadMedia(file);
                  }}
                  className={INPUT}
                />
                <p className="mt-1 text-sm text-muted-foreground">
                  {uploading
                    ? uploadPercent === 100
                      ? "Finishing"
                      : "Uploading — this can take a while for video"
                    : mediaPath
                      ? `Stored: ${mediaPath}`
                      : "No recording uploaded yet."}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  MP4, MOV, WebM, MP3, M4A or WAV. Up to 500 MB. The file goes
                  straight to storage, so large videos are fine.
                </p>
              </div>
              <div>
                <label htmlFor="media_duration" className="text-sm font-medium">
                  Duration (seconds)
                </label>
                <input
                  id="media_duration"
                  type="number"
                  value={mediaDuration}
                  onChange={(e) => setMediaDuration(e.target.value)}
                  disabled={saving}
                  className={INPUT}
                />
              </div>
            </>
          )}
        </div>
      )}

      <div>
        <label htmlFor="body" className="text-sm font-medium">
          {contentType === "article" ? "Body" : "Notes (optional)"}
        </label>
        <textarea
          id="body"
          value={bodyMarkdown}
          onChange={(e) => setBodyMarkdown(e.target.value)}
          rows={contentType === "article" ? 18 : 6}
          disabled={saving}
          className={INPUT + " font-mono"}
        />
        <p className="mt-1 text-sm text-muted-foreground">
          Plain text. Blank lines separate paragraphs.
        </p>
      </div>

      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={published}
          onChange={(e) => setPublished(e.target.checked)}
          disabled={saving}
        />
        Published
      </label>

      {error && <p className="text-sm text-red-700">{error}</p>}
      {notice && <p className="text-sm text-muted-foreground">{notice}</p>}

      <div className="flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={saving}
          className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {saving ? "Saving" : isEdit ? "Save changes" : "Create module"}
        </button>

        {isEdit &&
          (confirmDelete ? (
            <>
              <button
                type="button"
                onClick={() => void remove()}
                disabled={deleting}
                className="rounded-md border-[0.5px] border-red-300 bg-red-50 px-4 py-2 text-sm font-medium text-red-700 transition-colors hover:bg-red-100 disabled:opacity-50"
              >
                {deleting ? "Deleting" : "Confirm delete"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
                className="rounded-md px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="rounded-md px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent"
            >
              Delete
            </button>
          ))}
      </div>
    </form>
  );
}
