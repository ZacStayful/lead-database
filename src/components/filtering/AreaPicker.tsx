"use client";

import { useMemo } from "react";
import { Input } from "@/components/ui/input";

/**
 * Hand-picking postcode areas: a search box, a checkbox list carrying each
 * area's lead count, and removable chips for what is selected.
 *
 * Lifted verbatim out of LeadFilteringPanel so the public estimator offers the
 * same control rather than a thinner imitation of it. The per-area counts are
 * the reason it is worth sharing — a bare list of codes asks a visitor to know
 * which areas are worth having, which is the thing they came to find out.
 */

export interface AreaOption {
  area: string;
  label: string;
}

/** The area's display label, falling back to the bare code. */
export function labelFor(area: string, options: AreaOption[]): string {
  return options.find((o) => o.area === area)?.label ?? area;
}

export function AreaPicker({
  availableAreas,
  areaCounts,
  selected,
  query,
  onQueryChange,
  onToggle,
}: {
  availableAreas: AreaOption[];
  areaCounts: Record<string, number>;
  selected: string[];
  query: string;
  onQueryChange: (q: string) => void;
  onToggle: (area: string) => void;
}) {
  const visibleAreas = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return availableAreas;
    return availableAreas.filter(
      (a) =>
        a.area.toLowerCase().includes(q) || a.label.toLowerCase().includes(q)
    );
  }, [availableAreas, query]);

  return (
    <>
      <Input
        className="mt-2"
        placeholder="Search areas…"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
      />
      <div className="mt-2 grid max-h-64 grid-cols-1 gap-1 overflow-y-auto rounded-md border-[0.5px] border-border p-2 sm:grid-cols-2 lg:grid-cols-3">
        {visibleAreas.map((a) => {
          const checked = selected.includes(a.area);
          return (
            <label
              key={a.area}
              className={
                "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm " +
                (checked ? "bg-brand/10" : "hover:bg-accent")
              }
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onToggle(a.area)}
                className="h-4 w-4 shrink-0"
              />
              <span className="truncate">{a.label}</span>
              {areaCounts[a.area] != null && (
                <span className="ml-auto shrink-0 tabular-nums text-xs text-muted-foreground">
                  {areaCounts[a.area]}
                </span>
              )}
            </label>
          );
        })}
        {visibleAreas.length === 0 && (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">
            No areas match “{query}”.
          </p>
        )}
      </div>
      {selected.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {selected.map((a) => (
            <span
              key={a}
              className="inline-flex items-center gap-1 rounded bg-brand/10 px-2 py-0.5 text-xs font-medium text-brand"
            >
              {labelFor(a, availableAreas)}
              <button
                type="button"
                onClick={() => onToggle(a)}
                aria-label={`Remove ${a}`}
                className="text-brand/70 hover:text-brand"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </>
  );
}
