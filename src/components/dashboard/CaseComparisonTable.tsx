"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { GATE_LABEL, LOSS_REASON_LABEL, OUTCOME_LABEL } from "@/lib/caseStudies";
import type { CaseStudy } from "@/lib/types";

type SortKey = "sort_order" | "days_to_outcome" | "outcome";

/**
 * All nine journeys side by side, sortable.
 *
 * Client-side sorting on a set this small: the whole table is already in the
 * page, so a round trip to reorder nine rows would be slower and would lose
 * the reader's place.
 */
export function CaseComparisonTable({ cases }: { cases: CaseStudy[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("sort_order");
  const [ascending, setAscending] = useState(true);

  const rows = useMemo(() => {
    const sorted = [...cases].sort((a, b) => {
      if (sortKey === "days_to_outcome") {
        return a.days_to_outcome - b.days_to_outcome;
      }
      if (sortKey === "outcome") {
        // Signed first when ascending; within a group keep the authored order.
        if (a.outcome !== b.outcome) return a.outcome === "signed" ? -1 : 1;
        return a.sort_order - b.sort_order;
      }
      return a.sort_order - b.sort_order;
    });
    return ascending ? sorted : sorted.reverse();
  }, [cases, sortKey, ascending]);

  function toggle(key: SortKey) {
    if (key === sortKey) {
      setAscending((v) => !v);
      return;
    }
    setSortKey(key);
    setAscending(true);
  }

  function arrow(key: SortKey) {
    if (key !== sortKey) return null;
    return <span aria-hidden="true"> {ascending ? "↑" : "↓"}</span>;
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-black/10 bg-white">
      <table className="w-full min-w-[52rem] border-collapse text-sm">
        <thead>
          <tr className="border-b-[0.5px] border-black/10 text-left">
            <th className="px-4 py-3 font-medium">Case</th>
            <th className="px-4 py-3 font-medium">
              <button
                type="button"
                onClick={() => toggle("outcome")}
                className="font-medium hover:underline"
              >
                Outcome{arrow("outcome")}
              </button>
            </th>
            <th className="px-4 py-3 font-medium">Reached</th>
            <th className="px-4 py-3 text-right font-medium">
              <button
                type="button"
                onClick={() => toggle("days_to_outcome")}
                className="font-medium hover:underline"
              >
                Days{arrow("days_to_outcome")}
              </button>
            </th>
            <th className="px-4 py-3 text-right font-medium">Meetings</th>
            <th className="px-4 py-3 text-right font-medium">Calls answered</th>
            <th className="px-4 py-3 text-right font-medium">Emails out</th>
            <th className="px-4 py-3 font-medium">Offer</th>
            <th className="px-4 py-3 font-medium">No-show</th>
            <th className="px-4 py-3 font-medium">Why it ended</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id} className="border-b-[0.5px] border-black/10 last:border-0">
              <td className="px-4 py-3">
                <Link
                  href={`/dashboard/training/case-studies/${c.slug}`}
                  className="font-medium text-[#1a1a19] hover:underline"
                >
                  {c.reference}
                </Link>
                <span className="block text-sm text-muted-foreground">
                  {c.property_summary}
                </span>
              </td>
              <td className="px-4 py-3">
                <span
                  className={
                    "font-medium " +
                    (c.outcome === "signed" ? "text-[#5D8156]" : "text-[#52514e]")
                  }
                >
                  {OUTCOME_LABEL[c.outcome]}
                </span>
              </td>
              <td className="px-4 py-3 text-muted-foreground">
                {GATE_LABEL[c.gate_reached]}
              </td>
              <td className="px-4 py-3 text-right">{c.days_to_outcome}</td>
              <td className="px-4 py-3 text-right">{dash(c.meetings_sat)}</td>
              <td className="px-4 py-3 text-right">{dash(c.calls_answered)}</td>
              <td className="px-4 py-3 text-right">{dash(c.emails_out)}</td>
              <td className="px-4 py-3 text-muted-foreground">
                {c.offer_applied ? "Yes" : "No"}
              </td>
              <td className="px-4 py-3 text-muted-foreground">
                {c.had_no_show ? "Yes" : "No"}
              </td>
              <td className="px-4 py-3 text-muted-foreground">
                {c.loss_reason ? LOSS_REASON_LABEL[c.loss_reason] : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** An em dash for a figure that was never recorded, never a zero. */
function dash(value: number | null): string {
  return value === null || value === undefined ? "—" : String(value);
}
