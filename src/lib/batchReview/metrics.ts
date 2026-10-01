/**
 * What a reviewed batch says (§73). Pure and import-free.
 *
 * ⚠️ EVERY RATE IS OVER `delivered`, not over the answered rows. A lead the
 * customer did not ring is still a lead they were sent, and leaving it out
 * would flatter the batch in exactly the way that hides an unworked month.
 *
 * ⚠️ The benchmark is a long-run average (5% management, 10% GR, as each
 * landing page says). A single month's signed rate will usually read below it,
 * because most deals close after the month ends. The results panel therefore
 * puts the LIFETIME rate beside it and never presents the batch rate as a
 * verdict.
 */
import { CONVERSION_BENCHMARK, type BatchAnswer, type LeadTypeKey } from "./answers";

const INTERESTED: ReadonlySet<BatchAnswer> = new Set<BatchAnswer>([
  "talking",
  "meeting_booked",
  "meeting_held",
  "viewing_booked",
  "contract_sent",
  "likely_later",
  "signed",
]);

/** A signed lead was met, so it counts as a meeting too (a no-show still counts as booked, §20). */
const MEETING: ReadonlySet<BatchAnswer> = new Set<BatchAnswer>([
  "meeting_booked",
  "meeting_held",
  "viewing_booked",
  "contract_sent",
  "signed",
]);

export interface BatchCounts {
  delivered: number;
  answered: number;
  called: number;
  interested: number;
  meetings: number;
  likelyLater: number;
  signed: number;
  notInterested: number;
  noAnswer: number;
  notCalled: number;
}

export function countAnswers(
  delivered: number,
  answers: (BatchAnswer | null | undefined)[]
): BatchCounts {
  const c: BatchCounts = {
    delivered,
    answered: 0,
    called: 0,
    interested: 0,
    meetings: 0,
    likelyLater: 0,
    signed: 0,
    notInterested: 0,
    noAnswer: 0,
    notCalled: 0,
  };
  for (const a of answers) {
    if (!a) continue;
    c.answered += 1;
    if (a === "not_called") c.notCalled += 1;
    else c.called += 1;
    if (INTERESTED.has(a)) c.interested += 1;
    if (MEETING.has(a)) c.meetings += 1;
    if (a === "likely_later") c.likelyLater += 1;
    if (a === "signed") c.signed += 1;
    if (a === "not_interested") c.notInterested += 1;
    if (a === "no_answer") c.noAnswer += 1;
  }
  return c;
}

/** n ÷ d as a fraction, or null when there is nothing to divide by. */
export function rate(n: number, d: number): number | null {
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return null;
  return n / d;
}

/** "12%". One decimal below 10% so a 5% benchmark is not rounded into a lie. */
export function formatRate(r: number | null): string {
  if (r == null) return "—";
  const pct = r * 100;
  if (pct > 0 && pct < 10) return `${pct.toFixed(1).replace(/\.0$/, "")}%`;
  return `${Math.round(pct)}%`;
}

export function benchmarkFor(leadType: LeadTypeKey): number {
  return CONVERSION_BENCHMARK[leadType];
}

export interface BenchmarkReading {
  benchmark: number;
  lifetimeRate: number | null;
  /** "above" / "below" / "level", or null when there is nothing to compare. */
  position: "above" | "below" | "level" | null;
}

/**
 * Lifetime signed ÷ received against the benchmark. Fewer than 10 leads is too
 * few to compare, so the position is withheld rather than read either way.
 */
export function benchmarkReading(
  leadType: LeadTypeKey,
  lifetimeSigned: number,
  lifetimeReceived: number
): BenchmarkReading {
  const benchmark = benchmarkFor(leadType);
  const lifetimeRate = rate(lifetimeSigned, lifetimeReceived);
  if (lifetimeRate == null || lifetimeReceived < 10) {
    return { benchmark, lifetimeRate, position: null };
  }
  const diff = lifetimeRate - benchmark;
  const position = Math.abs(diff) < 0.005 ? "level" : diff > 0 ? "above" : "below";
  return { benchmark, lifetimeRate, position };
}
