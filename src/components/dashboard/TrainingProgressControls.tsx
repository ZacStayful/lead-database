"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Progress controls for a training module's detail page.
 *
 * Two jobs: fire `started` once on mount, and offer the complete / undo
 * button.
 *
 * The mount write is fire and forget. A subscriber opening a module is not
 * asking to record progress, so a failed write must never surface an error or
 * block anything — the page is entirely usable whether or not it lands, and
 * `completed` backfills `started_at` if it never did.
 */
export function TrainingProgressControls({
  moduleId,
  completedAt,
}: {
  moduleId: string;
  completedAt: string | null;
}) {
  const router = useRouter();
  const [completed, setCompleted] = useState<string | null>(completedAt);
  const [busy, setBusy] = useState(false);
  // StrictMode mounts twice in development; without this the started write
  // fires twice. Harmless — started_at is written once server-side — but there
  // is no reason to make the request twice.
  const startedFired = useRef(false);

  useEffect(() => {
    if (startedFired.current) return;
    startedFired.current = true;

    void fetch(`/api/customer/training/${moduleId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "started" }),
    }).catch(() => {
      // Deliberately silent.
    });
  }, [moduleId]);

  async function send(event: "completed" | "uncompleted") {
    setBusy(true);
    try {
      const res = await fetch(`/api/customer/training/${moduleId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event }),
      });
      if (!res.ok) return;
      setCompleted(event === "completed" ? new Date().toISOString() : null);
      router.refresh();
    } catch {
      // Leave the button as it was; nothing is lost by trying again.
    } finally {
      setBusy(false);
    }
  }

  if (completed) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium text-[#5D8156]">
          ✓ Completed on{" "}
          {new Date(completed).toLocaleDateString("en-GB", {
            day: "numeric",
            month: "long",
            year: "numeric",
          })}
        </span>
        <button
          type="button"
          onClick={() => void send("uncompleted")}
          disabled={busy}
          className="text-sm font-medium text-[#52514e] underline hover:no-underline disabled:opacity-50"
        >
          Undo
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void send("completed")}
      disabled={busy}
      className="rounded-lg bg-[#3B6D11] px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[#2d5409] disabled:opacity-60"
    >
      {busy ? "Saving" : "Mark as complete"}
    </button>
  );
}
