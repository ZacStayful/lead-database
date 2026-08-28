/**
 * How a message reads on screen, in one place.
 *
 * Shared by the composer modal and the lead timeline. They show the same
 * messages side by side, so two definitions of what "Delivered" means would
 * eventually disagree in front of the operator — the §26.7 rule, applied before
 * the duplication exists rather than after.
 *
 * The language is the operator's, never the vendor's: nobody wants to read
 * "Sending" or a provider status code on their own lead.
 */

export interface DisplayMessage {
  direction: "outbound" | "inbound";
  status: string;
  read_at?: string | null;
  first_opened_at?: string | null;
  first_clicked_at?: string | null;
}

export function statusLabel(m: DisplayMessage): string {
  if (m.direction === "inbound") return "Reply";
  if (m.status === "failed") return "Failed";
  if (m.first_clicked_at) return "Clicked a link";
  if (m.read_at) return "Read";
  if (m.first_opened_at) return "Opened";
  if (m.status === "delivered") return "Delivered";
  if (m.status === "sent") return "Sent";
  if (m.status === "queued") return "Sending…";
  return m.status;
}

/**
 * ⚠️ An open is not a fact. Apple Mail Privacy Protection pre-loads images, so
 * "Opened" can mean a machine looked at it. §11 makes the same point about
 * viewed_at; this puts it on the screen rather than only in the docs.
 */
export function statusIsApproximate(m: DisplayMessage): boolean {
  return m.direction === "outbound" && Boolean(m.first_opened_at) && !m.read_at;
}

export function formatWhen(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const mins = Math.round((now - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function channelLabel(channel: string): string {
  return channel === "whatsapp" ? "WhatsApp" : "Email";
}
