"use client";

import { useMemo, useState } from "react";
import { LeadCard } from "@/components/dashboard/LeadCard";
import {
  StageFilterBar,
  type StageFilter,
} from "@/components/dashboard/StageFilterBar";
import type { AssignmentWithLead } from "@/lib/types";

/**
 * The priority call list, with the same stage chips as the main leads list.
 *
 * Filtering only — the priority ORDER is computed on the server and preserved
 * exactly. Selecting a stage narrows the list; it never re-sorts it, so the
 * lead at the top of "Web meeting booked" is still the one due to be called
 * first.
 *
 * 'won' and 'contract_signed' are excluded from the chips: this list already
 * filters out status = 'won', and both of those stages set that status
 * (migration 0050), so they could only ever show a permanent zero.
 */
export function PriorityLeadsList({
  assignments,
}: {
  assignments: AssignmentWithLead[];
}) {
  const [stageFilter, setStageFilter] = useState<StageFilter>("all");

  const filtered = useMemo(
    () =>
      stageFilter === "all"
        ? assignments
        : assignments.filter((a) => a.pipeline_stage === stageFilter),
    [assignments, stageFilter]
  );

  if (assignments.length === 0) {
    return (
      <div className="rounded-lg border-[0.5px] border-dashed border-border p-12 text-center text-muted-foreground">
        No active leads to call right now.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <StageFilterBar
        optionSource={assignments}
        counted={assignments}
        value={stageFilter}
        onChange={setStageFilter}
        exclude={["won", "contract_signed"]}
        allLabel="All stages"
      />

      {filtered.length === 0 ? (
        <div className="rounded-lg border-[0.5px] border-dashed border-border p-12 text-center text-muted-foreground">
          No leads at this stage.
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((a) => (
            <LeadCard key={a.id} assignment={a} from="priority" />
          ))}
        </div>
      )}
    </div>
  );
}
