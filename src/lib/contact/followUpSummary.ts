/**
 * What today's follow-up prompt says (§42).
 *
 * PURE, so the wording and the arithmetic are testable without a client or a
 * mail server — the reasoning `cadence.ts` and `sendWindow.ts` both give at
 * length. The cron does the reads and the sending.
 */

import { channelLabel, type ContactChannel } from "@/lib/contact/contactStrategy";

export interface DueAttempt {
  assignmentId: string;
  leadId: string;
  leadName: string | null;
  channel: ContactChannel;
  stepNumber: number;
  /** How many days past its date, 0 when due today. */
  overdueDays: number;
}

export interface DaySummary {
  total: number;
  byChannel: { channel: ContactChannel; count: number }[];
  overdue: number;
  /** Roughly how long the list takes, for the one line that decides if they open it. */
  minutes: number;
}

/** A call takes longer than tapping a message; both are short. */
const MINUTES_PER: Record<ContactChannel, number> = {
  call: 2,
  whatsapp: 1,
  email: 1,
};

/** Channels in the order the sequence uses them, so the summary reads the same way. */
const CHANNEL_ORDER: ContactChannel[] = ["call", "whatsapp", "email"];

export function summariseDay(attempts: DueAttempt[]): DaySummary {
  const counts = new Map<ContactChannel, number>();
  let minutes = 0;
  for (const a of attempts) {
    counts.set(a.channel, (counts.get(a.channel) ?? 0) + 1);
    minutes += MINUTES_PER[a.channel];
  }
  return {
    total: attempts.length,
    byChannel: CHANNEL_ORDER.filter((c) => counts.has(c)).map((c) => ({
      channel: c,
      count: counts.get(c) as number,
    })),
    overdue: attempts.filter((a) => a.overdueDays > 0).length,
    // Round up, and never claim under a minute — "about 0 minutes" reads as broken.
    minutes: Math.max(1, Math.ceil(minutes)),
  };
}

/**
 * What the daily release adds to the prompt (§54).
 *
 * `newLeadsToday` — marketplace leads that arrived since yesterday's email;
 * each is a first call today, so it counts as work and can carry a send on
 * its own. `nextLead` — the sentence about when the next one is due; it goes
 * in the body and is NEVER a reason to send, or the email would arrive on
 * every quiet day and be filtered on the first.
 */
export interface DigestExtras {
  newLeadsToday: number;
  nextLead: string | null;
}

const NO_EXTRAS: DigestExtras = { newLeadsToday: 0, nextLead: null };

/** A new lead's first call is attempt 1 of the plan, and not yet drafted. */
const MINUTES_PER_NEW_LEAD = MINUTES_PER.call;

function withNewLeads(s: DaySummary, extras: DigestExtras): DaySummary {
  if (extras.newLeadsToday <= 0) return s;
  return {
    ...s,
    minutes: Math.max(1, s.minutes + extras.newLeadsToday * MINUTES_PER_NEW_LEAD),
  };
}

/** "4 calls, 2 WhatsApps and 1 email" — the line that says what the work IS. */
export function describeChannels(s: DaySummary): string {
  const parts = s.byChannel.map(
    (b) => `${b.count} ${channelLabel(b.channel).toLowerCase()}${b.count === 1 ? "" : "s"}`
  );
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * The subject line.
 *
 * ⚠️ IT NAMES THE NUMBER AND THE TIME. "You have follow-ups waiting" is the
 * shape of every ignorable notification ever sent; "6 follow-ups today — about
 * 8 minutes" is a decision the reader can make in the inbox without opening it.
 */
export function summarySubject(s: DaySummary, extras: DigestExtras = NO_EXTRAS): string {
  const t = withNewLeads(s, extras);
  const minutes = `about ${t.minutes} minute${t.minutes === 1 ? "" : "s"}`;
  const n = extras.newLeadsToday;
  const newPart = n > 0 ? `${n} new lead${n === 1 ? "" : "s"}` : "";
  const duePart = s.total > 0 ? `${s.total} follow-up${s.total === 1 ? "" : "s"}` : "";
  const what = [newPart, duePart].filter(Boolean).join(" and ");
  return `${what} today — ${minutes}`;
}

/**
 * The SMS. One line, a length that will not split into two segments, and a
 * link. Nothing else fits and nothing else is read.
 */
export function summarySms(s: DaySummary, url: string, extras: DigestExtras = NO_EXTRAS): string {
  const t = withNewLeads(s, extras);
  const n = extras.newLeadsToday;
  const lead = n > 0 ? `${n} new lead${n === 1 ? "" : "s"} in` : "";
  if (s.total === 0) {
    return `Stayful: ${lead} — ring them today. About ${t.minutes} min. ${url}`;
  }
  const overdue = s.overdue > 0 ? ` (${s.overdue} overdue)` : "";
  const head = lead ? `${lead}, ` : "";
  return `Stayful: ${head}${s.total} follow-up${s.total === 1 ? "" : "s"} due today${overdue} — ${describeChannels(s)}. About ${t.minutes} min. ${url}`;
}

/**
 * ⚠️ NOTHING IS SENT ON A DAY WITH NOTHING DUE, and that is the rule that keeps
 * the rest of it read. A daily email that arrives whether or not there is work
 * trains the reader to archive it unopened, and then the day there IS work it
 * goes the same way.
 */
export function worthSending(s: DaySummary, extras: DigestExtras = NO_EXTRAS): boolean {
  // A new lead is work (its first call is today). The next-lead sentence is
  // not, and must never make a quiet day into an email.
  return s.total > 0 || extras.newLeadsToday > 0;
}
