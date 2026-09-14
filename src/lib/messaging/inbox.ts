/**
 * The customer's inbox: one row per lead with any contact activity, newest
 * first (§56).
 *
 * ⚠️ WHY CLICKS ARE IN HERE. Messages only exist for a customer with a
 * connected TimelinesAI workspace or a verified sending domain, and at the time
 * of writing that is nobody (§42.3, §55). The path the whole book actually uses
 * — the wa.me hand-off, tel: and mailto: — writes a lead_events row and nothing
 * else (§40.15). An inbox built on lead_messages alone would render empty for
 * every customer, so a row here is "a lead you have approached", whether the
 * approach left a message behind or only a click. The two are never confused:
 * a click row carries no delivery status, and the preview says what the
 * operator did on their own device rather than what the landlord received.
 *
 * ⚠️ GROUPED BY LEAD, NOT BY THREAD. lead_message_threads is unique on
 * (customer, channel, counterparty), so a landlord contacted on WhatsApp and
 * email is two thread rows. The operator thinks in landlords, so the inbox
 * folds every thread and click for one lead into one row and reports which
 * channels it has.
 *
 * `buildInboxRows` is PURE and unit-tested; `fetchInboxRows` does the reads —
 * four round trips for the whole inbox, never one per lead, because every
 * dashboard query shares one Supabase connection that is already timing out on
 * busy mornings.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { viewerScopedLead } from "@/lib/customerLeads";
import { CONTACT_CLICK_EVENT_TYPES, clickChannel, clickPreview, isContactClick } from "@/lib/leadEvents";
import type { MessageChannel } from "@/lib/messaging/types";
import type { AssignmentWithLead } from "@/lib/types";

export interface InboxThread {
  id: string;
  channel: MessageChannel;
  assignment_id: string | null;
  lead_id: string | null;
  unread_inbound_count: number;
  starred_at: string | null;
  last_message_at: string | null;
  last_inbound_at: string | null;
}

/** The newest message on a thread — enough for a preview line. */
export interface InboxMessagePreview {
  thread_id: string;
  direction: "outbound" | "inbound";
  channel: MessageChannel;
  subject: string | null;
  body_text: string | null;
  created_at: string;
}

export interface InboxClick {
  assignment_id: string;
  event_type: string;
  created_at: string;
}

export type InboxPreview =
  | {
      kind: "message";
      channel: MessageChannel;
      direction: "outbound" | "inbound";
      text: string;
    }
  | { kind: "click"; channel: "call" | "whatsapp" | "email"; text: string };

export interface InboxRow {
  leadId: string;
  assignmentId: string;
  assignment: AssignmentWithLead;
  /** Message channels with a thread on this lead, in a fixed order. */
  channels: MessageChannel[];
  /** Whether anything at all has been sent or received through a connected channel. */
  hasMessages: boolean;
  unread: number;
  starred: boolean;
  /** Newest of: last message, last click. Never null on a returned row. */
  lastActivityAt: string;
  lastInboundAt: string | null;
  preview: InboxPreview;
}

const CHANNEL_ORDER: MessageChannel[] = ["whatsapp", "email"];

function later(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

function previewText(m: InboxMessagePreview): string {
  const body = (m.body_text ?? "").replace(/\s+/g, " ").trim();
  if (body) return body.length > 140 ? `${body.slice(0, 139)}…` : body;
  const subject = (m.subject ?? "").trim();
  return subject || (m.direction === "inbound" ? "Reply" : "Message");
}

/**
 * Fold assignments, threads, previews and clicks into inbox rows.
 *
 * A lead with neither a thread nor a click is not a conversation and is not
 * returned; the caller lists those elsewhere. Rows are ordered by most recent
 * activity, whatever kind it was.
 */
export function buildInboxRows(input: {
  assignments: AssignmentWithLead[];
  threads: InboxThread[];
  previews: InboxMessagePreview[];
  clicks: InboxClick[];
}): InboxRow[] {
  const previewByThread = new Map<string, InboxMessagePreview>();
  for (const p of input.previews) {
    const existing = previewByThread.get(p.thread_id);
    if (!existing || new Date(p.created_at) > new Date(existing.created_at)) {
      previewByThread.set(p.thread_id, p);
    }
  }

  const threadsByAssignment = new Map<string, InboxThread[]>();
  for (const t of input.threads) {
    if (!t.assignment_id) continue;
    const list = threadsByAssignment.get(t.assignment_id) ?? [];
    list.push(t);
    threadsByAssignment.set(t.assignment_id, list);
  }

  const latestClickByAssignment = new Map<string, InboxClick>();
  for (const c of input.clicks) {
    if (!isContactClick(c.event_type)) continue;
    const existing = latestClickByAssignment.get(c.assignment_id);
    if (!existing || new Date(c.created_at) > new Date(existing.created_at)) {
      latestClickByAssignment.set(c.assignment_id, c);
    }
  }

  const rows: InboxRow[] = [];
  for (const a of input.assignments) {
    const threads = threadsByAssignment.get(a.id) ?? [];
    const click = latestClickByAssignment.get(a.id) ?? null;
    if (threads.length === 0 && !click) continue;

    let lastMessageAt: string | null = null;
    let lastInboundAt: string | null = null;
    let unread = 0;
    let starred = false;
    let newest: InboxMessagePreview | null = null;
    const channels = new Set<MessageChannel>();
    for (const t of threads) {
      channels.add(t.channel);
      unread += t.unread_inbound_count ?? 0;
      starred = starred || Boolean(t.starred_at);
      lastMessageAt = later(lastMessageAt, t.last_message_at);
      lastInboundAt = later(lastInboundAt, t.last_inbound_at);
      const p = previewByThread.get(t.id);
      if (p && (!newest || new Date(p.created_at) > new Date(newest.created_at))) newest = p;
    }

    const clickAt = click?.created_at ?? null;
    const messageAt = newest?.created_at ?? lastMessageAt;
    const lastActivityAt = later(messageAt, clickAt);
    if (!lastActivityAt) continue;

    // The preview follows whichever happened last. A message always has more
    // to say than a click, so on a tie the message wins.
    let preview: InboxPreview;
    if (newest && (!clickAt || new Date(newest.created_at) >= new Date(clickAt))) {
      preview = {
        kind: "message",
        channel: newest.channel,
        direction: newest.direction,
        text: previewText(newest),
      };
    } else if (click && isContactClick(click.event_type)) {
      preview = {
        kind: "click",
        channel: clickChannel(click.event_type),
        text: clickPreview(click.event_type),
      };
    } else {
      // A thread with no message yet (created by a failed send). Say so rather
      // than inventing a line.
      preview = { kind: "message", channel: threads[0].channel, direction: "outbound", text: "No messages yet" };
    }

    rows.push({
      leadId: a.lead_id,
      assignmentId: a.id,
      assignment: a,
      channels: CHANNEL_ORDER.filter((c) => channels.has(c)),
      hasMessages: Boolean(newest) || lastMessageAt !== null,
      unread,
      starred,
      lastActivityAt,
      lastInboundAt,
      preview,
    });
  }

  rows.sort((x, y) => new Date(y.lastActivityAt).getTime() - new Date(x.lastActivityAt).getTime());
  return rows;
}

const THREAD_COLUMNS =
  "id, channel, assignment_id, lead_id, unread_inbound_count, starred_at, last_message_at, last_inbound_at";

/**
 * Read everything the inbox needs for one customer, then fold it. Four reads,
 * all scoped by customer_id (0116's containment guarantee), none per lead.
 */
export async function fetchInboxRows(
  admin: SupabaseClient,
  customerId: string
): Promise<{ rows: InboxRow[]; error: string | null }> {
  const [assignmentsRes, threadsRes] = await Promise.all([
    admin
      .from("lead_assignments")
      .select("*, lead:leads(*)")
      .eq("customer_id", customerId)
      .order("assigned_at", { ascending: false }),
    admin
      .from("lead_message_threads")
      .select(THREAD_COLUMNS)
      .eq("customer_id", customerId)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(1000),
  ]);
  if (assignmentsRes.error) return { rows: [], error: assignmentsRes.error.message };
  if (threadsRes.error) return { rows: [], error: threadsRes.error.message };

  const assignments = ((assignmentsRes.data ?? []) as AssignmentWithLead[]).map((a) => ({
    ...a,
    lead: viewerScopedLead(a.lead, customerId),
  })) as AssignmentWithLead[];
  const threads = (threadsRes.data ?? []) as InboxThread[];
  const assignmentIds = assignments.map((a) => a.id);

  const [previewsRes, clicksRes] = await Promise.all([
    threads.length === 0
      ? Promise.resolve({ data: [] as InboxMessagePreview[], error: null })
      : admin
          .from("lead_messages")
          .select("thread_id, direction, channel, subject, body_text, created_at")
          .eq("customer_id", customerId)
          .order("created_at", { ascending: false })
          .limit(2000),
    assignmentIds.length === 0
      ? Promise.resolve({ data: [] as InboxClick[], error: null })
      : admin
          .from("lead_events")
          .select("assignment_id, event_type, created_at")
          .in("assignment_id", assignmentIds)
          .in("event_type", [...CONTACT_CLICK_EVENT_TYPES])
          .order("created_at", { ascending: false })
          .limit(5000),
  ]);
  if (previewsRes.error) return { rows: [], error: previewsRes.error.message };
  if (clicksRes.error) return { rows: [], error: clicksRes.error.message };

  return {
    rows: buildInboxRows({
      assignments,
      threads,
      previews: (previewsRes.data ?? []) as InboxMessagePreview[],
      clicks: (clicksRes.data ?? []) as InboxClick[],
    }),
    error: null,
  };
}

/** Sum of unread replies across every thread — the nav badge. One count query. */
export async function unreadReplyCount(admin: SupabaseClient, customerId: string): Promise<number> {
  const { data } = await admin
    .from("lead_message_threads")
    .select("unread_inbound_count")
    .eq("customer_id", customerId)
    .gt("unread_inbound_count", 0);
  return ((data ?? []) as { unread_inbound_count: number }[]).reduce(
    (n, r) => n + (r.unread_inbound_count ?? 0),
    0
  );
}
