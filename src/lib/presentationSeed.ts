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
   * The property's own seasonal curve as multipliers of its average month, or
   * null. Not a field the tool ships with — it is read by the patched
   * genMonths() so "regenerate" uses this property's shape rather than the
   * generic one.
   */
  monthWeights: number[] | null;
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
}

export interface SeedCustomer {
  business_name: string | null;
  presentation_settings: unknown;
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
