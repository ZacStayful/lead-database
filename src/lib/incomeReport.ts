/**
 * Reading the figures out of a Stayful property-analysis PDF: the projected
 * gross revenue (0089), and the nightly rate and occupancy behind it (0090).
 *
 * THE DOCUMENT IS NOW KEPT (0092). It used to be downloaded, read for three
 * numbers and discarded; operators can now read the analysis their figures come
 * from. Nothing changes HERE, though — this file still only reads. It hands the
 * bytes back on the outcome and incomeReportStorage.ts decides what becomes of
 * them, so the parser keeps its no-Supabase-import rule and the two concerns
 * stay separable.
 *
 * The report's URL is still never stored. Monday's public_url is signed for an
 * hour, so a persisted copy would be dead before anyone clicked it.
 *
 * A MIS-PARSE MUST FAIL SILENT. A wrong income figure is worse than no figure,
 * because an operator prices a call on it — so the gross is published only when
 * the document corroborates it twice, and this never throws. The rate and
 * occupancy are reported as stated; whether they reconcile with the gross is a
 * question about wording, and belongs at render time.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ANCHORS LOOK BACK-TO-FRONT
 * ---------------------------------------------------------------------------
 * The headline block's LABELS are letter-spaced in the PDF's text layer and are
 * effectively unmatchable — "AVG NIGHTLY RATE" comes out as
 * `AVG N I G H T LY R AT E`, with the spacing irregular enough that a tolerant
 * pattern would be guesswork. The plain-rendered captions that FOLLOW each
 * value are not letter-spaced, so every anchor here reads the caption and
 * captures backwards:
 *
 *     ... AVG N I G H T LY R AT E £157 ADR across comp set
 *         O C C U PA N C Y R AT E 63% Market average 62% ...
 *
 * The gross figure escapes this only because the "Revenue Breakdown" table on a
 * later page prints it in ordinary title case, which is what GROSS_RE matches —
 * not the headline. Anchoring on the obvious label is the thing that does not
 * work here.
 */

/** Collapse a PDF's text layer to a single line of single-spaced text. */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function toNumber(raw: string): number {
  return Number(raw.replace(/,/g, ""));
}

/**
 * `Gross Revenue £36,112 £3,009`. Case-insensitive because the headline block
 * shouts it and the breakdown table title-cases it; the first match wins and
 * both carry the same pair.
 */
const GROSS_RE = /Gross\s+Revenue\s*£\s*([\d,]+)\s*£\s*([\d,]+)/i;

/**
 * The report's own fee line, used only to corroborate. Absent from some
 * layouts, which is fine — it is a guard, not a requirement.
 */
const FEE_RE = /Management\s+Fees\s*\(15%\)\s*£\s*([\d,]+)/i;

/**
 * `£157 ADR across comp set` — the property's average nightly rate. Anchored on
 * the caption, for the reason in the header.
 */
const NIGHTLY_RATE_RE = /£\s*([\d,]+)\s+ADR\s+across/i;

/**
 * `63% Market average 62%` — the first figure is the PROPERTY'S occupancy, the
 * second the market's. Only the first is captured: the market average is not
 * asked for, and one live report states it as 0% (no comparable listings
 * nearby) while its own figures are perfectly good, so nothing may depend on it.
 */
const OCCUPANCY_RE = /(\d+)\s*%\s+Market\s+average\s+(\d+)\s*%/i;

/**
 * The Short-Term Rental breakdown's bottom two rows, matched TOGETHER (0093).
 *
 * `NET ANNUAL REVENUE` appears TWICE in every report — once for the short-let
 * table and once for the long-let one directly below it — so matching it alone
 * is a coin toss that happens to land right today and would land wrong the day
 * the tables swap order. Anchoring through `Total Operating Costs`, which
 * appears only in the short-let table, makes the pair unambiguous and hands
 * back the costs figure that corroborates it.
 *
 * The headline block states the same number as `N E T R E V E N U E`, which is
 * letter-spaced and unmatchable — the reason this reads the table, as GROSS_RE
 * does.
 */
const NET_RE =
  /Total\s+Operating\s+Costs\s*\(\s*[\d.]+\s*%\s*\)\s*£\s*([\d,]+)\s*£\s*[\d,]+\s*NET\s+ANNUAL\s+REVENUE\s*£\s*([\d,]+)\s*£\s*([\d,]+)/i;

/**
 * `Platform Fees (15%) £12,489` and `Cleaning & Laundry (18%) £14,987`.
 *
 * These two DO come from the report where the management fee deliberately does
 * not: a platform's commission and what a clean costs are facts about the
 * market that apply to whoever runs the property, while the management fee is
 * the operator's own price and is theirs to set (§26).
 */
const PLATFORM_RE = /Platform\s+Fees\s*\(\s*([\d.]+)\s*%\s*\)\s*£\s*([\d,]+)/i;
const CLEANING_RE =
  /Cleaning\s*(?:&|and)\s*Laundry\s*\(\s*([\d.]+)\s*%\s*\)\s*£\s*([\d,]+)/i;

/**
 * `Gross Rental Income £26,940 £2,245` — the Long-Term Let table's top row, and
 * the only place that phrase appears.
 */
const LONG_LET_RE = /Gross\s+Rental\s+Income\s*£\s*([\d,]+)\s*£\s*([\d,]+)/i;

/**
 * ── The market, as the analysis states it (0113) ──────────────────────────
 *
 * These four anchors read PLAIN captions, not the letter-spaced headline
 * labels the header warns about: they live on the "Comparable Properties" and
 * "Local Demand & Risk" pages, which the report renders in ordinary type.
 *
 * ⚠️ The rating is printed as `4.8 ★`, and Helvetica has no star, so what
 * survives into the text layer varies. The pattern therefore stops at the
 * number and never asserts what follows it. `formatRating` prints an em dash
 * for an unrated comp set, which simply does not match — the right outcome.
 */
const COMP_SET_RE =
  /(\d[\d,]*)\s+active\s+Airbnb\s+listings\s+within\s+([\d.]+)\s*km/i;
const COMP_RATING_RE = /Avg\s+Rating\s*([\d.]+)/i;
const COMP_REVIEWS_RE = /Avg\s+Reviews\s*(\d[\d,]*)/i;
const DIRECT_BOOKING_RE = /Direct\s+Booking\s+Potential\s+Score:\s*(\d{1,3})\s*\/\s*100/i;
/**
 * `Low-Medium Risk · 38/100`.
 *
 * The paragraph above it explains the scale as "(0 = Low Risk, 100 = High
 * Risk)", which is why the separator class admits no comma: matching there
 * would read the explanation as the verdict.
 */
const RISK_RE = /(Low-Medium|Medium-High|Low|High|Medium)\s+Risk\s*[·.]?\s*(\d{1,3})\s*\/\s*100/i;

/**
 * The forecast table prints `January £3,142 +£1,122 100%` per row. Full month
 * names appear only there — the bar chart above it abbreviates to `Jan` — so
 * the name is a safe anchor and the order is read from the names rather than
 * from position.
 */
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** The stated monthly must be the stated annual over twelve, within rounding. */
const MONTHLY_TOLERANCE = 0.02;
/** A stated percentage must agree with the money printed beside it. */
const PCT_TOLERANCE = 0.01;
/** Gross minus the report's own total operating costs must be its net. */
const NET_TOLERANCE = 0.01;
/**
 * Twelve rounded monthlies against a rounded annual. Looser than the others
 * because twelve roundings accumulate, and it is still tight enough to reject a
 * curve that has picked up a row from another table.
 */
const PROFILE_SUM_TOLERANCE = 0.05;
/** The report's own fee line must agree with gross / 6.667. */
const FEE_TOLERANCE = 0.01;
const MANAGEMENT_FEE_DIVISOR = 6.667;

/** What a report yields. Nulls throughout mean "the document did not say". */
export interface ParsedIncomeReport {
  grossAnnualIncome: number;
  /** Null when absent or uncorroborated; the gross figure survives either way. */
  avgNightlyRate: number | null;
  /** The percentage as printed (63, not 0.63). Same null rule as the rate. */
  occupancyRate: number | null;
  /**
   * What the landlord keeps at STAYFUL'S fee structure. Never shown to anyone
   * (0093) — the presentation computes its own net from the operator's fee.
   * Kept because it corroborates the whole breakdown table.
   */
  netAnnualIncome: number | null;
  /** The Long-Term Let table's gross rent. */
  longLetAnnualIncome: number | null;
  /** Percentages as printed (15, not 0.15). */
  platformFeePct: number | null;
  cleaningFeePct: number | null;
  /** The twelve-month forecast, January first, or null. */
  monthlyRevenueProfile: number[] | null;
  /** What the analysis says about the market around it (0113). */
  marketOccupancyRate: number | null;
  compSetSize: number | null;
  compSetRadiusKm: number | null;
  compAvgRating: number | null;
  compAvgReviewCount: number | null;
  /** 0-100, and 0 is GOOD — the analyser scores risk, not quality. */
  riskScore: number | null;
  riskLabel: string | null;
  /** 0-100, and 100 is good. The opposite direction to riskScore. */
  directBookingScore: number | null;
}

/**
 * The figures the report states, or null if it does not state a gross revenue
 * we can trust.
 *
 * A null RETURN covers three different documents and the caller cannot tell
 * them apart, which is deliberate — all three mean "no figure": a legacy
 * third-party valuation with no such section, a current report whose format has
 * moved, and a corrupt download. The sweep records the status; only the
 * transient case is retried, and that is decided by whether this threw at the
 * fetch, not here.
 *
 * THE RATE AND OCCUPANCY FAIL ALONE. Gross is live on leads customers are
 * already reading; losing it because a nightly rate could not be read would
 * trade a working figure for a missing one. So they come back null and the
 * gross is published regardless.
 */
export async function parseIncomeReport(
  bytes: Uint8Array
): Promise<ParsedIncomeReport | null> {
  let flat: string;
  try {
    // Imported lazily so the parser is only pulled into a lambda that actually
    // reads a PDF — the ingest path reaches this on new leads only.
    const { extractText, getDocumentProxy } = await import("unpdf");
    // ⚠️ A COPY, NOT `bytes`. pdf.js takes ownership of the array it is given
    // and DETACHES its ArrayBuffer, so the caller's `bytes` comes back with
    // byteLength 0 once this returns. That silently uploaded 159 empty PDFs
    // (0092) — the figures parsed fine, because they are read before the
    // detach, and only the stored file was empty.
    //
    // The copy belongs HERE rather than at the call site: this function is the
    // destructive consumer, so not destroying its caller's data is its job, and
    // doing it here makes "parsing does not consume what you passed in" true
    // for every future caller instead of something each one has to remember.
    const doc = await getDocumentProxy(bytes.slice());
    const { text } = await extractText(doc, { mergePages: true });
    flat = flatten(Array.isArray(text) ? text.join(" ") : text);
  } catch (err) {
    // Message only, not the object: a legacy third-party valuation on an old
    // item takes this path routinely, and a stack trace per lead would bury the
    // failures that actually mean something.
    console.error(
      "parseIncomeReport: could not read PDF —",
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }

  const match = flat.match(GROSS_RE);
  if (!match) return null;

  const annual = toNumber(match[1]);
  const monthly = toNumber(match[2]);
  if (!Number.isFinite(annual) || annual <= 0) return null;

  // Cross-check 1 — the two figures on the same line must be the same figure.
  // This is what stops a match that has straddled two unrelated table cells:
  // any such pair fails the twelve-times relationship immediately.
  if (!Number.isFinite(monthly) || monthly <= 0) return null;
  const expectedMonthly = annual / 12;
  if (Math.abs(monthly - expectedMonthly) / expectedMonthly > MONTHLY_TOLERANCE) {
    console.error(
      `parseIncomeReport: monthly ${monthly} does not match annual ${annual} / 12`
    );
    return null;
  }

  // Cross-check 2 — where the report states its own management fee, it must be
  // the fee we are about to show. If the analyser ever changes what it means by
  // gross, this is the line that catches it rather than the customer.
  const fee = flat.match(FEE_RE);
  if (fee) {
    const stated = toNumber(fee[1]);
    const expected = annual / MANAGEMENT_FEE_DIVISOR;
    if (
      !Number.isFinite(stated) ||
      Math.abs(stated - expected) / expected > FEE_TOLERANCE
    ) {
      console.error(
        `parseIncomeReport: stated fee ${stated} does not match gross ${annual} / ${MANAGEMENT_FEE_DIVISOR}`
      );
      return null;
    }
  }

  return {
    grossAnnualIncome: annual,
    ...parseRateAndOccupancy(flat),
    ...parsePresentationFigures(flat, annual),
    ...parseMarketFigures(flat),
  };
}

/**
 * The nightly rate and occupancy the report states.
 *
 * WHAT THIS DOES NOT DO IS CHECK THE ARITHMETIC. It used to: the pair was
 * dropped unless `rate × 365 × occupancy` reproduced the gross within 2%. That
 * hid the figures on 12 of 149 live leads, and it was the wrong place for the
 * test — the report states these numbers whether or not they multiply out, and
 * "the report says X" is a different claim from "the gross was derived from X".
 * `incomeBasis()` in incomeProjection.ts now makes that distinction at render
 * time, which is where the wording lives. See §25.
 *
 * The identity was never the primary defence against reading the WRONG pair
 * either. The "Comparable Properties" page prints `Avg Nightly Rate` and
 * `Avg Occupancy`; the anchors here are `ADR across` and `Market average`,
 * which appear only in the headline block and cannot match it.
 *
 * Both or neither: a rate without the occupancy it was measured at is not a
 * fact an operator can use.
 */
function parseRateAndOccupancy(
  flat: string
): Pick<ParsedIncomeReport, "avgNightlyRate" | "occupancyRate"> {
  const none = { avgNightlyRate: null, occupancyRate: null };

  const rateMatch = flat.match(NIGHTLY_RATE_RE);
  const occMatch = flat.match(OCCUPANCY_RE);
  if (!rateMatch || !occMatch) return none;

  const rate = toNumber(rateMatch[1]);
  const occupancy = toNumber(occMatch[1]);
  if (!Number.isFinite(rate) || rate <= 0) return none;
  // 0% is a real value the report prints for the MARKET average when there are
  // no comparable listings; it is never the property's own projected occupancy,
  // and a zero here would render "at 0% occupancy" beside a five-figure gross.
  if (!Number.isFinite(occupancy) || occupancy <= 0 || occupancy > 100) return none;

  return { avgNightlyRate: rate, occupancyRate: occupancy };
}

/**
 * Everything else the report states, for the tailored presentation (0093).
 *
 * FIVE FIGURES THAT FAIL INDEPENDENTLY, and independently of the gross. Each is
 * dropped on its own if it cannot be corroborated, and none of them can fail the
 * parse: a lead whose platform-fee percentage could not be read still shows the
 * income figures 149 leads are already live with, and its presentation simply
 * falls back to the tool's own default for that one field.
 *
 * `p_gross` is passed in rather than re-matched because every cross-check here
 * is against it, and re-reading it would let two branches disagree about which
 * gross they were checking.
 */
function parsePresentationFigures(
  flat: string,
  gross: number
): Pick<
  ParsedIncomeReport,
  | "netAnnualIncome"
  | "longLetAnnualIncome"
  | "platformFeePct"
  | "cleaningFeePct"
  | "monthlyRevenueProfile"
> {
  const netAnnualIncome = parseNet(flat, gross);
  return {
    netAnnualIncome,
    longLetAnnualIncome: parseLongLet(flat),
    platformFeePct: parsePctLine(flat, PLATFORM_RE, gross, "platform"),
    cleaningFeePct: parsePctLine(flat, CLEANING_RE, gross, "cleaning"),
    // The forecast is checked against the NET, not the gross — it is a table of
    // net monthlies — so it can only be trusted when the net was.
    monthlyRevenueProfile: parseMonthlyProfile(flat, netAnnualIncome),
  };
}

/**
 * What the analysis says about the market (0113).
 *
 * EVERY FIGURE HERE FAILS ON ITS OWN. There is no cross-check to run — unlike
 * the money figures, none of these has a second printing to agree with, and
 * inventing an arithmetic relationship between them would be inventing the
 * thing this section exists not to invent. What guards them instead is RANGE:
 * a rating outside 0-5 or a score outside 0-100 is a match that has wandered
 * into another number, and is dropped rather than stored.
 *
 * ⚠️ THE TWO SCORES RUN IN OPPOSITE DIRECTIONS. `riskScore` is 0 for LOW risk;
 * `directBookingScore` is 100 for the best. They are stored exactly as printed
 * and the presentation words each accordingly — normalising one to match the
 * other here would silently invert a number an operator reads aloud.
 *
 * Exported for its tests. It takes the FLATTENED text layer rather than bytes,
 * which is what lets the anchors be exercised as pure units — no PDF, no
 * network, so they can sit in the suite that gates the build.
 */
export function parseMarketFigures(
  flat: string
): Pick<
  ParsedIncomeReport,
  | "marketOccupancyRate"
  | "compSetSize"
  | "compSetRadiusKm"
  | "compAvgRating"
  | "compAvgReviewCount"
  | "riskScore"
  | "riskLabel"
  | "directBookingScore"
> {
  const compSet = flat.match(COMP_SET_RE);
  const rating = flat.match(COMP_RATING_RE);
  const reviews = flat.match(COMP_REVIEWS_RE);
  const risk = flat.match(RISK_RE);
  const direct = flat.match(DIRECT_BOOKING_RE);
  const occ = flat.match(OCCUPANCY_RE);

  const inRange = (value: number, min: number, max: number): number | null =>
    Number.isFinite(value) && value >= min && value <= max ? value : null;

  const size = compSet ? inRange(toNumber(compSet[1]), 0, 100000) : null;
  const radius = compSet ? inRange(Number(compSet[2]), 0.001, 500) : null;

  return {
    // The market's average occupancy, which OCCUPANCY_RE has captured and
    // discarded since 0090. 0 is kept: it means no comparable listings nearby,
    // which is a fact about the market rather than a failed read.
    marketOccupancyRate: occ ? inRange(toNumber(occ[2]), 0, 100) : null,
    // Both or neither: a comp-set size with no radius does not say how hard the
    // analyser had to look for it, and a radius with no count says less still.
    compSetSize: size != null && radius != null ? size : null,
    compSetRadiusKm: size != null && radius != null ? radius : null,
    compAvgRating: rating ? inRange(Number(rating[1]), 0, 5) : null,
    compAvgReviewCount: reviews ? inRange(toNumber(reviews[1]), 0, 100000) : null,
    // Both or neither again, for a different reason: "38/100" with no wording
    // beside it is a number a landlord cannot read, and the wording without the
    // number is a claim with nothing behind it.
    riskScore: risk ? inRange(Number(risk[2]), 0, 100) : null,
    riskLabel: risk && inRange(Number(risk[2]), 0, 100) != null ? `${risk[1]} Risk` : null,
    directBookingScore: direct ? inRange(Number(direct[1]), 0, 100) : null,
  };
}

/**
 * The short-let table's net, corroborated twice: the printed monthly must be
 * the printed annual over twelve, and `gross - total operating costs` must
 * reproduce it. The second is the strong one — it says the whole breakdown
 * table was read coherently rather than a match having straddled two unrelated
 * cells.
 */
function parseNet(flat: string, gross: number): number | null {
  const m = flat.match(NET_RE);
  if (!m) return null;

  const costs = toNumber(m[1]);
  const annual = toNumber(m[2]);
  const monthly = toNumber(m[3]);
  if (!Number.isFinite(annual) || annual <= 0) return null;
  if (!Number.isFinite(monthly) || monthly <= 0) return null;
  if (!Number.isFinite(costs) || costs <= 0) return null;

  const expectedMonthly = annual / 12;
  if (Math.abs(monthly - expectedMonthly) / expectedMonthly > MONTHLY_TOLERANCE) {
    console.error(`parseNet: monthly ${monthly} does not match annual ${annual} / 12`);
    return null;
  }
  // A net at or above gross is not a net; it is a match on the wrong table.
  if (annual >= gross) {
    console.error(`parseNet: net ${annual} is not below gross ${gross}`);
    return null;
  }
  if (Math.abs(gross - costs - annual) / annual > NET_TOLERANCE) {
    console.error(`parseNet: gross ${gross} - costs ${costs} does not give net ${annual}`);
    return null;
  }
  return annual;
}

/** The long-let table's gross rent, corroborated by its own monthly. */
function parseLongLet(flat: string): number | null {
  const m = flat.match(LONG_LET_RE);
  if (!m) return null;
  const annual = toNumber(m[1]);
  const monthly = toNumber(m[2]);
  if (!Number.isFinite(annual) || annual <= 0) return null;
  if (!Number.isFinite(monthly) || monthly <= 0) return null;
  const expectedMonthly = annual / 12;
  if (Math.abs(monthly - expectedMonthly) / expectedMonthly > MONTHLY_TOLERANCE) {
    console.error(`parseLongLet: monthly ${monthly} does not match annual ${annual} / 12`);
    return null;
  }
  return annual;
}

/**
 * A `(15%) £12,489` cost line. The percentage is what we want; the money beside
 * it is what proves we read the right line, because a percentage on its own is
 * two characters and could come from anywhere in the document.
 */
function parsePctLine(
  flat: string,
  re: RegExp,
  gross: number,
  label: string
): number | null {
  const m = flat.match(re);
  if (!m) return null;
  const pct = Number(m[1]);
  const money = toNumber(m[2]);
  if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) return null;
  if (!Number.isFinite(money) || money <= 0) return null;
  const expected = (gross * pct) / 100;
  if (Math.abs(money - expected) / expected > PCT_TOLERANCE) {
    console.error(`parsePctLine(${label}): ${money} is not ${pct}% of ${gross}`);
    return null;
  }
  return pct;
}

/**
 * The twelve-month forecast, in calendar order.
 *
 * ALL TWELVE OR NOTHING. A partial forecast is not a seasonal curve, and a
 * shape built from nine months would misprice a season silently. The sum is
 * checked against the report's own net, which is what catches a row picked up
 * from a neighbouring table.
 */
function parseMonthlyProfile(flat: string, net: number | null): number[] | null {
  if (net == null) return null;

  const months: number[] = [];
  for (const name of MONTH_NAMES) {
    // Anchored on the SECOND £ — the "vs long-let" column — so a month named
    // anywhere else in the document cannot match. Its sign is optional on
    // purpose: the report prints "+£75" for a gain but a NEGATIVE delta comes
    // through the text layer as a bare "£545", the minus glyph having been
    // dropped. Requiring the sign silently lost the forecast on every property
    // that underperforms a long let in any single month — 11 of 24 live
    // reports, which is exactly the population where the seasonal curve is
    // most worth showing.
    const m = flat.match(
      new RegExp(`${name}\\s*£\\s*([\\d,]+)\\s*[+\\-\\u2212]?\\s*£`, "i")
    );
    if (!m) return null;
    const value = toNumber(m[1]);
    if (!Number.isFinite(value) || value <= 0) return null;
    months.push(value);
  }

  const sum = months.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - net) / net > PROFILE_SUM_TOLERANCE) {
    console.error(`parseMonthlyProfile: months sum to ${sum}, net is ${net}`);
    return null;
  }
  return months;
}

// ---------------------------------------------------------------------------
// Fetching a report and turning the outcome into columns.
//
// Shared by ingest (new leads, inline) and /api/cron/parse-income-reports (the
// backlog and retries), so the two can never disagree about what a given
// outcome means. No Supabase import here on purpose: this returns a patch, the
// callers own their own writes.
// ---------------------------------------------------------------------------

export type IncomeReportStatus =
  | "pending"
  | "parsed"
  | "no_report"
  | "unparsed"
  | "failed";

export interface IncomeReportOutcome {
  status: IncomeReportStatus;
  grossAnnualIncome: number | null;
  avgNightlyRate: number | null;
  occupancyRate: number | null;
  /** The presentation figures (0093). Same fail-alone rule as the two above. */
  netAnnualIncome: number | null;
  longLetAnnualIncome: number | null;
  platformFeePct: number | null;
  cleaningFeePct: number | null;
  monthlyRevenueProfile: number[] | null;
  /** The market block (0113). Same fail-alone rule again. */
  marketOccupancyRate: number | null;
  compSetSize: number | null;
  compSetRadiusKm: number | null;
  compAvgRating: number | null;
  compAvgReviewCount: number | null;
  riskScore: number | null;
  riskLabel: string | null;
  directBookingScore: number | null;
  assetId: string | null;
  error: string | null;
  /**
   * The report itself, on a `parsed` outcome only.
   *
   * NOT A COLUMN. `incomeReportPatch()` never reads it; it is here so the
   * caller can hand the bytes to `syncStoredReport()` without downloading the
   * same document twice. Null on every other outcome — a report we could not
   * read is not one to keep (0092).
   */
  bytes: Uint8Array | null;
}

/** Matches the lead-files ceiling; an analysis is ~25 KB, so this is a bound on nonsense. */
const MAX_REPORT_BYTES = 25 * 1024 * 1024;

/** Matches MONDAY_TIMEOUT_MS. The money path must never wait longer than this. */
const DOWNLOAD_TIMEOUT_MS = 8000;

/**
 * Download a report and read its gross figure.
 *
 * NEVER THROWS. A lead with no income figure is a lead that looks the way every
 * lead looked last week; a lead that failed to ingest is a landlord nobody
 * rings. Every failure becomes a status.
 *
 * `failed` is the only outcome the sweep retries, and it is reserved for things
 * that might work next time — an unreachable host, a truncated download. A PDF
 * we read and could not trust is `unparsed`, which is a permanent fact about
 * that document and is not retried.
 */
/**
 * Every failure outcome carries the same empty figures, and no bytes. Spread
 * rather than repeated, so adding a fourth figure to the type cannot leave one
 * branch behind still reporting a stale value.
 *
 * Exported because there is now a SECOND producer of IncomeReportOutcome —
 * src/lib/leadAnalysis.ts, which builds one from the analyser's JSON rather
 * than from a Monday PDF. It must share this constant for exactly the reason
 * above: a figure added here has to reach both producers or one of them starts
 * quietly reporting stale values.
 *
 * `bytes` belongs here for the same reason: a branch that forgot to null it
 * would hand a truncated or unreadable download to the storage layer.
 */
export const NO_FIGURES = {
  grossAnnualIncome: null,
  avgNightlyRate: null,
  occupancyRate: null,
  netAnnualIncome: null,
  longLetAnnualIncome: null,
  platformFeePct: null,
  cleaningFeePct: null,
  monthlyRevenueProfile: null,
  marketOccupancyRate: null,
  compSetSize: null,
  compSetRadiusKm: null,
  compAvgRating: null,
  compAvgReviewCount: null,
  riskScore: null,
  riskLabel: null,
  directBookingScore: null,
  bytes: null,
} as const;

export async function resolveIncomeReport(
  asset: { id: string; public_url: string } | null,
  timeoutMs: number = DOWNLOAD_TIMEOUT_MS
): Promise<IncomeReportOutcome> {
  if (!asset?.public_url) {
    return { status: "no_report", ...NO_FIGURES, assetId: null, error: null };
  }

  let bytes: Uint8Array;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(asset.public_url, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        status: "failed",
        ...NO_FIGURES,
        assetId: asset.id,
        error: `Report download HTTP ${res.status}`,
      };
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_REPORT_BYTES) {
      return {
        status: "unparsed",
        ...NO_FIGURES,
        assetId: asset.id,
        error: `Report is ${buf.byteLength} bytes, over the ${MAX_REPORT_BYTES} limit`,
      };
    }
    bytes = new Uint8Array(buf);
  } catch (err) {
    return {
      status: "failed",
      ...NO_FIGURES,
      assetId: asset.id,
      error: err instanceof Error ? err.message : "Report download failed",
    };
  } finally {
    clearTimeout(timer);
  }

  const parsed = await parseIncomeReport(bytes);
  if (parsed == null) {
    return {
      status: "unparsed",
      ...NO_FIGURES,
      assetId: asset.id,
      error: "No trustworthy gross revenue figure in the report",
    };
  }

  // `parsed` is only ever reached with a gross figure; the rate and occupancy
  // may legitimately be null and that is not an unparsed report.
  return { status: "parsed", ...parsed, assetId: asset.id, error: null, bytes };
}

/**
 * The `leads` patch for an outcome.
 *
 * Every figure is written on EVERY outcome, so a report that is replaced with
 * an unreadable one clears the old values rather than leaving stale numbers
 * attributed to a document that no longer states them.
 */
/**
 * ONLY the presentation figures 0093 added, for backfilling a lead that already
 * has its income block.
 *
 * ⚠️ THIS IS NOT `incomeReportPatch()` AND MUST NEVER BECOME IT. That function
 * writes `gross_annual_income`, `avg_nightly_rate` and `occupancy_rate` as well,
 * which is right when a lead is being read for the first time and wrong when it
 * already has them: 159 leads are live with a gross figure customers can see,
 * and re-writing it from a re-read would let a report that has since been moved
 * or deleted on Monday BLANK a working figure. Trading something that works for
 * nothing is the one thing §25 says never to do.
 *
 * So the backfill pass this exists for MAY ONLY ADD. It never writes a column
 * that already has a value, and it returns an empty patch unless the re-read
 * actually produced something.
 */
export function presentationFiguresPatch(
  outcome: IncomeReportOutcome
): Record<string, unknown> {
  if (outcome.status !== "parsed") return {};
  const patch: Record<string, unknown> = {};
  if (outcome.netAnnualIncome != null) patch.net_annual_income = outcome.netAnnualIncome;
  if (outcome.longLetAnnualIncome != null)
    patch.long_let_annual_income = outcome.longLetAnnualIncome;
  if (outcome.platformFeePct != null) patch.platform_fee_pct = outcome.platformFeePct;
  if (outcome.cleaningFeePct != null) patch.cleaning_fee_pct = outcome.cleaningFeePct;
  if (outcome.monthlyRevenueProfile != null)
    patch.monthly_revenue_profile = outcome.monthlyRevenueProfile;
  // The market block (0113), under the same add-only rule as everything above.
  if (outcome.marketOccupancyRate != null)
    patch.market_occupancy_rate = outcome.marketOccupancyRate;
  if (outcome.compSetSize != null) patch.comp_set_size = outcome.compSetSize;
  if (outcome.compSetRadiusKm != null) patch.comp_set_radius_km = outcome.compSetRadiusKm;
  if (outcome.compAvgRating != null) patch.comp_avg_rating = outcome.compAvgRating;
  if (outcome.compAvgReviewCount != null)
    patch.comp_avg_review_count = outcome.compAvgReviewCount;
  if (outcome.riskScore != null) patch.risk_score = outcome.riskScore;
  if (outcome.riskLabel != null) patch.risk_label = outcome.riskLabel;
  if (outcome.directBookingScore != null)
    patch.direct_booking_score = outcome.directBookingScore;
  return patch;
}

export function incomeReportPatch(
  outcome: IncomeReportOutcome
): Record<string, unknown> {
  return {
    gross_annual_income: outcome.grossAnnualIncome,
    avg_nightly_rate: outcome.avgNightlyRate,
    occupancy_rate: outcome.occupancyRate,
    net_annual_income: outcome.netAnnualIncome,
    long_let_annual_income: outcome.longLetAnnualIncome,
    platform_fee_pct: outcome.platformFeePct,
    cleaning_fee_pct: outcome.cleaningFeePct,
    monthly_revenue_profile: outcome.monthlyRevenueProfile,
    market_occupancy_rate: outcome.marketOccupancyRate,
    comp_set_size: outcome.compSetSize,
    comp_set_radius_km: outcome.compSetRadiusKm,
    comp_avg_rating: outcome.compAvgRating,
    comp_avg_review_count: outcome.compAvgReviewCount,
    risk_score: outcome.riskScore,
    risk_label: outcome.riskLabel,
    direct_booking_score: outcome.directBookingScore,
    income_report_status: outcome.status,
    income_report_asset_id: outcome.assetId,
    income_report_parsed_at: new Date().toISOString(),
    income_report_error: outcome.error,
  };
}
