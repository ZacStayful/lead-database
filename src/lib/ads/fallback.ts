import type { Question } from "./schemas";
import { questionForSlot } from "./slotCopy";
import { DEFAULT_TEMPLATE_ID, templateById, type AdTemplate } from "./templates";
import type { Resolution } from "./resolveSlots";

/**
 * What the chat asks when the model cannot (§65).
 *
 * ⚠️ AN EMPTY QUESTION LIST IS A SUCCESS IN §50 AND A FAILURE HERE, and that
 * is the difference worth stating. A support ticket with no clarification is
 * still a ticket that sends; an ad with no answers cannot be built at all. So
 * every degraded path — no API key, a timeout, malformed output, the budget
 * gone — lands on a real questionnaire rather than on nothing.
 */

export const FALLBACK_REASON =
  "This one asks a question rather than making a claim, which is the safest place to start.";

/**
 * Only what is genuinely missing, in the template's own order.
 *
 * ⚠️ IT MUST SHRINK AS THE PROFILE FILLS. That is the whole promise of the
 * setup/ad slot split — a second ad asks fewer questions — and a fallback that
 * re-asks everything every time would make the promise false on exactly the
 * days the model is down.
 */
export function fallbackQuestionnaire(template: AdTemplate, resolution: Resolution): Question[] {
  const out: Question[] = [];

  // Targeting first: it decides which headline form the rest is written for.
  if (resolution.targeting.kind !== "areas" || resolution.slots.city === undefined) {
    out.push({
      id: `q${out.length + 1}`,
      question: "Should the ad name a town or city, or run without one?",
      options: ["Name a town or city", "Run it without a place name"],
      allowOther: true,
      slot: "city",
      depth: 0,
      calls: 0,
    });
  }

  for (const slot of resolution.missing) {
    const q = questionForSlot(slot, template);
    if (!q) continue;
    out.push({
      id: `q${out.length + 1}`,
      question: q.question,
      options: q.options,
      allowOther: q.allowOther,
      slot,
      depth: 0,
      calls: 0,
    });
  }

  return out;
}

/** The template a failed pick falls back to, with a reason a customer can read. */
export function fallbackTemplate(): { template: AdTemplate; reason: string } {
  return { template: templateById(DEFAULT_TEMPLATE_ID)!, reason: FALLBACK_REASON };
}
