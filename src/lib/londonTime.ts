/**
 * Short, London-clock labels for the CRM screens (§56.7). PURE, import-free.
 *
 * Vercel runs in UTC and Britain is an hour ahead for half the year
 * (§40.12), so every wall-clock string shown to an operator is formatted in
 * Europe/London explicitly rather than from the server's `Date` methods.
 */

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parts(iso: string): { y: number; m: number; d: number; hh: string; mm: string; dow: number } {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(new Date(iso));
  const get = (t: string) => f.find((p) => p.type === t)?.value ?? "";
  return {
    y: Number(get("year")),
    m: Number(get("month")),
    d: Number(get("day")),
    hh: get("hour").padStart(2, "0") === "24" ? "00" : get("hour").padStart(2, "0"),
    mm: get("minute").padStart(2, "0"),
    dow: DAYS.indexOf(get("weekday")),
  };
}

/** "2026-09-14" in London. */
export function londonYmd(iso: string): string {
  const p = parts(iso);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** "08:32" */
export function londonHHMM(iso: string): string {
  const p = parts(iso);
  return `${p.hh}:${p.mm}`;
}

/** "Thu 11 Sep", or "Today" / "Yesterday" relative to `now`. */
export function londonDayHeading(iso: string, now: Date): string {
  const ymd = londonYmd(iso);
  const today = londonYmd(now.toISOString());
  if (ymd === today) return "Today";
  const yesterday = londonYmd(new Date(now.getTime() - 86_400_000).toISOString());
  if (ymd === yesterday) return "Yesterday";
  const p = parts(iso);
  return `${DAYS[p.dow]} ${p.d} ${MONTHS[p.m - 1]}`;
}

/** Inbox-row time: "08:32" today, "Sat" inside a week, "9 Sep" beyond. */
export function shortWhen(iso: string, now: Date): string {
  const ymd = londonYmd(iso);
  const today = londonYmd(now.toISOString());
  if (ymd === today) return londonHHMM(iso);
  const age = now.getTime() - new Date(iso).getTime();
  const p = parts(iso);
  if (age < 6 * 86_400_000) return DAYS[p.dow];
  return `${p.d} ${MONTHS[p.m - 1]}${p.y !== parts(now.toISOString()).y ? ` ${p.y}` : ""}`;
}

/** Activity-column stamp: "Today 08:32" or "11 Sep 14:20". */
export function activityWhen(iso: string, now: Date): string {
  const ymd = londonYmd(iso);
  const today = londonYmd(now.toISOString());
  if (ymd === today) return `Today ${londonHHMM(iso)}`;
  const p = parts(iso);
  return `${p.d} ${MONTHS[p.m - 1]} ${p.hh}:${p.mm}`;
}
