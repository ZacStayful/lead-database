"use client";

import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { LeadCard } from "./LeadCard";
import type { AssignmentWithLead } from "@/lib/types";

type Filter = "all" | "new" | "viewed" | "contacted";

export function LeadsList({
  assignments,
}: {
  assignments: AssignmentWithLead[];
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return assignments.filter((a) => {
      const lead = a.lead;
      if (filter === "new" && a.viewed_at) return false;
      if (filter === "viewed" && !a.viewed_at) return false;
      if (filter === "contacted" && a.status !== "contacted") return false;
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
  }, [assignments, query, filter]);

  const filters: { key: Filter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "new", label: "New" },
    { key: "viewed", label: "Viewed" },
    { key: "contacted", label: "Contacted" },
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
