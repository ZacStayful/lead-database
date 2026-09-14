"use client";

/**
 * The composer's state and its two calls — draft and send — lifted from the
 * old message dialog so the inbox and the lead page share one definition
 * (§56.7). Every rule the dialog stated still holds here:
 *
 * - a failed send NEVER clears the typed text;
 * - a draft never silently overwrites something the operator has typed;
 * - a failed draft is a muted note, not the red error block;
 * - a fresh client token is minted after every successful send.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { MessageChannel } from "@/lib/messaging/types";

export interface Composer {
  channel: MessageChannel;
  subject: string;
  bodyText: string;
  sending: boolean;
  drafting: boolean;
  error: string | null;
  draftNote: string | null;
  canSend: boolean;
  setSubject: (v: string) => void;
  setBodyText: (v: string) => void;
  insertText: (v: string, selectionStart?: number | null) => void;
  generateDraft: () => Promise<void>;
  send: () => Promise<boolean>;
}

export function canSendMessage(channel: MessageChannel, subject: string, body: string): boolean {
  return body.trim().length > 0 && (channel !== "email" || subject.trim().length > 0);
}

export function draftNoteFor(hadFigures: boolean): string {
  return hadFigures
    ? "Written from this property's analysis. Read it before you send."
    : "This property has no analysis, so the draft quotes no figures. Read it before you send.";
}

export function useComposer(assignmentId: string, channel: MessageChannel): Composer {
  const router = useRouter();
  const [subject, setSubject] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientToken, setClientToken] = useState(() => crypto.randomUUID());
  const [drafting, setDrafting] = useState(false);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftNote, setDraftNote] = useState<string | null>(null);

  function insertText(v: string, selectionStart?: number | null) {
    if (selectionStart == null) {
      setBodyText((b) => (b.trim() ? `${b.replace(/\s+$/, "")}\n${v}` : v));
      return;
    }
    setBodyText((b) => b.slice(0, selectionStart) + v + b.slice(selectionStart));
  }

  async function generateDraft() {
    // ⚠️ Never silently overwrite something the operator has typed.
    if (bodyText.trim().length > 0) {
      const ok = window.confirm("Replace what you have written with a generated draft?");
      if (!ok) return;
    }
    setDrafting(true);
    setDraftNote(null);
    setError(null);
    try {
      const res = await fetch("/api/customer/messaging/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignment_id: assignmentId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // A failed draft is not a failed action — it is a blank page, which is
        // where they started. Muted, never the red error block.
        setDraftNote(data.error ?? "We could not write a draft just now.");
        return;
      }
      setBodyText(data.text ?? "");
      setDraftId(data.draft_id ?? null);
      setDraftNote(draftNoteFor(Boolean(data.had_figures)));
    } catch {
      setDraftNote("We could not reach the server. Write the message yourself.");
    } finally {
      setDrafting(false);
    }
  }

  async function send(): Promise<boolean> {
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/customer/messaging/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assignment_id: assignmentId,
          channel,
          subject: channel === "email" ? subject : undefined,
          body: bodyText,
          client_token: clientToken,
          draft_id: draftId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // ⚠️ The composed text is NOT cleared. Losing what somebody just wrote
        // because a request failed is the kind of small betrayal that stops a
        // feature being used.
        setError(data.error ?? "The message could not be sent.");
        return false;
      }
      setBodyText("");
      setSubject("");
      setDraftId(null);
      setDraftNote(null);
      setClientToken(crypto.randomUUID());
      router.refresh();
      return true;
    } catch {
      setError("We could not reach the server. Your message has been kept below.");
      return false;
    } finally {
      setSending(false);
    }
  }

  return {
    channel,
    subject,
    bodyText,
    sending,
    drafting,
    error,
    draftNote,
    canSend: canSendMessage(channel, subject, bodyText),
    setSubject,
    setBodyText,
    insertText,
    generateDraft,
    send,
  };
}
