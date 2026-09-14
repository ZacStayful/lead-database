import type { SourceRow } from "@/lib/home/leadSources";
import { SOURCE_WINDOW_DAYS } from "@/lib/home/leadSources";
import { CardTitleRow, HomeCard } from "./HomeCard";

export function LeadSourcesCard({ rows }: { rows: SourceRow[] }) {
  return (
    <HomeCard>
      <CardTitleRow title="Lead sources" right={<span className="text-xs text-ink-2">By area · last {SOURCE_WINDOW_DAYS} days</span>} />
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-ink-2">No leads in the last {SOURCE_WINDOW_DAYS} days.</p>
      ) : (
        <ul className="mt-3.5 space-y-2.5">
          {rows.map((r) => (
            <li key={r.area} className="flex items-center gap-2.5">
              <span className="w-[110px] truncate text-[13px]" title={r.label}>
                {r.label}
              </span>
              <span className="h-2 flex-1 overflow-hidden rounded-full bg-rail">
                <span className="block h-full rounded-full bg-[#8FAE82]" style={{ width: `${r.pct}%` }} />
              </span>
              <span className="w-6 text-right font-semibold tabular-nums">{r.count}</span>
            </li>
          ))}
        </ul>
      )}
    </HomeCard>
  );
}
