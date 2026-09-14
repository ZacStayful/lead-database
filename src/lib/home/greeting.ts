/**
 * The dashboard greeting (§56.7). PURE; the page supplies `now`.
 *
 * The hour is London's, never the server's — Vercel runs in UTC and Britain
 * is an hour ahead for half the year (§40.12), so a UTC hour would say
 * "Good morning" at 12:30 in June.
 */
import { dayLabel } from "@/lib/todaySummary";

export function londonHour(now: Date): number {
  const s = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    hour12: false,
  }).format(now);
  return Number(s) % 24;
}

export function greeting(now: Date, firstName: string | null): string {
  const h = londonHour(now);
  const part = h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
  const name = (firstName ?? "").trim();
  return name ? `Good ${part}, ${name}` : `Good ${part}`;
}

/** "Mon 14 Sep · 2 new leads arrived today, your next is due tomorrow." */
export function greetingSubtitle(today: string, lines: { key: string; text: string }[]): string {
  const picked = lines
    .filter((l) => l.key === "new_leads" || l.key === "next_lead")
    .map((l) => l.text.replace(/\.$/, ""));
  return [dayLabel(today), ...picked].join(" · ") + (picked.length ? "." : "");
}

export function firstNameOf(contactName: string | null | undefined): string | null {
  const n = (contactName ?? "").trim().split(/\s+/)[0];
  return n || null;
}
