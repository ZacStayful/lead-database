import type { SupabaseClient } from "@supabase/supabase-js";
import { cityForArea } from "@/lib/postcode";
import { distanceToNearestKm } from "@/lib/areaCentroids";
import { CONTENDED_FILTERED_CUSTOMERS, type LeadType } from "@/lib/types";

/**
 * Predicting a lead filter's monthly volume from real ingest history.
 *
 * When a customer narrows their leads by postcode area and bedroom range, they
 * will receive fewer of them. This module quantifies how many fewer: given the
 * leads that have actually arrived since ingest began, how many per month would
 * have matched this selection? `filterForecast.ts` turns that into the figure
 * the customer is shown. The customer panel, its expansion suggestions, and both admin
 * surfaces all call the same functions here — one definition, the
 * `announcementTargetsCustomer()` discipline — so a customer and an admin
 * always see the same number for the same filter.
 *
 * The matching rules deliberately mirror `get_filtered_candidates_for_lead`
 * (migration 0026), including its silent exclusion: a lead with no parseable
 * postcode area OR no parseable bedroom count is invisible to EVERY filtered
 * customer, so such leads never enter `areaBedCounts` and are excluded from
 * every prediction by construction. `matchableLeads` vs `totalLeads` is how
 * the UI surfaces that honestly.
 *
 * Display only — nothing here is persisted and nothing gates routing. A filter
 * applies whatever this predicts; the prediction informs the customer, it does
 * not decide anything, and nothing downstream of it is a commitment.
 */

/** Day 1 of real ingest history. Verified: no leads.created_at precedes it. */
export const INGEST_EPOCH_ISO = "2026-07-01";

export const WEEKS_PER_MONTH = 4.33;

/** Below this many total matches the extrapolation is too thin to show as a number. */
export const MIN_RELIABLE_MATCHES = 5;

/** Per-product ingest history, restricted to what filtered routing can see. */
export interface ProductVolume {
  /** INGEST_EPOCH_ISO — kept on the object so the UI can name its basis. */
  windowStart: string;
  /** Server-computed at render time, floored at 1 so early weeks cannot blow up the rate. */
  weeksElapsed: number;
  /** ALL leads of this product since windowStart, unparseable ones included. */
  totalLeads: number;
  /** The subset with a non-null postcode area AND a parseable bedroom count. */
  matchableLeads: number;
  /** postcode area (uppercase) -> parsed bedroom count (string key) -> lead count. */
  areaBedCounts: Record<string, Record<string, number>>;
}

export type LeadVolumeAggregate = Record<LeadType, ProductVolume>;

export interface FilterSelection {
  /** Empty = anywhere, matching the SQL's null/empty-array rule. */
  areas: string[];
  minBedrooms: number | null;
  maxBedrooms: number | null;
}

/**
 * How many OTHER filtered customers already cover each postcode area, and the
 * ceiling at which a lead is shared out rather than won.
 *
 * A lead reaches at most `maxPerLead` filtered customers, so once more than
 * that many compete for one area, none of them can expect all of its volume.
 * Below the ceiling nothing changes — every filtered customer covering an area
 * can receive every lead in it, because there are enough slots to go round.
 *
 * Counts FILTERED customers only. Counting unfiltered ones as competitors would
 * be wrong and badly so: they are eligible everywhere, so every area would look
 * saturated and every quote would collapse — when in fact the engine can serve
 * them from anywhere and a filtered customer's areas are not really contested
 * by that demand at all.
 */
export interface AreaContention {
  /** Uppercase postcode area -> number of filtered customers covering it. */
  filteredCustomers: Record<string, number>;
  /** CONTENDED_FILTERED_CUSTOMERS — the assignment ceiling for one lead. */
  maxPerLead: number;
  /**
   * Filtered customers with no area restriction (a bedroom-only filter). They
   * compete in every area, including ones no explicit filter names, so they are
   * a floor under areas absent from `filteredCustomers` too.
   */
  everywhere?: number;
}

/**
 * The share of an area's volume one more filtered customer can expect.
 *
 * 1.0 until the ceiling, then `maxPerLead / competitors` — the fraction of
 * leads there are slots for. `competitors` includes the customer being quoted,
 * which is what makes this answer "if I apply this filter, what do I get"
 * rather than "what do the incumbents get".
 */
export function contentionShare(
  area: string,
  contention: AreaContention | null | undefined,
  includeSelf = true
): number {
  if (!contention) return 1;
  const key = area.toUpperCase();
  const existing =
    contention.filteredCustomers[key] ?? contention.everywhere ?? 0;
  const competitors = existing + (includeSelf ? 1 : 0);
  if (competitors <= contention.maxPerLead) return 1;
  return contention.maxPerLead / competitors;
}

export interface VolumePrediction {
  /** Raw matches since windowStart. */
  matchingLeads: number;
  /** matchingLeads / weeksElapsed * WEEKS_PER_MONTH, unrounded. */
  monthlyRate: number;
  /** Math.round(monthlyRate) — what the UI prints as "~N". */
  displayRate: number;
  /** matchingLeads >= MIN_RELIABLE_MATCHES. */
  reliable: boolean;
  /**
   * The observation window the rate was measured over, carried through from
   * `ProductVolume`. The forecast needs the raw (count, exposure) pair rather
   * than the rate alone — a rate of 5/month means something very different
   * measured over one week than over one year, and the forecast's confidence
   * is exactly that difference (see filterForecast.ts).
   */
  weeksElapsed: number;
}

export interface ExpansionSuggestion {
  area: string;
  /** cityForArea(area), or the code itself when unknown. */
  city: string;
  /** Matches under the CURRENT bedroom range. */
  matchingLeads: number;
  /** Rounded leads/month the chip displays as "+~N/mo". */
  monthlyRate: number;
  /** Km to the nearest selected area; null when no centroid is known. */
  distanceKm: number | null;
  /**
   * WHICH selected area the distance is measured from, so a multi-area
   * selection reads "21 mi from Manchester" rather than an unanchored figure.
   */
  nearestSelectedArea: string | null;
}

/**
 * JS mirror of the SQL bedroom parser in `get_filtered_candidates_for_lead`:
 * `nullif(substring(coalesce(bedrooms, '') from '\d+'), '')::int` — the first
 * run of digits ("3 bed" -> 3, "2-3" -> 2), null when none ("studio").
 * The two must stay identical or the prediction diverges from routing.
 */
export function parseBedrooms(
  bedrooms: string | null | undefined
): number | null {
  const m = /\d+/.exec(bedrooms ?? "");
  return m ? parseInt(m[0], 10) : null;
}

/** Whole weeks-and-fraction since startIso, floored at 1. */
export function weeksElapsedSince(startIso: string, now: Date = new Date()): number {
  const start = new Date(`${startIso}T00:00:00Z`).getTime();
  const weeks = (now.getTime() - start) / (7 * 24 * 60 * 60 * 1000);
  return Math.max(weeks, 1);
}

/**
 * The one matching rule, mirroring `get_filtered_candidates_for_lead`:
 * empty areas = any location; a null bound = open on that side. Unparseable
 * leads are already absent from `areaBedCounts`, so they can never match.
 */
export function predictMonthlyVolume(
  volume: ProductVolume,
  sel: FilterSelection,
  contention?: AreaContention | null
): VolumePrediction {
  const wantedAreas =
    sel.areas.length > 0
      ? new Set(sel.areas.map((a) => a.toUpperCase()))
      : null;

  let matchingLeads = 0;
  for (const [area, beds] of Object.entries(volume.areaBedCounts)) {
    if (wantedAreas && !wantedAreas.has(area)) continue;
    // Applied per AREA, not to the total: a filter spanning a crowded city and
    // an empty county is only contended in the city, and averaging the two
    // would understate one and overstate the other.
    const share = contentionShare(area, contention);
    for (const [bed, count] of Object.entries(beds)) {
      const b = Number(bed);
      if (sel.minBedrooms != null && b < sel.minBedrooms) continue;
      if (sel.maxBedrooms != null && b > sel.maxBedrooms) continue;
      matchingLeads += count * share;
    }
  }
  // Whole leads: a share can make this fractional, and every downstream
  // consumer — the reliability floor, the forecast's negative binomial — is
  // counting events, not expectations.
  matchingLeads = Math.floor(matchingLeads);

  const monthlyRate =
    (matchingLeads / volume.weeksElapsed) * WEEKS_PER_MONTH;
  return {
    matchingLeads,
    monthlyRate,
    displayRate: Math.round(monthlyRate),
    reliable: matchingLeads >= MIN_RELIABLE_MATCHES,
    weeksElapsed: volume.weeksElapsed,
  };
}

/**
 * True when the "too small for your plan" warning applies. Compared on the
 * ROUNDED figure so the displayed "~N" can never contradict the warning state
 * (a rate of 9.6 shown as "~10 of 10" must not carry a below-plan warning).
 */
export function belowAllocation(
  prediction: VolumePrediction,
  allocation: number
): boolean {
  return allocation > 0 && prediction.displayRate < allocation;
}

/**
 * Unselected areas the customer would plausibly expand INTO. The first area
 * someone selects is where they are (or close to it), so suggestions are the
 * areas AROUND their selection — places they could realistically service —
 * ranked strictly by distance to the nearest selected area, nearest first.
 * The point is to broaden their idea of what is within reach, not to point
 * at wherever the national lead volume happens to sit: a hotspot 200km away
 * is never a serviceable suggestion however many leads it holds. Volume
 * decides only (a) membership — an area with zero matching leads under the
 * current bedroom range is dropped, it would add nothing — and (b) the tie
 * between two areas at effectively the same distance.
 *
 * Areas with no known centroid (e.g. BT, absent from the boundary file) rank
 * after every area whose distance is known, by volume; the same fallback
 * applies to the whole list when the customer's own selection has no
 * centroid. Empty when no areas are selected — they already take everything.
 */
export function expansionSuggestions(
  volume: ProductVolume,
  sel: FilterSelection,
  limit = 5
): ExpansionSuggestion[] {
  if (sel.areas.length === 0) return [];
  const selectedList = sel.areas.map((a) => a.toUpperCase());
  const selected = new Set(selectedList);

  const out: ExpansionSuggestion[] = [];
  for (const area of Object.keys(volume.areaBedCounts)) {
    if (selected.has(area)) continue;
    const p = predictMonthlyVolume(volume, { ...sel, areas: [area] });
    if (p.matchingLeads === 0) continue;
    const nearest = distanceToNearestKm(area, selectedList);
    out.push({
      area,
      city: cityForArea(area) || area,
      matchingLeads: p.matchingLeads,
      monthlyRate: p.displayRate,
      distanceKm: nearest?.km ?? null,
      nearestSelectedArea: nearest?.fromArea ?? null,
    });
  }

  // Nearest first, in 20km bands: centroid distance is approximate, so two
  // areas in the same band are "equally close" and the one with more leads
  // wins the tie. Banding (rather than a pairwise tolerance) keeps the
  // ordering transitive.
  const band = (km: number) => Math.floor(km / 20);
  out.sort((a, b) => {
    if (a.distanceKm !== null && b.distanceKm !== null) {
      return (
        band(a.distanceKm) - band(b.distanceKm) ||
        b.matchingLeads - a.matchingLeads ||
        a.distanceKm - b.distanceKm
      );
    }
    if (a.distanceKm !== null) return -1;
    if (b.distanceKm !== null) return 1;
    return b.matchingLeads - a.matchingLeads || a.area.localeCompare(b.area);
  });
  return out.slice(0, limit);
}

/** Row shape both fetch paths produce (the filtering page's own loop, and fetchLeadVolumeAggregate). */
export interface LeadVolumeRow {
  postcode_area: string | null;
  bedrooms: string | null;
  lead_type: LeadType | string | null;
  created_at: string;
  /**
   * True when `lead_retired_from_allocation()` (0073) would return true — the
   * lead was claimed from the expired pool, or pooled on the `ignored` basis.
   * Ordinary routing will never hand it to anyone again (invariant 11), so it
   * must not count towards a volume the forecast is priced on. Optional so
   * callers that cannot cheaply determine it keep today's behaviour.
   */
  retired?: boolean | null;
}

function emptyVolume(now: Date): ProductVolume {
  return {
    windowStart: INGEST_EPOCH_ISO,
    weeksElapsed: weeksElapsedSince(INGEST_EPOCH_ISO, now),
    totalLeads: 0,
    matchableLeads: 0,
    areaBedCounts: {},
  };
}

/**
 * Pure aggregate builder — rows in, aggregate out. Rows before the epoch are
 * dropped defensively: none exist today, but a future backfill of historical
 * leads must inflate neither the rate's numerator without its denominator.
 *
 * Retired rows are dropped for a different reason and BEFORE `totalLeads`:
 * a lead invariant 11 has retired is not supply that was merely unmatchable,
 * it is supply that no longer exists. Counting it in the denominator would
 * understate the matchable share as much as counting it in the numerator
 * would overstate the rate.
 */
export function buildLeadVolumeAggregate(
  rows: LeadVolumeRow[],
  now: Date = new Date()
): LeadVolumeAggregate {
  const agg: LeadVolumeAggregate = {
    management: emptyVolume(now),
    guaranteed_rent: emptyVolume(now),
  };

  for (const row of rows) {
    const product: ProductVolume | undefined =
      row.lead_type === "guaranteed_rent"
        ? agg.guaranteed_rent
        : row.lead_type === "management"
          ? agg.management
          : undefined;
    if (!product) continue;
    if (!row.created_at || row.created_at.slice(0, 10) < INGEST_EPOCH_ISO) {
      continue;
    }
    if (row.retired) continue;

    product.totalLeads += 1;

    const area = row.postcode_area?.trim().toUpperCase();
    const bed = parseBedrooms(row.bedrooms);
    if (!area || bed == null) continue;

    product.matchableLeads += 1;
    const beds = (product.areaBedCounts[area] ??= {});
    beds[String(bed)] = (beds[String(bed)] ?? 0) + 1;
  }

  return agg;
}

/**
 * Fetch every lead's prediction-relevant columns (paginated — a single select
 * is capped at 1000 rows) and build the aggregate. The admin client is a
 * parameter so this module stays importable from client components.
 *
 * ORDER BY IS LOAD-BEARING, not tidiness. PostgREST's `.range()` is
 * LIMIT/OFFSET, and Postgres guarantees no row order without an ORDER BY — so
 * across pages the planner may repeat or skip rows, silently moving the number
 * the forecast is priced on. Harmless while one page covers the table; a
 * stable sort is what keeps it harmless once it does not.
 */
export async function fetchLeadVolumeAggregate(
  admin: SupabaseClient
): Promise<LeadVolumeAggregate> {
  return (await fetchLeadVolumeData(admin)).aggregate;
}

export interface LeadVolumeData {
  aggregate: LeadVolumeAggregate;
  /**
   * Postcode area (uppercase) -> lead count, bedroom-blind and across both
   * products, for shading the selection map. Counts RETIRED leads too: the map
   * answers "where do our leads come from", which is a question about the book,
   * not about what is still routable.
   */
  areaCounts: Record<string, number>;
}

/**
 * The single paginated pass over the lead book. Produces both structures the
 * filtering surfaces need, so the customer page and the two admin pages cannot
 * compute different numbers from the same table — the one-definition rule this
 * module's header states. The filtering page previously ran its own copy of
 * this loop, which is exactly how the two drifted.
 */
export async function fetchLeadVolumeData(
  admin: SupabaseClient
): Promise<LeadVolumeData> {
  const retired = await fetchRetiredLeadIds(admin);

  const rows: LeadVolumeRow[] = [];
  const areaCounts: Record<string, number> = {};
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("leads")
      .select(
        "id, postcode_area, bedrooms, lead_type, created_at, pool_expired_at, pool_entered_at, pool_entry_basis"
      )
      // Customer-owned leads are not marketplace supply. Counting them here
      // would inflate the volume figure we QUOTE to a customer applying a
      // filter (§28) — a number we would then fail to deliver, using leads they
      // brought in themselves as the evidence we could.
      .is("owner_customer_id", null)
      .gte("created_at", INGEST_EPOCH_ISO)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error || !data || data.length === 0) break;
    for (const r of data as RawLeadVolumeRow[]) {
      rows.push({
        postcode_area: r.postcode_area,
        bedrooms: r.bedrooms,
        lead_type: r.lead_type,
        created_at: r.created_at,
        retired: isRetired(r, retired),
      });
      const a = r.postcode_area?.trim().toUpperCase();
      if (a) areaCounts[a] = (areaCounts[a] ?? 0) + 1;
    }
    if (data.length < PAGE) break;
  }
  return { aggregate: buildLeadVolumeAggregate(rows), areaCounts };
}

/** The `leads`-side columns `lead_retired_from_allocation()` reads. */
interface RawLeadVolumeRow extends LeadVolumeRow {
  id: string;
  pool_expired_at: string | null;
  pool_entered_at: string | null;
  pool_entry_basis: string | null;
}

/**
 * JS mirror of `lead_retired_from_allocation()` (0073 §9), which is
 * `service_role`-only and cannot be called per row from PostgREST anyway.
 * The two `leads`-column branches are evaluated here; the assignment branch
 * needs `claimed_from_pool_at`, which is why the claimed ids are fetched once
 * up front rather than joined per row.
 */
function isRetired(row: RawLeadVolumeRow, claimedLeadIds: Set<string>): boolean {
  if (row.pool_expired_at != null) return true;
  if (row.pool_entered_at != null && row.pool_entry_basis === "ignored") {
    return true;
  }
  return claimedLeadIds.has(row.id);
}

/**
 * Count, per postcode area, the filtered customers already competing for it.
 *
 * POPULATION: the stable half of routing eligibility — the product's
 * subscription is live and a filter is on. Deliberately NOT `lead_balance > 0`,
 * which `get_filtered_candidates_for_lead` also requires: a balance empties and
 * refills through the month, so including it would make a customer's quoted
 * volume jitter with other people's spending. Contention is a question about
 * who is competing for these areas, not who happens to have credit this
 * afternoon.
 *
 * Per invariant 6 the two products have separate populations, and per invariant
 * 8 the GR side must never read `account_status`, which is management-only.
 *
 * `excludeCustomerId` drops the customer being quoted, so re-quoting an
 * existing filter does not count them as their own competitor — the +1 for
 * self is added by `contentionShare`.
 */
export async function fetchAreaContention(
  admin: SupabaseClient,
  leadType: LeadType,
  excludeCustomerId?: string | null
): Promise<AreaContention> {
  const isGr = leadType === "guaranteed_rent";
  const cols = isGr
    ? { status: "gr_filter_status", areas: "gr_filter_areas" }
    : { status: "filter_status", areas: "filter_areas" };

  let query = admin
    .from("customers")
    .select(`id, ${cols.areas}, ${cols.status}`)
    .in(cols.status, ["active", "pending_lift"]);

  query = isGr
    ? query.eq("gr_subscription_status", "active")
    : query.eq("account_status", "active").eq("subscription_status", "active");

  if (excludeCustomerId) query = query.neq("id", excludeCustomerId);

  const { data, error } = await query;
  const filteredCustomers: Record<string, number> = {};
  if (error || !data) {
    // Fail OPEN, deliberately. An empty contention map quotes the UNSHARED
    // volume, which is the number this feature showed before contention
    // existed — optimistic by at most the sharing factor. Failing closed would
    // quote zero and refuse to forecast at all on a transient read error.
    console.error("area contention read failed; quoting unshared", error);
    return { filteredCustomers, maxPerLead: CONTENDED_FILTERED_CUSTOMERS };
  }

  // A filter with no areas is a bedroom-only filter: that customer is eligible
  // in EVERY area and competes everywhere. Counted as a floor under every area
  // rather than being silently ignored.
  let everywhere = 0;
  const rows = data as unknown as Record<string, unknown>[];
  for (const row of rows) {
    const areas = row[cols.areas] as string[] | null;
    if (!areas || areas.length === 0) {
      everywhere += 1;
      continue;
    }
    for (const a of areas) {
      const key = a?.trim().toUpperCase();
      if (key) filteredCustomers[key] = (filteredCustomers[key] ?? 0) + 1;
    }
  }
  if (everywhere > 0) {
    for (const key of Object.keys(filteredCustomers)) {
      filteredCustomers[key] += everywhere;
    }
  }

  return {
    filteredCustomers,
    maxPerLead: CONTENDED_FILTERED_CUSTOMERS,
    everywhere,
  };
}

/**
 * Lead ids with at least one claimed-from-pool assignment. Claiming is rare by
 * design (§19) so this set stays small, but it is paginated on the same stable
 * sort as the main read for the same reason.
 */
async function fetchRetiredLeadIds(admin: SupabaseClient): Promise<Set<string>> {
  const ids = new Set<string>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("lead_assignments")
      .select("lead_id")
      .not("claimed_from_pool_at", "is", null)
      .order("lead_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error || !data || data.length === 0) break;
    for (const r of data as { lead_id: string }[]) ids.add(r.lead_id);
    if (data.length < PAGE) break;
  }
  return ids;
}
