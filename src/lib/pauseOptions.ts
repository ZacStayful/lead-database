/**
 * The durations a customer may pause for, and the reasons they may give.
 *
 * Kept in lib rather than beside the route because a Next.js route file may only
 * export route handlers and config — exporting constants from there fails the
 * build's route-type check. The UI and the route both read them from here, so
 * the list and its copy cannot drift apart. Same placement, and same reason, as
 * src/lib/closeReasons.ts.
 *
 * ⚠️ These values must match the CHECK constraint in
 * supabase/migrations/0077_pause_reasons_and_capacity.sql
 * character-for-character. Nothing enforces that mechanically; a mismatch shows
 * up as a 500 on submit, not as a build error.
 */

export const PAUSE_REASONS = {
  too_expensive: "Too expensive at the moment",
  not_enough_leads: "Not receiving enough leads",
  lead_quality: "The leads weren't the right fit",
  at_capacity: "Too busy — at capacity right now",
  seasonal: "Seasonal or quiet period",
  other: "Something else",
} as const;

export type PauseReason = keyof typeof PAUSE_REASONS;

/**
 * The sentinel written by 0077's backfill for customers who were already paused
 * when reason capture shipped.
 *
 * Deliberately not one of PAUSE_REASONS: it is never offered in the UI and never
 * accepted from a request, so "we never asked" stays visibly distinct from "they
 * told us" the moment anyone counts reasons.
 */
export const PAUSE_REASON_UNKNOWN = "unknown_pre_0077";

/** Narrow untrusted input to a valid, customer-selectable pause reason. */
export function isPauseReason(value: unknown): value is PauseReason {
  return typeof value === "string" && value in PAUSE_REASONS;
}

/** Narrow an untrusted array to a non-empty list of valid reasons. */
export function isPauseReasonList(value: unknown): value is PauseReason[] {
  return Array.isArray(value) && value.length > 0 && value.every(isPauseReason);
}

/**
 * Human label for a stored reason, including the backfill sentinel, which the
 * admin surfaces have to render even though no customer can choose it.
 */
export function pauseReasonLabel(value: string): string {
  if (value === PAUSE_REASON_UNKNOWN) return "Not recorded (paused before we asked)";
  return isPauseReason(value) ? PAUSE_REASONS[value] : value;
}

export const PAUSE_MONTHS_OPTIONS = [1, 2, 3] as const;
export type PauseMonths = (typeof PAUSE_MONTHS_OPTIONS)[number];

export function isPauseMonths(value: unknown): value is PauseMonths {
  return (
    typeof value === "number" &&
    (PAUSE_MONTHS_OPTIONS as readonly number[]).includes(value)
  );
}

export function pauseMonthsLabel(months: number): string {
  return months === 1 ? "1 month" : `${months} months`;
}

/** Spelt-out duration for email prose ("paused for two months"). */
export function pauseMonthsWords(months: number): string {
  return months === 1 ? "one month" : months === 2 ? "two months" : "three months";
}

export const PAUSE_NOTE_MAX_LENGTH = 500;
