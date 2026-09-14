"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import type { Tabset } from "@/lib/dashboardNav";

/** The second white strip under the top bar (§56.7). */
export function SubTabs({
  tabset,
  activeHref,
  showTitle,
}: {
  tabset: Tabset;
  activeHref: string | null;
  showTitle: boolean;
}) {
  return (
    <div className="flex flex-shrink-0 items-end gap-6 overflow-x-auto border-b border-line bg-white px-5 pt-3.5">
      {showTitle && (
        <h1 className="hidden pb-3 font-display text-[22px] font-semibold tracking-[-0.01em] text-ink lg:block">
          {tabset.title}
        </h1>
      )}
      <div className="flex gap-1">
        {tabset.tabs.map((t) => {
          const active = t.href === activeHref;
          return (
            <Link
              key={t.href}
              href={t.href}
              className={cn(
                "whitespace-nowrap border-b-2 px-3 pb-3 pt-1.5 text-[15px] font-medium transition-colors",
                active ? "border-brand text-brand-dark" : "border-transparent text-ink-2 hover:text-ink"
              )}
            >
              {t.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
