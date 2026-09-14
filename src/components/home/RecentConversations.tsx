import Link from "next/link";
import type { InboxRow } from "@/lib/messaging/inbox";
import { shortWhen } from "@/lib/londonTime";
import { Avatar, type BadgeChannel } from "@/components/conversations/Avatar";
import { CardTitleRow, HomeCard } from "./HomeCard";

export function rowChannel(row: InboxRow): BadgeChannel {
  if (row.preview.kind === "click") return row.preview.channel;
  return row.preview.channel;
}

/** The four most recent inbox rows (§56.7). */
export function RecentConversations({ rows, now }: { rows: InboxRow[]; now: Date }) {
  return (
    <HomeCard>
      <CardTitleRow
        title="Recent conversations"
        right={
          <Link href="/dashboard/conversations" className="text-sm font-semibold text-brand hover:text-brand-dark">
            Open inbox →
          </Link>
        }
      />
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-ink-2">
          Nothing yet. Ring, WhatsApp or email a landlord from a lead and it shows up here.
        </p>
      ) : (
        <ul className="mt-1">
          {rows.slice(0, 4).map((r) => (
            <li key={r.leadId} className="border-b border-rail last:border-b-0">
              <Link href={`/dashboard/conversations/${r.leadId}`} className="flex gap-3 py-3">
                <Avatar name={r.assignment.lead?.lead_name} size={40} channel={rowChannel(r)} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className={"truncate " + (r.unread > 0 ? "font-bold" : "font-semibold")}>
                      {r.assignment.lead?.lead_name ?? "Lead"}
                    </span>
                    <span className="flex-shrink-0 text-xs text-ink-2">{shortWhen(r.lastActivityAt, now)}</span>
                  </span>
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-[13px] text-ink-2">{r.preview.text}</span>
                    {r.unread > 0 && (
                      <span className="flex h-5 min-w-5 flex-shrink-0 items-center justify-center rounded-full bg-brand px-1.5 text-[11px] font-bold text-white">
                        {r.unread}
                      </span>
                    )}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </HomeCard>
  );
}
