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
export function summarySubject(s: DaySummary): string {
  return `${s.total} follow-up${s.total === 1 ? "" : "s"} today — about ${s.minutes} minute${s.minutes === 1 ? "" : "s"}`;
}

/**
 * The SMS. One line, a length that will not split into two segments, and a
 * link. Nothing else fits and nothing else is read.
 */
export function summarySms(s: DaySummary, url: string): string {
  const overdue = s.overdue > 0 ? ` (${s.overdue} overdue)` : "";
  return `Stayful: ${s.total} follow-up${s.total === 1 ? "" : "s"} due today${overdue} — ${describeChannels(s)}. About ${s.minutes} min. ${url}`;
}

/**
 * ⚠️ NOTHING IS SENT ON A DAY WITH NOTHING DUE, and that is the rule that keeps
 * the rest of it read. A daily email that arrives whether or not there is work
 * trains the reader to archive it unopened, and then the day there IS work it
 * goes the same way.
 */
export function worthSending(s: DaySummary): boolean {
  return s.total > 0;
}
