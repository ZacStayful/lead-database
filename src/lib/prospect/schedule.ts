/**
 * WHEN EACH CHASE GOES OUT, AND ON WHICH CHANNEL (§55).
 *
 * Pure — no client, no clock of its own, no environment. Everything here is a
 * function of `enquiredAt`, `now` and what has already been claimed, so the
 * whole ladder is testable without a database.
 *
 * ⚠️ PLAIN ELAPSED TIME, DELIBERATELY. There is no working-day arithmetic and
 * no quiet-hours deferral in this module, because the decision taken for this
 * feature is that both channels fire immediately whatever the hour. §40.12's
 * 09:00–20:00 window still exists and is still the rule for landlord
 * messaging; the override is applied at the send, explicitly and by name, so a
 * reader sees a choice rather than an omission. Putting it here instead would
 * hide it in arithmetic.
 */

export type ProspectChannel = "whatsapp" | "email";

export interface ProspectStep {
  step: 1 | 2 | 3;
  /** Milliseconds after the enquiry. */
  afterMs: number;
  channels: readonly ProspectChannel[];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * ⚠️ THE LADDER, AND THE ONE PLACE ITS SHAPE LIVES.
 *
 * Step 1 is both channels because the brief is that a WhatsApp and an email
 * land together, about two minutes after enquiring — while they are still at
 * the screen they just filled the form in on.
 *
 * Steps 2 and 3 are ONE CHANNEL EACH. Three emails in three days is what gets
 * a sending domain marked as spam, and the WhatsApp is the one that actually
 * gets read; alternating also ends on the channel somebody can reply to at
 * leisure. Change `channels` here and every caller follows — the cron reads
 * this array and nothing restates it.
 */
export const PROSPECT_STEPS: readonly ProspectStep[] = [
  { step: 1, afterMs: 2 * MINUTE, channels: ["whatsapp", "email"] },
  { step: 2, afterMs: 24 * HOUR, channels: ["whatsapp"] },
  { step: 3, afterMs: 48 * HOUR, channels: ["email"] },
] as const;

/** The last rung. Reaching it with nothing booked completes the ladder. */
export const FINAL_STEP = PROSPECT_STEPS[PROSPECT_STEPS.length - 1].step;

/** A claim already in `prospect_nudge_sends`, as `${step}:${channel}`. */
export function claimKey(step: number, channel: ProspectChannel): string {
  return `${step}:${channel}`;
}

export function dueAt(enquiredAt: Date, step: ProspectStep): Date {
  return new Date(enquiredAt.getTime() + step.afterMs);
}

export type ProspectWork =
  | { kind: "due"; step: 1 | 2 | 3; channels: ProspectChannel[] }
  | { kind: "waiting"; nextDueAt: Date }
  | { kind: "complete" };

/**
 * What, if anything, this ladder owes right now.
 *
 * Walks the steps in order and returns the FIRST one that is both due and
 * incomplete. Earliest-first matters: a ladder whose step 1 failed to send
 * must retry step 1 rather than skipping ahead to step 2 because the clock has
 * moved on — the prospect would otherwise get "didn't manage to get you in the
 * diary yesterday" as the first thing they ever hear from us.
 *
 * `sent` is the set of claim keys that already exist, which is the same thing
 * whether the send succeeded or is still being retried: a claimed row means
 * the provider has already been called once for that channel, and the claim is
 * what stops it being called again.
 */
export function prospectWork(
  enquiredAt: Date,
  now: Date,
  sent: ReadonlySet<string>
): ProspectWork {
  let nextDueAt: Date | null = null;

  for (const step of PROSPECT_STEPS) {
    const outstanding = step.channels.filter(
      (c) => !sent.has(claimKey(step.step, c))
    );
    if (outstanding.length === 0) continue;

    const due = dueAt(enquiredAt, step);
    if (due.getTime() <= now.getTime()) {
      return { kind: "due", step: step.step, channels: outstanding };
    }
    // The first step still in the future is what we are waiting for.
    if (!nextDueAt) nextDueAt = due;
  }

  if (nextDueAt) return { kind: "waiting", nextDueAt };
  return { kind: "complete" };
}
