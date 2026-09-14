"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { SidebarModel } from "@/lib/dashboardNav";

export interface PaletteLead {
  id: string;
  name: string;
  address: string | null;
}

/**
 * ⌘K. A client-side filter over the nav and the customer's own leads — the
 * rows arrive with the layout, so there is no search endpoint and §27.1's
 * rule (no free-form query surface) is untouched.
 */
export function CommandPalette({
  open,
  onOpenChange,
  model,
  leads,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  model: SidebarModel;
  leads: PaletteLead[];
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) {
      setQ("");
      setCursor(0);
    }
  }, [open]);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const pages = [...model.main, ...model.secondary, model.bottom].map((i) => ({
      kind: "page" as const,
      label: i.label,
      sub: null as string | null,
      href: i.href,
    }));
    const leadRows = leads.map((l) => ({
      kind: "lead" as const,
      label: l.name,
      sub: l.address,
      href: `/dashboard/leads/${l.id}`,
    }));
    if (!needle) return pages.slice(0, 8);
    const match = (s: string | null) => (s ?? "").toLowerCase().includes(needle);
    return [
      ...pages.filter((p) => match(p.label)),
      ...leadRows.filter((l) => match(l.label) || match(l.sub)),
    ].slice(0, 12);
  }, [q, model, leads]);

  function go(href: string) {
    onOpenChange(false);
    router.push(href);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[18%] max-w-lg -translate-y-0 gap-0 p-0 sm:rounded-xl">
        <DialogTitle className="sr-only">Search</DialogTitle>
        <div className="flex items-center gap-2 border-b border-line px-4">
          <Search className="h-4 w-4 text-ink-2" />
          <input
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setCursor(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor((c) => Math.min(c + 1, results.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              } else if (e.key === "Enter" && results[cursor]) {
                e.preventDefault();
                go(results[cursor].href);
              }
            }}
            placeholder="Search pages and leads…"
            className="h-12 flex-1 bg-transparent text-[15px] outline-none placeholder:text-ink-placeholder"
          />
        </div>
        <ul className="max-h-80 overflow-y-auto p-1" role="listbox">
          {results.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-ink-2">Nothing matches.</li>
          )}
          {results.map((r, i) => (
            <li key={`${r.kind}:${r.href}`} role="option" aria-selected={i === cursor}>
              <button
                type="button"
                onMouseEnter={() => setCursor(i)}
                onClick={() => go(r.href)}
                className={
                  "flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm " +
                  (i === cursor ? "bg-page" : "")
                }
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium text-ink">{r.label}</span>
                  {r.sub && <span className="block truncate text-xs text-ink-2">{r.sub}</span>}
                </span>
                <span className="ml-3 flex-shrink-0 text-[11px] uppercase tracking-wide text-ink-2">
                  {r.kind}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
