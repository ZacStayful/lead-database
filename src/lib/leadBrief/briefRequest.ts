import type { BriefInput } from "@/lib/leadBrief/input";
import type { TravelLimit } from "@/lib/leadBrief/plans";

/**
 * A questionnaire request body, read as a closed set of named fields (the
 * §27.1 rule): nothing else in the body reaches the engine. Ranking and
 * thresholds are not asked in the questionnaire (A8) and are never read here;
 * the "Your brief" editor (Phase 5) is where they arrive.
 *
 * Values are passed through untouched for `normaliseBriefInput` to judge, so
 * there is one validator and one set of issue codes. This only refuses
 * shapes that could never be valid, and caps list lengths so a crafted body
 * cannot make the engine walk a thousand areas.
 */
export const MAX_EXTRA_AREAS = 10;
export const MAX_SIMILAR_AREAS_IN = 10;

export interface ParsedBriefBody {
  input: BriefInput;
  /** False when the body sent no similar-area list (the first preview). */
  similarAreasGiven: boolean;
  /** The radius the customer was shown, for the confirm check; null when absent. */
  shownRadiusMiles: number | null;
}

function strings(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x === "string" && x.trim() !== "") out.push(x.trim().slice(0, 12));
    if (out.length >= max) break;
  }
  return out;
}

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function parseBriefBody(body: unknown): ParsedBriefBody {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const travel = b.travelLimitMiles;
  const similarAreasGiven = Array.isArray(b.similarAreas);
  return {
    input: {
      basePostcode: typeof b.basePostcode === "string" ? b.basePostcode.slice(0, 16) : "",
      priorityOutcodes: strings(b.priorityOutcodes, MAX_EXTRA_AREAS),
      // Null is "anywhere"; anything else is judged by normaliseBriefInput.
      travelLimitMiles: (travel === null ? null : numberOrNull(travel) ?? undefined) as TravelLimit,
      minBedrooms: numberOrNull(b.minBedrooms),
      minGross: numberOrNull(b.minGross),
      similarAreas: strings(b.similarAreas, MAX_SIMILAR_AREAS_IN),
    },
    similarAreasGiven,
    shownRadiusMiles: numberOrNull(b.shownRadiusMiles),
  };
}
