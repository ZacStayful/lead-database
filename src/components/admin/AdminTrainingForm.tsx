"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { slugFromTitle } from "@/lib/training";
import type {
  TrainingContentType,
  TrainingLeadTypeScope,
  TrainingModule,
  TrainingVideoProvider,
} from "@/lib/types";

const INPUT =
  "mt-1 w-full rounded-md border-[0.5px] border-border bg-background px-3 py-2 text-sm disabled:opacity-60";

/**
 * Create and edit form for a training module.
 *
 * One component in both modes: a create posts to /api/admin/training, an edit
 * patches /api/admin/training/[id]. The fields are identical, and keeping them
 * in one place is what stops the two drifting.
 *
 * The audio upload only appears in edit mode. A recording is stored under the
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
  const [audioDuration, setAudioDuration] = useState(
    module?.audio_duration_seconds ? String(module.audio_duration_seconds) : ""
  );
  const [bodyMarkdown, setBodyMarkdown] = useState(module?.body_markdown ?? "");

  const [audioPath, setAudioPath] = useState(module?.audio_storage_path ?? null);
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
      audio_duration_seconds: audioDuration || null,
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

  async function uploadAudio(file: File) {
    setUploading(true);
    setError(null);
    setNotice(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/admin/training/${module!.id}/audio`, {
        method: "POST",
        body: form,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? "Could not upload the recording.");
        return;
      }
      setAudioPath(data.path as string);
      setNotice("Recording uploaded");
      router.refresh();
    } catch {
      setError("Could not upload the recording.");
    } finally {
      setUploading(false);
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
            <option value="audio">Audio</option>
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
              Embed URL
            </label>
            <input
              id="video_url"
              value={videoUrl}
              onChange={(e) => setVideoUrl(e.target.value)}
              placeholder="https://www.loom.com/embed/…"
              disabled={saving}
              className={INPUT}
            />
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

      {contentType === "audio" && (
        <div className="space-y-4 rounded-md border-[0.5px] border-border p-4">
          {!isEdit ? (
            <p className="text-sm text-muted-foreground">
              Save this module first, then upload the recording.
            </p>
          ) : (
            <>
              <div>
                <label htmlFor="audio" className="text-sm font-medium">
                  Recording
                </label>
                <input
                  id="audio"
                  type="file"
                  accept="audio/*"
                  disabled={uploading || saving}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void uploadAudio(file);
                  }}
                  className={INPUT}
                />
                <p className="mt-1 text-sm text-muted-foreground">
                  {uploading
                    ? "Uploading"
                    : audioPath
                      ? `Stored: ${audioPath}`
                      : "No recording uploaded yet."}
                </p>
              </div>
              <div>
                <label htmlFor="audio_duration" className="text-sm font-medium">
                  Duration (seconds)
                </label>
                <input
                  id="audio_duration"
                  type="number"
                  value={audioDuration}
                  onChange={(e) => setAudioDuration(e.target.value)}
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
