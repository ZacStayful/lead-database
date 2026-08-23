/**
 * Worked-lead conversion — the definitions, mirrored from 0097.
 *
 * The metric this supports: operators who actually take a lead into their
 * pipeline sign 13.2% of them, against 1.6% of everything delivered. Only 38 of
 * 311 delivered assignments ever got that far. The gap between those two
 * numbers is the whole argument, which is why nothing here ever returns one
 * without the other being available beside it.
 *
 * ⚠️ EVERY VALUE AND PREDICATE IN THIS FILE IS WRITTEN TWICE — here and in
 * `supabase/migrations/0097_worked_conversion.sql`. They are one definition and
 * must change together. The same arrangement §20 records for
 * `capture_operator_proof` duplicating `get_operator_proof`, and for the same
 * reason: the SQL cannot be called from a unit test and the TypeScript cannot
 * be called from the database.
 *
 * Admin-only for now. Nothing in this file is reachable from a customer
 * surface, and none of the 0097 functions is granted to `authenticated`.
 */

/** The pipeline stage every assignment starts at. Nothing below counts it as worked. */
const COLD = "cold";

/**
 * Has the operator advanced this lead out of cold into their own pipeline?
 *
 * The mirror of `public.assignment_worked_past_cold(text)`. Blank and null are
 * both false: neither can occur in `lead_assignments.pipeline_stage` (NOT NULL,
 * defaulted to 'cold', CHECK-constrained to ten known values) but this side is
 * fed from API rows where they can, and the two must agree on every input or
 * they are not one definition.
 */
export function isWorkedPastCold(stage: string | null | undefined): boolean {
  return typeof stage === "string" && stage.trim() !== "" && stage !== COLD;
}

/**
 * Days before a monthly cohort's rate means anything.
 *
 * Time from assignment to win across the five wins on record: 2, 2, 10, 22, 24.
 * Thirty covers the longest with headroom. Read raw and without this, the two
 * cohorts that exist say 19.0% then 5.9% — which reads as a collapse and is
 * almost entirely the second cohort being three weeks old.
 */
export const MATURITY_DAYS = 30;

const MS_PER_DAY = 86_400_000;

/**
 * Is every assignment in this cohort at least MATURITY_DAYS old?
 *
 * `newestAssignedAt` is the most recent assignment in the cohort, so the whole
 * cohort has had time to convert only once that one has. Inclusive at the
 * boundary — "at least 30 days old" includes exactly 30 — matching the `<=` in
 * 0097. A strict comparison would mature every cohort a day late, which is the
 * kind of off-by-one nobody ever notices in rendered output.
 */
export function isCohortMature(
  newestAssignedAt: string | Date | null | undefined,
  now: Date = new Date()
): boolean {
  if (newestAssignedAt == null) return false;
  const newest =
    newestAssignedAt instanceof Date
      ? newestAssignedAt
      : new Date(newestAssignedAt);
  if (Number.isNaN(newest.getTime())) return false;
  return now.getTime() - newest.getTime() >= MATURITY_DAYS * MS_PER_DAY;
}

/**
 * The sample floors below which a rate is not worth reading.
 *
 * An honesty flag, not a privacy gate — nothing here is published, so this is
 * about not quoting a rate off three rows rather than about anonymity. If this
 * ever does become customer-facing it needs §20's k-anonymity treatment as
 * well, which is a different and stricter question.
 */
export const WORKED_CONVERSION_FLOORS = {
  minWorked: 20,
  minWins: 3,
  minOperators: 3,
} as const;

/** Mirror of 0097's `thin` flag. */
export function isThinSample(row: {
  workedPastCold: number;
  won: number;
  operators: number;
}): boolean {
  return (
    row.workedPastCold < WORKED_CONVERSION_FLOORS.minWorked ||
    row.won < WORKED_CONVERSION_FLOORS.minWins ||
    row.operators < WORKED_CONVERSION_FLOORS.minOperators
  );
}

/**
 * A percentage, or null when there is nothing to divide by.
 *
 * Null rather than 0 throughout, because a suppressed or undefined rate
 * rendering as "0%" is the exact failure §10 named when it explained why
 * benchmarks are withheld rather than shown empty at launch.
 */
export function rate(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/** One row of `get_worked_conversion`. `cohortMonth` is null on the all-time total. */
export interface WorkedConversionRow {
  cohortMonth: string | null;
  delivered: number;
  contacted: number;
  workedPastCold: number;
  won: number;
  /** Null when `thin`, or when the denominator is zero. Never 0 as a stand-in. */
  winRateDelivered: number | null;
  winRateWorked: number | null;
  /** Distinct customers carrying a win in this cohort. */
  operators: number;
  mature: boolean;
  thin: boolean;
}

export interface WorkedConversion {
  unavailable: boolean;
  /** The all-time row (`cohortMonth === null`), or null if it could not be read. */
  total: WorkedConversionRow | null;
  /** Monthly cohorts, oldest first. */
  cohorts: WorkedConversionRow[];
  /** Wins whose recorded outcome is corroborated by notes or telemetry (0069). */
  corroboratedWins: number;
}
