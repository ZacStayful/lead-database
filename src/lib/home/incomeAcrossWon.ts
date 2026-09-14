/**
 * "Income projection across your N signed landlords" (§56.7). PURE.
 *
 * ⚠️ Sums `leads.gross_annual_income` — Stayful's figure — and NEVER
 * `income_estimate`, the operator's own typed number (§25: the two are never
 * merged or used as each other's fallback). Management only: the fee half
 * is what a management operator earns (§31.10), and a GR lead carries no
 * analysis today anyway.
 *
 * A won lead the viewer uploaded and sold on is theirs; one they bought from
 * another operator is also theirs to count. What is excluded is nothing —
 * the caller has already viewer-scoped the list. Leads with no figure are
 * counted in `signed` and contribute nothing, and the card says so.
 */
import { buildIncomeProjection, type IncomeProjection } from "@/lib/incomeProjection";

export interface IncomeAcrossWon {
  signed: number;
  withFigures: number;
  projection: IncomeProjection;
}

export function buildIncomeAcrossWon(
  assignments: {
    status: string;
    lead?: { lead_type?: string | null; gross_annual_income?: number | null } | null;
  }[]
): IncomeAcrossWon | null {
  const won = assignments.filter(
    (a) => a.status === "won" && (a.lead?.lead_type ?? "management") === "management"
  );
  if (won.length === 0) return null;
  const figures = won.map((a) => a.lead?.gross_annual_income).filter((g): g is number => typeof g === "number" && g > 0);
  if (figures.length === 0) return null;
  const projection = buildIncomeProjection({
    gross_annual_income: figures.reduce((s, g) => s + g, 0),
  });
  if (!projection) return null;
  return { signed: won.length, withFigures: figures.length, projection };
}

/** "£94k – £115k" / "£1,200 – £1,500" */
export function formatRangeGbp(low: number, high: number): string {
  return `${compactGbp(low)} – ${compactGbp(high)}`;
}

export function compactGbp(n: number): string {
  if (n >= 10_000) {
    const k = n / 1000;
    const s = k >= 100 ? Math.round(k).toString() : (Math.round(k * 10) / 10).toString();
    return `£${s}k`;
  }
  return `£${Math.round(n).toLocaleString("en-GB")}`;
}
