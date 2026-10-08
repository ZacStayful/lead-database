import { bandFor } from "@/lib/filterPrediction";
import { CONTENDED_FILTERED_CUSTOMERS } from "@/lib/types";
import type { NormalisedBrief } from "@/lib/leadBrief/input";
import type { BriefContention, BriefSupply, OtherBrief, SupplyLead } from "@/lib/leadBrief/types";

/**
 * Which leads a brief could receive, and how much of each it can expect.
 *
 * Essentials are the only hard exclusions besides the area boundary (locked
 * decision 6). A lead with no figure for an essential does NOT meet it — the
 * same rule Phase 4's SQL will apply, and the safe direction: we never promise
 * a 3-bedroom lead on the strength of a bedroom count we do not have.
 */
export function meetsEssentials(
  lead: SupplyLead,
  brief: Pick<NormalisedBrief, "minBedrooms" | "minGross">
): boolean {
  if (brief.minBedrooms !== null) {
    if (lead.bedrooms === null || lead.bedrooms < brief.minBedrooms) return false;
  }
  if (brief.minGross !== null) {
    if (lead.gross === null || lead.gross < brief.minGross) return false;
  }
  return true;
}

/**
 * Filtered legacy customers competing for this lead: the lookup
 * `contentionShare` makes in filterPrediction.ts. Restated rather than called
 * because the brief adds a second kind of competitor (other brief customers)
 * that `contentionShare` cannot take; a test asserts that with no other briefs
 * the two give the same share for every area and band.
 */
export function filteredCompetitors(
  lead: Pick<SupplyLead, "area" | "gross">,
  contention: BriefContention | null
): number {
  if (!contention || !lead.area) return 0;
  const band = bandFor(lead.gross);
  return contention.byBand[lead.area]?.[band] ?? contention.everywhereByBand[band] ?? 0;
}

/** How many OTHER active briefs can receive a lead in each outcode. */
export function otherBriefCoverage(otherBriefs: OtherBrief[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const b of otherBriefs) {
    const covered = new Set([...b.serviceOutcodes, ...b.firstPickOutcodes]);
    for (const oc of Array.from(covered)) counts.set(oc, (counts.get(oc) ?? 0) + 1);
  }
  return counts;
}

/**
 * The share of a lead one more customer can expect: 1 until the lead's slots
 * run out, then maxPerLead / competitors — `contentionShare`'s model, with
 * other brief customers counted as competitors too, and the customer being
 * quoted counted once.
 */
export function leadShare(
  lead: SupplyLead,
  contention: BriefContention | null,
  briefCoverage: Map<string, number>
): number {
  const maxPerLead = contention?.maxPerLead ?? CONTENDED_FILTERED_CUSTOMERS;
  const competitors =
    filteredCompetitors(lead, contention) +
    (lead.outcode ? (briefCoverage.get(lead.outcode) ?? 0) : 0) +
    1;
  return competitors <= maxPerLead ? 1 : maxPerLead / competitors;
}

/**
 * Contention-weighted supply per outcode for one brief: the leads that meet
 * its essentials, each counted at its share. Leads with no outcode are not
 * reachable by distance and are left out.
 */
export function weightedSupplyByOutcode(
  brief: Pick<NormalisedBrief, "minBedrooms" | "minGross">,
  supply: BriefSupply
): Map<string, number> {
  const coverage = otherBriefCoverage(supply.otherBriefs);
  const byOutcode = new Map<string, number>();
  for (const lead of supply.leads) {
    if (!lead.outcode || !meetsEssentials(lead, brief)) continue;
    const share = leadShare(lead, supply.contention, coverage);
    byOutcode.set(lead.outcode, (byOutcode.get(lead.outcode) ?? 0) + share);
  }
  return byOutcode;
}
