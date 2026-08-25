/**
 * Month boundaries for the imported-leads report.
 *
 * The counts in 0106 are cut in **Europe/London**, because that is the month
 * the business works in and the month the lead list prints beside each row. A
 * lead added at 00:30 BST on the 1st of August is 23:30 UTC on the 31st of
 * July, and a naive UTC cut would report it in July while the list shows August.
 *
 * The page then has to fetch the leads for a month it was given as a local
 * date, which means turning "August 2026, London" back into the UTC instants
 * PostgREST compares `created_at` against. That is what this does — and it has
 * to agree with the SQL exactly, or the month you click and the rows you get
 * are off by an hour's worth of leads at each end.
 *
 * No date library: `Intl` already knows every offset and every transition, and
 * a second source of timezone truth is the thing worth avoiding.
 */

/** How far ahead of UTC Europe/London is at a given instant, in milliseconds. */
export function londonOffsetMs(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    timeZoneName: "longOffset",
  }).formatToParts(at);
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  // "GMT+01:00" in summer, plain "GMT" in winter.
  const match = name.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3])) * 60_000;
}

/**
 * "2026-08-01" → the instant midnight Europe/London on that date, in UTC.
 *
 * The offset is read from MIDDAY on the 1st rather than from midnight itself.
 * Midnight is the moment a transition can land on, and asking for the offset at
 * the instant you are trying to convert is circular; midday is safely inside
 * the day whichever way the clocks went.
 */
export function londonMonthStartIso(month: string): string {
  const [year, mon] = month.split("-").map(Number);
  const probe = new Date(Date.UTC(year, mon - 1, 1, 12, 0, 0));
  const offsetMs = londonOffsetMs(probe);
  return new Date(Date.UTC(year, mon - 1, 1, 0, 0, 0) - offsetMs).toISOString();
}

/** The month after this one, as "YYYY-MM-01". Rolls the year over. */
export function nextMonth(month: string): string {
  const [year, mon] = month.split("-").map(Number);
  const y = mon === 12 ? year + 1 : year;
  const m = mon === 12 ? 1 : mon + 1;
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

/**
 * The half-open UTC window `[start, end)` covering one Europe/London month.
 *
 * Half-open on purpose: a lead created at exactly midnight on the 1st belongs
 * to the month starting, not the one ending, and it must belong to exactly one.
 */
export function londonMonthRange(month: string): { startIso: string; endIso: string } {
  return {
    startIso: londonMonthStartIso(month),
    endIso: londonMonthStartIso(nextMonth(month)),
  };
}

/** "August 2026", in the timezone the months were cut in. */
export function monthLabel(month: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "Europe/London",
  }).format(new Date(`${month}T12:00:00Z`));
}

/** "25 Aug 2026", the date convention used everywhere else in the app. */
export function formatAdminDate(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Europe/London",
  }).format(new Date(iso));
}
