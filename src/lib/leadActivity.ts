/**
 * The lead's activity column (§56): everything that has happened on this
 * assignment, newest first, from the data the system already keeps.
 *
 * There was no customer-visible activity feed before this. lead_events was
 * read back only by admin; notes and messages were merged in LeadNotes; the
 * contact plan lived in its own timeline; and "the lead was delivered to you"
 * was a date on a header. This is the merge.
 *
 * `buildLeadActivity` is PURE and tested. `fetchLeadActivity` does the reads.
 *
 * What is deliberately NOT here:
 *   * detail_opened — sixty opens per lead is noise, and the count belongs to
 *     the effort figures, not a feed.
 *   * nudge_sent — ours, not the operator's (§3).
 *   * message_sent / message_received / note_added / file_added events — each
 *     duplicates a row that is rendered from its own table with more detail.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { pipelineLabel } from "@/components/dashboard/pipelineStage";
import type { TimelineAttempt } from "@/lib/contact/contactPlan";
import { channelLabel as contactChannelLabel } from "@/lib/contact/contactStrategy";
import { OPERATOR_EVENT_COPY, isContactClick } from "@/lib/leadEvents";
import { channelLabel } from "@/lib/messaging/display";
import type { MessageChannel } from "@/lib/messaging/types";

export type ActivityKind =
  | "delivered"
  | "introduced"
  | "click"
  | "stage"
  | "contacted"
  | "message_out"
  | "message_in"
  | "opened"
  | "clicked_link"
  | "note"
  | "file"
  | "attempt"
  | "won"
  | "closed";

export interface ActivityItem {
  id: string;
  at: string;
  kind: ActivityKind;
  label: string;
  /** Secondary line: a subject, a note excerpt, a stage name. */
  detail: string | null;
  channel: "call" | "whatsapp" | "email" | null;
}

export interface ActivityInput {
  assignment: {
    id: string;
    assigned_at: string;
    first_contacted_at: string | null;
    landlord_referral_sent_at: string | null;
    status: string;
    closed_at: string | null;
    last_status_change_at?: string | null;
  };
  events: { id: string; event_type: string; created_at: string; metadata?: Record<string, unknown> | null }[];
  messages: {
    id: string;
    channel: MessageChannel;
    direction: "outbound" | "inbound";
    subject: string | null;
    body_text: string | null;
    created_at: string;
    first_opened_at?: string | null;
    first_clicked_at?: string | null;
  }[];
  notes: { id: string; body: string; created_at: string }[];
  files: { id: string; file_name: string; created_at: string }[];
  attempts?: TimelineAttempt[];
  totalAttempts?: number;
}

function excerpt(s: string | null | undefined, n = 90): string | null {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export function buildLeadActivity(input: ActivityInput): ActivityItem[] {
  const items: ActivityItem[] = [];
  const a = input.assignment;

  items.push({
    id: `delivered-${a.id}`,
    at: a.assigned_at,
    kind: "delivered",
    label: "Lead delivered to you",
    detail: null,
    channel: null,
  });

  if (a.landlord_referral_sent_at) {
    items.push({
      id: `introduced-${a.id}`,
      at: a.landlord_referral_sent_at,
      kind: "introduced",
      label: "We introduced you to the landlord by email",
      detail: null,
      channel: null,
    });
  }

  if (a.first_contacted_at) {
    items.push({
      id: `contacted-${a.id}`,
      at: a.first_contacted_at,
      kind: "contacted",
      label: "First contact recorded",
      detail: null,
      channel: null,
    });
  }

  for (const e of input.events) {
    if (isContactClick(e.event_type)) {
      items.push({
        id: e.id,
        at: e.created_at,
        kind: "click",
        label: OPERATOR_EVENT_COPY[e.event_type],
        detail: null,
        channel: e.event_type === "tel_click" ? "call" : e.event_type === "whatsapp_click" ? "whatsapp" : "email",
      });
    } else if (e.event_type === "stage_changed") {
      const to = typeof e.metadata?.to === "string" ? (e.metadata.to as string) : null;
      const from = typeof e.metadata?.from === "string" ? (e.metadata.from as string) : null;
      items.push({
        id: e.id,
        at: e.created_at,
        kind: "stage",
        label: to ? `Stage → ${pipelineLabel(to)}` : "Pipeline stage changed",
        detail: from ? `from ${pipelineLabel(from)}` : null,
        channel: null,
      });
    }
    // detail_opened, nudge_sent, note_added, file_added, message_* — see the
    // file header for why each is left out.
  }

  for (const m of input.messages) {
    const ch = m.channel;
    if (m.direction === "inbound") {
      items.push({
        id: m.id,
        at: m.created_at,
        kind: "message_in",
        label: `Replied on ${channelLabel(ch)}`,
        detail: excerpt(m.body_text ?? m.subject),
        channel: ch,
      });
      continue;
    }
    items.push({
      id: m.id,
      at: m.created_at,
      kind: "message_out",
      label: `${channelLabel(ch)} sent`,
      detail: excerpt(m.subject ?? m.body_text),
      channel: ch,
    });
    if (m.first_opened_at) {
      items.push({
        id: `${m.id}-opened`,
        at: m.first_opened_at,
        kind: "opened",
        label: ch === "email" ? "Opened your email" : "Read your message",
        detail: excerpt(m.subject),
        channel: ch,
      });
    }
    if (m.first_clicked_at) {
      items.push({
        id: `${m.id}-clicked`,
        at: m.first_clicked_at,
        kind: "clicked_link",
        label: "Clicked a link in your email",
        detail: excerpt(m.subject),
        channel: ch,
      });
    }
  }

  for (const n of input.notes) {
    items.push({
      id: n.id,
      at: n.created_at,
      kind: "note",
      label: "You added a note",
      detail: excerpt(n.body),
      channel: null,
    });
  }

  for (const f of input.files) {
    items.push({
      id: f.id,
      at: f.created_at,
      kind: "file",
      label: "You attached a file",
      detail: f.file_name,
      channel: null,
    });
  }

  const total = input.totalAttempts ?? input.attempts?.length ?? 0;
  for (const t of input.attempts ?? []) {
    // A click-closed rung is already the click row above.
    if (t.state === "done" && t.doneAt && !t.byClick) {
      items.push({
        id: `attempt-${t.number}`,
        at: t.doneAt,
        kind: "attempt",
        label: `Follow-up ${t.number} of ${total} done`,
        detail: contactChannelLabel(t.channel),
        channel: t.channel,
      });
    }
  }

  if (a.status === "won" && a.last_status_change_at) {
    items.push({
      id: `won-${a.id}`,
      at: a.last_status_change_at,
      kind: "won",
      label: "Marked as signed",
      detail: null,
      channel: null,
    });
  }
  if (a.closed_at) {
    items.push({
      id: `closed-${a.id}`,
      at: a.closed_at,
      kind: "closed",
      label: "Lead closed",
      detail: null,
      channel: null,
    });
  }

  items.sort((x, y) => new Date(y.at).getTime() - new Date(x.at).getTime());
  return items;
}

/**
 * Read the pieces for one assignment and build the feed. The attempts are
 * passed in by the caller, which already builds the contact timeline for the
 * page; reading them twice would be a second copy of that query.
 */
export async function fetchLeadActivity(
  admin: SupabaseClient,
  assignment: ActivityInput["assignment"],
  attempts?: TimelineAttempt[],
  totalAttempts?: number
): Promise<ActivityItem[]> {
  const [events, messages, notes, files] = await Promise.all([
    admin
      .from("lead_events")
      .select("id, event_type, created_at, metadata")
      .eq("assignment_id", assignment.id)
      .in("event_type", ["tel_click", "whatsapp_click", "mailto_click", "stage_changed"])
      .order("created_at", { ascending: false })
      .limit(500),
    admin
      .from("lead_messages")
      .select("id, channel, direction, subject, body_text, created_at, first_opened_at, first_clicked_at")
      .eq("assignment_id", assignment.id)
      .order("created_at", { ascending: false })
      .limit(200),
    admin
      .from("lead_notes")
      .select("id, body, created_at")
      .eq("lead_assignment_id", assignment.id)
      .order("created_at", { ascending: false })
      .limit(200),
    admin
      .from("lead_files")
      .select("id, file_name, created_at")
      .eq("lead_assignment_id", assignment.id)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  return buildLeadActivity({
    assignment,
    events: (events.data ?? []) as ActivityInput["events"],
    messages: (messages.data ?? []) as ActivityInput["messages"],
    notes: (notes.data ?? []) as ActivityInput["notes"],
    files: (files.data ?? []) as ActivityInput["files"],
    attempts,
    totalAttempts,
  });
}
