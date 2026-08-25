"use client";

import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { LeadCard } from "./LeadCard";
import {
  StageFilterBar,
  productOf,
  type StageFilter,
} from "@/components/dashboard/StageFilterBar";
import type { AssignmentWithLead } from "@/lib/types";

/**
 * Activity filters — the state of the customer's own working relationship with
 * a lead, as distinct from where it sits in their sales pipeline. Kept separate
 * from the stage filter below because they answer different questions: "what
 * haven't I looked at" versus "what's at the meeting-booked step".
 */
type Filter = "all" | "new" | "viewed" | "contacted" | "won";
type TypeFilter = "all" | "management" | "guaranteed_rent";
/**
 * Where the lead came from. Only offered once the customer actually has some of
 * their own, so a customer who has never imported anything never sees a filter
 * whose second option would always be empty.
 */
type SourceFilter = "all" | "stayful" | "mine";

export function LeadsList({
  assignments,
}: {
  assignments: AssignmentWithLead[];
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [stageFilter, setStageFilter] = useState<StageFilter>("all");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");

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

  const hasOwnLeads = useMemo(
    () => assignments.some((a) => Boolean(a.lead?.owner_customer_id)),
    [assignments]
  );

  // Which chips exist follows the product and source filters only — not the
  // search box, so the row doesn't reflow while the customer is typing in it.
  const typeScoped = useMemo(() => {
    const byType =
      typeFilter === "all"
        ? assignments
        : assignments.filter((a) => productOf(a) === typeFilter);
    if (sourceFilter === "all") return byType;
    return byType.filter((a) =>
      sourceFilter === "mine"
        ? Boolean(a.lead?.owner_customer_id)
        : !a.lead?.owner_customer_id
    );
  }, [assignments, typeFilter, sourceFilter]);

  // Everything except the stage filter, so stage counts reflect the other
  // filters in force.
  const beforeStage = useMemo(() => {
    const q = query.trim().toLowerCase();
    return typeScoped.filter((a) => {
      const lead = a.lead;
      if (filter === "new" && a.viewed_at) return false;
      if (filter === "viewed" && !a.viewed_at) return false;
      if (filter === "contacted" && a.status !== "contacted") return false;
      // Won filters on STATUS, not stage: both the Management 'won' stage and
      // the GR 'contract_signed' stage set status = 'won' (migration 0050), so
      // one status check covers both products and also catches leads won via
      // the "Mark as signed" button without the stage being moved.
      if (filter === "won" && a.status !== "won") return false;
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
  }, [typeScoped, query, filter]);

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

  const sourceFilters: { key: SourceFilter; label: string }[] = [
    { key: "all", label: "All sources" },
    { key: "stayful", label: "From Stayful" },
    { key: "mine", label: "Your leads" },
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

      {hasOwnLeads && (
        <div className="flex gap-1">
          {sourceFilters.map((f) => (
            <button
              key={f.key}
              onClick={() => {
                setSourceFilter(f.key);
                setStageFilter("all");
              }}
              className={
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors " +
                (sourceFilter === f.key
                  ? "bg-brand text-brand-foreground"
                  : "text-muted-foreground hover:bg-accent")
              }
            >
              {f.label}
            </button>
          ))}
        </div>
      )}

      <StageFilterBar
        optionSource={typeScoped}
        counted={beforeStage}
        value={stageFilter}
        onChange={setStageFilter}
      />

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
