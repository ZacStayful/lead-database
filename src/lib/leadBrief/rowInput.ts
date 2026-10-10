import type { ParsedBriefBody } from "@/lib/leadBrief/briefRequest";
import { keptForRecompute, planAndTravelOf, readStoredPriorities } from "@/lib/leadBrief/editBrief";
import type { PriorityKey } from "@/lib/leadBrief/types";

/**
 * A stored brief's answers, as the engine's input: recompute it against live
 * supply without asking the customer anything (batch 04). PURE.
 *
 * The same reading Phase 2's recalculation always made, now shared with the
 * confirm screen (Phase 3), so a recalculated area and the confirmation of it
 * are worked out from one definition of "this customer's answers":
 *   - the ranking, and the levels the customer chose on priorities that are
 *     not essentials (keptForRecompute);
 *   - the travel limit read through planAndTravelOf, so a stored value the
 *     engine does not offer reads as "anywhere" rather than failing;
 *   - similar areas as stored, never re-ticked (similarAreasGiven: true).
 */
export interface StoredBriefAnswers {
  base_postcode: string;
  priority_outcodes: string[] | null;
  travel_limit_miles: number | null;
  min_bedrooms: number | null;
  min_gross: number | null;
  similar_areas: string[] | null;
  priorities: unknown;
  allocation: number;
}

export function parsedBodyFromRow(row: StoredBriefAnswers): {
  parsed: ParsedBriefBody;
  chosenKeys: PriorityKey[];
} {
  const kept = keptForRecompute(readStoredPriorities(row.priorities), {
    minBedrooms: row.min_bedrooms,
    minGross: row.min_gross,
  });
  const { travel } = planAndTravelOf(row);
  return {
    parsed: {
      input: {
        basePostcode: row.base_postcode,
        priorityOutcodes: row.priority_outcodes ?? [],
        travelLimitMiles: travel,
        minBedrooms: row.min_bedrooms,
        minGross: row.min_gross,
        similarAreas: row.similar_areas ?? [],
        ranking: kept.ranking,
        thresholds: kept.thresholds,
      },
      similarAreasGiven: true,
      shownRadiusMiles: null,
    },
    chosenKeys: Object.keys(kept.thresholds) as PriorityKey[],
  };
}
