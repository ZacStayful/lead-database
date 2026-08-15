/**
 * Choosing what to say to one operator, once a month.
 *
 * The email carries the same four rows as the Leaderboard page, but a table on
 * its own is not a message. This picks the ONE step to ask for, and the tone to
 * ask in, from that customer's own figures.
 *
 * WHY ONE ASK
 * -----------
 * The funnel breaks in a different place for different people. Telling somebody
 * who has not opened their leads to "ask for the meeting" is noise; telling
 * somebody already booking meetings to "open your leads" is insulting. Four
 * asks in one email is the same as none — so the message names the earliest
 * step they are behind on and stops there.
 *
 * ON TONE, WHICH IS MOST OF THE WORK HERE
 * ---------------------------------------
 * This message goes to paying customers, unprompted, and tells them how they
 * compare to their peers. Done badly that reads as a supplier telling a
 * customer off, and the people it lands hardest on are the ones already closest
 * to leaving — the same reason the Leaderboard page does not rank anybody.
 *
 * Three rules hold the copy together:
 *
 *   1. NEVER CHARACTERISE THE PERSON. "23 leads are still unopened" is a fact
 *      about leads. "You aren't working your leads" is a verdict about them.
 *      Only the first is ever written here.
 *   2. THE COHORT IS EVIDENCE, NOT A STICK. Peer figures appear to show that
 *      the next step works, not to establish that the reader is behind.
 *   3. ASSUME A REASON. Operators are busy and leads pile up. The copy is
 *      written as though there is an obvious explanation, because there
 *      usually is.
 */

export type InsightFocus = "open" | "ring" | "meeting" | "strong";

export type CustomerInsight = {
  customer_id: string;
  email: string;
  contact_name: string;
  phone: string | null;
  sms_alerts_enabled: boolean | null;
  notification_preferences: Record<string, boolean> | null;
  last_insights_sent_at: string | null;
  delivered: number;
  opened: number;
  attempted: number;
  meetings: number;
  wins: number;
  notes: number;
  open_rate: number | null;
  contact_rate: number | null;
  meeting_rate: number | null;
};

export type CohortFigures = {
  open_rate: number | null;
  contact_rate: number | null;
  meeting_rate: number | null;
  operators: number;
};

/**
 * Thresholds are set BELOW the winners' figures, not at them.
 *
 * Operators who have signed a client sit at 100% opened, 100% contacted and 20%
 * booked. Using those as the bar would put all but a handful of customers in
 * the earliest bucket forever, and nobody would ever see the message move on.
 * These are "clearly behind on this step" lines, not targets.
 */
const OPEN_FLOOR = 0.9;
const CONTACT_FLOOR = 0.75;
const MEETING_FLOOR = 0.15;

/** The earliest step this operator is materially behind on. */
export function selectFocus(c: CustomerInsight): InsightFocus {
  const open = c.open_rate ?? 0;
  const contact = c.contact_rate ?? 0;
  const meeting = c.meeting_rate ?? 0;

  if (open < OPEN_FLOOR) return "open";
  if (contact < CONTACT_FLOOR) return "ring";
  if (meeting < MEETING_FLOOR) return "meeting";
  return "strong";
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export type InsightCopy = {
  subject: string;
  heading: string;
  /** The one thing being asked for, or a note of recognition. */
  ask: string;
  /** Why it is worth doing, drawn from what the cohort actually did. */
  evidence: string | null;
  buttonLabel: string;
  /**
   * Under 160 GSM-7 characters, and deliberately free of em dashes, curly
   * quotes and other non-GSM punctuation: a single one of those forces the
   * whole message to UCS-2, which cuts the segment limit from 160 to 70 and
   * turned these into 3-segment sends at 3x the cost. Straight ASCII only.
   *
   * Carries no comparative figure either. The same stat that reads as useful
   * in an email somebody opened reads as a rebuke when it arrives unbidden on
   * a phone, so the text is a pointer and nothing more.
   */
  sms: string;
};

function pct(v: number | null): string {
  if (v === null || v === undefined) return "—";
  return `${Math.round(Number(v) * 100)}%`;
}

/**
 * Compose the message for one customer.
 *
 * `dashboardUrl` is passed rather than imported so this stays a pure function —
 * it is the piece most likely to want testing, and the piece most likely to be
 * rewritten once Zac has seen a month of them.
 */
export function composeInsight(
  c: CustomerInsight,
  cohort: CohortFigures,
  dashboardUrl: string
): InsightCopy {
  const focus = selectFocus(c);
  const firstName = c.contact_name.trim().split(/\s+/)[0] || c.contact_name;
  const unopened = Math.max(c.delivered - c.opened, 0);
  const uncontacted = Math.max(c.opened - c.attempted, 0);

  switch (focus) {
    case "open":
      return {
        subject: `${unopened} of your leads are still waiting`,
        heading: `Your leads so far, ${firstName}`,
        // Names the leads, never the person. An operator with 23 unopened
        // leads knows they are busy; they do not know it is 23.
        ask:
          unopened === 1
            ? "One lead you've been sent hasn't been opened yet. It only takes a minute, and it's the step everything else follows from."
            : `${unopened} of the ${c.delivered} leads you've been sent haven't been opened yet. Working through those is the step everything else follows from.`,
        evidence: cohort.open_rate
          ? `Across the operators who've signed a management client, ${pct(cohort.open_rate)} of the leads they receive get opened.`
          : null,
        buttonLabel: "Open your leads",
        sms: `Stayful: ${unopened} of your leads are still unopened. Your monthly summary is in your inbox. ${dashboardUrl}`,
      };

    case "ring":
      return {
        subject: "Your monthly lead summary",
        heading: `Your leads so far, ${firstName}`,
        ask:
          uncontacted > 0
            ? `You've opened ${c.opened} of your ${c.delivered} leads, and ${uncontacted} ${plural(uncontacted, "hasn't", "haven't")} been called yet. Picking up the phone is the single biggest step between the two groups below.`
            : `You've opened your leads but ${c.delivered - c.attempted} ${plural(c.delivered - c.attempted, "is", "are")} still waiting on a first call. That call is the single biggest step between the two groups below.`,
        evidence: cohort.contact_rate
          ? `Operators who've signed a management client called ${pct(cohort.contact_rate)} of the leads they were sent. Across everyone else it's closer to half.`
          : null,
        buttonLabel: "See your leads",
        sms: `Stayful: your monthly lead summary is in your inbox, including the leads still waiting on a first call. ${dashboardUrl}`,
      };

    case "meeting":
      return {
        subject: "Your monthly lead summary",
        heading: `You're doing the hard part, ${firstName}`,
        // This operator is already ringing people. The ask is a technique, not
        // more effort, and the copy says so — being told to "try harder" when
        // you are already working is the fastest way to lose someone.
        ask: `You've called ${c.attempted} of your ${c.delivered} leads, which is more than most. The step that separates operators who sign clients is asking for the meeting on that first call${c.meetings > 0 ? ` — you've booked ${c.meetings} so far` : ""}.`,
        evidence: cohort.meeting_rate
          ? `Around ${pct(cohort.meeting_rate)} of leads reach a booked meeting for operators who've signed a client, against roughly 1 in 14 for everyone else.`
          : null,
        buttonLabel: "See your leads",
        sms: `Stayful: your monthly lead summary is in your inbox, including what turns your calls into booked meetings. ${dashboardUrl}`,
      };

    case "strong":
    default:
      return {
        subject: "Your monthly lead summary",
        heading: `Strong month, ${firstName}`,
        ask:
          c.wins > 0
            ? `You've opened and worked nearly everything you've been sent, and signed ${c.wins} ${plural(c.wins, "client", "clients")} from it. This is what the figures below look like when somebody works the leads properly.`
            : "You've opened and worked nearly everything you've been sent, and you're booking meetings off the back of it. That's the pattern that turns into signed clients.",
        evidence: null,
        buttonLabel: "See your leaderboard",
        sms: `Stayful: strong month. Your lead summary is in your inbox. ${dashboardUrl}`,
      };
  }
}

/**
 * Monthly dedup. Deliberately 25 days rather than 30: a calendar-monthly cron
 * lands 28-31 days apart, so a 30-day guard would silently skip February. A
 * manual re-run inside the same month is still a no-op, which is the behaviour
 * the guard exists for.
 */
export const INSIGHTS_DEDUP_DAYS = 25;

export function alreadySentThisMonth(
  lastSentAt: string | null,
  now: Date = new Date()
): boolean {
  if (!lastSentAt) return false;
  const days = (now.getTime() - new Date(lastSentAt).getTime()) / 86_400_000;
  return days < INSIGHTS_DEDUP_DAYS;
}

/** Missing / unset key defaults to true — opt-out is only an explicit false. */
export function wantsInsights(c: CustomerInsight): boolean {
  return c.notification_preferences?.monthly_insights !== false;
}
