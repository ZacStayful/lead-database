"use client";

/**
 * The inbox column (§56.7): one row per lead the operator has approached,
 * whether by a connected channel or by a tap on their own phone. Tabs
 * Unread / All / Recent / Starred, a channel chip row (WhatsApp / Email —
 * never SMS), a search toggle. Selecting a row navigates: every thread is one
 * server pass, never an N+1.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { ListFilter, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { shortWhen } from "@/lib/londonTime";
import type { MessageChannel } from "@/lib/messaging/types";
import { Avatar, type BadgeChannel } from "./Avatar";
import { ConnectPrompt } from "./ConnectPrompt";

/** The lighter row shape the server hands the client (no full assignment). */
export interface InboxListRow {
  leadId: string;
  name: string;
  address: string | null;
  channel: BadgeChannel;
  channels: MessageChannel[];
  hasMessages: boolean;
  unread: number;
  starred: boolean;
  lastActivityAt: string;
  preview: string;
  isClick: boolean;
}

type Tab = "unread" | "all" | "recent" | "starred";

export interface ConnectState {
  /** A `connected` WhatsApp workspace — the prompt never shows for one. */
  connected: boolean;
  /** A connection row exists but is not connected — "Continue" rather than "Begin". */
  setupStarted: boolean;
}

export function InboxList({
  rows,
  selectedLeadId,
  emailEnabled,
  connect,
}: {
  rows: InboxListRow[];
  selectedLeadId: string | null;
  emailEnabled: boolean;
  connect: ConnectState;
}) {
  const now = useMemo(() => new Date(), []);
  const unreadCount = rows.filter((r) => r.unread > 0).length;
  // Every row is a tap on the operator's own phone and nothing has ever come
  // back: the one state where "connect" is worth a strip above the list.
  const clickOnly = rows.length > 0 && rows.every((r) => r.isClick && !r.hasMessages);
  const offerConnect = !connect.connected;
  const [tab, setTab] = useState<Tab>(unreadCount > 0 ? "unread" : "all");
  const [channel, setChannel] = useState<MessageChannel | "all">("all");
  const [searching, setSearching] = useState(false);
  const [q, setQ] = useState("");

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const week = now.getTime() - 7 * 86_400_000;
    return rows.filter((r) => {
      if (tab === "unread" && r.unread === 0) return false;
      if (tab === "starred" && !r.starred) return false;
      if (tab === "recent" && new Date(r.lastActivityAt).getTime() < week) return false;
      if (channel !== "all" && !r.channels.includes(channel) && !(r.isClick && r.channel === channel)) return false;
      if (needle && ![r.name, r.address, r.preview].some((s) => (s ?? "").toLowerCase().includes(needle))) return false;
      return true;
    });
  }, [rows, tab, channel, q, now]);

  const tabs: { key: Tab; label: string }[] = [
    { key: "unread", label: unreadCount > 0 ? `Unread (${unreadCount})` : "Unread" },
    { key: "all", label: "All" },
    { key: "recent", label: "Recent" },
    { key: "starred", label: "Starred" },
  ];

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-white">
      <div className="flex-shrink-0 px-4 pt-3.5">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Inbox</h2>
          <div className="flex items-center">
            <button
              type="button"
              onClick={() => setChannel((c) => (c === "all" ? "whatsapp" : c === "whatsapp" && emailEnabled ? "email" : "all"))}
              title={channel === "all" ? "All channels" : channel === "whatsapp" ? "WhatsApp only" : "Email only"}
              aria-label="Filter by channel"
              className={cn("p-1.5 text-ink-2 hover:text-ink", channel !== "all" && "text-brand-dark")}
            >
              <ListFilter className="h-[18px] w-[18px]" />
            </button>
            <button
              type="button"
              onClick={() => {
                setSearching((v) => !v);
                setQ("");
              }}
              aria-label="Search"
              aria-pressed={searching}
              className={cn("p-1.5 text-ink-2 hover:text-ink", searching && "text-brand-dark")}
            >
              <Search className="h-[18px] w-[18px]" />
            </button>
          </div>
        </div>
        {searching && (
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name, address or message…"
            className="mt-2 h-9 w-full rounded-lg border border-control px-3 text-sm outline-none focus:border-brand"
          />
        )}
        {channel !== "all" && (
          <p className="mt-1 text-xs text-ink-2">
            Showing {channel === "whatsapp" ? "WhatsApp" : "Email"} only ·{" "}
            <button type="button" className="underline" onClick={() => setChannel("all")}>
              clear
            </button>
          </p>
        )}
        <div className="mt-2 flex gap-1 border-b border-line">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                "flex-1 border-b-2 px-0.5 pb-2.5 pt-2 text-[13px] font-semibold",
                tab === t.key ? "border-brand text-brand-dark" : "border-transparent text-ink-2"
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto">
        {offerConnect && clickOnly && (
          <li>
            <ConnectPrompt variant="card" setupStarted={connect.setupStarted} emailEnabled={emailEnabled} />
          </li>
        )}
        {visible.length === 0 && (
          <li className="px-4 py-8 text-center text-sm text-ink-2">
            {rows.length === 0
              ? "No conversations yet. Ring, WhatsApp or email a landlord from a lead and it appears here."
              : "Nothing matches."}
          </li>
        )}
        {/* On a phone the right-hand panel is hidden, so the empty list carries the prompt itself. */}
        {offerConnect && rows.length === 0 && (
          <li className="lg:hidden">
            <ConnectPrompt variant="card" setupStarted={connect.setupStarted} emailEnabled={emailEnabled} />
          </li>
        )}
        {visible.map((r) => {
          const selected = r.leadId === selectedLeadId;
          const unread = r.unread > 0;
          return (
            <li key={r.leadId}>
              <Link
                href={`/dashboard/conversations/${r.leadId}`}
                aria-current={selected ? "page" : undefined}
                className={cn(
                  "flex gap-3 border-b border-rail px-4 py-3.5 text-left",
                  selected ? "bg-[#f3f7f1]" : "bg-white hover:bg-page",
                  "border-l-[3px]",
                  selected || unread ? "border-l-brand" : "border-l-transparent"
                )}
              >
                <Avatar name={r.name} size={42} channel={r.channel} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className={cn("truncate", unread ? "font-bold" : "font-semibold")}>{r.name}</span>
                    <span className="flex-shrink-0 text-xs text-ink-2">{shortWhen(r.lastActivityAt, now)}</span>
                  </span>
                  <span className="block truncate text-xs text-ink-2">{r.address ?? "—"}</span>
                  <span className="mt-0.5 flex items-center justify-between gap-2">
                    <span className={cn("truncate text-[13px]", unread ? "text-ink" : "text-ink-2", r.isClick && "italic")}>
                      {r.preview}
                    </span>
                    {unread && (
                      <span className="flex h-5 min-w-5 flex-shrink-0 items-center justify-center rounded-full bg-brand px-1.5 text-[11px] font-bold text-white">
                        {r.unread}
                      </span>
                    )}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
