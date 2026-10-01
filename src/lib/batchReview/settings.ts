/**
 * The batch-review switch, its three numbers, and the date arithmetic (§73).
 * Pure and import-free.
 *
 * ⚠️ The defaults here must equal the `fallback` values in
 * src/lib/messaging/adminSettings.ts, or the admin page shows a limit the cron
 * is not actually using. adminSettings.test.ts pins both.
 */

export const BATCH_REVIEW_SETTING_KEYS = [
  "batch_reviews_enabled",
  "batch_review_delay_days",
  "batch_review_reminder_days",
  "batch_review_token_days",
] as const;

export interface BatchReviewSettings {
  enabled: boolean;
  delayDays: number;
  reminderDays: number;
  tokenDays: number;
}

function int(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = raw == null ? NaN : Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

/** Fails to OFF: only the literal "true" enables sending. */
export function batchReviewSettingsFrom(config: Map<string, string>): BatchReviewSettings {
  return {
    enabled: config.get("batch_reviews_enabled") === "true",
    delayDays: int(config.get("batch_review_delay_days"), 7, 0, 21),
    reminderDays: int(config.get("batch_review_reminder_days"), 3, 1, 14),
    tokenDays: int(config.get("batch_review_token_days"), 30, 7, 90),
  };
}

/** YYYY-MM-DD plus n days, in plain calendar arithmetic (no time zone involved). */
export function addDaysIso(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "15 Sep" */
function shortDate(date: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(`${date}T00:00:00Z`)
  );
}

/**
 * "15 Sep – 14 Oct". The window is [start, end), so the label stops the day
 * BEFORE the reset date. A label ending on the reset date would claim a day
 * that belongs to the next batch.
 */
export function cycleLabel(cycleStart: string, cycleEnd: string): string {
  return `${shortDate(cycleStart)} – ${shortDate(addDaysIso(cycleEnd, -1))}`;
}

/** "15 October" — the date the next cycle's leads start. */
export function longDate(date: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", timeZone: "UTC" }).format(
    new Date(`${date}T00:00:00Z`)
  );
}

export type ReviewPhase = "shortfall" | "survey" | "reminder";

export interface ReviewTiming {
  cycle_end: string;
  delivered: number;
  survey_sent_at: string | null;
  reminder_sent_at: string | null;
  submitted_at: string | null;
  token_expires_at: string | null;
}

/** The shortfall email is only worth sending close to the reset. Older ones are skipped, never sent late. */
export const SHORTFALL_FRESH_DAYS = 3;

export function surveyDue(r: ReviewTiming, today: string, s: BatchReviewSettings): boolean {
  return (
    r.delivered > 0 &&
    r.survey_sent_at == null &&
    r.submitted_at == null &&
    addDaysIso(r.cycle_end, s.delayDays) <= today &&
    // A batch the customer could not answer for weeks reads as noise. Two
    // windows of delay is the latest a first survey still goes out.
    addDaysIso(r.cycle_end, s.delayDays * 2 + 7) > today
  );
}

export function reminderDue(r: ReviewTiming, now: Date, s: BatchReviewSettings): boolean {
  if (r.survey_sent_at == null || r.reminder_sent_at != null || r.submitted_at != null) return false;
  if (r.token_expires_at && new Date(r.token_expires_at).getTime() <= now.getTime()) return false;
  // By DATE, not by milliseconds. The cron runs once a day and its start time
  // drifts, so "72 hours to the millisecond" would miss by a few seconds and
  // slip the reminder a whole day.
  return addDaysIso(r.survey_sent_at.slice(0, 10), s.reminderDays) <= now.toISOString().slice(0, 10);
}

/** Shown on the dashboard while sent, unsubmitted and unexpired. */
export function reviewOpen(r: ReviewTiming, now: Date): boolean {
  if (r.survey_sent_at == null || r.submitted_at != null) return false;
  if (!r.token_expires_at) return false;
  return new Date(r.token_expires_at).getTime() > now.getTime();
}
