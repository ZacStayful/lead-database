/**
 * UK business-day arithmetic, shared by the scheduled jobs.
 *
 * The bank-holiday fetch previously lived inline in the inactivity-nudge cron.
 * It is extracted here because the reclaim cron needs the same calendar, and
 * two copies of "when is the UK closed" would eventually disagree — which for
 * reclaim means taking a lead off an operator on a day they were never working.
 */

// gov.uk bank holidays API (division-specific endpoint, returning a
// { division, events: [{ title, date, notes, bunting }] } object).
// Docs: https://www.gov.uk/bank-holidays — the .json feeds are the documented API.
const BANK_HOLIDAY_URL =
  "https://www.gov.uk/bank-holidays/england-and-wales.json";
const BANK_HOLIDAY_TIMEOUT_MS = 8000;

/** Today's date (YYYY-MM-DD) in UK local time — en-CA formats as ISO date. */
export function ukDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
  }).format(d);
}

/** Day of week (0 = Sunday … 6 = Saturday) in UK local time. */
function ukWeekday(d: Date): number {
  const name = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
  }).format(d);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
}

/**
 * Every England & Wales bank holiday date the gov.uk feed knows about, as a set
 * of YYYY-MM-DD strings.
 *
 * FAILS OPEN: any network error, timeout or non-200 returns an EMPTY set, so an
 * outage degrades to "weekends only" rather than halting the job. The fall-open
 * is logged.
 *
 * Note the asymmetry this creates and why it is the right way round: for the
 * nudge, failing open means a nudge may go out on a bank holiday. For reclaim,
 * it means a lead could be reclaimed up to a day earlier than intended. Both are
 * mild; the alternative — treating a fetch failure as "no business days have
 * passed" — would silently freeze reclaim entirely for as long as gov.uk was
 * down, which is far worse because nothing would look broken.
 */
export async function fetchUkBankHolidays(): Promise<Set<string>> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BANK_HOLIDAY_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(BANK_HOLIDAY_URL, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      console.warn(
        `[businessTime] bank-holiday fetch HTTP ${res.status}; failing open`
      );
      return new Set();
    }
    const data = (await res.json()) as { events?: { date: string }[] };
    return new Set((data.events ?? []).map((e) => e.date));
  } catch (err) {
    console.warn("[businessTime] bank-holiday fetch errored; failing open", err);
    return new Set();
  }
}

/** True if the given instant falls on a UK working day (Mon–Fri, not a bank holiday). */
export function isBusinessDay(d: Date, holidays: Set<string>): boolean {
  const dow = ukWeekday(d);
  if (dow === 0 || dow === 6) return false;
  return !holidays.has(ukDate(d));
}

/** True if today (UK date) is an England & Wales bank holiday. */
export function isBankHoliday(d: Date, holidays: Set<string>): boolean {
  return holidays.has(ukDate(d));
}

/**
 * The instant `days` business days after `start`, preserving the time of day.
 *
 * Walks forward one calendar day at a time and only counts days that are
 * working days, so a run of weekend/holiday dates simply does not advance the
 * counter. The START day is never counted — an assignment made at 18:00 on
 * Friday has not consumed any of Friday.
 *
 * Worked example (the case that motivated business days at all):
 *
 *   Friday 18:00 + 3 business days
 *     Sat  — not counted
 *     Sun  — not counted
 *     Mon  — 1
 *     Tue  — 2
 *     Wed  — 3   -> Wednesday 18:00
 *
 * so a lead delivered on Friday evening is never reclaimed over the weekend,
 * and the operator gets three genuine working days to act. If the Monday is a
 * bank holiday the deadline slides to Thursday, automatically.
 */
export function addBusinessDays(
  start: Date,
  days: number,
  holidays: Set<string>
): Date {
  const result = new Date(start.getTime());
  let remaining = days;
  // Bounded so a pathological holiday set can never spin forever.
  let guard = 0;
  while (remaining > 0 && guard < 400) {
    result.setUTCDate(result.getUTCDate() + 1);
    if (isBusinessDay(result, holidays)) remaining -= 1;
    guard += 1;
  }
  return result;
}

/**
 * Whether `days` business days have fully elapsed between `start` and `now`.
 * The comparison instant is passed in rather than read from the clock so the
 * caller can use one consistent "now" across a whole batch.
 */
export function businessDaysElapsed(
  start: Date,
  days: number,
  now: Date,
  holidays: Set<string>
): boolean {
  return addBusinessDays(start, days, holidays).getTime() <= now.getTime();
}
