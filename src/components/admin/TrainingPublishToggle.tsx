"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";

/**
 * Publish state as a control rather than a label.
 *
 * A module is invisible to every customer until it is published, and the only
 * way to do it used to be opening the edit form, ticking a box and saving —
 * three steps for the one field that decides whether the work reaches anybody.
 * Uploading a recording and never publishing it is the easiest mistake in this
 * feature to make, and the symptom (an empty Training tab) points nowhere near
 * the cause.
 *
 * The refusal comes back as a sentence from publishBlocker — "upload a
 * recording first" — so a module that is not ready says why.
 */
export function TrainingPublishToggle({
  moduleId,
  isPublished,
}: {
  moduleId: string;
  isPublished: boolean;
}) {
  const router = useRouter();
  const [published, setPublished] = useState(isPublished);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setBusy(true);
    setError(null);
    const next = !published;

    try {
      const res = await fetch(`/api/admin/training/${moduleId}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_published: next }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? "Could not save.");
        return;
      }
      setPublished(next);
      // The customer-facing pages read this table, so refresh rather than
      // leaving other views showing the old state.
      router.refresh();
    } catch {
      setError("Could not save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        title={
          published
            ? "Hide this module from customers"
            : "Make this module visible to customers"
        }
        className="disabled:opacity-60"
      >
        {published ? (
          <Badge className="border-transparent bg-green-100 text-green-700 hover:bg-green-200">
            Published
          </Badge>
        ) : (
          <Badge className="border-transparent bg-amber-100 text-amber-700 hover:bg-amber-200">
            Draft
          </Badge>
        )}
      </button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
