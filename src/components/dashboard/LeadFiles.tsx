"use client";

import { useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { formatDateTime } from "@/lib/utils";
import type { LeadFile } from "@/lib/types";
import { FileText, Upload, Trash2, Download } from "lucide-react";

const BUCKET = "lead-files";
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB, matching the bucket limit

function humanSize(bytes: number | null): string {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Attach files (e.g. an STR Analyser PDF) to a lead. Files upload directly to a
 * private Storage bucket from the browser, then their metadata is recorded so
 * they can be listed and re-downloaded later. Drag-and-drop or click to select.
 */
export function LeadFiles({
  assignmentId,
  userId,
  initialFiles,
}: {
  assignmentId: string;
  userId: string;
  initialFiles: LeadFile[];
}) {
  const [files, setFiles] = useState<LeadFile[]>(initialFiles);
  const [dragActive, setDragActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function uploadOne(file: File) {
    if (file.size > MAX_BYTES) {
      setError(`${file.name} is larger than 25 MB.`);
      return;
    }
    const supabase = createClient();
    const safeName = file.name.replace(/[^\w.\-]+/g, "_");
    const path = `${userId}/${assignmentId}/${crypto.randomUUID()}_${safeName}`;

    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, file, {
        contentType: file.type || undefined,
        upsert: false,
      });
    if (upErr) {
      setError(`Could not upload ${file.name}: ${upErr.message}`);
      return;
    }

    const res = await fetch("/api/customer/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lead_assignment_id: assignmentId,
        storage_path: path,
        file_name: file.name,
        size_bytes: file.size,
        mime_type: file.type,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.file) {
      // Roll back the orphaned upload.
      await supabase.storage.from(BUCKET).remove([path]);
      setError(data.error ?? `Could not save ${file.name}`);
      return;
    }
    setFiles((prev) => [data.file as LeadFile, ...prev]);
  }

  async function handleFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    setBusy(true);
    setError(null);
    for (const file of Array.from(list)) {
      await uploadOne(file);
    }
    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function remove(id: string) {
    setFiles((prev) => prev.filter((f) => f.id !== id));
    try {
      await fetch(`/api/customer/files/${id}`, { method: "DELETE" });
    } catch {
      /* non-blocking */
    }
  }

  return (
    <div className="rounded-xl border-[0.5px] border-border bg-card p-6">
      <div className="mb-4 flex items-center gap-2">
        <FileText className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Files</h2>
      </div>

      {/* Drop zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragActive(false);
          void handleFiles(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        className={
          "flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-4 py-8 text-center text-sm transition-colors " +
          (dragActive
            ? "border-brand bg-brand/5 text-brand"
            : "border-border text-muted-foreground hover:bg-muted/40")
        }
      >
        <Upload className="mb-2 h-5 w-5" />
        {busy ? (
          <span>Uploading…</span>
        ) : (
          <span>
            Drag &amp; drop a PDF here, or click to choose a file (up to 25 MB)
          </span>
        )}
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          multiple
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>

      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

      {files.length > 0 && (
        <ul className="mt-4 space-y-2 border-t-[0.5px] border-border pt-4">
          {files.map((f) => (
            <li
              key={f.id}
              className="flex items-center gap-3 rounded-md border-[0.5px] border-border px-3 py-2"
            >
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <a
                  href={`/api/customer/files/${f.id}/download`}
                  className="block truncate text-sm text-brand hover:underline"
                >
                  {f.file_name}
                </a>
                <p className="text-xs text-muted-foreground">
                  {humanSize(f.size_bytes)}
                  {f.size_bytes ? " · " : ""}
                  {formatDateTime(f.created_at)}
                </p>
              </div>
              <a
                href={`/api/customer/files/${f.id}/download`}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                title="Download"
              >
                <Download className="h-4 w-4" />
              </a>
              <button
                onClick={() => remove(f.id)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-destructive"
                title="Delete"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
