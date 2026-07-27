"use client";

import { useMemo } from "react";
import {
  PIPELINE_STAGES,
  GR_PIPELINE_STAGES,
  pipelineBadgeClass,
} from "@/components/dashboard/pipelineStage";
import type { AssignmentWithLead, PipelineStage } from "@/lib/types";

export type StageFilter = "all" | PipelineStage;

export function productOf(a: AssignmentWithLead) {
  return a.lead?.lead_type === "guaranteed_rent" ? "guaranteed_rent" : "management";
}

/**
 * Which stage chips to offer, driven by the products the customer actually
 * holds in the given set.
 *
 * A Management-only customer never sees "Contract sent"; a GR-only customer
 * never sees "Web meeting booked". Someone holding both gets exactly the union
 * — so the row stays short enough to scan instead of listing every stage in the
 * system.
 */
export function stageOptionsFor(
  assignments: AssignmentWithLead[],
  exclude: PipelineStage[] = []
): { value: PipelineStage; label: string }[] {
  const seen = new Set<string>();
  for (const a of assignments) seen.add(productOf(a));

  const out: { value: PipelineStage; label: string }[] = [];
  const push = (list: { value: PipelineStage; label: string }[]) => {
    for (const s of list) {
      if (exclude.includes(s.value)) continue;
      if (!out.some((o) => o.value === s.value)) out.push(s);
    }
  };
  if (seen.has("management")) push(PIPELINE_STAGES);
  if (seen.has("guaranteed_rent")) push(GR_PIPELINE_STAGES);
  return out;
}

/**
 * The stage chip row, shared by the leads list and the priority call list.
 *
 * Two separate sets go in on purpose:
 *  - `optionSource` decides WHICH chips exist. It is deliberately the widest
 *    reasonable set, so chips don't appear and disappear as the customer types
 *    in a search box — a row that reflows under the cursor is unusable.
 *  - `counted` decides the NUMBER on each chip, and is the set actually on
 *    screen. Without this a count would promise leads the search box then
 *    hides, and the number would look broken.
 */
export function StageFilterBar({
  optionSource,
  counted,
  value,
  onChange,
  exclude = [],
  allLabel = "All stages",
}: {
  optionSource: AssignmentWithLead[];
  counted: AssignmentWithLead[];
  value: StageFilter;
  onChange: (next: StageFilter) => void;
  /** Stages that cannot occur in this list — omitted rather than shown at 0. */
  exclude?: PipelineStage[];
  allLabel?: string;
}) {
  const options = useMemo(
    () => stageOptionsFor(optionSource, exclude),
    // `exclude` is a literal at every call site; spread so a fresh array
    // identity on each render doesn't recompute needlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [optionSource, exclude.join(",")]
  );

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of counted) {
      const s = a.pipeline_stage ?? "cold";
      map.set(s, (map.get(s) ?? 0) + 1);
    }
    return map;
  }, [counted]);

  if (options.length === 0) return null;

  return (
    /* Horizontally scrollable rather than wrapping — seven-plus stages would
       otherwise take three lines on a phone before a single lead is visible. */
    <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
      <StageChip
        label={allLabel}
        count={counted.length}
        active={value === "all"}
        onClick={() => onChange("all")}
      />
      {options.map((s) => (
        <StageChip
          key={s.value}
          label={s.label}
          count={counts.get(s.value) ?? 0}
          active={value === s.value}
          badgeClass={pipelineBadgeClass(s.value)}
          onClick={() => onChange(s.value)}
        />
      ))}
    </div>
  );
}

/**
 * A stage filter chip carrying its own count.
 *
 * The count is the point: it turns the row into a summary of where the
 * customer's pipeline actually sits, so they can see they have four leads at
 * "web meeting booked" without selecting anything. A zero-count stage stays
 * visible but dimmed — that a stage is empty is information too, and hiding it
 * would make the row jump around as leads move.
 */
function StageChip({
  label,
  count,
  active,
  badgeClass,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  badgeClass?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border-[0.5px] px-3 py-1.5 text-sm transition-colors " +
        (active
          ? "border-brand bg-brand text-brand-foreground"
          : count === 0
            ? "border-border text-muted-foreground/60 hover:bg-accent"
            : "border-border text-foreground hover:bg-accent")
      }
    >
      {!active && badgeClass && (
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${badgeClass}`}
          aria-hidden
        />
      )}
      <span className="whitespace-nowrap">{label}</span>
      <span className={active ? "opacity-80" : "text-muted-foreground"}>
        {count}
      </span>
    </button>
  );
}
