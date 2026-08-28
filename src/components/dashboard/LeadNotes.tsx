"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/utils";
import type { LeadNote } from "@/lib/types";
import { StickyNote, MessageCircle, Mail, CornerDownLeft } from "lucide-react";
import {
  statusLabel,
  statusIsApproximate,
  channelLabel,
  type DisplayMessage,
} from "@/lib/messaging/display";

export interface TimelineMessage extends DisplayMessage {
  id: string;
  channel: string;
  subject: string | null;
  body_text: string | null;
  created_at: string;
}

/**
 * The lead's timeline: notes the operator typed, and messages to and from the
 * landlord, in one list.
 *
 * ⚠️ MESSAGES ARE RENDERED FROM lead_messages, NOT WRITTEN AS lead_notes ROWS.
 * That looks like a display decision and is not. A row in lead_notes is read by
 * around twenty-five predicates as a claim that the operator did work on this
 * lead: it PERMANENTLY BARS the lead from the expired pool (§19.3), it scores
 * 0.40 against a day-10 escalation threshold of 0.35, it blocks a discard
 * (0010), and since 0114 it blocks a credit refund when a filter is applied.
 * Writing one per message would have changed lead routing in a dozen places by
 * accident — and an inbound reply would have done it on the landlord's behalf.
 *
 * So the visibility is here, in the timeline, and the meaning of a note is left
 * alone. Notes are deliberately NOT badged: every existing note is an operator
 * note, and badging all of them is noise.
 */
export function LeadNotes({
  assignmentId,
  initialNotes,
  messages = [],
  onNoteAdded,
}: {
  assignmentId: string;
  initialNotes: LeadNote[];
  /** Read-only. Composing still happens in the message dialog. */
  messages?: TimelineMessage[];
  onNoteAdded?: () => void;
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
      onNoteAdded?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save note");
    } finally {
      setBusy(false);
    }
  }

  // Newest first, matching how notes have always read.
  const timeline: TimelineEntry[] = [
    ...notes.map((note) => ({ kind: "note" as const, at: note.created_at, note })),
    ...messages.map((message) => ({
      kind: "message" as const,
      at: message.created_at,
      message,
    })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  const hasMessages = messages.length > 0;

  return (
    <div className="rounded-xl border-[0.5px] border-border bg-card p-6">
      <div className="mb-4 flex items-center gap-2">
        <StickyNote className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">
          {hasMessages ? "Notes and messages" : "Your notes"}
        </h2>
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

      {timeline.length > 0 ? (
        <ul className="mt-5 space-y-3 border-t-[0.5px] border-border pt-4">
          {timeline.map((entry) =>
            entry.kind === "note" ? (
              <li key={`n-${entry.note.id}`} className="text-sm">
                <p className="whitespace-pre-wrap">{entry.note.body}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatDateTime(entry.note.created_at)}
                </p>
              </li>
            ) : (
              <MessageEntry key={`m-${entry.message.id}`} message={entry.message} />
            )
          )}
        </ul>
      ) : (
        <p className="mt-5 border-t-[0.5px] border-border pt-4 text-sm text-muted-foreground">
          No notes yet. Add one above to start a contact history for this lead.
        </p>
      )}
    </div>
  );
}

type TimelineEntry =
  | { kind: "note"; at: string; note: LeadNote }
  | { kind: "message"; at: string; message: TimelineMessage };

/**
 * One message in the timeline. An inbound reply is given the strongest visual
 * treatment on the page: it is the single most important thing that can happen
 * to a lead, and burying it would defeat the point of showing messages here.
 */
function MessageEntry({ message }: { message: TimelineMessage }) {
  const inbound = message.direction === "inbound";
  const Icon = message.channel === "whatsapp" ? MessageCircle : Mail;

  return (
    <li
      className={
        inbound
          ? "rounded-md border-l-2 border-primary bg-primary/5 py-2 pl-3 pr-2 text-sm"
          : "border-l-2 border-muted py-1 pl-3 text-sm"
      }
    >
      <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        {inbound ? (
          <CornerDownLeft className="h-3.5 w-3.5 text-primary" />
        ) : (
          <Icon className="h-3.5 w-3.5" />
        )}
        <span className={inbound ? "font-medium text-foreground" : undefined}>
          {inbound
            ? `Reply on ${channelLabel(message.channel)}`
            : `Sent on ${channelLabel(message.channel)}`}
        </span>
      </div>

      {message.subject && <p className="font-medium">{message.subject}</p>}
      <p className="whitespace-pre-wrap">{message.body_text}</p>

      <p className="mt-1 text-xs text-muted-foreground">
        {statusLabel(message)}
        {statusIsApproximate(message) && (
          <span title="Approximate — some mail apps pre-load images."> (approx.)</span>
        )}{" "}
        · {formatDateTime(message.created_at)}
      </p>
    </li>
  );
}
