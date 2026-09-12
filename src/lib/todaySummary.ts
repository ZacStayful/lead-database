/**
 * The Today panel on the dashboard home, and the sentences it shares with the
 * daily digest (§54). PURE — the page and the cron do the reads.
 *
 * Rules carried over from NeedsAttention: it names THINGS, never rates, and
 * nothing here is comparative. The one line worth seeing on a quiet day is
 * the next-lead line, because "your next lead is due tomorrow" is the reason
 * to come back tomorrow; everything else renders only when it is non-zero.
 */
import type { ReleaseSchedule } from "@/lib/pacing";
import { isWorkingDay, addDays } from "@/lib/pacing";
import type { DaySummary } from "@/lib/contact/followUpSummary";
import { describeChannels } from "@/lib/contact/followUpSummary";

/** "Mon 14 Sep" from a YYYY-MM-DD, with no timezone in the question. */
export function dayLabel(ymd: string): string {
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  // Fixed tables rather than Intl: ICU renders September as "Sept" in en-GB
  // on newer Node and "Sep" on older, and the digest is compared by a test.
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${DAYS[date.getUTCDay()]} ${d} ${MONTHS[m - 1]}`;
}

/**
 * The next-lead sentence. Null when there is nothing honest to say: the
 * switch is off, or the customer is exempt (their leads arrive as they come).
 */
export function nextLeadLine(s: ReleaseSchedule, today: string): string | null {
  if (!s.enabled || s.mode === "immediate") return null;
  if (s.onHoldUntil) {
    return `Your leads are on hold until ${dayLabel(s.onHoldUntil)}. They start again that day.`;
  }
  if (s.exhausted) {
    return "You've had every lead you're owed this cycle — the next batch starts at your renewal.";
  }
  if (s.dueToday) {
    return s.receivedToday > 0
      ? "Today's lead is in, and there may be another if one arrives."
      : "Your next lead is due today.";
  }
  if (s.nextReleaseDate) {
    return s.nextReleaseDate === addDays(today, 1)
      ? `Your next lead is due tomorrow (${dayLabel(s.nextReleaseDate)}).`
      : `Your next lead is due on ${dayLabel(s.nextReleaseDate)}.`;
  }
  return null;
}

/**
 * Consecutive working days, ending today or the last working day, on which
 * the operator did something with a lead. Weekends neither count nor break
 * the run. `activeDays` are London dates with at least one operator-generated
 * event (ENGAGEMENT_EVENT_TYPES — never nudge_sent, §3).
 *
 * Personal only, never compared (§20). Rendered from 2 upward by the caller
 * so a fresh customer is not shown "0 days".
 */
export function workingDayStreak(activeDays: Iterable<string>, today: string): number {
  const active = new Set(activeDays);
  let d = today;
  // A quiet day that is still in progress does not end the run.
  if (!active.has(d) || !isWorkingDay(d)) d = addDays(d, -1);
  let streak = 0;
  for (let i = 0; i < 120; i += 1) {
    if (isWorkingDay(d)) {
      if (!active.has(d)) break;
      streak += 1;
    }
    d = addDays(d, -1);
  }
  return streak;
}

export interface TodayLine {
  key: "new_leads" | "next_lead" | "followups" | "callbacks" | "replies" | "pool" | "streak";
  text: string;
  href: string | null;
  detail?: string;
}

export interface TodayInput {
  today: string;
  /** Marketplace leads assigned today (London date). */
  newLeadsToday: number;
  /** One per product the customer holds, in the order to show them. */
  schedules: { label: string | null; schedule: ReleaseSchedule }[];
  dueFollowUps: DaySummary;
  dueTodayCallbacks: number;
  overdueCallbacks: number;
  unreadReplies: number;
  poolLeads: number;
  streakDays: number;
}

export function buildTodayLines(input: TodayInput): TodayLine[] {
  const lines: TodayLine[] = [];

  if (input.newLeadsToday > 0) {
    lines.push({
      key: "new_leads",
      text:
        input.newLeadsToday === 1
          ? "1 new lead arrived today"
          : `${input.newLeadsToday} new leads arrived today`,
      href: "/dashboard/leads?activity=new",
      detail: "Ring today — a cold call answers ~17% of the time, and less once it has gone cold.",
    });
  }

  for (const { label, schedule } of input.schedules) {
    const line = nextLeadLine(schedule, input.today);
    if (!line) continue;
    lines.push({
      key: "next_lead",
      text: label ? `${label}: ${line}` : line,
      href: null,
    });
  }

  if (input.dueFollowUps.total > 0) {
    const s = input.dueFollowUps;
    lines.push({
      key: "followups",
      text: `${s.total} follow-up${s.total === 1 ? "" : "s"} due today — about ${s.minutes} minute${s.minutes === 1 ? "" : "s"}`,
      href: "/dashboard/leads/priority",
      detail: `${describeChannels(s)}${s.overdue > 0 ? ` · ${s.overdue} already past ${s.overdue === 1 ? "its" : "their"} date` : ""}`,
    });
  }

  if (input.dueTodayCallbacks > 0 || input.overdueCallbacks > 0) {
    const parts: string[] = [];
    if (input.dueTodayCallbacks > 0) {
      parts.push(
        `${input.dueTodayCallbacks} call-back${input.dueTodayCallbacks === 1 ? "" : "s"} due today`
      );
    }
    if (input.overdueCallbacks > 0) {
      parts.push(`${input.overdueCallbacks} past ${input.overdueCallbacks === 1 ? "its" : "their"} date`);
    }
    lines.push({
      key: "callbacks",
      text: parts.join(", "),
      href: "/dashboard/leads/priority",
      detail: "Dates you set yourself when you last spoke to them.",
    });
  }

  if (input.unreadReplies > 0) {
    lines.push({
      key: "replies",
      text:
        input.unreadReplies === 1
          ? "1 landlord has replied"
          : `${input.unreadReplies} landlords have replied`,
      href: "/dashboard/leads?activity=contacted",
      detail: "A reply is the warmest lead you have today.",
    });
  }

  if (input.poolLeads > 0) {
    lines.push({
      key: "pool",
      text:
        input.poolLeads === 1
          ? "1 landlord in the expired pool you can ring for free"
          : `${input.poolLeads} landlords in the expired pool you can ring for free`,
      href: "/dashboard/leads/expired",
      detail: "Calling is free. First to claim keeps the lead.",
    });
  }

  if (input.streakDays >= 2) {
    lines.push({
      key: "streak",
      text: `You've worked a lead ${input.streakDays} working days running`,
      href: null,
    });
  }

  return lines;
}
