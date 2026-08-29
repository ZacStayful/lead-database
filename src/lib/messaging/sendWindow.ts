/**
 * When a landlord may be messaged (§40.12).
 *
 * The existing send limits are about VOLUME and are per customer —
 * `daily_send_cap` and `min_send_interval_secs` (§40.10). Neither asks what
 * time it is, and 6 of the first 17 WhatsApps ever sent went out at 20:xx
 * London. A stranger messaging a member of the public at that hour is the
 * behaviour worth preventing whoever sends it.
 *
 * ⚠️ THIS IS THE FIRST TIME-OF-DAY HELPER IN THE CODEBASE. `businessTime.ts` is
 * date-granularity only — `ukDate`, and a module-private `ukWeekday` — and
 * nothing anywhere asked what HOUR it is in London. Follow its house style:
 * `Intl.DateTimeFormat` with an explicit timeZone, no date library, because
 * none is installed and one calendar implementation is enough.
 *
 * EVERYTHING HERE IS PURE. That is deliberate rather than tidy: `service.ts`
 * tests `assignmentSendable` with no fake client at all, while the hand-rolled
 * `fakeAdmin` in `service.test.ts` implements none of `.neq`, `.gte`, `.not`,
 * `.order`, `.limit` or `{ count: "exact", head: true }`. A pure decision is
 * testable in the good style without extending that fake — and `draft.test.ts`
 * records that the seam between two well-tested pieces is where the bug lives.
 *
 * SEVEN DAYS A WEEK, and no bank holidays. A landlord is a CONSUMER, not a
 * business: a Saturday morning may land better than a Tuesday one, so
 * `businessTime.ts`'s working-day calendar is the wrong question here. Its
 * `fetchUkBankHolidays()` also does a live gov.uk request with an 8s timeout,
 * which is fine in the batch crons that call it and not fine on the synchronous
 * path behind a Send button.
 */
import { ukDate } from "@/lib/businessTime";

/** The defaults, mirrored in 0120. A missing setting means these, not off. */
export const DEFAULT_QUIET_START_HOUR = 9;
export const DEFAULT_QUIET_END_HOUR = 20;

/** Hour of day (0–23) in Europe/London, whatever the server's own zone is. */
export function londonHour(at: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(at)
  );
}

/**
 * Inclusive of `startHour`, exclusive of `endHour` — so 9 and 20 mean a message
 * may go out at 09:00 and may not at 20:00.
 */
export function withinSendingHours(
  at: Date,
  startHour: number,
  endHour: number
): boolean {
  const hour = londonHour(at);
  return hour >= startHour && hour < endHour;
}

/**
 * The next instant sending is permitted. Returns `at` unchanged when it is
 * already inside the window.
 *
 * Steps forward an hour at a time and re-reads the London hour each time, so a
 * DST transition is handled by the zone database rather than by arithmetic. The
 * minute/second zeroing is done in UTC, which lands on the top of the London
 * hour too because Europe/London is always a whole number of hours from UTC —
 * true for this zone, and not a general property of time zones.
 */
export function nextWindowOpensAt(
  at: Date,
  startHour: number,
  endHour: number
): Date {
  if (withinSendingHours(at, startHour, endHour)) return at;

  const next = new Date(at.getTime());
  // Bounded so a nonsensical window (start >= end) cannot spin: 48 steps is two
  // days, and any sane window opens within one.
  for (let i = 0; i < 48; i += 1) {
    next.setUTCMinutes(0, 0, 0);
    next.setTime(next.getTime() + 60 * 60 * 1000);
    if (withinSendingHours(next, startHour, endHour)) return next;
  }
  return next;
}

/** "9am", "8pm", "midday", "midnight" — for a sentence, not a table. */
function hourLabel(hour: number): string {
  if (hour === 0) return "midnight";
  if (hour === 12) return "midday";
  return hour < 12 ? `${hour}am` : `${hour - 12}pm`;
}

/**
 * How the refusal names the time sending resumes: "9am" or "9am tomorrow".
 *
 * Safe to disclose, unlike the cooldown's equivalent — this is a fact about the
 * clock and about a Stayful rule, and says nothing about any other operator.
 */
export function describeNextWindow(
  at: Date,
  startHour: number,
  endHour: number
): string {
  const opensAt = nextWindowOpensAt(at, startHour, endHour);
  const label = hourLabel(londonHour(opensAt));
  return ukDate(opensAt) === ukDate(at) ? label : `${label} tomorrow`;
}
