/**
 * Paid lead analysis: what can be analysed, what it costs, and what comes back.
 *
 * A customer-owned lead arrives with no figures and no analysis PDF — those
 * come from parsing a document attached to the lead's Monday item (§25), and a
 * lead the customer added has no Monday item. This module is the pure half of
 * closing that gap for £3 a lead: deciding which of their leads the analyser
 * can actually price, quoting the job, explaining the ones it cannot, and
 * turning the analyser's reply back into the `IncomeReportOutcome` the existing
 * write path already knows how to store.
 *
 * Everything here is a pure function of its inputs — no network, no database —
 * so it sits in the build-gating vitest suite, and so the client can run
 * `analysability()` against live form state to enable or disable a checkbox.
 */

import { NO_FIGURES, type IncomeReportOutcome } from "./incomeReport";
import { extractAllPostcodes, extractPostcode } from "./postcode";
import type { LeadType } from "./types";

/**
 * £3 a lead. One constant, read by the quote, the charge and the refund, so a
 * price change cannot land in two of the three.
 *
 * Flat — there is no VAT handling anywhere in this codebase and none here, so
 * "10 leads = £30" is literally what leaves the customer's account.
 */
export const LEAD_ANALYSIS_PRICE_PENCE = 300;

/**
 * The most leads one purchase may cover.
 *
 * Rejected rather than truncated, like the import cap it sits behind: quietly
 * analysing the first 200 of somebody's 500 leads is the kind of loss nobody
 * notices until they go looking for a property that was never run.
 */
export const MAX_ANALYSIS_ROWS = 200;

/**
 * Above this, send the customer to a hosted Stripe page instead of charging the
 * card on file.
 *
 * A £600 off-session charge nobody is present for is exactly the shape issuers
 * decline. Putting the cardholder in front of it turns a silent failure into a
 * 3-D Secure prompt they can answer.
 */
export const HOSTED_CHECKOUT_THRESHOLD_PENCE = 30_000;

/** Why a lead cannot be analysed — or `ok`, when it can. */
export type AnalysabilityCode =
  | "ok"
  | "no_address"
  | "no_postcode"
  | "ambiguous_postcode"
  | "no_bedrooms"
  | "bedrooms_out_of_range"
  | "already_analysed"
  /** Set by the server from the job tables, never by `analysability()`. */
  | "analysis_pending";

/** The fields `analysability` reads. Deliberately narrow so a form can pass one. */
export interface AnalysableLead {
  lead_type?: LeadType | null;
  address?: string | null;
  postcode?: string | null;
  bedrooms?: string | null;
  gross_annual_income?: number | null;
}

export interface Analysability {
  code: AnalysabilityCode;
  ok: boolean;
  /** The values that would be sent to the analyser, when `ok`. */
  input: { address: string; postcode: string; bedrooms: number } | null;
}

/**
 * Bedrooms, from whatever the sheet said.
 *
 * Mirrors the analyser's own parser rather than importing it: the two apps
 * deploy independently, and a shared package for one function would couple
 * their release cycles for no benefit. The behaviours that must match are
 * pinned by tests on both sides.
 *
 * "Studio" is 0, not null — a studio is a real property with a real bedroom
 * count, and the analyser accepts 0.
 */
export function parseBedrooms(value: string | number | null | undefined): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (/^studio$/i.test(text)) return 0;
  // The minus sign is deliberately inside the character class: "-1" must FAIL
  // validation below rather than silently become 1.
  const match = text.match(/^[-]?\d+(?:\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  if (!Number.isFinite(n)) return null;
  // "3.5 bed" is a listing quirk, not half a bedroom.
  return Math.trunc(n);
}

/**
 * Can the analyser price this property?
 *
 * The bar is exactly what `normaliseAnalysisInput` requires on the other side —
 * an address, a postcode, and bedrooms 0–10. Guests are derived there and
 * clamped, so they can never be the blocker.
 *
 * Note what is NOT checked: a name, an email, a phone. The analyser is sent the
 * property and nothing else, so a lead with no contact details at all is
 * perfectly analysable.
 */
export function analysability(lead: AnalysableLead): Analysability {
  const refuse = (code: AnalysabilityCode): Analysability => ({ code, ok: false, input: null });

  const address = (lead.address ?? "").trim();
  const explicitPostcode = (lead.postcode ?? "").trim();
  if (!address && !explicitPostcode) return refuse("no_address");

  // Two DIFFERENT postcodes in one cell is two properties, or a typo. Either
  // way, picking one and charging for it is guessing with somebody's money.
  const found = extractAllPostcodes(address);
  if (!explicitPostcode && found.length > 1) return refuse("ambiguous_postcode");

  const postcode = extractPostcode(explicitPostcode) ?? found[0] ?? null;
  if (!postcode) return refuse("no_postcode");
  if (!address) return refuse("no_address");

  const bedrooms = parseBedrooms(lead.bedrooms);
  if (bedrooms === null) return refuse("no_bedrooms");
  if (bedrooms < 0 || bedrooms > 10) return refuse("bedrooms_out_of_range");

  // Offered as a re-run rather than refused outright, so the customer decides.
  // Never charged silently — the caller has to ask for it explicitly.
  if (lead.gross_annual_income != null) {
    return { code: "already_analysed", ok: false, input: { address, postcode, bedrooms } };
  }

  return { code: "ok", ok: true, input: { address, postcode, bedrooms } };
}

/**
 * What a batch would cost, and which rows are in it.
 *
 * The count is derived from the leads themselves, never from a number the
 * browser sends — the client-proposes/server-re-derives discipline the import
 * commit already follows (§30.6).
 */
export function analysisQuote<T extends AnalysableLead & { id?: string }>(
  leads: T[]
): {
  eligible: T[];
  ineligible: Array<{ lead: T; code: AnalysabilityCode }>;
  amountPence: number;
} {
  const eligible: T[] = [];
  const ineligible: Array<{ lead: T; code: AnalysabilityCode }> = [];
  for (const lead of leads) {
    const verdict = analysability(lead);
    if (verdict.ok) eligible.push(lead);
    else ineligible.push({ lead, code: verdict.code });
  }
  return {
    eligible,
    ineligible,
    amountPence: eligible.length * LEAD_ANALYSIS_PRICE_PENCE,
  };
}

/** "£30" / "£4.50" — whole pounds stay whole, so a quote never reads "£30.00". */
export function formatPence(pence: number): string {
  return pence % 100 === 0 ? `£${pence / 100}` : `£${(pence / 100).toFixed(2)}`;
}

/**
 * How to format a spreadsheet so its leads can be analysed.
 *
 * ONE definition, rendered by the mapping screen and the purchase offer alike,
 * so the promise made in one place cannot drift from the other — the rule
 * `topupDeliveryNote()` already follows for the top-up wording.
 */
export const ANALYSIS_SHEET_HELP = {
  heading:
    "To run the figures, each lead needs a property address with its postcode, and a bedroom count.",
  intro:
    "Everything else on your sheet is optional — this is only what the analyser needs to price a property.",
  points: [
    {
      label: "Address",
      body: "The full property address. If the postcode is in the same cell, that is enough.",
    },
    {
      label: "Postcode",
      body:
        "If you keep the postcode in its own column, set that column to Postcode on the previous screen. A column headed “Postcode” is not an address column, so we will not find it there.",
    },
    {
      label: "Bedrooms",
      body: "A number from 0 to 10. “3”, “3 bed” and “Studio” all work — a studio counts as 0.",
    },
  ],
  footer:
    "We don’t need a name, an email or a phone number to run the figures — only the property.",
} as const;

/** Why one lead was left out, in words the customer can act on. */
export function describeIneligibility(code: AnalysabilityCode): string {
  switch (code) {
    case "no_address":
      return "No property address. Add the full address, including the postcode.";
    case "no_postcode":
      return "No postcode in the address. Add it to the address, or put it in its own column and set that column to Postcode.";
    case "ambiguous_postcode":
      return "Two different postcodes in one address. Leave the one the property is at.";
    case "no_bedrooms":
      return "No bedroom count. Add a number from 0 to 10 — “Studio” works too.";
    case "bedrooms_out_of_range":
      return "Bedrooms must be between 0 and 10.";
    case "already_analysed":
      return "Already has figures. You can re-run them from the lead itself.";
    case "analysis_pending":
      return "Already running — the figures will appear shortly.";
    case "ok":
      return "";
  }
}

// ─── The analyser's reply ─────────────────────────────────────────

/** The success body of POST /api/internal/analyse. Mirrored, not imported. */
export interface AnalyserFigures {
  gross_annual_income: number;
  net_annual_income: number;
  long_let_annual_income: number | null;
  avg_nightly_rate: number | null;
  occupancy_rate: number | null;
  platform_fee_pct: number;
  cleaning_fee_pct: number;
  management_fee_annual: number;
  monthly_revenue_profile: number[] | null;
  /**
   * ── The market block (0113) ──────────────────────────────────────────
   *
   * OPTIONAL, and that is load-bearing rather than lax. The analyser is a
   * separately deployed app: a build of it that predates these fields must go
   * on producing usable leads, so every one of them is "absent means the
   * document did not say", exactly as a missing figure in a PDF is.
   *
   * ⚠️ THE TWO SCORES RUN IN OPPOSITE DIRECTIONS — risk is 0 for LOW, direct
   * booking is 100 for best. Stored as stated; never normalised to agree.
   */
  market_occupancy_rate?: number | null;
  comp_set_size?: number | null;
  comp_set_radius_km?: number | null;
  comp_avg_rating?: number | null;
  comp_avg_review_count?: number | null;
  risk_score?: number | null;
  risk_label?: string | null;
  direct_booking_score?: number | null;
}

export interface AnalyserSuccess {
  ok: true;
  quality_ok: boolean;
  quality_reason: string | null;
  figures: AnalyserFigures;
}

/**
 * Turn the analyser's reply into the outcome the existing write path stores.
 *
 * This is the seam, and every guard below exists because the receiving columns
 * cannot catch these mistakes themselves:
 *
 *  - `occupancy_rate` is a WHOLE PERCENT here and a 0–1 FRACTION in the
 *    analyser. The column's CHECK is `>= 0 and <= 100`, so a lost `× 100`
 *    stores 0.63 without complaint, and the only visible symptom is that
 *    `incomeBasis()` silently switches to the comparable-set wording. The
 *    conversion happens on the analyser side; this asserts it happened.
 *  - `monthly_revenue_profile` has a `cardinality(...) = 12` CHECK. A short
 *    array does not fail that one column — it aborts the whole lead update.
 *  - a zero-length PDF is never a legitimate state, and a lead with no figures
 *    has no business carrying a "read the analysis" link.
 *
 * Returns `parsed` only when everything holds. Anything else is `unparsed`,
 * which is the status this codebase already reserves for "we read a document
 * and could not trust it" — permanent, not retried, and refundable.
 */
export function buildOutcomeFromAnalyserResponse(
  payload: AnalyserSuccess,
  pdfBytes: Uint8Array | null
): IncomeReportOutcome {
  const reject = (error: string): IncomeReportOutcome => ({
    status: "unparsed",
    ...NO_FIGURES,
    assetId: null,
    error,
  });

  if (!payload?.ok) return reject("Analyser reported a failed run");
  if (!payload.quality_ok) {
    // getShortLetData() swallows upstream failures and returns a plausible
    // SYNTHETIC figure. This is the flag that stops a customer paying for one.
    return reject(payload.quality_reason ?? "No trustworthy short-let data for this property");
  }

  const f = payload.figures;
  const gross = f?.gross_annual_income;
  if (typeof gross !== "number" || !Number.isFinite(gross) || gross <= 0) {
    return reject("Analyser returned no gross income");
  }

  const profile = f.monthly_revenue_profile;
  if (profile != null && (profile.length !== 12 || !profile.every(Number.isFinite))) {
    return reject("Monthly forecast was not twelve months");
  }

  // Both or neither, twice over — the same pairing rule the PDF parser applies:
  // a comp-set count says nothing without the radius it was found in, and a
  // risk score with no wording is a number a landlord cannot read.
  const compSetOk =
    inRange(f.comp_set_size, 0, 100_000) != null &&
    inRange(f.comp_set_radius_km, 0.001, 500) != null;
  const riskOk =
    inRange(f.risk_score, 0, 100) != null &&
    typeof f.risk_label === "string" &&
    f.risk_label.trim().length > 0;

  const occupancy = f.occupancy_rate;
  const rate = f.avg_nightly_rate;
  const pairOk =
    typeof occupancy === "number" &&
    Number.isInteger(occupancy) &&
    occupancy > 0 &&
    occupancy <= 100 &&
    typeof rate === "number" &&
    Number.isFinite(rate) &&
    rate > 0;

  if (!pdfBytes || pdfBytes.byteLength === 0) {
    return reject("Analyser returned no report document");
  }

  return {
    status: "parsed",
    grossAnnualIncome: Math.round(gross),
    // Both or neither — a nightly rate with no occupancy is a number the
    // operator cannot check (0091).
    avgNightlyRate: pairOk ? Math.round(rate as number) : null,
    occupancyRate: pairOk ? (occupancy as number) : null,
    netAnnualIncome: numberOrNull(f.net_annual_income),
    longLetAnnualIncome: numberOrNull(f.long_let_annual_income),
    platformFeePct: numberOrNull(f.platform_fee_pct),
    cleaningFeePct: numberOrNull(f.cleaning_fee_pct),
    monthlyRevenueProfile: profile ?? null,
    // The market block (0113). Range-guarded here rather than trusted, for the
    // same reason occupancy is asserted above: the receiving CHECK constraints
    // abort the WHOLE lead update on a bad value, so one out-of-range score
    // would cost the figures beside it. Out of range becomes null.
    marketOccupancyRate: inRange(f.market_occupancy_rate, 0, 100),
    compSetSize: compSetOk ? numberOrNull(f.comp_set_size) : null,
    compSetRadiusKm: compSetOk ? numberOrNull(f.comp_set_radius_km) : null,
    compAvgRating: inRange(f.comp_avg_rating, 0, 5),
    compAvgReviewCount: inRange(f.comp_avg_review_count, 0, 100_000),
    riskScore: riskOk ? inRange(f.risk_score, 0, 100) : null,
    riskLabel: riskOk ? String(f.risk_label).slice(0, 60) : null,
    directBookingScore: inRange(f.direct_booking_score, 0, 100),
    // Opaque Monday asset ids do not exist for a lead we analysed ourselves.
    assetId: null,
    error: null,
    bytes: pdfBytes,
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A number the receiving CHECK constraint will accept, or null. */
function inRange(value: unknown, min: number, max: number): number | null {
  const n = numberOrNull(value);
  return n != null && n >= min && n <= max ? n : null;
}
