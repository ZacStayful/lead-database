"use client";

import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { LeadCard } from "./LeadCard";
import {
  PIPELINE_STAGES,
  GR_PIPELINE_STAGES,
  pipelineBadgeClass,
} from "@/components/dashboard/pipelineStage";
import type { AssignmentWithLead, PipelineStage } from "@/lib/types";

/**
 * Activity filters — the state of the customer's own working relationship with
 * a lead, as distinct from where it sits in their sales pipeline. Kept separate
 * from the stage filter below because they answer different questions: "what
 * haven't I looked at" versus "what's at the meeting-booked step".
 */
type Filter = "all" | "new" | "viewed" | "contacted" | "won";
type TypeFilter = "all" | "management" | "guaranteed_rent";
type StageFilter = "all" | PipelineStage;

export function LeadsList({
  assignments,
}: {
  assignments: AssignmentWithLead[];
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [stageFilter, setStageFilter] = useState<StageFilter>("all");

  // Only offer the product filter when the customer actually holds both types.
  const hasBothTypes = useMemo(() => {
    let mgmt = false;
    let gr = false;
    for (const a of assignments) {
      if (a.lead?.lead_type === "guaranteed_rent") gr = true;
      else mgmt = true;
      if (mgmt && gr) return true;
    }
    return false;
  }, [assignments]);

  const productOf = (a: AssignmentWithLead) =>
    a.lead?.lead_type === "guaranteed_rent" ? "guaranteed_rent" : "management";

  /**
   * Which stages to offer, driven by the leads the customer actually holds.
   *
   * A Management-only customer never sees "Contract sent"; a GR-only customer
   * never sees "Web meeting booked". Someone holding both, or filtered to one
   * product, gets exactly the relevant set — so the chip row stays short enough
   * to scan instead of listing every stage in the system.
   */
  const stageOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const a of assignments) {
      if (typeFilter !== "all" && productOf(a) !== typeFilter) continue;
      seen.add(productOf(a));
    }
    const out: { value: PipelineStage; label: string }[] = [];
    const push = (list: { value: PipelineStage; label: string }[]) => {
      for (const s of list) {
        if (!out.some((o) => o.value === s.value)) out.push(s);
      }
    };
    if (seen.has("management")) push(PIPELINE_STAGES);
    if (seen.has("guaranteed_rent")) push(GR_PIPELINE_STAGES);
    return out;
  }, [assignments, typeFilter]);

  // Everything except the stage filter, so stage counts reflect the other
  // filters in force. Without this a count would promise leads that the search
  // box or product filter then hides, and the number would look broken.
  const beforeStage = useMemo(() => {
    const q = query.trim().toLowerCase();
    return assignments.filter((a) => {
      const lead = a.lead;
      if (filter === "new" && a.viewed_at) return false;
      if (filter === "viewed" && !a.viewed_at) return false;
      if (filter === "contacted" && a.status !== "contacted") return false;
      // Won filters on STATUS, not stage: both the Management 'won' stage and
      // the GR 'contract_signed' stage set status = 'won' (migration 0050), so
      // one status check covers both products and also catches leads won via
      // the "Mark as signed" button without the stage being moved.
      if (filter === "won" && a.status !== "won") return false;
      if (typeFilter !== "all" && productOf(a) !== typeFilter) return false;
      if (!q) return true;
      return [
        lead?.lead_name,
        lead?.address,
        lead?.email,
        lead?.bedrooms,
        lead?.lead_profile,
      ]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });
  }, [assignments, query, filter, typeFilter]);

  const stageCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of beforeStage) {
      const s = a.pipeline_stage ?? "cold";
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    return counts;
  }, [beforeStage]);

  const filtered = useMemo(
    () =>
      stageFilter === "all"
        ? beforeStage
        : beforeStage.filter((a) => a.pipeline_stage === stageFilter),
    [beforeStage, stageFilter]
  );

  const filters: { key: Filter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "new", label: "New" },
    { key: "viewed", label: "Viewed" },
    { key: "contacted", label: "Contacted" },
    { key: "won", label: "Won" },
  ];

  const typeFilters: { key: TypeFilter; label: string }[] = [
    { key: "all", label: "All types" },
    { key: "management", label: "Management" },
    { key: "guaranteed_rent", label: "Guaranteed Rent" },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Input
          placeholder="Search by name, address, email…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="sm:max-w-xs"
        />
        <div className="flex gap-1">
          {filters.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors " +
                (filter === f.key
                  ? "bg-brand text-brand-foreground"
                  : "text-muted-foreground hover:bg-accent")
              }
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {hasBothTypes && (
        <div className="flex gap-1">
          {typeFilters.map((f) => (
            <button
              key={f.key}
              onClick={() => {
                setTypeFilter(f.key);
                // A stage that belongs to the other product would now match
                // nothing, leaving an empty list with a filter the customer
                // can no longer see selected. Reset rather than strand them.
                setStageFilter("all");
              }}
              className={
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors " +
                (typeFilter === f.key
                  ? "bg-brand text-brand-foreground"
                  : "text-muted-foreground hover:bg-accent")
              }
            >
              {f.label}
            </button>
          ))}
        </div>
      )}

      {/* Stage chips. Horizontally scrollable rather than wrapping — seven-plus
          stages would otherwise take three lines on a phone before a single
          lead is visible. */}
      {stageOptions.length > 0 && (
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
          <StageChip
            label="All stages"
            count={beforeStage.length}
            active={stageFilter === "all"}
            onClick={() => setStageFilter("all")}
          />
          {stageOptions.map((s) => (
            <StageChip
              key={s.value}
              label={s.label}
              count={stageCounts.get(s.value) ?? 0}
              active={stageFilter === s.value}
              badgeClass={pipelineBadgeClass(s.value)}
              onClick={() => setStageFilter(s.value)}
            />
          ))}
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="rounded-lg border-[0.5px] border-dashed border-border p-12 text-center text-muted-foreground">
          No leads match your filters.
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((a) => (
            <LeadCard key={a.id} assignment={a} />
          ))}
        </div>
      )}
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
