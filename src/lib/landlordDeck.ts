/**
 * The reveal deck a landlord walks through at /p/[token] (§41).
 *
 * Each card gives the landlord something about their own property before the
 * next question is asked. The questions are the spine and always run; cards
 * attach to whichever ones the report actually supports.
 *
 * ⚠️ SEVEN RULES. Every one of them is a way this could tell a member of the
 * public something untrue or something that is not ours to say.
 *
 * 1. NEVER buildPresentationSeed(). It substitutes TOOL_INCOME_DEFAULTS —
 *    £60,000 gross, £185 a night, 60% occupancy. Right for an operator's
 *    editable form, a lie to a landlord. Absent is omitted, never defaulted.
 * 2. net_annual_income IS NEVER SHOWN. It is net of STAYFUL'S 15% and is
 *    rendered nowhere by design (§26.1).
 * 3. NO FEE AND NO PERCENTAGE OF INCOME REACHES THE LANDLORD. The report's fee
 *    is ours; the operator's is different and unknown at this moment. Note that
 *    buildIncomeProjection() also returns the fee figures alongside the gross
 *    — this module reads the gross fields BY NAME and never spreads the object,
 *    which is what stops a future edit leaking them.
 * 4. risk_score IS INVERTED (0 = LOW risk, §38.4). Only risk_label's own
 *    wording is used; the number never appears.
 * 5. market_occupancy_rate = 0 MEANS "no comparable listings found", not 0%
 *    occupancy (§40.5). The figure is dropped, not printed.
 * 6. NOTHING ABOUT OPERATORS. Not who holds the lead, not how many. §19.7
 *    removed exactly this from the pool row set "so no later UI change can
 *    reach for it", and the rule is sharper here because the reader is the
 *    landlord.
 * 7. EVERY FIGURE IS AN ESTIMATE AND IS WORDED AS ONE, reusing incomeBasis()'s
 *    existing two wordings rather than inventing a third.
 *
 * ⚠️ MANAGEMENT ONLY, AS A GATE RATHER THAN AN OUTCOME. 0 of 252 guaranteed
 * rent leads carry a single figure — §25's analysis is management-only by
 * design — so a GR deck would be empty 100% of the time. Stated, so nobody
 * later "fixes" the asymmetry.
 */
import {
  buildIncomeProjection,
  incomeBasis,
} from "@/lib/incomeProjection";

/** Index 0 is January — the order incomeReport.ts's own month list parses. */
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export interface DeckLead {
  lead_type?: string | null;
  address?: string | null;
  bedrooms?: string | null;
  gross_annual_income?: number | null;
  avg_nightly_rate?: number | null;
  occupancy_rate?: number | null;
  monthly_revenue_profile?: number[] | null;
  market_occupancy_rate?: number | null;
  comp_set_size?: number | null;
  comp_set_radius_km?: number | null;
  comp_avg_rating?: number | null;
  comp_avg_review_count?: number | null;
  risk_label?: string | null;
}

export interface DeckHeadline {
  grossLow: number;
  grossHigh: number;
}

export type DeckCard =
  | {
      kind: "mechanism";
      title: string;
      body: string;
      nightlyRate: number;
      occupancyPct: number;
    }
  | {
      kind: "market";
      title: string;
      body: string;
      /** Relative bars are not needed here; these are for the figure row. */
      compSetSize: number | null;
      radiusKm: number | null;
      rating: number | null;
      reviews: number | null;
      marketOccupancyPct: number | null;
      propertyOccupancyPct: number | null;
    }
  | {
      kind: "seasonality";
      title: string;
      body: string;
      /** Multipliers of the property's own average month. A SHAPE, not money. */
      weights: number[];
      months: string[];
      peak: string;
      trough: string;
    }
  | { kind: "risk"; title: string; body: string; label: string };

export interface LandlordDeck {
  headline: DeckHeadline | null;
  cards: DeckCard[];
}

/**
 * `Number(null)` is 0, not NaN, so a bare Number() turns every absent figure
 * into a confident zero. Same trap §38.5 records and the same guard.
 */
function numOrNull(v: unknown, allowZero = false): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return n > 0 || allowZero ? n : null;
}

/**
 * The seasonal SHAPE, as multipliers of the property's own average month.
 *
 * ⚠️ NEVER RENDERED IN POUNDS. The report states that forecast NET AT STAYFUL'S
 * FEE (§26.2), so printing it as money would either contradict the gross figure
 * on the card above or leak our fee — rules 2 and 3 at once. The shape carries
 * the whole insight, which is WHEN the money arrives.
 */
export function seasonalWeights(profile: unknown): number[] | null {
  if (!Array.isArray(profile) || profile.length !== 12) return null;
  const nums = profile.map((m) => Number(m));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return null;
  const avg = sum / 12;
  return nums.map((m) => m / avg);
}

export function buildLandlordDeck(lead: DeckLead): LandlordDeck {
  // Rule: management only, and a gate rather than an empty outcome.
  if (lead.lead_type !== "management") return { headline: null, cards: [] };

  const projection = buildIncomeProjection({
    gross_annual_income: lead.gross_annual_income ?? null,
  } as Parameters<typeof buildIncomeProjection>[0]);

  // Read by name. Never spread — the object also carries the fee figures.
  const headline: DeckHeadline | null = projection
    ? { grossLow: projection.grossAnnualLow, grossHigh: projection.grossAnnualHigh }
    : null;

  const cards: DeckCard[] = [];

  // ── Card 1: how the number is built ──────────────────────────────────────
  const basis = incomeBasis({
    gross_annual_income: lead.gross_annual_income ?? null,
    avg_nightly_rate: lead.avg_nightly_rate ?? null,
    occupancy_rate: lead.occupancy_rate ?? null,
  } as Parameters<typeof incomeBasis>[0]);

  if (basis) {
    cards.push({
      kind: "mechanism",
      title: "Where that figure comes from",
      // The two wordings are incomeBasis()'s, not new ones. Where the identity
      // reconciles the pair IS the basis of the gross; where it does not, they
      // are the comparable set's averages and saying otherwise would be false.
      body: basis.reconciles
        ? `Based on £${basis.nightlyRate} a night at ${basis.occupancyPct}% occupancy across the year.`
        : `Comparable properties nearby average £${basis.nightlyRate} a night at ${basis.occupancyPct}% occupancy.`,
      nightlyRate: basis.nightlyRate,
      occupancyPct: basis.occupancyPct,
    });
  }

  // ── Card 2: what the market around them looks like ───────────────────────
  const compSetSize = numOrNull(lead.comp_set_size);
  const radiusKm = numOrNull(lead.comp_set_radius_km);
  const rating = numOrNull(lead.comp_avg_rating);
  const reviews = numOrNull(lead.comp_avg_review_count);
  // Rule 5: a stored 0 means no comparables were found, not 0% occupancy.
  const marketOcc = numOrNull(lead.market_occupancy_rate);
  const propertyOcc = numOrNull(lead.occupancy_rate);

  if (compSetSize || rating || marketOcc) {
    const bits: string[] = [];
    if (compSetSize) {
      bits.push(
        radiusKm
          ? `There are ${compSetSize} active short lets within ${radiusKm.toFixed(1)}km of you.`
          : `There are ${compSetSize} active short lets nearby.`
      );
    }
    if (rating && reviews) {
      bits.push(`They average ${rating.toFixed(1)} out of 5 from around ${Math.round(reviews)} reviews each.`);
    } else if (rating) {
      bits.push(`They average ${rating.toFixed(1)} out of 5.`);
    }
    if (marketOcc && propertyOcc) {
      bits.push(`The area runs at about ${Math.round(marketOcc)}% occupancy; your property models at ${Math.round(propertyOcc)}%.`);
    } else if (marketOcc) {
      bits.push(`The area runs at about ${Math.round(marketOcc)}% occupancy.`);
    }

    cards.push({
      kind: "market",
      title: "What's happening around you",
      body: bits.join(" "),
      compSetSize,
      radiusKm,
      rating,
      reviews,
      marketOccupancyPct: marketOcc,
      propertyOccupancyPct: propertyOcc,
    });
  }

  // ── Card 3: when the money actually arrives ──────────────────────────────
  const weights = seasonalWeights(lead.monthly_revenue_profile);
  if (weights) {
    let peakI = 0;
    let troughI = 0;
    weights.forEach((w, i) => {
      if (w > weights[peakI]) peakI = i;
      if (w < weights[troughI]) troughI = i;
    });
    cards.push({
      kind: "seasonality",
      title: "It isn't the same every month",
      body: `${MONTHS[peakI]} models as your strongest month and ${MONTHS[troughI]} your quietest. Most of the year sits between the two.`,
      weights,
      months: MONTHS,
      peak: MONTHS[peakI],
      trough: MONTHS[troughI],
    });
  }

  // ── Card 4: the analyser's own read on demand ────────────────────────────
  // Rule 4: the LABEL only. risk_score is 0-for-low and a number shown here
  // would be read the opposite way round by anybody sensible.
  const riskLabel = lead.risk_label?.trim();
  if (riskLabel) {
    cards.push({
      kind: "risk",
      title: "How steady the demand looks",
      body: `Our analysis rates demand risk in your area as ${riskLabel.toLowerCase()}.`,
      label: riskLabel,
    });
  }

  return { headline, cards };
}
