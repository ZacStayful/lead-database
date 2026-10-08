import { areaOfOutcode, milesBetween } from "@/lib/leadBrief/geo";
import type { NormalisedBrief } from "@/lib/leadBrief/input";
import { MIN_LOCATION_THRESHOLD_MILES, MIN_TYPICAL_SAMPLE } from "@/lib/leadBrief/plans";
import type { BriefPriority, MatchLabel, PriorityKey, SupplyLead } from "@/lib/leadBrief/types";

/**
 * How well a lead fits a brief: which priorities it meets, a score, and a
 * label. Pure. Built now because the expected mix (Phase 2) needs the same
 * definitions routing will use to label a real lead (Phase 4) — one
 * definition, so the mix a customer is shown is computed by the rules their
 * leads are labelled by.
 *
 * Priorities RANK, they never exclude (locked decision 6). The essentials are
 * already guaranteed by eligibility, so here they are simply met.
 */

/** The median of the non-null values, or null when there are none. */
export function median(values: (number | null)[]): number | null {
  const v = values.filter((x): x is number => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function typical(
  field: "gross" | "bedrooms" | "occupancy",
  areaLeads: SupplyLead[],
  allLeads: SupplyLead[]
): number | null {
  const local = areaLeads.map((l) => l[field]).filter((x): x is number => x !== null);
  const values =
    local.length >= MIN_TYPICAL_SAMPLE ? local : allLeads.map((l) => l[field]);
  return median(values);
}

/**
 * Turn the ranking into stored priorities with a threshold each (A8: the
 * customer is not asked, so the thresholds default to "typical for your
 * area"):
 *
 *   location   an explicit threshold, else half the service radius (≥ 5 miles)
 *   revenue    explicit, else the revenue essential, else the area's median gross
 *   bedrooms   explicit, else the bedrooms essential, else the area's median
 *   occupancy  explicit, else the area's median occupancy
 *
 * "The area" is the leads this brief could receive (service area, essentials
 * met); with fewer than MIN_TYPICAL_SAMPLE figures it falls back to every lead
 * in supply. A threshold that still cannot be found is null, and that priority
 * is then not judged at all rather than judged against nothing.
 */
export function resolvePriorities(args: {
  brief: Pick<NormalisedBrief, "ranking" | "thresholds" | "minBedrooms" | "minGross">;
  serviceRadiusMiles: number;
  areaLeads: SupplyLead[];
  allLeads: SupplyLead[];
}): BriefPriority[] {
  const { brief } = args;
  return brief.ranking.map((key): BriefPriority => {
    const explicit = brief.thresholds[key];
    if (explicit !== undefined) return { key, threshold: explicit };
    switch (key) {
      case "location":
        return {
          key,
          threshold: Math.max(
            MIN_LOCATION_THRESHOLD_MILES,
            Math.round(args.serviceRadiusMiles / 2)
          ),
        };
      case "revenue": {
        if (brief.minGross !== null) return { key, threshold: brief.minGross };
        const t = typical("gross", args.areaLeads, args.allLeads);
        return { key, threshold: t === null ? null : Math.round(t / 1000) * 1000 };
      }
      case "bedrooms": {
        if (brief.minBedrooms !== null) return { key, threshold: brief.minBedrooms };
        const t = typical("bedrooms", args.areaLeads, args.allLeads);
        return { key, threshold: t === null ? null : Math.round(t) };
      }
      case "occupancy": {
        const t = typical("occupancy", args.areaLeads, args.allLeads);
        return { key, threshold: t === null ? null : Math.round(t) };
      }
    }
  });
}

/**
 * The priorities as customer_lead_briefs.priorities stores them (0162): an
 * unresolved threshold is OMITTED, never written as JSON null — the CHECK
 * requires a present threshold to be a number.
 */
export function prioritiesForStorage(
  priorities: BriefPriority[]
): ({ key: PriorityKey } | { key: PriorityKey; threshold: number })[] {
  return priorities.map((p) => (p.threshold === null ? { key: p.key } : { key: p.key, threshold: p.threshold }));
}

export interface PriorityResult {
  key: PriorityKey;
  threshold: number | null;
  /** The lead's figure in the priority's unit (miles for location), or null. */
  value: number | null;
  /** Null when the priority could not be judged (no threshold). */
  met: boolean | null;
  /** 0–1: 1 when met; partial credit for how close it came. */
  credit: number;
}

export interface LeadEvaluation {
  results: PriorityResult[];
  /** Priorities with a threshold. */
  judged: number;
  /** Judged priorities the lead does not meet. */
  missed: number;
  /** 0–100, weighted by rank: the top priority counts most. */
  score: number;
}

export interface MatchContext {
  baseOutcode: string;
  priorityOutcodes: string[];
  similarAreas: string[];
  /** The A3 cap, in miles: location credit falls to 0 there. */
  capMiles: number;
}

function locationValue(lead: SupplyLead, ctx: MatchContext): number | null {
  if (!lead.outcode) return null;
  let best: number | null = null;
  for (const anchor of [ctx.baseOutcode, ...ctx.priorityOutcodes]) {
    const d = milesBetween(anchor, lead.outcode);
    if (d !== null && (best === null || d < best)) best = d;
  }
  return best;
}

function evaluateOne(p: BriefPriority, lead: SupplyLead, ctx: MatchContext): PriorityResult {
  const t = p.threshold;
  if (p.key === "location") {
    const value = locationValue(lead, ctx);
    if (t === null) return { key: p.key, threshold: null, value, met: null, credit: 0 };
    const inSimilar = lead.outcode !== null && ctx.similarAreas.includes(areaOfOutcode(lead.outcode));
    const met = inSimilar || (value !== null && value <= t);
    let credit = 0;
    if (met) credit = 1;
    else if (value !== null) credit = Math.max(0, Math.min(1, 1 - (value - t) / Math.max(ctx.capMiles - t, 1)));
    return { key: p.key, threshold: t, value, met, credit };
  }
  const value =
    p.key === "revenue" ? lead.gross : p.key === "bedrooms" ? lead.bedrooms : lead.occupancy;
  if (t === null) return { key: p.key, threshold: null, value, met: null, credit: 0 };
  if (value === null) return { key: p.key, threshold: t, value, met: false, credit: 0 };
  const met = value >= t;
  return { key: p.key, threshold: t, value, met, credit: met ? 1 : Math.max(0, Math.min(1, value / t)) };
}

export function evaluateLead(
  lead: SupplyLead,
  priorities: BriefPriority[],
  ctx: MatchContext
): LeadEvaluation {
  const results = priorities.map((p) => evaluateOne(p, lead, ctx));
  let judged = 0;
  let missed = 0;
  let weighted = 0;
  let totalWeight = 0;
  results.forEach((r, i) => {
    if (r.met === null) return;
    judged += 1;
    if (!r.met) missed += 1;
    const w = results.length - i;
    weighted += w * r.credit;
    totalWeight += w;
  });
  const score = totalWeight === 0 ? 0 : Math.round((1000 * weighted) / totalWeight) / 10;
  return { results, judged, missed, score };
}

/**
 * The label (build prompt, Phase 4 rules, with the approved D6 copy rule):
 *
 *   - A lead offered only because the customer is behind pace (A11) is a
 *     Nearby opportunity, whatever it scores.
 *   - Top match: every judged priority met.
 *   - First pick: the lead is in a first-pick outcode AND this is the lead's
 *     first sale (D6: never call it a first pick when someone else had it
 *     first). It is the primary label unless the lead is also a Top match, in
 *     which case it rides along as a tag.
 *   - Strong match: exactly one judged priority missed, out of at least two.
 *   - Otherwise Nearby opportunity.
 */
export function labelFor(
  evaluation: Pick<LeadEvaluation, "judged" | "missed">,
  flags: { inFirstPick: boolean; isFirstSale: boolean; paceOnly: boolean }
): { label: MatchLabel; firstPickTag: boolean } {
  if (flags.paceOnly) return { label: "nearby_opportunity", firstPickTag: false };
  const firstPick = flags.inFirstPick && flags.isFirstSale;
  const top = evaluation.judged >= 1 && evaluation.missed === 0;
  if (top) return { label: "top_match", firstPickTag: firstPick };
  if (firstPick) return { label: "first_pick", firstPickTag: false };
  if (evaluation.missed === 1 && evaluation.judged >= 2) {
    return { label: "strong_match", firstPickTag: false };
  }
  return { label: "nearby_opportunity", firstPickTag: false };
}
