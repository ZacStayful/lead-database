/**
 * When the next step of a follow-up sequence falls due (§40.13).
 *
 * PURE, for the reason sendWindow.ts states at length: `service.test.ts`'s
 * hand-rolled fake implements none of `.neq`, `.gte`, `.not`, `.order` or
 * `{ count: "exact", head: true }`, and a decision that needs no client is
 * testable in the good style without extending it. Cadence is the arithmetic
 * this feature is most likely to get quietly wrong, so it lives where it can be
 * pinned.
 *
 * ⚠️ CALENDAR DAYS, NOT WORKING DAYS. `businessTime.ts` is the wrong calendar
 * here for the reason §40.12 already gives about quiet hours: a landlord is a
 * CONSUMER, so a Saturday may land better than a Tuesday, and
 * `fetchUkBankHolidays()` makes a live gov.uk request that has no business
 * anywhere near a send decision.
 *
 * ⚠️ AND THE TIME OF DAY IS HELD IN LONDON WALL CLOCK, NOT IN MILLISECONDS.
 * Adding `days * 86_400_000` is right for 51 weeks of the year and wrong across
 * the last Sunday in March and October, when it moves the whole remaining ladder
 * by an hour. On a five-step sequence that starts as a 9am message and ends as
 * an 8am one — and 8am is outside sending hours, so the last step would be
 * silently deferred by quiet hours rather than sent when it was meant to be. The
 * zone database decides, never arithmetic.
 */

/** Europe/London calendar and clock fields for an instant. */
interface LondonParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const LONDON = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function londonParts(at: Date): LondonParts {
  const found: Record<string, string> = {};
  for (const part of LONDON.formatToParts(at)) {
    if (part.type !== "literal") found[part.type] = part.value;
  }
  return {
    year: Number(found.year),
    month: Number(found.month),
    day: Number(found.day),
    hour: Number(found.hour),
    minute: Number(found.minute),
    second: Number(found.second),
  };
}

/** How far Europe/London is from UTC at this instant, in milliseconds. */
function londonOffsetMs(at: Date): number {
  const p = londonParts(at);
  return (
    Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) -
    Math.floor(at.getTime() / 1000) * 1000
  );
}

/**
 * The instant at which the London wall clock reads these fields.
 *
 * Two passes, because the offset we need depends on the answer: guess with the
 * offset at the naive instant, then re-read the offset there and correct. That
 * converges for any zone whose transitions are smaller than a day, which
 * Europe/London's are. A wall-clock time that does not exist (01:30 on the
 * spring-forward Sunday) resolves to the instant just after the jump, which is
 * the behaviour anyone would want and, here, unreachable in practice — every
 * send is gated to 09:00–20:00 by §40.12 anyway.
 */
function fromLondonWallClock(p: LondonParts): Date {
  const naive = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  let guess = new Date(naive);
  for (let i = 0; i < 2; i += 1) {
    guess = new Date(naive - londonOffsetMs(guess));
  }
  return guess;
}

/**
 * `days` calendar days after `at`, keeping the London time of day.
 *
 * `days = 0` returns the same instant, which is what makes "message them as soon
 * as they are assigned" need no special case in the schema or the engine: it is
 * simply a first step with no delay.
 */
export function addCalendarDaysLondon(at: Date, days: number): Date {
  if (!Number.isFinite(days) || days === 0) return new Date(at.getTime());
  const p = londonParts(at);
  // Date.UTC normalises the rollover, so day 31 + 3 becomes the 3rd of the
  // following month without any month-length table here.
  const rolled = new Date(
    Date.UTC(p.year, p.month - 1, p.day + Math.trunc(days), p.hour, p.minute, p.second)
  );
  return fromLondonWallClock({
    year: rolled.getUTCFullYear(),
    month: rolled.getUTCMonth() + 1,
    day: rolled.getUTCDate(),
    hour: p.hour,
    minute: p.minute,
    second: p.second,
  });
}

/** A step, as far as the cadence is concerned. */
export interface CadenceStep {
  step_number: number;
  delay_days: number;
}

/**
 * When step `stepNumber` falls due, measured from `from` — enrolment for step 1,
 * the moment the previous step actually SENT for every step after.
 *
 * Measuring from the send rather than from the schedule is deliberate: a step
 * held back overnight by quiet hours, or by the daily cap, must push the rest of
 * the ladder along with it. Otherwise a backlog enrolled at the cap sends steps
 * 1 and 2 within hours of each other the moment the cap clears — the burst
 * profile that gets a WhatsApp number restricted.
 */
export function dueAtForStep(
  from: Date,
  steps: CadenceStep[],
  stepNumber: number
): Date | null {
  const step = steps.find((s) => s.step_number === stepNumber);
  if (!step) return null;
  return addCalendarDaysLondon(from, step.delay_days);
}

/** The next step number after `current`, or null when the ladder is finished. */
export function nextStepNumber(
  steps: CadenceStep[],
  current: number
): number | null {
  const remaining = steps
    .map((s) => s.step_number)
    .filter((n) => n > current)
    .sort((a, b) => a - b);
  return remaining.length > 0 ? remaining[0] : null;
}

/**
 * How many days a backlog will take to clear at the operator's own send cap.
 *
 * ⚠️ The enrolment confirmation MUST state this. `daily_send_cap` defaults to
 * 40; a three-step sequence over two hundred leads is six hundred messages,
 * which is fifteen days. An operator who enrols their whole book expecting it to
 * go out this afternoon has been misled by our silence, and the first they would
 * learn of it is a landlord ringing about a message sent a fortnight late.
 */
export function daysToClear(
  leadCount: number,
  stepCount: number,
  dailySendCap: number
): number {
  if (leadCount <= 0 || stepCount <= 0) return 0;
  const cap = dailySendCap > 0 ? dailySendCap : 40;
  return Math.ceil((leadCount * stepCount) / cap);
}
