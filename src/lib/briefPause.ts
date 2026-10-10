import { londonOffsetMs } from "@/lib/importedLeadMonths";

/**
 * A Lead Brief customer's pause (batch 04 Phase 2). PURE, and safe in a
 * client component: the pause card and the pause route both read this, so the
 * date the card shows is the date the route stores.
 *
 * Locked decisions (docs/build/04-area-changes-pause-topups.md):
 *   2. A pause of up to 4 weeks keeps the area exactly as it is.
 *   3. A longer pause (up to the existing maximum, 3 months) releases the area
 *      at once; the return date is fixed when they pause; the area is
 *      recalculated 7 days before return.
 *
 * ⚠️ EVERYTHING IS COUNTED IN LONDON DATES, matching the CHECKs 0167 put on
 * subscription_pauses: a return on day 28 is a short pause whatever the hour,
 * and across a clock change. A pause is chosen as a RETURN DATE, never as
 * months: "1 month" runs 28 to 31 days, so it would be short or long depending
 * on the month (batch 04 C6).
 *
 * The return happens at the START of the return date, London time: the stored
 * `pause_resumes_at` is London midnight, so the 08:00 UTC resume cron restarts
 * leads on the day the customer was told.
 */

/** Locked decision 2: up to 4 weeks keeps the area. */
export const BRIEF_SHORT_PAUSE_DAYS = 28;
/** Locked decision 3: "up to the existing maximum, 3 months". */
export const BRIEF_PAUSE_MAX_MONTHS = 3;
/** Locked decision 3: the area is recalculated 7 days before return. */
export const BRIEF_RECALIBRATE_DAYS_BEFORE = 7;

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/** YYYY-MM-DD in Europe/London for the given instant. */
export function londonToday(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function parseYmd(ymd: string): { y: number; m: number; d: number } | null {
  const match = YMD.exec(ymd);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return null;
  }
  return { y, m, d };
}

function ymdOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** YYYY-MM-DD plus n calendar days. */
export function addDaysYmd(ymd: string, n: number): string {
  const p = parseYmd(ymd);
  if (!p) throw new Error(`not a date: ${ymd}`);
  return ymdOf(new Date(Date.UTC(p.y, p.m - 1, p.d + n)));
}

/**
 * YYYY-MM-DD plus n calendar months, clamped to the month's last day: 30 Nov
 * + 3 months is 28 Feb. Postgres's `date + interval 'n months'`, which is what
 * subscription_pauses_brief_max (0167) bounds a brief pause with.
 *
 * ⚠️ NOT JavaScript's setMonth, which rolls 30 Nov + 3 over to 2 March (§11).
 */
export function addMonthsClampedYmd(ymd: string, n: number): string {
  const p = parseYmd(ymd);
  if (!p) throw new Error(`not a date: ${ymd}`);
  const monthIndex = p.m - 1 + n;
  const y = p.y + Math.floor(monthIndex / 12);
  const m = ((monthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return ymdOf(new Date(Date.UTC(y, m, Math.min(p.d, lastDay))));
}

/** Whole days from one date to another (to − from). */
export function daysBetweenYmd(from: string, to: string): number {
  const a = parseYmd(from);
  const b = parseYmd(to);
  if (!a || !b) throw new Error(`not a date: ${from} / ${to}`);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);
}

/**
 * London midnight at the start of that date, as a UTC instant.
 *
 * ⚠️ NOT importedLeadMonths' midday rule. That reads the offset at midday on
 * the 1st, which is never a clock-change day; here the date can be one (the
 * last Sunday of March or October), and midday's offset is then the wrong one:
 * it put 29 March 2026's midnight at 23:00 on the 28th.
 *
 * The offset is read at the UTC midnight of the date instead, and that is
 * exact for the UK: the clocks change at 01:00 UTC, so 00:00 UTC is always on
 * the same side of a change as London's own midnight (00:00 GMT, or 23:00 UTC
 * the evening before in BST).
 */
export function londonMidnightIso(ymd: string): string {
  const p = parseYmd(ymd);
  if (!p) throw new Error(`not a date: ${ymd}`);
  const utcMidnight = Date.UTC(p.y, p.m - 1, p.d);
  return new Date(utcMidnight - londonOffsetMs(new Date(utcMidnight))).toISOString();
}

/** The dates a brief customer may return on, chosen today. */
export interface BriefPauseWindow {
  today: string;
  /** The earliest return date: tomorrow. */
  earliest: string;
  /** "Pause for 4 weeks": the last day that still keeps the area. */
  fourWeeks: string;
  /** The latest return date: today + 3 months, month-end clamped. */
  latest: string;
}

export function briefPauseWindow(now: Date): BriefPauseWindow {
  const today = londonToday(now);
  return {
    today,
    earliest: addDaysYmd(today, 1),
    fourWeeks: addDaysYmd(today, BRIEF_SHORT_PAUSE_DAYS),
    latest: addMonthsClampedYmd(today, BRIEF_PAUSE_MAX_MONTHS),
  };
}

/** Locked decision 2: 28 days or fewer, counted in London dates. */
export function holdsArea(days: number): boolean {
  return days <= BRIEF_SHORT_PAUSE_DAYS;
}

export type ReturnDateCheck =
  | { ok: true; returnDate: string; days: number; holdArea: boolean; resumesAtIso: string }
  | { ok: false; code: "return_date_invalid" | "return_date_too_soon" | "return_date_too_late" };

/**
 * Judge a return date sent by the pause card. The server's own clock decides
 * the window and whether the area is kept; nothing is taken from the request
 * but the date itself.
 */
export function checkReturnDate(raw: unknown, now: Date): ReturnDateCheck {
  if (typeof raw !== "string" || !parseYmd(raw.trim())) {
    return { ok: false, code: "return_date_invalid" };
  }
  const returnDate = raw.trim();
  const window = briefPauseWindow(now);
  if (returnDate < window.earliest) return { ok: false, code: "return_date_too_soon" };
  if (returnDate > window.latest) return { ok: false, code: "return_date_too_late" };
  const days = daysBetweenYmd(window.today, returnDate);
  return {
    ok: true,
    returnDate,
    days,
    holdArea: holdsArea(days),
    resumesAtIso: londonMidnightIso(returnDate),
  };
}

/** The pause columns that say whether a customer is on a long brief pause. */
export interface BriefPauseState {
  paused_at: string | null;
  pause_holds_area: boolean | null;
}

/**
 * On a pause that RELEASES the area (locked decision 3). Null pause_holds_area
 * is every pause that is not a brief customer's, and it is never long.
 */
export function onLongBriefPause(c: BriefPauseState): boolean {
  return Boolean(c.paused_at) && c.pause_holds_area === false;
}

/** Locked decision 3: recalculate 7 days before return, or any time after. */
export function recalibrationDue(resumesAtIso: string, now: Date): boolean {
  const resumes = Date.parse(resumesAtIso);
  if (!Number.isFinite(resumes)) return false;
  return now.getTime() >= resumes - BRIEF_RECALIBRATE_DAYS_BEFORE * 86_400_000;
}

// --- the recalculated area ---------------------------------------------------

/** The parts of a brief that say what the customer receives. */
export interface AreaShape {
  service_radius_miles: number;
  service_outcodes: string[] | null;
}

/**
 * Whether the recalculated area differs from what the customer has now.
 *
 * The pause card promises: "If it changes, we'll tell you first and you'll
 * choose what happens next." So an unchanged area is not written as a pending
 * version and asks nothing of the customer. "Changes" is the radius or the set
 * of service outcodes; a change of answers (a scheduled change the customer
 * saved, C9) is a change too.
 */
export function areaChanged(current: AreaShape, next: AreaShape, answersChanged: boolean): boolean {
  if (answersChanged) return true;
  if (current.service_radius_miles !== next.service_radius_miles) return true;
  const a = new Set(current.service_outcodes ?? []);
  const b = new Set(next.service_outcodes ?? []);
  if (a.size !== b.size) return true;
  return Array.from(a).some((oc) => !b.has(oc));
}

// --- what happens when the return date comes ---------------------------------

/** The stored outcome of a long pause's recalculation. */
export interface RecalibrationState {
  recalibrated_at: string | null;
  pending_brief_id: string | null;
  /** The status of that pending version now, when there is one. */
  pending_status: "pending_confirmation" | "active" | "superseded" | null;
}

export type ReturnDecision =
  /** Recalculate now (it has not happened yet), then decide. */
  | "recalibrate"
  /** Restart leads: the area is unchanged, confirmed, or replaced by the customer's own save. */
  | "resume"
  /** Stay paused until the customer confirms the new area (locked decision 4, C4). */
  | "await_confirmation";

/**
 * What to do with a long brief pause whose return date has come (or that the
 * customer asked to end early).
 *
 * ⚠️ A PENDING VERSION STILL AWAITING CONFIRMATION KEEPS THEM PAUSED. That is
 * C4: only a return from pause holds delivery, and it does so by staying
 * paused, so they are neither sent leads nor billed. Phase 3's confirm screen
 * (and its 72-hour auto-accept) is what restarts them.
 *
 * A pending version the customer's own area save superseded (0164: their
 * newer choice) does not hold them: they chose an area against live supply
 * after the recalculation, and it starts at renewal as the editor told them.
 */
export function returnDecision(state: RecalibrationState): ReturnDecision {
  if (!state.recalibrated_at) return "recalibrate";
  if (!state.pending_brief_id) return "resume";
  return state.pending_status === "pending_confirmation" ? "await_confirmation" : "resume";
}

// --- the event n8n picks up (C8) ----------------------------------------------

/**
 * The facts n8n needs to send the WhatsApp Zac approves. Never the message:
 * its wording is n8n's, approved by Zac, and not held here (batch 04 Phase 2).
 */
export interface BriefAreaUpdatedPayload {
  first_name: string;
  phone: string | null;
  email: string;
  /** YYYY-MM-DD, London: the date their leads restart once they confirm. */
  return_date: string;
  radius_miles: number;
  previous_radius_miles: number;
  base_postcode: string;
  review_url: string;
}

export function firstNameOf(contactName: string | null | undefined, email: string): string {
  const name = (contactName ?? "").trim();
  if (!name) return email;
  return name.split(/\s+/)[0] || name;
}

// --- copy ---------------------------------------------------------------------

/**
 * The pause screen, word for word from batch 04 Phase 2. Held to the A9 list
 * by briefCopy.test.ts.
 */
export const BRIEF_PAUSE_COPY = {
  title: "Pausing your leads",
  intro: "While you're paused, no leads are sent and you're not charged.",
  short:
    "Pause for up to 4 weeks and nothing changes. You return to exactly what you have now: the same area, the same brief and the same quality of matches.",
  long:
    "Pausing for longer? Your brief, your quality of matching and every credit you're owed stay exactly the same. Your coverage area is recalculated from live supply before you return. If it changes, we'll tell you first and you'll choose what happens next.",
  slower:
    "Prefer to keep leads coming at a slower pace? Switch to 10 leads a month and keep your area active.",
  pauseFourWeeks: "Pause for 4 weeks",
  chooseLonger: "Choose a longer pause",
  switchTo10: "Switch to 10 leads",
  returnDateLabel: "When would you like your leads to restart?",
  keepsArea: "Up to 4 weeks: you come back to exactly the same area.",
  recalculated:
    "Over 4 weeks: your coverage area is recalculated from live supply before you return.",
  switchConfirm:
    "Your plan moves to 10 leads a month from your next billing date. Nothing is charged or refunded today.",
  switchPending: "Your plan moves to 10 leads a month at your next billing date.",
  pausedShort: "Your leads are paused. You come back to exactly the same area.",
  pausedLong:
    "Your leads are paused. Your coverage area is recalculated from live supply before you return.",
  areaToReview:
    "Your area has been updated. Review it before your leads restart.",
  earlyLong:
    "Your coverage area is recalculated from live supply first. If it has changed, you'll review it before your leads restart.",
} as const;

/** "Your leads restart on 7 November 2026." */
export function restartLine(returnDate: string): string {
  return `Your leads restart on ${longDate(returnDate)}.`;
}

/** "7 November 2026" for a YYYY-MM-DD date. */
export function longDate(ymd: string): string {
  const p = parseYmd(ymd);
  if (!p) return ymd;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(p.y, p.m - 1, p.d)));
}

/** The pause route's refusals, worded for the customer. */
export const RETURN_DATE_MESSAGES: Record<
  Extract<ReturnDateCheck, { ok: false }>["code"],
  string
> = {
  return_date_invalid: "Please choose the date you'd like your leads to restart.",
  return_date_too_soon: "Please choose a date from tomorrow onwards.",
  return_date_too_late: "A pause can last up to 3 months. Please choose an earlier date.",
};
