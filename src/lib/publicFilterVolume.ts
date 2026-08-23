import type { SupabaseClient } from "@supabase/supabase-js";
import {
  contentionShare,
  fetchAreaContention,
  fetchLeadVolumeData,
  weeksElapsedSince,
  INGEST_EPOCH_ISO,
  type LeadVolumeAggregate,
  type ProductVolume,
} from "@/lib/filterPrediction";
import type { LeadType } from "@/lib/types";

/**
 * The lead-volume payload the pre-signup estimator runs on.
 *
 * Same shape the dashboard's prediction consumes, so a prospect and a customer
 * are quoted by identical code — the number someone signs up for is the number
 * they then get.
 *
 * Two things are done HERE rather than in the browser, and both are the point:
 *
 *  1. CONTENTION IS PRE-APPLIED. The published counts are already the share a
 *     newcomer could expect, so the estimate is honest without the payload ever
 *     carrying how many customers hold each area. Shipping raw counts plus a
 *     contention map would quote the same number and hand anyone who opened
 *     devtools our per-area customer list.
 *  2. It is CACHED. fetchLeadVolumeData pages the whole leads table; behind a
 *     login that is one query per render, on a public endpoint it is a lever
 *     anyone can pull.
 */

/** Rebuild at most this often. Lead volume moves slowly; quotes need not. */
export const PUBLIC_VOLUME_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export interface PublicProductVolume {
  windowStart: string;
  weeksElapsed: number;
  totalLeads: number;
  matchableLeads: number;
  areaBedCounts: Record<string, Record<string, number>>;
}

export interface PublicFilterVolume {
  management: PublicProductVolume;
  guaranteed_rent: PublicProductVolume;
  generatedAt: string;
}

/**
 * Scale one product's per-area counts by what a newcomer could actually expect
 * to receive there.
 *
 * `includeSelf` is true because the reader is, by definition, not yet a
 * customer: an area holding four filtered customers can absorb a fifth only at
 * four-fifths of its volume, and quoting the unshared figure would promise a
 * prospect leads that routing would hand to somebody else.
 */
function applyContention(
  volume: ProductVolume,
  contention: Awaited<ReturnType<typeof fetchAreaContention>>
): PublicProductVolume {
  const areaBedCounts: Record<string, Record<string, number>> = {};
  let matchableLeads = 0;

  for (const [area, beds] of Object.entries(volume.areaBedCounts)) {
    const share = contentionShare(area, contention, true);
    const scaled: Record<string, number> = {};
    for (const [bed, count] of Object.entries(beds)) {
      // Floor per bucket: a fractional lead is not a lead, and rounding up
      // would let a heavily-shared area quote volume nobody will receive.
      const n = Math.floor(count * share);
      if (n > 0) {
        scaled[bed] = n;
        matchableLeads += n;
      }
    }
    if (Object.keys(scaled).length > 0) areaBedCounts[area] = scaled;
  }

  return {
    windowStart: volume.windowStart,
    weeksElapsed: volume.weeksElapsed,
    // Scaled in proportion so the "N of M leads carry enough detail to match"
    // line the UI shows stays truthful against the counts beside it.
    totalLeads:
      volume.matchableLeads > 0
        ? Math.round(
            volume.totalLeads * (matchableLeads / volume.matchableLeads)
          )
        : volume.totalLeads,
    matchableLeads,
    areaBedCounts,
  };
}

/** Build the public payload from live data. Service-role only. */
export async function buildPublicFilterVolume(
  admin: SupabaseClient
): Promise<PublicFilterVolume> {
  const [{ aggregate }, mgmt, gr] = await Promise.all([
    fetchLeadVolumeData(admin),
    fetchAreaContention(admin, "management"),
    fetchAreaContention(admin, "guaranteed_rent"),
  ]);

  return {
    management: applyContention(aggregate.management, mgmt),
    guaranteed_rent: applyContention(aggregate.guaranteed_rent, gr),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Rehydrate a cached payload into the shape `predictMonthlyVolume` expects.
 *
 * weeksElapsed is recomputed from the epoch rather than trusted from the cache:
 * a payload built six hours ago would otherwise quote a rate against a stale
 * denominator, which drifts upward as the cache ages.
 */
export function toProductVolume(
  payload: PublicFilterVolume,
  leadType: LeadType,
  now: Date = new Date()
): ProductVolume {
  // Defaulted rather than assumed present. The cache row ships as `{}` (0099)
  // and is only filled on the first rebuild, so a landing page can genuinely
  // render against an empty payload — and an estimator that throws is worse
  // than one that quietly says it has no data.
  const p =
    (leadType === "guaranteed_rent"
      ? payload?.guaranteed_rent
      : payload?.management) ?? ({} as PublicProductVolume);
  return {
    windowStart: p.windowStart ?? INGEST_EPOCH_ISO,
    weeksElapsed: weeksElapsedSince(p.windowStart ?? INGEST_EPOCH_ISO, now),
    totalLeads: p.totalLeads ?? 0,
    matchableLeads: p.matchableLeads ?? 0,
    areaBedCounts: p.areaBedCounts ?? {},
  };
}

/** Every area the payload knows about, for the picker. */
export function areasInPayload(payload: PublicFilterVolume): string[] {
  const set = new Set<string>();
  for (const product of [payload?.management, payload?.guaranteed_rent]) {
    for (const area of Object.keys(product?.areaBedCounts ?? {})) set.add(area);
  }
  return Array.from(set).sort();
}

export type { LeadVolumeAggregate };
