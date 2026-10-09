import { capMilesFor, isBriefPlan, isTravelLimit, type BriefPlan, type TravelLimit } from "@/lib/leadBrief/plans";
import { PRIORITY_KEYS, type EssentialKey, type PriorityKey } from "@/lib/leadBrief/types";

/**
 * The "Your brief" editor's rules (Lead Brief Phase 5, Part B). Pure, and
 * client-safe (it reaches only plans.ts and types.ts, which import nothing), so
 * the editor screen and the route offer and judge the same levels.
 *
 * Two kinds of edit (build prompt, Phase 5; decided 9 Oct):
 *   - the priority RANKING and the LEVELS of non-essential priorities, which
 *     apply now. An essential's level is set by Q3 ("Anything a lead must
 *     have?"), because it shapes the service area, so it is never changed here;
 *   - the area (Q1–Q3 and similar areas), which applies at the next renewal.
 *
 * A level the customer set is stored with `"chosen": true` (0162's priorities
 * CHECK allows the extra key). An area change keeps chosen levels as they are
 * and works the engine-set ones out again for the new area, so location still
 * follows the radius unless the customer pinned it.
 */

export interface StoredPriority {
  key: PriorityKey;
  threshold: number | null;
  chosen: boolean;
}

/** One entry as customer_lead_briefs.priorities stores it. */
export type StorablePriority = { key: PriorityKey; threshold?: number; chosen?: true };

/** customer_lead_briefs.priorities as the editor reads it. Unknown keys are dropped. */
export function readStoredPriorities(raw: unknown): StoredPriority[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredPriority[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    if (typeof r.key !== "string" || !(PRIORITY_KEYS as readonly string[]).includes(r.key)) continue;
    if (out.some((p) => p.key === r.key)) continue;
    out.push({
      key: r.key as PriorityKey,
      threshold: typeof r.threshold === "number" && Number.isFinite(r.threshold) ? r.threshold : null,
      chosen: r.chosen === true,
    });
  }
  return out;
}

function toStorable(p: StoredPriority): StorablePriority {
  if (p.threshold === null) return { key: p.key };
  return p.chosen ? { key: p.key, threshold: p.threshold, chosen: true } : { key: p.key, threshold: p.threshold };
}

// --- the levels the editor offers ------------------------------------------

/** Distances offered for location, cut at the plan cap and the travel limit (A3). */
export const LOCATION_LEVELS = [5, 10, 15, 20, 25, 30, 40, 50, 60, 75] as const;
export const REVENUE_LEVELS = [15000, 20000, 25000, 30000, 35000, 40000, 45000, 50000, 60000, 75000] as const;
export const BEDROOM_LEVELS = [1, 2, 3, 4, 5] as const;
export const OCCUPANCY_LEVELS = [40, 45, 50, 55, 60, 65, 70, 75, 80] as const;

/**
 * The levels offered for one priority: the fixed list (location cut at the
 * plan's reach), plus the current level so the select can always show it.
 */
export function offeredLevels(
  key: PriorityKey,
  ctx: { plan: BriefPlan; travel: TravelLimit; current: number | null }
): number[] {
  let list: number[];
  switch (key) {
    case "location": {
      const cap = capMilesFor(ctx.plan, ctx.travel);
      list = LOCATION_LEVELS.filter((m) => m <= cap);
      break;
    }
    case "revenue":
      list = [...REVENUE_LEVELS];
      break;
    case "bedrooms":
      list = [...BEDROOM_LEVELS];
      break;
    case "occupancy":
      list = [...OCCUPANCY_LEVELS];
      break;
  }
  if (ctx.current !== null && !list.includes(ctx.current)) list.push(ctx.current);
  return list.sort((a, b) => a - b);
}

// --- a priorities edit -----------------------------------------------------

export interface PrioritiesEdit {
  /** Every stored priority, most important first. */
  ranking: PriorityKey[];
  /** Only the levels the customer changed. */
  levels: Partial<Record<PriorityKey, number>>;
}

export type PrioritiesEditIssue = "ranking_invalid" | "level_invalid" | "level_essential";

export type PrioritiesEditResult =
  | { ok: true; priorities: StorablePriority[]; changed: boolean }
  | { ok: false; code: PrioritiesEditIssue; key?: PriorityKey };

/**
 * Apply a priorities edit to the stored priorities.
 *
 *   - The ranking must be exactly the stored keys, reordered.
 *   - A level may be set only on a non-essential priority, and only to an
 *     offered level (or the current one).
 *   - A level the customer sets is marked chosen. Sending the current
 *     engine-set level back changes nothing, so a level is never pinned by
 *     accident.
 */
export function buildEditedPriorities(args: {
  stored: StoredPriority[];
  essentials: EssentialKey[];
  plan: BriefPlan;
  travel: TravelLimit;
  edit: PrioritiesEdit;
}): PrioritiesEditResult {
  const { stored, edit } = args;
  const keys = stored.map((p) => p.key);
  if (
    edit.ranking.length !== keys.length ||
    new Set(edit.ranking).size !== edit.ranking.length ||
    !edit.ranking.every((k) => keys.includes(k))
  ) {
    return { ok: false, code: "ranking_invalid" };
  }

  for (const [k, level] of Object.entries(edit.levels) as [PriorityKey, number][]) {
    const current = stored.find((p) => p.key === k);
    if (!current) return { ok: false, code: "level_invalid", key: k };
    if ((args.essentials as string[]).includes(k)) return { ok: false, code: "level_essential", key: k };
    const offered = offeredLevels(k, { plan: args.plan, travel: args.travel, current: current.threshold });
    if (typeof level !== "number" || !offered.includes(level)) return { ok: false, code: "level_invalid", key: k };
  }

  const next: StoredPriority[] = edit.ranking.map((k) => {
    const s = stored.find((p) => p.key === k) as StoredPriority;
    const level = edit.levels[k];
    if (level === undefined || (level === s.threshold && !s.chosen)) return s;
    return { key: k, threshold: level, chosen: true };
  });

  const changed = next.some((p, i) => {
    const s = stored[i];
    return p.key !== s.key || p.threshold !== s.threshold || p.chosen !== s.chosen;
  });
  return { ok: true, priorities: next.map(toStorable), changed };
}

/**
 * The same edit carried onto a pending area change, so it is not lost at
 * renewal: the new ranking, and the customer's chosen levels — except on a
 * priority that is an ESSENTIAL in the pending brief, whose level is its Q3
 * answer. Engine-set levels there stay as the pending computation set them.
 */
export function carryEditToScheduled(args: {
  scheduled: StoredPriority[];
  scheduledEssentials: EssentialKey[];
  edited: StorablePriority[];
}): StorablePriority[] {
  const byKey = new Map(args.scheduled.map((p) => [p.key, p]));
  const out: StoredPriority[] = [];
  for (const e of args.edited) {
    const s = byKey.get(e.key);
    if (!s) continue;
    const essential = (args.scheduledEssentials as string[]).includes(e.key);
    out.push(e.chosen && !essential ? { key: e.key, threshold: e.threshold ?? null, chosen: true } : s);
  }
  // A priority only the pending brief has (never expected) keeps its place last.
  for (const s of args.scheduled) if (!out.some((p) => p.key === s.key)) out.push(s);
  return out.map(toStorable);
}

// --- an area edit ----------------------------------------------------------

/**
 * What an area recompute keeps from the stored brief: the ranking, and the
 * customer's chosen levels on priorities that are not essentials in the NEW
 * answers (an essential's level is its Q3 answer, and an explicit threshold
 * would override it in resolvePriorities).
 */
export function keptForRecompute(
  stored: StoredPriority[],
  next: { minBedrooms: number | null; minGross: number | null }
): { ranking: PriorityKey[]; thresholds: Partial<Record<PriorityKey, number>> } {
  const essential = new Set<PriorityKey>();
  if (next.minBedrooms !== null) essential.add("bedrooms");
  if (next.minGross !== null) essential.add("revenue");
  const thresholds: Partial<Record<PriorityKey, number>> = {};
  for (const p of stored) {
    if (p.chosen && p.threshold !== null && !essential.has(p.key)) thresholds[p.key] = p.threshold;
  }
  return { ranking: stored.map((p) => p.key), thresholds };
}

/** The Q1–Q3 answers and similar areas, as stored on a brief row. */
export interface StoredAreaAnswers {
  base_postcode: string;
  priority_outcodes: string[] | null;
  travel_limit_miles: number | null;
  min_bedrooms: number | null;
  min_gross: number | null;
  similar_areas: string[] | null;
}

/** The same answers, normalised (normaliseBriefInput's output). */
export interface AreaAnswers {
  basePostcode: string;
  priorityOutcodes: string[];
  travelLimitMiles: TravelLimit;
  minBedrooms: number | null;
  minGross: number | null;
  similarAreas: string[];
}

function sameSet(a: string[], b: string[]): boolean {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && Array.from(x).every((v) => y.has(v));
}

/** True when an area save would change nothing about the stored brief. */
export function sameAreaAnswers(row: StoredAreaAnswers, next: AreaAnswers): boolean {
  return (
    row.base_postcode === next.basePostcode &&
    sameSet(row.priority_outcodes ?? [], next.priorityOutcodes) &&
    (row.travel_limit_miles ?? null) === next.travelLimitMiles &&
    (row.min_bedrooms ?? null) === next.minBedrooms &&
    (row.min_gross ?? null) === next.minGross &&
    sameSet(row.similar_areas ?? [], next.similarAreas)
  );
}

// --- the request body ------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EditBodyKind =
  | { kind: "priorities"; expectedActiveId: string; edit: PrioritiesEdit }
  | { kind: "area"; expectedActiveId: string; body: Record<string, unknown> };

/**
 * The editor's request body, as a closed set of named fields (§27.1). The
 * area kind's answers are handed to parseBriefBody, the questionnaire's own
 * parser, so there is one reader of them.
 */
export function parseEditBody(body: unknown): EditBodyKind | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.expectedActiveId !== "string" || !UUID.test(b.expectedActiveId)) return null;

  if (b.kind === "priorities") {
    if (!Array.isArray(b.ranking) || b.ranking.length > PRIORITY_KEYS.length) return null;
    const ranking: PriorityKey[] = [];
    for (const k of b.ranking) {
      if (typeof k !== "string" || !(PRIORITY_KEYS as readonly string[]).includes(k)) return null;
      ranking.push(k as PriorityKey);
    }
    const levels: Partial<Record<PriorityKey, number>> = {};
    if (b.levels !== undefined) {
      if (!b.levels || typeof b.levels !== "object" || Array.isArray(b.levels)) return null;
      for (const [k, v] of Object.entries(b.levels as Record<string, unknown>)) {
        if (!(PRIORITY_KEYS as readonly string[]).includes(k)) return null;
        if (typeof v !== "number" || !Number.isFinite(v)) return null;
        levels[k as PriorityKey] = v;
      }
    }
    return { kind: "priorities", expectedActiveId: b.expectedActiveId, edit: { ranking, levels } };
  }

  if (b.kind === "area") return { kind: "area", expectedActiveId: b.expectedActiveId, body: b };
  return null;
}

/** A stored allocation and travel limit as the editor's plan and reach. */
export function planAndTravelOf(row: { allocation: number; travel_limit_miles: number | null }): {
  plan: BriefPlan;
  travel: TravelLimit;
} {
  const plan: BriefPlan = isBriefPlan(row.allocation) ? row.allocation : row.allocation <= 10 ? 10 : 20;
  const travel: TravelLimit = isTravelLimit(row.travel_limit_miles) ? row.travel_limit_miles : null;
  return { plan, travel };
}
