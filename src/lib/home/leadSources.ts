/**
 * Where the last 30 days' leads came from, by POSTCODE AREA (§56.7). PURE.
 *
 * ⚠️ Areas, never towns. §40.14 measured `extractCity()` at 173 of 446
 * addresses and wrong on the commonest shape. `postcode_area` is parsed,
 * indexed and what the router itself matches on.
 */
import { areaLabel } from "@/lib/postcode";

export const SOURCE_WINDOW_DAYS = 30;
export const SOURCE_ROWS = 5;

export interface SourceRow {
  area: string;
  label: string;
  count: number;
  /** Bar width relative to the top row, 0–100. */
  pct: number;
}

export function buildLeadSources(
  assignments: { assigned_at: string; lead?: { postcode_area?: string | null } | null }[],
  now: Date
): SourceRow[] {
  const since = now.getTime() - SOURCE_WINDOW_DAYS * 86_400_000;
  const counts = new Map<string, number>();
  for (const a of assignments) {
    if (new Date(a.assigned_at).getTime() < since) continue;
    const area = a.lead?.postcode_area?.trim().toUpperCase();
    if (!area) continue;
    counts.set(area, (counts.get(area) ?? 0) + 1);
  }
  const sorted = Array.from(counts.entries()).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
  const top = sorted[0]?.[1] ?? 0;
  return sorted.slice(0, SOURCE_ROWS).map(([area, count]) => ({
    area,
    label: areaLabel(area),
    count,
    pct: top > 0 ? Math.round((count / top) * 100) : 0,
  }));
}
