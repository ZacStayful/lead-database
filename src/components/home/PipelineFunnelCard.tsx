"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { formatMinutes, type Funnel } from "@/lib/home/pipelineFunnel";
import { CardTitleRow, HomeCard } from "./HomeCard";

const PRODUCT_LABEL = { management: "Management", guaranteed_rent: "Guaranteed Rent" } as const;

/**
 * Received → Contacted → meeting stages → Won, with Cumulative and Next-step
 * columns (§56.7). One funnel per product the customer has leads for; the
 * toggle only appears when there is more than one.
 */
export function PipelineFunnelCard({ funnels }: { funnels: Funnel[] }) {
  const [which, setWhich] = useState(0);
  const f = funnels[which] ?? funnels[0];
  if (!f || f.received === 0) return null;

  return (
    <HomeCard>
      <CardTitleRow
        title="Pipeline funnel"
        right={
          funnels.length > 1 ? (
            <label className="relative inline-flex h-8 items-center rounded-lg border border-control px-2.5 text-[13px] font-medium text-ink">
              <select
                aria-label="Product"
                value={which}
                onChange={(e) => setWhich(Number(e.target.value))}
                className="appearance-none bg-transparent pr-5 outline-none"
              >
                {funnels.map((x, i) => (
                  <option key={x.leadType} value={i}>
                    {PRODUCT_LABEL[x.leadType]}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 h-3 w-3" />
            </label>
          ) : funnels.length === 1 && f.leadType === "guaranteed_rent" ? (
            <span className="text-[13px] text-ink-2">{PRODUCT_LABEL[f.leadType]}</span>
          ) : null
        }
      />
      <div className="mt-2 flex flex-wrap items-baseline gap-2">
        <span className="font-display text-[30px] font-semibold text-brand-dark">{f.signedPct ?? 0}%</span>
        <span className="text-ink-2">
          of leads signed
          {f.medianResponseMinutes !== null && ` · ${formatMinutes(f.medianResponseMinutes)} median response`}
        </span>
      </div>

      <div className="mt-3.5 grid gap-x-2.5 gap-y-1.5 text-center text-xs text-ink-2" style={{ gridTemplateColumns: "minmax(0,1fr) 84px 84px" }}>
        <span />
        <span>Cumulative</span>
        <span>Next step</span>
        {f.rows.map((r, i) => (
          <FunnelRow key={r.key} row={r} light={i < 4} />
        ))}
      </div>
    </HomeCard>
  );
}

function FunnelRow({ row, light }: { row: Funnel["rows"][number]; light: boolean }) {
  return (
    <>
      <div className="relative h-11 overflow-hidden rounded-md bg-page">
        <div className="absolute bottom-0 left-0 top-0 rounded-md" style={{ width: `${row.widthPct}%`, background: row.fill }} />
        <div
          className="absolute inset-0 flex items-center justify-between px-3.5 text-sm"
          style={{ color: light ? "#1a1a19" : "#fff" }}
        >
          <span className="font-medium">{row.label}</span>
          <span className="font-semibold tabular-nums">{row.count}</span>
        </div>
      </div>
      <div className="flex h-11 items-center justify-center rounded-md bg-rail text-sm font-semibold tabular-nums text-ink">
        {row.cumulativePct}%
      </div>
      <div className="flex h-11 items-center justify-center rounded-md bg-rail text-sm font-semibold tabular-nums text-ink">
        {row.nextStepPct === null ? "—" : `${row.nextStepPct}%`}
      </div>
    </>
  );
}
