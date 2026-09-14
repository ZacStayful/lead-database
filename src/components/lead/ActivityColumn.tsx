"use client";

import {
  Calendar,
  Check,
  Eye,
  FileText,
  Inbox,
  Mail,
  MessageCircle,
  MousePointerClick,
  PartyPopper,
  Phone,
  StickyNote,
  UserCheck,
  X,
  XCircle,
} from "lucide-react";
import type { ActivityItem } from "@/lib/leadActivity";
import { activityWhen } from "@/lib/londonTime";

/** Icon bubble per activity kind, in the design's colours. */
function iconFor(it: ActivityItem): { Icon: React.ComponentType<{ className?: string }>; bg: string; fg: string } {
  const wa = { bg: "#dcebd2", fg: "#25a244" };
  const green = { bg: "#EAF3DE", fg: "#3B6D11" };
  const grey = { bg: "#f3f5f3", fg: "#4b544c" };
  const amber = { bg: "#fef3c7", fg: "#92400e" };
  switch (it.kind) {
    case "delivered":
      return { Icon: Inbox, ...grey };
    case "introduced":
      return { Icon: UserCheck, ...green };
    case "click":
      return it.channel === "whatsapp"
        ? { Icon: MessageCircle, ...wa }
        : it.channel === "email"
          ? { Icon: Mail, ...green }
          : { Icon: Phone, ...grey };
    case "stage":
      return { Icon: Check, ...amber };
    case "contacted":
      return { Icon: Phone, ...green };
    case "message_out":
      return it.channel === "email" ? { Icon: Mail, ...green } : { Icon: MessageCircle, ...wa };
    case "message_in":
      return it.channel === "email" ? { Icon: Mail, ...green } : { Icon: MessageCircle, ...wa };
    case "opened":
      return { Icon: Eye, ...green };
    case "clicked_link":
      return { Icon: MousePointerClick, ...green };
    case "note":
      return { Icon: StickyNote, ...grey };
    case "file":
      return { Icon: FileText, ...grey };
    case "attempt":
      return { Icon: Calendar, ...grey };
    case "won":
      return { Icon: PartyPopper, ...green };
    case "closed":
      return { Icon: XCircle, ...grey };
  }
}

export function ActivityColumn({
  items,
  onClose,
}: {
  items: ActivityItem[];
  onClose?: () => void;
}) {
  const now = new Date();
  return (
    <aside className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-white">
      <header className="flex flex-shrink-0 items-center justify-between border-b border-line px-4 py-3.5">
        <h2 className="text-base font-semibold">Activity</h2>
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Close" className="text-ink-2 hover:text-ink">
            <X className="h-[18px] w-[18px]" />
          </button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {items.length === 0 && <p className="text-sm text-ink-2">Nothing yet.</p>}
        <ol>
          {items.map((it, i) => {
            const { Icon, bg, fg } = iconFor(it);
            return (
              <li key={it.id} className="relative flex gap-3 pb-[18px]">
                {i < items.length - 1 && (
                  <span aria-hidden className="absolute bottom-0 left-[11px] top-[26px] w-px bg-line" />
                )}
                <span
                  className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full"
                  style={{ background: bg, color: fg }}
                >
                  <Icon className="h-3 w-3" />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium">{it.label}</p>
                  {it.detail && <p className="truncate text-xs text-ink-3">{it.detail}</p>}
                  <p className="text-xs text-ink-2">{activityWhen(it.at, now)}</p>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </aside>
  );
}
