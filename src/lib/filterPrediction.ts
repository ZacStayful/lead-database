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

/**
 * The revenue floors a customer may choose, in POUNDS.
 *
 * ⚠️ POUNDS, NOT PENCE. `leads.gross_annual_income` is `numeric` in pounds,
 * and every price column in this codebase is in pence (`costPerLeadPence`,
 * `filter_forecast_plan_price_pence`). A floor stored in pence compared
 * against a pounds column matches nothing, quotes zero, and reads to the
 * customer as "your filter is too narrow".
 *
 * ⚠️ A FIXED LIST, NEVER A FREE NUMBER, and that is what makes the banding
 * exact: because the only floors are these, `>= £40k` is EXACTLY the union of
 * the bands from 40k up, with no approximation and agreeing with the SQL cell
 * for cell. The migration's CHECK is asserted against this constant
 * mechanically (the `cancelOptions.ts` arrangement, §29) — if the two ever
 * diverge, every floored quote is computed at the wrong edge and half the
 * directions OVERSTATE.
 *
 * ⚠️ £100k was measured and DROPPED. Only 7 management leads in the whole book
 * clear it, so no area-restricted filter could ever reach MIN_RELIABLE_MATCHES
 * — and an unofferable forecast does not merely decline to quote, it writes
 * null into all five forecast columns (§28, §58.3). Adding it back is one
 * entry here plus the CHECK, if the book ever grows into it.
 */
export const GROSS_THRESHOLDS = [25000, 30000, 40000, 50000, 75000] as const;

export type GrossThreshold = (typeof GROSS_THRESHOLDS)[number];

/**
 * Is this a floor we actually offer?
 *
 * ⚠️ THE ONE VALIDATOR, and the apply route must use it rather than a range
 * check. The list is a fixed set precisely so `>= £40k` is EXACTLY the union
 * of the bands from 40k up (above); a free number between two thresholds would
 * be banded at the wrong edge and quoted against stock it does not admit, and
 * the SQL CHECK would refuse the write afterwards with a 500 rather than a
 * sentence the customer can act on.
 */
export function isGrossThreshold(v: unknown): v is GrossThreshold {
  return (
    typeof v === "number" &&
    (GROSS_THRESHOLDS as readonly number[]).includes(v)
  );
}

/** "£50k" from 50000 — the label the control and every summary line use. */
export function formatGrossThreshold(gross: number): string {
  return `£${Math.round(gross / 1000)}k`;
}

/**
 * The band a lead's gross figure falls in.
 *
 * `"none"` is a lead with NO figure — 29 of 273 management leads (10.6%), and
 * every one of the 291 guaranteed-rent leads, because §25's analysis is
 * management-only by design. `"0"` is a real figure below the lowest floor.
 * ⚠️ The two are not interchangeable: an absent floor admits both, and ANY
 * floor excludes both.
 */
export type GrossBand = "none" | "0" | `${GrossThreshold}`;

/** Every band key, lowest first. Derived from the thresholds so it cannot drift. */
export const GROSS_BAND_KEYS: readonly GrossBand[] = [
  "none",
  "0",
  ...GROSS_THRESHOLDS.map((t) => String(t) as `${GrossThreshold}`),
];

/**
 * Which band a gross figure belongs to. `null` (no figure) is `"none"`.
 *
 * The band is the HIGHEST threshold the figure clears, so a lead at £52,000
 * lands in `"50000"` and is admitted by floors of 25k, 30k, 40k and 50k but
 * not 75k — which is exactly what `gross >= floor` means.
 */
export function bandFor(gross: number | null | undefined): GrossBand {
  if (gross == null || !Number.isFinite(gross)) return "none";
  let band: GrossBand = "0";
  for (const t of GROSS_THRESHOLDS) {
    if (gross >= t) band = String(t) as `${GrossThreshold}`;
  }
  return band;
}

/**
 * The bands a floor admits.
 *
 * ⚠️ ONE PREDICATE, NO `minGross == null` BRANCH. A null floor admits every
 * key INCLUDING `"none"`, so a customer who sets no floor sees byte-identical
 * numbers to before this feature existed; a floor admits the numeric bands at
 * or above it and excludes `"none"` and `"0"`. A branch here is where the
 * floored and unfloored paths would drift (§28.5, §28.8).
 */
export function allowedBands(minGross: number | null | undefined): Set<GrossBand> {
  if (minGross == null) return new Set(GROSS_BAND_KEYS);
  const out = new Set<GrossBand>();
  for (const t of GROSS_THRESHOLDS) {
    if (t >= minGross) out.add(String(t) as `${GrossThreshold}`);
  }
  return out;
}

/** postcode area -> bedroom count -> band -> lead count. */
export type AreaBedBandCounts = Record<
  string,
  Record<string, Partial<Record<GrossBand, number>>>
>;

/**
 * Sum a band index back into the plain area/bed shape.
 *
 * ⚠️ `areaBedCounts` is DERIVED FROM THIS and never accumulated separately.
 * That makes the two consistent STRUCTURALLY — there is no second number to
 * disagree with — which matters because contention floors per bucket
 * (`Math.floor(count * share)`) and independently-floored quantities do not
 * sum. With per-band contention each band scales by a different factor, so a
 * separately-stored total could not be reconciled with the sum of its own
 * bands at all.
 */
export function deriveAreaBedCounts(
  bands: AreaBedBandCounts
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [area, beds] of Object.entries(bands)) {
    const row: Record<string, number> = {};
    for (const [bed, byBand] of Object.entries(beds)) {
      let total = 0;
      for (const n of Object.values(byBand)) total += n ?? 0;
      if (total > 0) row[bed] = total;
    }
    if (Object.keys(row).length > 0) out[area] = row;
  }
  return out;
}

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
  /**
   * postcode area (uppercase) -> parsed bedroom count (string key) -> lead count.
   *
   * ⚠️ DERIVED from `areaBedBandCounts`, never accumulated — see
   * `deriveAreaBedCounts`. Kept on the object because every existing reader
   * (the estimator, the public payload, the radius widening scan) wants the
   * bedroom-level total and should not have to sum bands itself.
   */
  areaBedCounts: Record<string, Record<string, number>>;
  /**
   * The same index split by revenue band.
   *
   * ⚠️ NULL MEANS "THIS SOURCE CANNOT ANSWER REVENUE QUESTIONS" — not "no lead
   * clears any floor" (§18.3's three outcomes, never two). Only the public
   * cached payload can be null, and only while it predates revenue banding; a
   * surface that finds it null must HIDE the revenue control rather than quote
   * zero, which is §58.2's failure self-inflicted on a marketing page. Gate on
   * `canFilterByGross`.
   */
  areaBedBandCounts: AreaBedBandCounts | null;
}

export type LeadVolumeAggregate = Record<LeadType, ProductVolume>;

export interface FilterSelection {
  /** Empty = anywhere, matching the SQL's null/empty-array rule. */
  areas: string[];
  minBedrooms: number | null;
  maxBedrooms: number | null;
  /**
   * Minimum projected gross annual revenue, in POUNDS, from GROSS_THRESHOLDS.
   * Null = no revenue floor.
   *
   * ⚠️ REQUIRED, NEVER OPTIONAL, and deliberately so. Four call sites build
   * this type as an object LITERAL and would compile unchanged — and be
   * silently wrong — if the field were optional: both admin predictions would
   * ignore the floor and read systematically high against the stored figure
   * (§28.7's drift indicator), `forecastBackfill` would store a forecast that
   * ignores it, and the radius widening scan would quote a gain computed over
   * stock the floor excludes. Required, `tsc` enumerates every one of them.
   */
  minGross: number | null;
}

/**
 * Whether this volume source can answer a revenue-floor question at all.
 *
 * ⚠️ THE GATE, and it is not optional. `predictMonthlyVolume` cannot answer a
 * floor without band data, and neither available answer is safe: ignoring the
 * floor OVERSTATES, and excluding everything quotes ZERO, which §58.2 records
 * as indistinguishable from a real answer and the more dangerous of the two.
 * So the control is hidden upstream instead.
 */
export function canFilterByGross(volume: ProductVolume): boolean {
  return volume.areaBedBandCounts !== null;
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
  /**
   * Uppercase postcode area -> number of filtered customers covering it.
   *
   * ⚠️ BAND-BLIND, AND FOR DISPLAY ONLY — the admin density map asks "how many
   * customers cover this area", which is a headcount question. The forecast
   * must not read it: a competitor eligible for a tenth of an area's leads is
   * not a whole competitor for any of them. Use `byBand`.
   */
  filteredCustomers: Record<string, number>;
  /** CONTENDED_FILTERED_CUSTOMERS — the assignment ceiling for one lead. */
  maxPerLead: number;
  /**
   * Filtered customers with no area restriction (a bedroom-only filter). They
   * compete in every area, including ones no explicit filter names, so they are
   * a floor under areas absent from `filteredCustomers` too.
   */
  everywhere?: number;
  /**
   * area -> band -> competitors for a lead IN THAT BAND.
   *
   * ⚠️ THE ROUTING-ACCURATE ONE, and §28.5 is why it has to exist: "the
   * estimate must agree with the router, or the number quoted is one the
   * engine was never going to deliver." The router shares a SPECIFIC lead
   * among the customers who match THAT lead — which now includes its revenue.
   * Keyed area-only, a £75k-floor competitor counts as a full competitor in an
   * area where they are eligible for a twelfth of the leads, deflating
   * everyone else's quote; and four customers with DISJOINT floors do not
   * contend at all, yet would trip the ceiling and each be quoted 4/5.
   *
   * Always fully populated — a floor-less customer counts under every band —
   * so there is one code path rather than a "has floors?" branch.
   */
  byBand: Record<string, Partial<Record<GrossBand, number>>>;
  /** The bedroom-only filters of `everywhere`, split the same way. */
  everywhereByBand: Partial<Record<GrossBand, number>>;
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
  band: GrossBand,
  contention: AreaContention | null | undefined,
  includeSelf = true
): number {
  if (!contention) return 1;
  const key = area.toUpperCase();
  // ⚠️ `band` is REQUIRED, never optional. An optional band silently gives
  // band-blind contention to any caller that forgets it, which is the §G trap
  // in miniature — and the symptom is a quote that is wrong by the sharing
  // factor with nothing erroring.
  const existing =
    contention.byBand[key]?.[band] ?? contention.everywhereByBand[band] ?? 0;
  const competitors = existing + (includeSelf ? 1 : 0);
  if (competitors <= contention.maxPerLead) return 1;
  return contention.maxPerLead / competitors;
}

export interface VolumePrediction {
  /** Raw matches since windowStart. */
  matchingLeads: number;
  /**
   * `matchingLeads` BEFORE the whole-lead floor — contention-scaled, still
   * fractional.
   *
   * Purely additive, and it exists for the diagnosis in Phase 3: `Math.floor`
   * on the total and `Math.round` on the rate erase small real gains, so
   * ranking relaxations on `displayRate` produces three-way 0-0-0 ties that
   * render as "nothing is costing you volume" — the plausible-looking wrong
   * answer. Nothing user-facing reads it.
   */
  rawMatching: number;
  /**
   * False when a revenue floor was asked for and this source has no band data,
   * so the floor was IGNORED and the number is unfloored.
   *
   * ⚠️ A caller that set a floor and gets this back must not present the
   * figure as floored. Gate on `canFilterByGross` instead of relying on it —
   * this is the second layer, not the first.
   */
  grossFilterApplied: boolean;
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

  // ONE loop over ONE shape. A source with no band data is normalised into
  // all-"none" rather than given a second code path, because a branch is
  // where the floored and unfloored readings would drift apart.
  const bandView = bandViewFor(volume);
  const grossFilterApplied = sel.minGross == null || canFilterByGross(volume);
  const allowed = allowedBands(grossFilterApplied ? sel.minGross : null);

  let rawMatching = 0;
  for (const [area, beds] of Object.entries(bandView)) {
    if (wantedAreas && !wantedAreas.has(area)) continue;
    for (const [bed, byBand] of Object.entries(beds)) {
      const b = Number(bed);
      if (sel.minBedrooms != null && b < sel.minBedrooms) continue;
      if (sel.maxBedrooms != null && b > sel.maxBedrooms) continue;
      for (const [band, count] of Object.entries(byBand)) {
        if (!allowed.has(band as GrossBand)) continue;
        // Applied per (AREA, BAND), not to the total and not per area: a
        // filter spanning a crowded city and an empty county is only contended
        // in the city, and within one area a £75k lead is contended only by
        // the customers whose own floor admits it.
        rawMatching += (count ?? 0) * contentionShare(area, band as GrossBand, contention);
      }
    }
  }
  // Whole leads: a share can make this fractional, and every downstream
  // consumer — the reliability floor, the forecast's negative binomial — is
  // counting events, not expectations.
  const matchingLeads = Math.floor(rawMatching);

  const monthlyRate =
    (matchingLeads / volume.weeksElapsed) * WEEKS_PER_MONTH;
  return {
    matchingLeads,
    rawMatching,
    grossFilterApplied,
    monthlyRate,
    displayRate: Math.round(monthlyRate),
    reliable: matchingLeads >= MIN_RELIABLE_MATCHES,
    weeksElapsed: volume.weeksElapsed,
  };
}

/**
 * A band-shaped view of a volume, whatever it actually carries.
 *
 * With band data, itself. Without (an old public payload), every lead reads as
 * `"none"` — which is TRUE: that source tells us nothing about any lead's
 * gross. Totals are therefore unchanged, because an absent floor admits
 * `"none"`; a floor is refused upstream by `canFilterByGross`.
 */
function bandViewFor(volume: ProductVolume): AreaBedBandCounts {
  if (volume.areaBedBandCounts) return volume.areaBedBandCounts;
  const out: AreaBedBandCounts = {};
  for (const [area, beds] of Object.entries(volume.areaBedCounts)) {
    const row: Record<string, Partial<Record<GrossBand, number>>> = {};
    for (const [bed, n] of Object.entries(beds)) row[bed] = { none: n };
    out[area] = row;
  }
  return out;
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
   * Projected gross annual revenue in POUNDS (§25), or null where the lead
   * carries no Stayful analysis. Absent (rather than null) on callers that
   * predate revenue banding, which reads as `"none"` exactly as a null does.
   */
  gross_annual_income?: number | null;
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
    areaBedBandCounts: {},
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
    // ⚠️ THE BAND IS THE ONLY THING THAT MOVED. `matchableLeads` and the
    // `continue` above it are untouched on purpose: adding `|| gross == null`
    // to that guard would drop the 29 management leads (10.6%) carrying no
    // figure out of EVERY forecast, including those with no floor set,
    // silently and with nothing erroring. They land in `"none"` instead,
    // stay inside `matchableLeads`, and stay matched whenever `minGross` is
    // null — bit-identical totals, one structure.
    const bands = (product.areaBedBandCounts![area] ??= {});
    const byBand = (bands[String(bed)] ??= {});
    const band = bandFor(row.gross_annual_income);
    byBand[band] = (byBand[band] ?? 0) + 1;
  }

  // Derived last, from the bands, so the two can never disagree.
  for (const product of [agg.management, agg.guaranteed_rent]) {
    product.areaBedCounts = deriveAreaBedCounts(product.areaBedBandCounts!);
  }

  return agg;
}

/**
 * The lead book could not be read, so no volume figure exists.
 *
 * Thrown rather than swallowed (see the loops below) so every surface decides
 * for itself what an unreadable book means — §18.3's "three outcomes, never
 * two": the filtering page says so and disables Apply, the apply route answers
 * 503, the public estimator keeps its last good cache, the admin pages drop
 * the prediction column. None of them may quote zero.
 */
export class LeadVolumeUnavailableError extends Error {
  constructor(detail: string) {
    super(`Lead volume unavailable: ${detail}`);
    this.name = "LeadVolumeUnavailableError";
  }
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
        "id, postcode_area, bedrooms, lead_type, created_at, gross_annual_income, pool_expired_at, pool_entered_at, pool_entry_basis, stayful_conflict_at"
      )
      // Customer-owned leads are not marketplace supply. Counting them here
      // would inflate the volume figure we QUOTE to a customer applying a
      // filter (§28) — a number we would then fail to deliver, using leads they
      // brought in themselves as the evidence we could.
      .is("owner_customer_id", null)
      .gte("created_at", INGEST_EPOCH_ISO)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    // ⚠️ AN ERROR THROWS. It used to `break`, which returned an EMPTY aggregate
    // on a database error — indistinguishable from a book with no leads in it.
    // Every consumer then rendered that as fact: the filtering page said "No
    // postcode areas are available yet" and hid the map, the picker and the
    // radius search; the forecast read "not offerable" so the cost per lead,
    // the likelihood and the cheaper-plan advice vanished; the apply route
    // skipped the apply-now question; and the public estimator OVERWROTE its
    // cache with zeros. Supabase gateway timeouts on 9–14 Sep 2026 did exactly
    // that to production, and it read as every filter revision having been
    // reverted (§58). §30 had already recorded the same shape once. Only an
    // empty page is the end of paging.
    if (error) throw new LeadVolumeUnavailableError(error.message);
    if (!data || data.length === 0) break;
    for (const r of data as RawLeadVolumeRow[]) {
      rows.push({
        postcode_area: r.postcode_area,
        bedrooms: r.bedrooms,
        lead_type: r.lead_type,
        created_at: r.created_at,
        gross_annual_income: r.gross_annual_income,
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
  /** §64 — a landlord in Stayful's own pipeline is never supply. */
  stayful_conflict_at?: string | null;
}

/**
 * JS mirror of `lead_retired_from_allocation()` (0073 §9), which is
 * `service_role`-only and cannot be called per row from PostgREST anyway.
 * The two `leads`-column branches are evaluated here; the assignment branch
 * needs `claimed_from_pool_at`, which is why the claimed ids are fetched once
 * up front rather than joined per row.
 */
function isRetired(row: RawLeadVolumeRow, claimedLeadIds: Set<string>): boolean {
  if (row.stayful_conflict_at != null) return true;
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

  // ⚠️ THE FLOOR IS READ ON THE MANAGEMENT SIDE ONLY, and there is no gr_
  // column to read even by mistake (0158) — invariant 6 satisfied
  // structurally. A GR competitor therefore always counts under every band,
  // which is correct: no GR lead carries a gross figure at all.
  const select = isGr
    ? `id, ${cols.areas}, ${cols.status}`
    : `id, ${cols.areas}, ${cols.status}, filter_min_gross`;

  let query = admin
    .from("customers")
    .select(select)
    .in(cols.status, ["active", "pending_lift"]);

  query = isGr
    ? query.eq("gr_subscription_status", "active")
    : query.eq("account_status", "active").eq("subscription_status", "active");

  if (excludeCustomerId) query = query.neq("id", excludeCustomerId);

  const { data, error } = await query;
  const filteredCustomers: Record<string, number> = {};
  const byBand: Record<string, Partial<Record<GrossBand, number>>> = {};
  const everywhereByBand: Partial<Record<GrossBand, number>> = {};
  if (error || !data) {
    // Fail OPEN, deliberately. An empty contention map quotes the UNSHARED
    // volume, which is the number this feature showed before contention
    // existed — optimistic by at most the sharing factor. Failing closed would
    // quote zero and refuse to forecast at all on a transient read error.
    console.error("area contention read failed; quoting unshared", error);
    return {
      filteredCustomers,
      byBand,
      everywhereByBand,
      maxPerLead: CONTENDED_FILTERED_CUSTOMERS,
    };
  }

  // A filter with no areas is a bedroom-only filter: that customer is eligible
  // in EVERY area and competes everywhere. Counted as a floor under every area
  // rather than being silently ignored.
  let everywhere = 0;
  const rows = data as unknown as Record<string, unknown>[];
  for (const row of rows) {
    const areas = row[cols.areas] as string[] | null;
    // A competitor contends only for the bands their OWN floor admits. No
    // floor (every GR customer, and every management customer today) admits
    // all of them, so this reduces to the old headcount by construction.
    const floor = isGr ? null : ((row.filter_min_gross as number | null) ?? null);
    const bands = allowedBands(floor);

    if (!areas || areas.length === 0) {
      everywhere += 1;
      for (const band of Array.from(bands)) {
        everywhereByBand[band] = (everywhereByBand[band] ?? 0) + 1;
      }
      continue;
    }
    for (const a of areas) {
      const key = a?.trim().toUpperCase();
      if (!key) continue;
      filteredCustomers[key] = (filteredCustomers[key] ?? 0) + 1;
      const perBand = (byBand[key] ??= {});
      for (const band of Array.from(bands)) {
        perBand[band] = (perBand[band] ?? 0) + 1;
      }
    }
  }
  if (everywhere > 0) {
    for (const key of Object.keys(filteredCustomers)) {
      filteredCustomers[key] += everywhere;
    }
    // The same floor under every NAMED area, band by band. Areas nobody names
    // fall back to `everywhereByBand` in contentionShare.
    for (const key of Object.keys(byBand)) {
      for (const [band, n] of Object.entries(everywhereByBand)) {
        byBand[key][band as GrossBand] =
          (byBand[key][band as GrossBand] ?? 0) + (n ?? 0);
      }
    }
  }

  return {
    filteredCustomers,
    byBand,
    everywhereByBand,
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
    // Same rule as fetchLeadVolumeData: a read that failed is not an empty set.
    // Reading it as one would un-retire every pool-claimed lead in the figures.
    if (error) throw new LeadVolumeUnavailableError(error.message);
    if (!data || data.length === 0) break;
    for (const r of data as { lead_id: string }[]) ids.add(r.lead_id);
    if (data.length < PAGE) break;
  }
  return ids;
}
