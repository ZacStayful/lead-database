import type { SupabaseClient } from "@supabase/supabase-js";
import {
  contentionShare,
  deriveAreaBedCounts,
  fetchAreaContention,
  fetchLeadVolumeData,
  weeksElapsedSince,
  INGEST_EPOCH_ISO,
  type AreaBedBandCounts,
  type GrossBand,
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

/**
 * The shape of `payload`. Bump this whenever a field the estimator READS is
 * added, removed or changes meaning.
 *
 * ⚠️ WITHOUT IT, SHIPPING A NEW SHAPE QUOTES THE OLD ONE FOR SIX HOURS.
 * `toProductVolume` defaults every field, deliberately — the row genuinely
 * ships as `{}` (0099) and a landing page can render against an un-primed
 * cache — which makes an OLD-SHAPE payload indistinguishable from an
 * un-primed one. Folded into the staleness claim, the first request after a
 * deploy forces exactly ONE rebuild; without it, every revenue-floored
 * estimate on both landing pages reads zero until the window expires, which
 * is §58.2's failure self-inflicted on a marketing page.
 *
 * 1 = the original areas/bedrooms payload. 2 = adds `areaBedBandCounts`.
 */
export const PUBLIC_VOLUME_SCHEMA_VERSION = 2;

export interface PublicProductVolume {
  windowStart: string;
  weeksElapsed: number;
  totalLeads: number;
  matchableLeads: number;
  areaBedCounts: Record<string, Record<string, number>>;
  /**
   * The same counts split by revenue band, contention already applied per
   * (area, band). Present from schema version 2.
   *
   * ⚠️ This publishes how much high-value stock we hold, by area — a knowing
   * extension of the exposure §28.6 already accepts, and bounded by the fact
   * that the bands ARE the threshold list, so nothing finer than the
   * estimator needs is published.
   */
  areaBedBandCounts?: AreaBedBandCounts;
}

export interface PublicFilterVolume {
  management: PublicProductVolume;
  guaranteed_rent: PublicProductVolume;
  generatedAt: string;
  /** Mirrors the row's `schema_version`, so a served payload is self-describing. */
  schemaVersion?: number;
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
export function applyContention(
  volume: ProductVolume,
  contention: Awaited<ReturnType<typeof fetchAreaContention>>
): PublicProductVolume {
  // ⚠️ SCALED PER (AREA, BAND), AND `areaBedCounts` DERIVED FROM THE RESULT.
  // Each band scales by a different factor now, so a separately-scaled
  // bedroom total could not be reconciled with the sum of its own bands — a
  // customer would see one figure at the lowest floor and another with no
  // floor over the same stock. Deriving makes them agree structurally.
  const bands: AreaBedBandCounts = {};
  let matchableLeads = 0;

  for (const [area, beds] of Object.entries(volume.areaBedBandCounts ?? {})) {
    const scaledBeds: Record<string, Partial<Record<GrossBand, number>>> = {};
    for (const [bed, byBand] of Object.entries(beds)) {
      const scaled: Partial<Record<GrossBand, number>> = {};
      for (const [band, count] of Object.entries(byBand)) {
        const share = contentionShare(area, band as GrossBand, contention, true);
        // Floor per bucket: a fractional lead is not a lead, and rounding up
        // would let a heavily-shared area quote volume nobody will receive.
        const n = Math.floor((count ?? 0) * share);
        if (n > 0) {
          scaled[band as GrossBand] = n;
          matchableLeads += n;
        }
      }
      if (Object.keys(scaled).length > 0) scaledBeds[bed] = scaled;
    }
    if (Object.keys(scaledBeds).length > 0) bands[area] = scaledBeds;
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
    areaBedCounts: deriveAreaBedCounts(bands),
    areaBedBandCounts: bands,
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
    schemaVersion: PUBLIC_VOLUME_SCHEMA_VERSION,
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
    // ⚠️ NULL, NEVER {} — §18.3's three outcomes, and the whole reason the
    // schema version exists. A payload written before banding cannot answer a
    // revenue question; `{}` would read as "no lead clears any floor" and
    // quote ZERO on a marketing page. `canFilterByGross` turns this null into
    // a HIDDEN control instead, which is honest and needs no 503.
    areaBedBandCounts: p.areaBedBandCounts ?? null,
  };
}

/**
 * Every area THIS PRODUCT has leads in, for the picker.
 *
 * ⚠️ Scoped per product deliberately. A first cut unioned both, which put areas
 * with zero guaranteed-rent leads in front of a GR prospect: they would pick
 * one, get "not enough data to forecast this", and reasonably conclude the
 * product is empty in their patch. The two books genuinely differ in coverage,
 * and the picker is the wrong place to hide that.
 */
export function areasInPayload(
  payload: PublicFilterVolume,
  leadType: LeadType
): string[] {
  const product =
    leadType === "guaranteed_rent"
      ? payload?.guaranteed_rent
      : payload?.management;
  return Object.keys(product?.areaBedCounts ?? {}).sort();
}

export type { LeadVolumeAggregate };
