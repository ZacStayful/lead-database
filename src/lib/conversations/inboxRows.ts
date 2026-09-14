/**
 * The inbox column's row shape (§56.7): the lighter projection of an
 * `InboxRow` the client renders. The full assignment (with its viewer-scoped
 * lead) stays on the server; the browser gets a name, an address and a
 * preview. PURE.
 */
import type { InboxRow } from "@/lib/messaging/inbox";
import type { InboxListRow } from "@/components/conversations/InboxList";

export function toInboxListRows(rows: InboxRow[]): InboxListRow[] {
  return rows.map((r) => ({
    leadId: r.leadId,
    name: r.assignment.lead?.lead_name ?? "Lead",
    address: r.assignment.lead?.address ?? null,
    channel: r.preview.kind === "click" ? r.preview.channel : r.preview.channel,
    channels: r.channels,
    hasMessages: r.hasMessages,
    unread: r.unread,
    starred: r.starred,
    lastActivityAt: r.lastActivityAt,
    preview: r.preview.text,
    isClick: r.preview.kind === "click",
  }));
}
