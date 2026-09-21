import type { AdSlotKey, AdTemplate } from "./templates";

/**
 * How each slot is asked for when the model is not available to ask it (§65).
 * ⚠️ IMPORT-FREE apart from types — the chat renders these.
 *
 * The model normally writes the questions, in the operator's own words and
 * against their own account. This is the floor underneath that, and it has to
 * be answerable by the same person on a worse day.
 */

export type SlotQuestion = { question: string; options: string[]; allowOther: boolean };

export const SLOT_QUESTIONS: Partial<Record<AdSlotKey, SlotQuestion>> = {
  company_name: {
    question: "What name should the ad go out under?",
    options: [],
    allowOther: true,
  },
  city: {
    question: "Which town or city should the ad name?",
    options: [],
    allowOther: true,
  },
  areas: {
    question: "Which areas do you cover? However you would say it to a landlord.",
    options: [],
    allowOther: true,
  },
  destination: {
    question:
      "When a landlord taps the button on your ad, where should they land — a page on your own website, or a form inside Facebook?",
    options: ["A page on my own website", "A form inside Facebook"],
    allowOther: true,
  },
  landing_url: {
    question: "Where should the button send them?",
    options: [],
    allowOther: true,
  },
  fee_public: {
    question: "Do you want your fee on the ad?",
    options: ["Yes, put the fee on it", "No, keep the fee off"],
    allowOther: false,
  },
  fee_pct: {
    question: "What is your management fee, as a percentage?",
    options: [],
    allowOther: true,
  },
  fee_basis: {
    question: "Is that fee taken on the gross or the net?",
    options: ["Of gross", "Of net"],
    allowOther: false,
  },
  fee_vat: {
    // ⚠️ Asked because a bare "15%" is a different price either way, and the
    // landlord reading the ad cannot tell which.
    question: "Is that percentage before or after VAT?",
    options: ["Plus VAT", "Including VAT", "Rather not say"],
    allowOther: false,
  },
  councils: {
    question: "Which councils do you deal with? They go on the card as plain text.",
    options: [],
    allowOther: true,
  },
  property_types: {
    question: "What kinds of property do you take on?",
    options: ["Flats and apartments", "Houses", "Both"],
    allowOther: true,
  },
  turnaround: {
    question: "How quickly do you normally get back to an enquiry?",
    options: ["Same day", "Within 24 hours", "Within 48 hours"],
    allowOther: true,
  },
  years_trading: {
    question: "How many years have you been doing this?",
    options: [],
    allowOther: true,
  },
  properties_managed: {
    question: "How many properties do you look after right now?",
    options: [],
    allowOther: true,
  },
  review_score: {
    question: "What is your Google review score?",
    options: [],
    allowOther: true,
  },
  review_count: {
    // ⚠️ The spec: "The review score always renders with its count." A score
    // without one is the oldest trick in the book.
    question: "How many reviews is that score out of?",
    options: [],
    allowOther: true,
  },
};

/** The multi-selects are asked from the template's own vocabulary. */
export function serviceQuestion(t: AdTemplate): SlotQuestion | null {
  if (!t.services) return null;
  const question =
    t.services.slot === "handled"
      ? "Which of these do you actually handle? Only what you tick can appear on the ad."
      : "Which of these are included in what you do? Only what you tick can appear on the ad.";
  return { question, options: t.services.options.map((o) => o.label), allowOther: false };
}

export function questionForSlot(slot: AdSlotKey, t: AdTemplate): SlotQuestion | null {
  if (t.services && slot === t.services.slot) return serviceQuestion(t);
  return SLOT_QUESTIONS[slot] ?? null;
}

/**
 * A slot's name, as an operator would read it.
 *
 * ⚠️ NEVER SHOW THE RAW KEY. "We still need: landing_url, review_count" is a
 * database column list in front of a customer, and the fix for it is a
 * sentence rather than a snake_case string.
 */
export const SLOT_LABELS: Partial<Record<AdSlotKey, string>> = {
  company_name: "the name the ad goes out under",
  city: "a town or city to name",
  areas: "the areas you cover",
  destination: "where the button should send people",
  landing_url: "a page for the button to point at",
  fee_pct: "your fee",
  fee_basis: "whether the fee is on gross or net",
  fee_vat: "how VAT is treated",
  fee_public: "whether the fee goes on the ad",
  included: "what is included",
  handled: "what you handle",
  councils: "the councils you deal with",
  property_types: "the property types you take on",
  turnaround: "how quickly you reply",
  years_trading: "how long you have been trading",
  properties_managed: "how many properties you look after",
  review_score: "your review score",
  review_count: "how many reviews that is out of",
  included_list: "what is included",
  handled_list: "what you handle",
};

export function slotCopyLabel(slot: string): string {
  return SLOT_LABELS[slot as AdSlotKey] ?? slot.replace(/_/g, " ");
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

/**
 * `Resolution.warnings` in English.
 *
 * ⚠️ THE ARRAY WAS COMPUTED AND RENDERED NOWHERE. `resolveSlots` has always
 * flagged a fee outside the usual range, and the only reader was `brief.ts`,
 * which writes the raw key into the model's prompt. So an operator whose deck
 * fee is 45% had it dropped off every ad, and the one place that said why was
 * a string the model read and they never saw.
 *
 * ⚠️ NEVER THE RAW KEY, for the reason above `SLOT_LABELS`. An unknown flag
 * yields NOTHING rather than `fee_not_a_number` — a warning we cannot word is
 * one nobody can act on, and it is not worth showing a column name to say so.
 */
export const AD_WARNING_COPY: Record<string, string> = {
  fee_outside_usual_range:
    "Your saved fee is outside the 8% to 30% most managers charge. It'll still be used — worth a look if that wasn't intended.",
  fee_looks_like_a_typo:
    "The fee on file is outside the 8% to 30% most managers charge, so it's being left off the ad in case it was a typo.",
  fee_out_of_range: "The fee on file isn't a percentage anyone can charge, so it's being left off the ad.",
  fee_not_a_number: "The fee on file isn't a number, so it's being left off the ad.",
};

/** The sentences for a resolution's flags, in order, skipping any we cannot word. */
export function warningSentences(warnings: string[]): string[] {
  return warnings.map((w) => AD_WARNING_COPY[w]).filter(Boolean);
}
