"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import { snippetsForChannel, type Snippet } from "@/lib/messaging/snippets";
import type { MessageChannel } from "@/lib/messaging/types";

/**
 * The operator's saved replies (0150), fetched when the menu opens and
 * inserted into the composer. A closed list of their own text — no merge
 * fields are resolved here; {{booking_link}} and friends are the sequence
 * engine's business and are left as typed.
 */
export function SnippetPicker({
  channel,
  onPick,
}: {
  channel: MessageChannel;
  onPick: (body: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Snippet[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || list) return;
    fetch("/api/customer/messaging/snippets", { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error ?? "Could not load your snippets.");
        setList(d.snippets ?? []);
      })
      .catch((e: Error) => setError(e.message));
  }, [open, list]);

  const usable = list ? snippetsForChannel(list, channel) : [];

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Snippets"
        className="flex h-10 w-10 items-center justify-center rounded-[10px] border border-control bg-white text-ink-3 hover:bg-page"
      >
        <Sparkles className="h-[18px] w-[18px]" />
      </button>
      {open && (
        <div role="menu" className="absolute bottom-full right-0 z-30 mb-1 w-72 rounded-lg border border-line bg-white p-1">
          {error && <p className="px-3 py-2 text-xs text-destructive">{error}</p>}
          {!error && !list && <p className="px-3 py-2 text-xs text-ink-2">Loading…</p>}
          {list && usable.length === 0 && (
            <p className="px-3 py-2 text-xs text-ink-2">
              No snippets for this channel yet.{" "}
              <Link href="/dashboard/conversations/snippets" className="text-brand underline">
                Add one
              </Link>
              .
            </p>
          )}
          {usable.map((s) => (
            <button
              key={s.id}
              type="button"
              role="menuitem"
              onClick={() => {
                onPick(s.body_template);
                setOpen(false);
              }}
              className="block w-full rounded-md px-3 py-2 text-left hover:bg-page"
            >
              <span className="block truncate text-sm font-medium">{s.title}</span>
              <span className="block truncate text-xs text-ink-2">{s.body_template}</span>
            </button>
          ))}
          {list && (
            <Link href="/dashboard/conversations/snippets" className="block px-3 py-2 text-xs text-brand hover:underline">
              Manage snippets
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
