/**
 * One lead's conversation, as the thread column renders it (§56): messages
 * to and from the landlord, the operator's own contact clicks, and the
 * contact-plan rungs that are due — merged and in time order.
 *
 * PURE. The caller reads lead_messages, lead_events and the contact timeline;
 * this only decides what each becomes and in what order. That is what lets
 * every rule below be unit-tested without a database, and it is the reason the
 * file exists rather than the merge living inside a component.
 *
 * Three rules that are not presentation:
 *
 *   * ⚠️ A CLICK ROW HAS NO STATUS. tel_click / whatsapp_click / mailto_click
 *     are attempts made on the operator's own device and nothing comes back
 *     (§40.15). They are rendered as what the operator did, never as a message
 *     the landlord received, and no delivery state is ever attached.
 *   * ⚠️ A REPLY IS THE LANDLORD'S, not engagement. Inbound rows say so and
 *     are excluded from the "attempt" counting that lives elsewhere (§40.7).
 *   * `statusLabel` comes from display.ts, the one definition. The composer
 *     used to carry a private copy that ordered Opened before Read; it no
 *     longer does.
 */
import type { TimelineAttempt } from "@/lib/contact/contactPlan";
import { channelLabel as contactChannelLabel } from "@/lib/contact/contactStrategy";
import {
  OPERATOR_EVENT_COPY,
  clickChannel,
  isContactClick,
  type ContactClickEventType,
} from "@/lib/leadEvents";
import { channelLabel, statusIsApproximate, statusLabel, type DisplayMessage } from "@/lib/messaging/display";
import type { MessageChannel } from "@/lib/messaging/types";

export interface ThreadMessageInput extends DisplayMessage {
  id: string;
  channel: MessageChannel;
  subject: string | null;
  body_text: string | null;
  created_at: string;
  from_address?: string | null;
  to_address?: string | null;
}

export interface ThreadEventInput {
  id: string;
  event_type: string;
  created_at: string;
}

export type ThreadItem =
  | {
      kind: "message";
      id: string;
      at: string;
      channel: MessageChannel;
      channelLabel: string;
      direction: "outbound" | "inbound";
      subject: string | null;
      body: string;
      fromLine: string | null;
      status: string;
      statusLabel: string;
      approximate: boolean;
    }
  | {
      kind: "click";
      id: string;
      at: string;
      eventType: ContactClickEventType;
      channel: "call" | "whatsapp" | "email";
      label: string;
    }
  | {
      kind: "attempt";
      id: string;
      at: string;
      number: number;
      total: number;
      channel: "call" | "whatsapp" | "email";
      channelLabel: string;
      objective: string;
      state: "due" | "overdue" | "done";
      label: string;
    };

export function buildThreadItems(input: {
  messages: ThreadMessageInput[];
  events: ThreadEventInput[];
  attempts?: TimelineAttempt[];
  totalAttempts?: number;
  now?: Date;
}): ThreadItem[] {
  const now = input.now ?? new Date();
  const items: ThreadItem[] = [];

  for (const m of input.messages) {
    const fromLine =
      m.channel === "email" && (m.from_address || m.to_address)
        ? `${m.from_address ?? "—"} → ${m.to_address ?? "—"}`
        : null;
    items.push({
      kind: "message",
      id: m.id,
      at: m.created_at,
      channel: m.channel,
      channelLabel: channelLabel(m.channel),
      direction: m.direction,
      subject: m.subject,
      body: m.body_text ?? "",
      fromLine,
      status: m.status,
      statusLabel: statusLabel(m),
      approximate: statusIsApproximate(m),
    });
  }

  for (const e of input.events) {
    if (!isContactClick(e.event_type)) continue;
    items.push({
      kind: "click",
      id: e.id,
      at: e.created_at,
      eventType: e.event_type,
      channel: clickChannel(e.event_type),
      label: OPERATOR_EVENT_COPY[e.event_type],
    });
  }

  const total = input.totalAttempts ?? input.attempts?.length ?? 0;
  for (const a of input.attempts ?? []) {
    // A rung closed by a click already has its click row above; only a manual
    // tick needs a row of its own, or the ladder would show the attempt twice.
    if (a.state === "done" && a.doneAt && !a.byClick) {
      items.push({
        kind: "attempt",
        id: `attempt-${a.number}-done`,
        at: a.doneAt,
        number: a.number,
        total,
        channel: a.channel,
        channelLabel: contactChannelLabel(a.channel),
        objective: a.objective,
        state: "done",
        label: `Follow-up ${a.number} of ${total} done · ${contactChannelLabel(a.channel)}`,
      });
      continue;
    }
    if ((a.state === "due" || a.state === "overdue") && a.dueAt) {
      const overdue = new Date(a.dueAt).getTime() < now.getTime() - 86_400_000;
      items.push({
        kind: "attempt",
        id: `attempt-${a.number}-due`,
        at: a.dueAt,
        number: a.number,
        total,
        channel: a.channel,
        channelLabel: contactChannelLabel(a.channel),
        objective: a.objective,
        state: overdue ? "overdue" : "due",
        label: `Follow-up ${a.number} of ${total} ${overdue ? "overdue" : "due today"} · ${contactChannelLabel(a.channel)} · reply and the plan stops here`,
      });
    }
  }

  items.sort((x, y) => new Date(x.at).getTime() - new Date(y.at).getTime());
  return items;
}

/**
 * The London calendar day an item falls on, for date separators. Computed
 * here rather than in the component so the grouping is testable and does not
 * depend on the viewer's browser clock (§40.12's reason).
 */
export function londonDayKey(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}
