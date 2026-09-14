/**
 * Saved replies (§56): short pieces of text the operator keeps for the
 * composer, stored on message_templates (0116) — the table that shipped empty
 * waiting for exactly this.
 *
 * ⚠️ A snippet is pasted into a WhatsApp from a real person's own number, so
 * it gets the same ceiling every other operator-authored message has, and the
 * same refusal of a raw link (§40.14): links are the strongest spam signal in
 * a cold WhatsApp, and `{{booking_link}}` is the one sanctioned way to include
 * one. Validation is pure and tested; the DB CHECK carries the length bounds.
 */
import type { MessageChannel } from "@/lib/messaging/types";

export type SnippetChannel = MessageChannel | "any";

export const MAX_SNIPPET_CHARS = 480;
export const MAX_SNIPPET_TITLE_CHARS = 60;
export const MAX_SNIPPETS_PER_CUSTOMER = 50;

export const SNIPPET_COLUMNS =
  "id, channel, title, body_template, is_active, created_at, updated_at";

export interface Snippet {
  id: string;
  channel: SnippetChannel;
  title: string;
  body_template: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

const LINK_RE = /(https?:\/\/|www\.)\S+/i;

export function validateSnippet(input: {
  title?: unknown;
  body?: unknown;
  channel?: unknown;
}): { ok: true; title: string; body: string; channel: SnippetChannel } | { ok: false; error: string } {
  const title = typeof input.title === "string" ? input.title.replace(/\s+/g, " ").trim() : "";
  if (!title) return { ok: false, error: "Give the snippet a short title" };
  if (title.length > MAX_SNIPPET_TITLE_CHARS) {
    return { ok: false, error: `A title can be at most ${MAX_SNIPPET_TITLE_CHARS} characters` };
  }

  const body = typeof input.body === "string" ? input.body.replace(/\r\n/g, "\n").trim() : "";
  if (!body) return { ok: false, error: "The snippet is empty" };
  if (body.length > MAX_SNIPPET_CHARS) {
    return { ok: false, error: `A snippet can be at most ${MAX_SNIPPET_CHARS} characters` };
  }
  if (LINK_RE.test(body)) {
    return {
      ok: false,
      error: "Links are not allowed in a snippet. Use {{booking_link}} for your booking page.",
    };
  }

  const channel = input.channel === undefined || input.channel === null ? "any" : input.channel;
  if (channel !== "any" && channel !== "whatsapp" && channel !== "email") {
    return { ok: false, error: "channel must be whatsapp, email or any" };
  }

  return { ok: true, title, body, channel };
}

/** Which snippets belong in a composer for this channel. */
export function snippetsForChannel(list: Snippet[], channel: MessageChannel): Snippet[] {
  return list.filter((s) => s.is_active && (s.channel === "any" || s.channel === channel));
}
