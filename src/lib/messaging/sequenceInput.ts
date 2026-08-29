/**
 * Validating a sequence an operator has typed (§40.13).
 *
 * Pure, and separate from the routes, so the create and the update cannot
 * disagree about what a valid ladder is — the `cancelOptions.ts` discipline,
 * where a CHECK constraint and a TypeScript list are held equal by a test.
 *
 * ⚠️ THE LIMITS HERE ARE ABOUT THE LANDLORD, NOT ABOUT US. Six steps at three
 * days apart is over a fortnight of being messaged by a stranger who has had no
 * reply. That is the point at which chasing stops being follow-up and starts
 * being the behaviour that gets a number reported — and the number is the
 * operator's own.
 */
import { validateTemplate } from "./mergeFields";

/** Past this it is harassment, not follow-up. */
export const MAX_STEPS = 6;
/** Two steps in one day from one number is the burst profile, not a sequence. */
export const MIN_DELAY_DAYS_AFTER_FIRST = 1;
export const MAX_DELAY_DAYS = 90;
export const MAX_NAME_CHARS = 80;
export const MAX_BRIEF_CHARS = 200;

export interface SequenceStepInput {
  delay_days: number;
  brief: string | null;
  /** 'ai' = the model writes it per lead; 'manual' = body_template is filled in. */
  mode: "ai" | "manual";
  /**
   * The operator's own words, with {{fields}} unresolved. Kept even on an 'ai'
   * step so switching a step to AI and back does not destroy what they wrote.
   */
  body_template: string | null;
}

export type SequenceInputVerdict =
  | { ok: true; name: string; steps: SequenceStepInput[] }
  | { ok: false; error: string };

/**
 * ⚠️ `hasBookingLink` has to be passed in, not looked up here. This module is
 * pure so it can be tested without a client, and it is the one place both the
 * create and the update route agree about what a valid ladder is — the
 * `cancelOptions.ts` discipline. The caller reads the customer row; this
 * decides.
 */
export function validateSequenceInput(input: {
  name?: unknown;
  steps?: unknown;
  hasBookingLink?: boolean;
  /** Decides which merge fields exist — the analysis figures are management-only. */
  leadType?: string;
}): SequenceInputVerdict {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) return { ok: false, error: "Give the sequence a name." };
  if (name.length > MAX_NAME_CHARS) {
    return { ok: false, error: `Keep the name under ${MAX_NAME_CHARS} characters.` };
  }

  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    return { ok: false, error: "A sequence needs at least one message." };
  }
  if (input.steps.length > MAX_STEPS) {
    return {
      ok: false,
      error: `${MAX_STEPS} messages is the most we will send one landlord. Beyond that it stops reading as follow-up.`,
    };
  }

  const steps: SequenceStepInput[] = [];
  for (let i = 0; i < input.steps.length; i += 1) {
    const raw = input.steps[i] as { delay_days?: unknown; brief?: unknown };
    const delay = Number(raw?.delay_days);
    if (!Number.isFinite(delay) || !Number.isInteger(delay)) {
      return { ok: false, error: `Message ${i + 1} needs a whole number of days.` };
    }
    // The FIRST step may be zero — that is "message them as soon as they are
    // assigned", which is half of what this feature was asked for. Every step
    // after it must be at least a day, or the ladder becomes a burst.
    const min = i === 0 ? 0 : MIN_DELAY_DAYS_AFTER_FIRST;
    if (delay < min) {
      return {
        ok: false,
        error:
          i === 0
            ? "The first message cannot be scheduled in the past."
            : `Leave at least a day between messages. Message ${i + 1} is set to ${delay}.`,
      };
    }
    if (delay > MAX_DELAY_DAYS) {
      return {
        ok: false,
        error: `${MAX_DELAY_DAYS} days is the longest gap. A landlord will not remember you after that.`,
      };
    }

    const brief =
      typeof raw?.brief === "string" && raw.brief.trim()
        ? raw.brief.trim().slice(0, MAX_BRIEF_CHARS)
        : null;

    // Defaults to 'ai', which is also the column default — so a caller that
    // knows nothing about modes produces exactly today's behaviour.
    const mode = (raw as { mode?: unknown })?.mode === "manual" ? "manual" : "ai";
    const rawTemplate = (raw as { body_template?: unknown })?.body_template;
    const template =
      typeof rawTemplate === "string" && rawTemplate.trim() ? rawTemplate.trim() : null;

    if (mode === "manual") {
      if (!template) {
        return {
          ok: false,
          error: `Message ${i + 1} is set to your own words but has no text in it.`,
        };
      }
      // One definition of a valid template, shared with the preview route and
      // the drafting cron. Refuses an unknown field, a typed URL and an
      // over-long message — see mergeFields.ts for why those three and not the
      // model's own rules.
      const verdict = validateTemplate(template, {
        hasBookingLink: Boolean(input.hasBookingLink),
        leadType: input.leadType,
      });
      if (!verdict.ok) {
        return { ok: false, error: `Message ${i + 1}: ${verdict.error}` };
      }
    }

    steps.push({ delay_days: delay, brief, mode, body_template: template });
  }

  return { ok: true, name, steps };
}
