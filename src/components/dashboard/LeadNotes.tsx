"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/utils";
import type { LeadNote } from "@/lib/types";
import { StickyNote } from "lucide-react";

/**
 * Timestamped contact notes for a single lead assignment. Newest first. Each
 * saved note is stamped with the server time so an operator keeps an accurate
 * running history against the lead.
 */
export function LeadNotes({
  assignmentId,
  initialNotes,
}: {
  assignmentId: string;
  initialNotes: LeadNote[];
}) {
  const [notes, setNotes] = useState<LeadNote[]>(initialNotes);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function addNote() {
    const body = text.trim();
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/customer/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lead_assignment_id: assignmentId, body }),
      });
      const data = await res.json();
      if (!res.ok || !data.note) {
        throw new Error(data.error ?? "Could not save note");
      }
      setNotes((prev) => [data.note as LeadNote, ...prev]);
      setText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save note");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border-[0.5px] border-border bg-card p-6">
      <div className="mb-4 flex items-center gap-2">
        <StickyNote className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Your notes</h2>
      </div>

      <div className="space-y-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add a note — call outcome, next step, anything worth remembering…"
          rows={3}
          className="w-full resize-y rounded-md border-[0.5px] border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end">
          <Button size="sm" onClick={addNote} disabled={busy || !text.trim()}>
            {busy ? "Saving…" : "Add note"}
          </Button>
        </div>
      </div>

      {notes.length > 0 ? (
        <ul className="mt-5 space-y-3 border-t-[0.5px] border-border pt-4">
          {notes.map((n) => (
            <li key={n.id} className="text-sm">
              <p className="whitespace-pre-wrap">{n.body}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {formatDateTime(n.created_at)}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-5 border-t-[0.5px] border-border pt-4 text-sm text-muted-foreground">
          No notes yet. Add one above to start a contact history for this lead.
        </p>
      )}
    </div>
  );
}
