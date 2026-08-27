import {
  DEFAULT_PRESENTATION_SETTINGS,
  validatePresentationSettings,
  type PresentationSettings,
} from "@/lib/presentationSettings";

/**
 * Building a lead's income presentation (0093).
 *
 * The tool at public/income-presentation/ has always asked the operator to type
 * every figure in by hand. The analysis PDF states all of them, so this hands
 * it a complete, filled-in state instead: the property's numbers from its
 * report, the operator's terms from their profile, and the landlord's details
 * from the lead.
 *
 * ⚠️ THE SHAPE MIRRORS `defaults()` IN public/income-presentation/index.html AND
 * THE TWO MUST CHANGE TOGETHER. It must be COMPLETE, not a partial: the tool
 * merges what it receives over its own defaults with `merge(base, over)`, which
 * copies the base's keys first and therefore cannot SHRINK an array — a
 * three-step onboarding list merged over five defaults would come out as five.
 */

/** The tool's `data` object, exactly. */
export interface PresentationSeedData {
  company: string;
  property: string;
  income: {
    grossAnnual: number;
    nightly: number;
    occupancy: number;
    longLetAnnual: number;
    platform: number;
    cleaning: number;
  };
  fee: PresentationSettings["fee"];
  cleaning: PresentationSettings["cleaning"];
  contract: PresentationSettings["contract"];
  compliance: string;
  vetting: string;
  chart: { variance: number };
  months: number[];
  cases: { worst: number; likely: number; best: number };
  onboarding: PresentationSettings["onboarding"];
  managed: string[];
  landlord: string[];
  discovery: PresentationSettings["discovery"];
  nextSteps: PresentationSettings["nextSteps"];
  notes: { landlord: string; phone: string; note: string };
  /**
   * What the analysis says about the market around this property (0113), or
   * null when it said nothing.
   *
   * A SEPARATE OBJECT FROM `income`, because it is a different KIND of claim.
   * Everything in `income` is about money this property makes and feeds the
   * arithmetic on every slide; nothing here is computed with — it is evidence,
   * shown on its own slide and nowhere else. Folding it in would also mean the
   * tool's "Adjust figures" form had to offer an operator a rating to edit,
   * and these are not theirs to adjust.
   */
  market: PresentationMarket | null;
  /**
   * The property's own seasonal curve as multipliers of its average month, or
   * null. Not a field the tool ships with — it is read by the patched
   * genMonths() so "regenerate" uses this property's shape rather than the
   * generic one.
   */
  monthWeights: number[] | null;
}

/**
 * The market block, exactly as the report states it (0113).
 *
 * ⚠️ EVERY FIELD IS INDEPENDENTLY NULLABLE and the slide renders per field, so
 * a report that gave us a risk score and nothing else produces one card rather
 * than a broken slide. There is no default for any of them: the tool's other
 * defaults exist so a partly-parsed lead still shows a plausible FORM to fill
 * in, and a made-up guest rating is not a form, it is a false statement about
 * somebody else's property.
 */
export interface PresentationMarket {
  /** The property's projected occupancy, repeated here for the comparison. */
  occupancy: number | null;
  /** The market's, as printed. 0 legitimately means "no comparables nearby". */
  marketOccupancy: number | null;
  compSetSize: number | null;
  compSetRadiusKm: number | null;
  compAvgRating: number | null;
  compAvgReviews: number | null;
  /** 0-100 where 0 is LOW risk, with the report's own wording beside it. */
  riskScore: number | null;
  riskLabel: string | null;
  /** 0-100 where 100 is best — the opposite direction to riskScore. */
  directBookingScore: number | null;
}

/** The tool's own starting figures, for anything the report did not state. */
const TOOL_INCOME_DEFAULTS = {
  grossAnnual: 60000,
  nightly: 185,
  occupancy: 60,
  longLetAnnual: 14400,
  platform: 15,
  cleaning: 18,
};
const TOOL_MONTHS = [
  1650, 1780, 2200, 2600, 3050, 3500, 3800, 3900, 3150, 2600, 1950, 1520,
];
const TOOL_CASES = { worst: 1650, likely: 2700, best: 4600 };
/** The tool damps its generic curve; a real one needs no damping. See below. */
const TOOL_VARIANCE = 0.6;

export interface SeedLead {
  address: string | null;
  lead_name: string | null;
  phone: string | null;
  gross_annual_income: number | null;
  avg_nightly_rate: number | null;
  occupancy_rate: number | null;
  long_let_annual_income: number | null;
  platform_fee_pct: number | null;
  cleaning_fee_pct: number | null;
  monthly_revenue_profile: number[] | null;
  market_occupancy_rate: number | null;
  comp_set_size: number | null;
  comp_set_radius_km: number | null;
  comp_avg_rating: number | null;
  comp_avg_review_count: number | null;
  risk_score: number | null;
  risk_label: string | null;
  direct_booking_score: number | null;
}

export interface SeedCustomer {
  business_name: string | null;
  presentation_settings: unknown;
}

/**
 * The market block, or null when the report stated none of it.
 *
 * Null rather than an object of nulls, because the tool switches a whole SLIDE
 * on it: an object that is present but empty would put an empty slide in front
 * of a landlord, which is worse than the six slides this tool has always had.
 */
function marketFrom(lead: SeedLead): PresentationMarket | null {
  const market: PresentationMarket = {
    occupancy: numOrNull(lead.occupancy_rate),
    // 0 is kept — it is the report's way of saying there is nothing comparable
    // nearby, which is worth an operator knowing.
    marketOccupancy: numOrNull(lead.market_occupancy_rate, true),
    compSetSize: numOrNull(lead.comp_set_size, true),
    compSetRadiusKm: numOrNull(lead.comp_set_radius_km),
    compAvgRating: numOrNull(lead.comp_avg_rating),
    compAvgReviews: numOrNull(lead.comp_avg_review_count, true),
    riskScore: numOrNull(lead.risk_score, true),
    riskLabel: lead.risk_label?.trim() || null,
    directBookingScore: numOrNull(lead.direct_booking_score, true),
  };

  // The property's own occupancy is not evidence about the market on its own —
  // it is already on the income slide. Something the market block actually
  // states has to be present for the slide to be worth showing.
  const { occupancy, ...evidence } = market;
  const hasEvidence = Object.values(evidence).some((v) => v != null);
  return hasEvidence ? market : null;
}

/**
 * ⚠️ `Number(null)` IS 0, not NaN — so a bare `Number()` here would turn every
 * absent market figure into a legitimate-looking zero, and a lead whose report
 * stated none of this would arrive claiming a market occupancy of 0% and a comp
 * set of nothing. Absence is tested before the number is.
 */
function numOrNull(value: unknown, allowZero = false): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return null;
  return n > 0 || allowZero ? n : null;
}

function num(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * What the operator's own net works out at, using the tool's own arithmetic.
 *
 * DUPLICATED FROM THE TOOL'S `calc()` ON PURPOSE, and it must stay in step. The
 * months and cases below are expressed in net pounds, so they have to be scaled
 * against the same net the tool will compute and display — deriving them from
 * the report's net instead would put a curve on the slide that does not add up
 * to the total printed beside it.
 *
 * Note this is the OPERATOR'S net, not the report's. The report charges 15% of
 * gross because that is Stayful's fee; this uses theirs.
 */
function operatorNetAnnual(
  gross: number,
  platformPct: number,
  cleaningPct: number,
  fee: PresentationSettings["fee"]
): number {
  const platform = (gross * platformPct) / 100;
  const cleaning = (gross * cleaningPct) / 100;
  const feeBase = fee.basis === "net" ? gross - platform : gross;
  return gross - platform - cleaning - (feeBase * fee.pct) / 100;
}

/**
 * The report's forecast as MULTIPLIERS of its own average month.
 *
 * The forecast is stated in pounds net at Stayful's fee, so seeding it raw
 * beside a different net would be internally inconsistent — twelve months that
 * do not sum to the total on the same slide. The SHAPE is the part that is
 * about the property, and it survives the change of fee.
 */
function weightsFrom(profile: number[] | null): number[] | null {
  if (!profile || profile.length !== 12) return null;
  const sum = profile.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return null;
  const avg = sum / 12;
  return profile.map((m) => m / avg);
}

/**
 * A complete presentation for this lead and this operator.
 *
 * Layered defaults → the operator's profile → the property's figures. Anything
 * the report did not state keeps the tool's own default, so a partially parsed
 * lead is a partly filled form rather than a broken one, and a lead with no
 * report at all comes out identical to opening the tool blank.
 */
export function buildPresentationSeed(
  lead: SeedLead,
  customer: SeedCustomer
): PresentationSeedData {
  const settings = validatePresentationSettings(customer.presentation_settings);

  const grossAnnual = num(lead.gross_annual_income, TOOL_INCOME_DEFAULTS.grossAnnual);
  const platform = num(lead.platform_fee_pct, TOOL_INCOME_DEFAULTS.platform);
  const cleaning = num(lead.cleaning_fee_pct, TOOL_INCOME_DEFAULTS.cleaning);

  const income = {
    grossAnnual,
    nightly: num(lead.avg_nightly_rate, TOOL_INCOME_DEFAULTS.nightly),
    occupancy: num(lead.occupancy_rate, TOOL_INCOME_DEFAULTS.occupancy),
    // GROSS long-let rent, matching the field's label "Current long-let
    // income" — what the landlord actually receives. The report's own headline
    // uplift compares against the long-let NET, so our uplift reads higher
    // than the PDF's. The label wins: a landlord knows their rent, not their
    // rent after a letting agent's cut.
    longLetAnnual: num(lead.long_let_annual_income, TOOL_INCOME_DEFAULTS.longLetAnnual),
    platform,
    cleaning,
  };

  const weights = weightsFrom(lead.monthly_revenue_profile);
  let months = TOOL_MONTHS;
  let cases = TOOL_CASES;
  let variance = TOOL_VARIANCE;

  if (lead.gross_annual_income != null && weights) {
    const netMonthly =
      operatorNetAnnual(grossAnnual, platform, cleaning, settings.fee) / 12;
    months = weights.map((w) => Math.max(0, Math.round((netMonthly * w) / 10) * 10));
    cases = {
      worst: Math.min(...months),
      likely: Math.round(netMonthly),
      best: Math.max(...months),
    };
    // The tool's variance exists to soften its GENERIC curve toward the
    // average. Applied to a real one it would flatten the property's actual
    // seasonality, so a seeded lead regenerates at full strength.
    variance = 1;
  }

  return {
    company: customer.business_name?.trim() || "[Your company]",
    property: lead.address?.trim() || "this property",
    income,
    fee: settings.fee,
    cleaning: settings.cleaning,
    contract: settings.contract,
    compliance: settings.compliance,
    vetting: settings.vetting,
    chart: { variance },
    months,
    cases,
    onboarding: settings.onboarding,
    managed: settings.managed,
    landlord: settings.landlord,
    discovery: settings.discovery,
    nextSteps: settings.nextSteps,
    market: marketFrom(lead),
    // Private to the presenter — the notes panel, never a slide.
    notes: {
      landlord: lead.lead_name?.trim() || "",
      phone: lead.phone?.trim() || "",
      note: "",
    },
    monthWeights: weights,
  };
}

export { DEFAULT_PRESENTATION_SETTINGS };
