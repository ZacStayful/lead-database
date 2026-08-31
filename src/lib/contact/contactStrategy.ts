/**
 * The contact strategy (§42) — the single definition of how a lead is worked.
 *
 * Read by the customer guide (/dashboard/guide), the contact timeline on the
 * lead page, the next-attempt block on the pipeline card, and the plan the
 * scheduler materialises. The same discipline `cancelOptions.ts` (§29) and
 * `featureRequest.ts` (§21.8) use: guidance that disagreed with the to-do list
 * would be worse than either alone, and the failure would be silent.
 *
 * ⚠️ IT MUST STAY IMPORT-FREE of anything server-only. The guide page, the
 * timeline and the card are all client components; pulling supabase-js in here
 * would break every one of them.
 *
 * WHERE THE NUMBERS COME FROM
 * ---------------------------
 * Not generic sales advice. Stayful's own Management Leads pipeline, traced end
 * to end over July–August 2026: every call attempt and its outcome, every email,
 * cross-checked against real calendar bookings rather than CRM status labels.
 * One operator's data — a benchmark, never a guarantee, and worded that way
 * everywhere it is shown.
 *
 * ⚠️ TWO THINGS MUST NEVER APPEAR HERE OR IN ANYTHING RENDERED FROM IT, and
 * `contactStrategy.test.ts` asserts both against the rendered copy rather than
 * trusting review:
 *
 *   1. NO ATTENDANCE OR SHOW-UP RATE. An "83% of booked meetings are attended"
 *      figure was measured and then discarded: Calendly sends three reminders of
 *      its own before any meeting, so the number describes Calendly's dunning,
 *      not this strategy. Quoting it would have us promising an outcome we do
 *      not influence.
 *   2. NO PERCENTAGE ATTACHED TO SPEED. See SPEED below.
 */

import type { LeadEventType } from "@/lib/types";

/** How a single attempt reaches the landlord. */
export type ContactChannel = "call" | "whatsapp" | "email";

/**
 * One rung of the ladder.
 *
 * `delayDays` is measured from the PREVIOUS attempt, matching
 * `message_sequence_steps.delay_days` (0121) and `dueAtForStep` in
 * `cadence.ts`, so the stored plan and this table cannot describe different
 * schedules.
 */
export interface ContactAttempt {
  number: number;
  delayDays: number;
  channel: ContactChannel;
  /** What the attempt is FOR. Shown to the operator; never a script. */
  objective: string;
  /** One line of reasoning, shown in the guide only. */
  why?: string;
}

/**
 * ⚠️ COLD CALL FIRST, AND THE INTUITIVE ORDER IS THE WRONG ONE.
 *
 * A cold call — no text or email ahead of it — is answered about 17% of the
 * time. Once a message or an email has gone first, the answer rate on the
 * following call collapses to 0–4%. "Warm them up, then ring" is the natural
 * instinct and it costs roughly three quarters of the answer rate.
 *
 * This is also why the WhatsApp hand-off button (§40.15), which is the most
 * prominent contact action on a lead, is deliberately attempt 2 rather than
 * attempt 1. Nothing about the button changed; where it sits in the sequence
 * did.
 *
 * Cumulative days: 0, 0, 2, 5, 9.
 */
export const CONTACT_ATTEMPTS: readonly ContactAttempt[] = [
  {
    number: 1,
    delayDays: 0,
    channel: "call",
    objective:
      "Ring them. Introduce yourself and find out whether the property is tenanted right now or sitting empty.",
    why: "A cold call — nothing sent ahead of it — is answered far more often than one that follows a message.",
  },
  {
    number: 2,
    delayDays: 0,
    channel: "whatsapp",
    objective:
      "Same day, only if the call went unanswered. Say who you are, name the property, and ask one question they can answer quickly.",
    why: "A landlord who missed your call will often reply to a message about the same property within the hour.",
  },
  {
    number: 3,
    delayDays: 2,
    channel: "email",
    objective:
      "Something they can read in their own time — what the property could earn, and one clear question.",
    why: "Email carries detail a message cannot, and it survives in their inbox until they have a spare ten minutes.",
  },
  {
    number: 4,
    delayDays: 3,
    channel: "call",
    objective:
      "Ring again, at a different time of day from the first attempt.",
    why: "Never call straight back after a no-answer. Spacing it out, and varying the hour, is what gets a second call picked up.",
  },
  {
    number: 5,
    delayDays: 4,
    channel: "whatsapp",
    objective:
      "A last short nudge. Offer to leave it there — some landlords reply to exactly that.",
    why: "This is the end of the active sequence. Past here, fresh effort has produced almost nothing.",
  },
] as const;

/** Total attempts in the sequence. Never hard-code 5. */
export const TOTAL_ATTEMPTS = CONTACT_ATTEMPTS.length;

/**
 * ⚠️ STOP AT FIVE, AND DO NOT RAISE IT.
 *
 * About 89% of the leads that ever respond do so inside the first four or five
 * attempts. Beyond that the tracked data shows close to zero additional
 * bookings — so a longer ladder spends the operator's time on approaches that
 * do not convert and spends the landlord's patience on approaches they have
 * already ignored.
 *
 * An earlier working figure of "ideally 15 attempts" predates this measurement
 * and is superseded by it.
 */
export const RESPONDER_SHARE_BY_FIFTH_PCT = 89;

/** What disciplined follow-up has produced, not a promise. */
export const BOOKED_MEETING_RATE_PCT = 77;

/** Cold-call answer rate, and what it falls to once a message has gone first. */
export const COLD_CALL_ANSWER_PCT = 17;
export const WARMED_CALL_ANSWER_PCT_MAX = 4;

/**
 * ⚠️ SPEED IS A HOUSE RULE, DELIBERATELY WITH NO NUMBER ATTACHED.
 *
 * Attempt 1 falls on day 0 — the day the lead arrives. The speed test in the
 * sample showed no clear effect: the fastest-contacted leads included both
 * wins and total failures, and several landlords engaged only after three to
 * seven weeks. That measurement is thin, and the business judgement is that
 * speed matters, so the rule stays.
 *
 * What it must NOT do is borrow the credibility of the three figures above.
 * Those are presented as measured; this is presented as how we expect leads to
 * be worked, with no percentage behind it. That is the difference between a
 * customer disagreeing with our advice and catching us out on a claim.
 */
export const SPEED_RULE =
  "Make the first call the day the lead arrives.";

/**
 * ⚠️ DE-PRIORITISE, NEVER DISCARD.
 *
 * Several landlords in the sample engaged only after three to seven weeks, so
 * the end of the ladder is the end of ACTIVE chasing and nothing more. The lead
 * stays in the pipeline, the operator keeps it, and nothing is deleted.
 */
export const AFTER_LAST_ATTEMPT =
  "Five attempts made — de-prioritised. Still here if they come back to you.";

/** Short label for a channel, e.g. on a badge. */
export function channelLabel(channel: ContactChannel): string {
  if (channel === "call") return "Call";
  if (channel === "whatsapp") return "WhatsApp";
  return "Email";
}

/** The attempt definition for a step number, or null past the end. */
export function attemptByNumber(n: number): ContactAttempt | null {
  return CONTACT_ATTEMPTS.find((a) => a.number === n) ?? null;
}

/**
 * The `lead_events` type a click on this channel produces.
 *
 * The inverse of `closeMatchingAttempt`'s mapping, kept here so the button and
 * the completion rule cannot disagree about which event belongs to which rung.
 */
export function eventTypeForChannel(
  channel: ContactChannel
): Extract<LeadEventType, "tel_click" | "whatsapp_click" | "mailto_click"> {
  if (channel === "call") return "tel_click";
  if (channel === "whatsapp") return "whatsapp_click";
  return "mailto_click";
}

/**
 * ⚠️ THE LANDLORD'S OWN STATED PREFERENCE OUTRANKS THE DEFAULT FIRST ATTEMPT.
 *
 * §41's referral email asks the landlord how they would like to be contacted
 * and stores the answer on the LEAD as `landlord_contact_method`
 * ('whatsapp' | 'email' | 'phone'). Having asked the question, opening with a
 * cold call anyway is indefensible — and it is very likely worse, since the
 * 17% figure describes landlords who were never asked.
 *
 * So the override applies to attempt 1 ONLY. The rest of the ladder is
 * unchanged: it is a sequence of different approaches, and a landlord who asked
 * for email has not asked never to be rung.
 *
 * Absence — which is every lead that predates §41 and every landlord who never
 * answered — leaves the default cold call in place.
 */
export function firstAttemptChannel(
  landlordContactMethod: string | null | undefined
): ContactChannel {
  if (landlordContactMethod === "email") return "email";
  if (landlordContactMethod === "whatsapp") return "whatsapp";
  // 'phone' agrees with the default, and so does null.
  return "call";
}

/** The sequence as the operator's own plan, with any preference applied. */
export function attemptsForLead(
  landlordContactMethod: string | null | undefined
): ContactAttempt[] {
  const first = firstAttemptChannel(landlordContactMethod);
  return CONTACT_ATTEMPTS.map((a) =>
    a.number === 1 && a.channel !== first
      ? {
          ...a,
          channel: first,
          objective:
            first === "email"
              ? "They asked to be contacted by email. Introduce yourself and ask whether the property is tenanted right now or sitting empty."
              : "They asked to be contacted by WhatsApp. Introduce yourself, name the property, and ask whether it is tenanted right now or sitting empty.",
          why: "This landlord told us how they would like to be contacted, so we lead with that rather than a cold call.",
        }
      : { ...a }
  );
}
