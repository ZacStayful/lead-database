import { cityForArea } from "@/lib/postcode";
import { tierForArea } from "@/lib/leadBrief/areas";
import { MAX_SIMILAR_AREAS, MIN_SIMILAR_AREA_LEADS } from "@/lib/leadBrief/plans";
import type { CompetitionTier, SupplyLead } from "@/lib/leadBrief/types";

/**
 * Areas like the customer's own, ranked low competition first.
 *
 * Postcode areas, not outcodes (D4): no outcode in the book has more than four
 * leads, so outcode-level averages would be noise. An area is only compared
 * once it has MIN_SIMILAR_AREA_LEADS leads.
 *
 * Three figures are compared — average gross, nightly rate and occupancy — and
 * each similar area is returned with its figures beside the customer's, so the
 * preview can say exactly why it is similar. ⚠️ THERE IS DELIBERATELY NO
 * "LANDLORD GAIN" FIGURE: the build prompt's net − long-let uses
 * net_annual_income, which is net of Stayful's own 15% fee and is rendered
 * nowhere by design (§26.1, §40.5). Lead counts are never returned (A4).
 */
export interface AreaFigures {
  /** Average projected gross, pounds, to the nearest £100. */
  gross: number | null;
  /** Average nightly rate, whole pounds. */
  nightly: number | null;
  /** Average occupancy, whole percent. */
  occupancy: number | null;
}

export interface SimilarArea {
  area: string;
  city: string;
  tier: CompetitionTier | null;
  figures: AreaFigures;
  /** The customer's own areas' figures, the comparison point. */
  reference: AreaFigures;
  /** The top suggestion, pre-ticked as "Recommended for your brief" (A8). */
  recommended: boolean;
}

function mean(values: (number | null)[]): number | null {
  const v = values.filter((x): x is number => x !== null && Number.isFinite(x));
  return v.length === 0 ? null : v.reduce((a, b) => a + b, 0) / v.length;
}

export function figuresFor(leads: SupplyLead[]): AreaFigures {
  const gross = mean(leads.map((l) => l.gross));
  const nightly = mean(leads.map((l) => l.nightly));
  const occupancy = mean(leads.map((l) => l.occupancy));
  return {
    gross: gross === null ? null : Math.round(gross / 100) * 100,
    nightly: nightly === null ? null : Math.round(nightly),
    occupancy: occupancy === null ? null : Math.round(occupancy),
  };
}

/**
 * Mean relative difference over the figures both sides have. Lower is more
 * similar. Null when no figure can be compared.
 */
export function dissimilarity(a: AreaFigures, ref: AreaFigures): number | null {
  const diffs: number[] = [];
  for (const k of ["gross", "nightly", "occupancy"] as const) {
    const x = a[k];
    const r = ref[k];
    if (x !== null && r !== null && r > 0) diffs.push(Math.abs(x - r) / r);
  }
  return diffs.length === 0 ? null : diffs.reduce((s, d) => s + d, 0) / diffs.length;
}

const TIER_ORDER: Record<string, number> = { low: 0, medium: 1, unknown: 2, high: 3 };

export function computeSimilarAreas(args: {
  /** The customer's own postcode areas (base and priority outcodes). */
  referenceAreas: string[];
  /** Areas with at least one outcode inside the cap. */
  reachableAreas: Set<string>;
  leads: SupplyLead[];
  /** Used for the reference figures when the customer's own areas have no leads. */
  fallbackReferenceLeads: SupplyLead[];
  competition: Record<string, CompetitionTier>;
}): SimilarArea[] {
  const refSet = new Set(args.referenceAreas);
  const byArea = new Map<string, SupplyLead[]>();
  for (const lead of args.leads) {
    if (!lead.area) continue;
    const list = byArea.get(lead.area) ?? [];
    list.push(lead);
    byArea.set(lead.area, list);
  }

  const ownLeads = args.leads.filter((l) => l.area !== null && refSet.has(l.area));
  let reference = figuresFor(ownLeads);
  if (reference.gross === null && reference.nightly === null && reference.occupancy === null) {
    reference = figuresFor(args.fallbackReferenceLeads);
  }

  const ranked: { area: string; tier: CompetitionTier | null; figures: AreaFigures; d: number }[] = [];
  for (const [area, leads] of Array.from(byArea)) {
    if (refSet.has(area) || !args.reachableAreas.has(area)) continue;
    if (leads.length < MIN_SIMILAR_AREA_LEADS) continue;
    const figures = figuresFor(leads);
    const d = dissimilarity(figures, reference);
    if (d === null) continue;
    ranked.push({ area, tier: tierForArea(area, args.competition), figures, d });
  }

  ranked.sort(
    (x, y) =>
      TIER_ORDER[x.tier ?? "unknown"] - TIER_ORDER[y.tier ?? "unknown"] ||
      x.d - y.d ||
      (x.area < y.area ? -1 : 1)
  );

  return ranked.slice(0, MAX_SIMILAR_AREAS).map((r, i) => ({
    area: r.area,
    city: cityForArea(r.area),
    tier: r.tier,
    figures: r.figures,
    reference,
    recommended: i === 0,
  }));
}
