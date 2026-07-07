"use client";

import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { LeadCard } from "./LeadCard";
import type { AssignmentWithLead } from "@/lib/types";

type Filter = "all" | "new" | "viewed" | "contacted";
type TypeFilter = "all" | "management" | "guaranteed_rent";

export function LeadsList({
  assignments,
}: {
  assignments: AssignmentWithLead[];
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");

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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return assignments.filter((a) => {
      const lead = a.lead;
      if (filter === "new" && a.viewed_at) return false;
      if (filter === "viewed" && !a.viewed_at) return false;
      if (filter === "contacted" && a.status !== "contacted") return false;
      if (typeFilter !== "all") {
        const t = lead?.lead_type === "guaranteed_rent" ? "guaranteed_rent" : "management";
        if (t !== typeFilter) return false;
      }
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

  const filters: { key: Filter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "new", label: "New" },
    { key: "viewed", label: "Viewed" },
    { key: "contacted", label: "Contacted" },
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
              onClick={() => setTypeFilter(f.key)}
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
