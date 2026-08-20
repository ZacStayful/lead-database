/**
 * Reading the figures out of a Stayful property-analysis PDF: the projected
 * gross revenue (0089), and the nightly rate and occupancy behind it (0090).
 *
 * THE DOCUMENT NEVER REACHES A CUSTOMER. Nothing here stores or returns the
 * PDF, its URL, or any other figure it contains. The report is downloaded,
 * read for three numbers, and discarded.
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

/** The stated monthly must be the stated annual over twelve, within rounding. */
const MONTHLY_TOLERANCE = 0.02;
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
    const doc = await getDocumentProxy(bytes);
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
  assetId: string | null;
  error: string | null;
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
 * Every failure outcome carries the same empty figures. Spread rather than
 * repeated, so adding a fourth figure to the type cannot leave one branch
 * behind still reporting a stale value.
 */
const NO_FIGURES = {
  grossAnnualIncome: null,
  avgNightlyRate: null,
  occupancyRate: null,
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
  return { status: "parsed", ...parsed, assetId: asset.id, error: null };
}

/**
 * The `leads` patch for an outcome.
 *
 * Every figure is written on EVERY outcome, so a report that is replaced with
 * an unreadable one clears the old values rather than leaving stale numbers
 * attributed to a document that no longer states them.
 */
export function incomeReportPatch(
  outcome: IncomeReportOutcome
): Record<string, unknown> {
  return {
    gross_annual_income: outcome.grossAnnualIncome,
    avg_nightly_rate: outcome.avgNightlyRate,
    occupancy_rate: outcome.occupancyRate,
    income_report_status: outcome.status,
    income_report_asset_id: outcome.assetId,
    income_report_parsed_at: new Date().toISOString(),
    income_report_error: outcome.error,
  };
}
