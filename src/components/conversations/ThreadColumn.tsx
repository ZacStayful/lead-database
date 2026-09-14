"use client";

/**
 * The middle column (§56.7): header, the merged thread, the composer.
 *
 * The thread is `buildThreadItems` output rendered with London date
 * separators. Three rows, three shapes: a message bubble carries a status and
 * a tick; a click row carries NO status (§40.15 — nothing came back); an
 * attempt row is the contact plan's rung, styled as a system line.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Calendar,
  Check,
  CheckCheck,
  Clock,
  ContactRound,
  Mail,
  MailOpen,
  Phone,
  Star,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { londonDayHeading, londonHHMM, londonYmd } from "@/lib/londonTime";
import type { ThreadItem } from "@/lib/messaging/threadItems";
import type { ChannelAvailability } from "@/lib/messaging/types";
import { Avatar, ChannelIcon } from "./Avatar";
import { Composer } from "./Composer";

export interface ThreadColumnProps {
  assignmentId: string;
  leadId: string;
  leadName: string;
  address: string | null;
  bedrooms: string | null;
  phone: string | null;
  items: ThreadItem[];
  channels: ChannelAvailability[];
  unread: number;
  starred: boolean;
  hasThread: boolean;
  /** Where the name links: the lead page from the inbox, nowhere from the lead page. */
  nameHref: string | null;
  onBack?: () => void;
  onToggleRight?: () => void;
  rightOpen?: boolean;
  onTelClick: () => void;
}

export function ThreadColumn(p: ThreadColumnProps) {
  const router = useRouter();
  const [starred, setStarred] = useState(p.starred);
  const [unread, setUnread] = useState(p.unread);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => setStarred(p.starred), [p.starred, p.leadId]);
  useEffect(() => setUnread(p.unread), [p.unread, p.leadId]);

  // Opening a thread with replies waiting marks it read through the inbox
  // verb — not the thread GET's side effect — and refreshes the badge.
  useEffect(() => {
    if (p.unread <= 0) return;
    void fetch(`/api/customer/messaging/threads/${p.leadId}/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ read: true }),
    })
      .then((r) => {
        if (r.ok) {
          setUnread(0);
          router.refresh();
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.leadId]);

  async function verb(path: string, method: "POST" | "DELETE", body?: unknown) {
    const res = await fetch(`/api/customer/messaging/threads/${p.leadId}/${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setNotice(data.error ?? "That did not work.");
      return false;
    }
    return true;
  }

  async function toggleStar() {
    const next = !starred;
    setStarred(next);
    const ok = await verb("star", next ? "POST" : "DELETE");
    if (!ok) setStarred(!next);
    else router.refresh();
  }

  async function toggleRead() {
    const markUnread = unread === 0;
    const ok = await verb("read", "POST", { read: !markUnread });
    if (ok) {
      setUnread(markUnread ? 1 : 0);
      router.refresh();
    }
  }

  const cannot = p.hasThread
    ? undefined
    : "Nothing has been sent or received on this lead yet, so there is no conversation to mark.";
  const iconBtn =
    "flex h-9 w-9 items-center justify-center rounded-full text-ink-3 hover:bg-page disabled:opacity-40";

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-white">
      <header className="flex flex-shrink-0 items-center gap-3 border-b border-line px-4 py-3">
        {p.onBack && (
          <button type="button" onClick={p.onBack} aria-label="Back" className="-ml-1 p-1 text-ink lg:hidden">
            <ArrowLeft className="h-5 w-5" />
          </button>
        )}
        <Avatar name={p.leadName} size={38} />
        <div className="min-w-0 flex-1">
          {p.nameHref ? (
            <Link href={p.nameHref} className="block truncate text-base font-semibold text-ink hover:underline">
              {p.leadName}
            </Link>
          ) : (
            <h2 className="truncate text-base font-semibold text-ink">{p.leadName}</h2>
          )}
          <p className="truncate text-xs text-ink-2">
            {[p.address, p.bedrooms ? `${p.bedrooms} bed` : null].filter(Boolean).join(" · ") || "—"}
          </p>
        </div>
        <div className="flex items-center gap-0.5">
          {p.phone && (
            <a href={`tel:${p.phone}`} onClick={p.onTelClick} className={iconBtn} title="Call" aria-label="Call">
              <Phone className="h-[18px] w-[18px]" />
            </a>
          )}
          <button
            type="button"
            onClick={toggleStar}
            disabled={!p.hasThread}
            title={cannot ?? (starred ? "Unstar" : "Star")}
            aria-label={starred ? "Unstar" : "Star"}
            className={cn(iconBtn, starred && "text-brand-dark")}
          >
            <Star className="h-[18px] w-[18px]" fill={starred ? "currentColor" : "none"} />
          </button>
          <button
            type="button"
            onClick={toggleRead}
            disabled={!p.hasThread}
            title={cannot ?? (unread > 0 ? "Mark read" : "Mark unread")}
            aria-label={unread > 0 ? "Mark read" : "Mark unread"}
            className={iconBtn}
          >
            {unread > 0 ? <MailOpen className="h-[18px] w-[18px]" /> : <Mail className="h-[18px] w-[18px]" />}
          </button>
          {p.onToggleRight && (
            <button
              type="button"
              onClick={p.onToggleRight}
              title="Details"
              aria-label="Details"
              aria-pressed={p.rightOpen}
              className={cn(iconBtn, p.rightOpen && "text-brand-dark")}
            >
              <ContactRound className="h-[18px] w-[18px]" />
            </button>
          )}
        </div>
      </header>
      {notice && (
        <div className="border-b border-line bg-amber-50 px-4 py-2 text-xs text-amber-900">
          {notice}{" "}
          <button type="button" onClick={() => setNotice(null)} className="underline">
            OK
          </button>
        </div>
      )}

      <ThreadBody items={p.items} leadName={p.leadName} />

      <Composer
        assignmentId={p.assignmentId}
        leadId={p.leadId}
        leadName={p.leadName}
        leadPhone={p.phone}
        channels={p.channels}
      />
    </section>
  );
}

function ThreadBody({ items, leadName }: { items: ThreadItem[]; leadName: string }) {
  const now = new Date();
  let lastDay = "";
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto bg-[#f9faf9] px-5 py-4">
      {items.length === 0 && (
        <p className="m-auto max-w-xs text-center text-sm text-ink-2">
          Nothing here yet. Ring, WhatsApp or email {leadName.split(" ")[0]} and it shows up in this thread.
        </p>
      )}
      {items.map((it) => {
        const day = londonYmd(it.at);
        const sep = day !== lastDay;
        lastDay = day;
        return (
          <div key={it.id} className="contents">
            {sep && (
              <div className="my-1.5 flex items-center gap-1.5 self-center rounded-full border border-line bg-white px-3 py-1 text-xs font-semibold text-ink-3">
                <Calendar className="h-[13px] w-[13px]" />
                {londonDayHeading(it.at, now)}
              </div>
            )}
            {it.kind === "message" ? (
              <MessageRow item={it} leadName={leadName} />
            ) : it.kind === "click" ? (
              <SystemRow icon={<ChannelIcon channel={it.channel} className="h-3.5 w-3.5" />}>
                <strong>{it.label}</strong> · {londonHHMM(it.at)}
              </SystemRow>
            ) : (
              <SystemRow icon={<Clock className="h-3.5 w-3.5" />}>
                <strong>
                  Follow-up {it.number} of {it.total} {it.state === "done" ? "done" : it.state === "overdue" ? "overdue" : "due today"}
                </strong>{" "}
                · {it.channelLabel}
                {it.state !== "done" && " · reply and the plan stops here"}
              </SystemRow>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SystemRow({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 self-center rounded-[10px] border border-line bg-white px-3.5 py-2 text-[13px] text-ink-3">
      {icon}
      <span>{children}</span>
    </div>
  );
}

function Tick({ status }: { status: string }) {
  const read = status === "Read" || status === "Clicked a link";
  const double = read || status === "Delivered" || status === "Opened";
  const Icon = double ? CheckCheck : Check;
  return <Icon className="h-[13px] w-[13px]" style={{ color: read ? "#2f6fbf" : "#8a938b" }} />;
}

function MessageRow({ item, leadName }: { item: Extract<ThreadItem, { kind: "message" }>; leadName: string }) {
  const out = item.direction === "outbound";
  const time = londonHHMM(item.at);
  if (item.channel === "email") {
    return (
      <div className={cn("w-full max-w-[88%] overflow-hidden rounded-xl border border-line bg-white", out ? "self-end" : "self-start")}>
        <div className="flex items-center gap-2.5 border-b border-line bg-page px-3.5 py-2.5">
          <Mail className="h-4 w-4 text-brand-dark" />
          <span className="flex-1 truncate font-semibold">{item.subject || "(no subject)"}</span>
          <span className="text-xs text-ink-2">{time}</span>
        </div>
        <div className="px-3.5 py-3">
          {item.fromLine && <p className="mb-1 text-xs text-ink-2">{item.fromLine}</p>}
          <p className="whitespace-pre-line text-sm leading-normal">{item.body}</p>
          <p className="mt-2 text-xs font-semibold text-brand-dark">
            {item.statusLabel}
            {item.approximate && (
              <span className="font-normal text-ink-2" title="Approximate — some mail apps pre-load images.">
                {" "}
                · approx.
              </span>
            )}
          </p>
        </div>
      </div>
    );
  }
  if (out) {
    return (
      <div className="flex max-w-[78%] flex-col items-end self-end">
        <div className="whitespace-pre-line rounded-[14px_14px_4px_14px] bg-bubble px-3.5 py-2.5 text-[15px] leading-[1.45] text-ink">
          {item.body}
        </div>
        <div className="mt-[3px] flex items-center gap-1.5 pr-1 text-[11px] text-ink-2">
          {time} · {item.channelLabel} · {item.statusLabel}
          <Tick status={item.statusLabel} />
        </div>
      </div>
    );
  }
  return (
    <div className="flex max-w-[78%] items-end gap-2 self-start">
      <Avatar name={leadName} size={28} channel={item.channel} />
      <div>
        <div className="whitespace-pre-line rounded-[14px_14px_14px_4px] border border-line bg-white px-3.5 py-2.5 text-[15px] leading-[1.45]">
          {item.body}
        </div>
        <div className="mt-[3px] pl-1 text-[11px] text-ink-2">
          {time} · {item.channelLabel}
        </div>
      </div>
    </div>
  );
}
