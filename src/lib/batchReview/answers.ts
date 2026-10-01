/**
 * The monthly lead-batch review (§73): what a customer can say about each lead.
 *
 * ⚠️ IMPORT-FREE, and it must stay that way. `BatchReviewForm` is a
 * `"use client"` component and `vitest.config.mts` is PURE UNITS ONLY, so a
 * rule living in the component would be a rule no test can reach (§21.8,
 * §51.6, §69).
 *
 * The vocabulary is the union both products draw from; `answersFor()` says
 * which apply where. The SQL CHECK on lead_batch_review_items.answer must equal
 * `ALL_ANSWERS` exactly, and a test reads the migration to make sure it does,
 * because a value the CHECK refuses fails the whole submission.
 */

export type LeadTypeKey = "management" | "guaranteed_rent";

export const ALL_ANSWERS = [
  "not_called",
  "no_answer",
  "not_interested",
  "talking",
  "meeting_booked",
  "meeting_held",
  "viewing_booked",
  "contract_sent",
  "likely_later",
  "signed",
] as const;

export type BatchAnswer = (typeof ALL_ANSWERS)[number];

export const DEAD_REASONS = [
  "couldnt_reach",
  "with_other_company",
  "not_letting",
  "wrong_details",
  "numbers_dont_work",
  "other",
] as const;

export type DeadReason = (typeof DEAD_REASONS)[number];

export interface AnswerOption {
  value: BatchAnswer;
  label: string;
}

/** Ordered as the conversation goes: untouched, then nowhere, then onwards. */
const MANAGEMENT: AnswerOption[] = [
  { value: "not_called", label: "Not called yet" },
  { value: "no_answer", label: "Couldn't reach them" },
  { value: "not_interested", label: "Not interested" },
  { value: "talking", label: "Interested, talking" },
  { value: "meeting_booked", label: "Web meeting booked" },
  { value: "meeting_held", label: "Meeting held" },
  { value: "likely_later", label: "Likely to sign later" },
  { value: "signed", label: "Signed" },
];

const GUARANTEED_RENT: AnswerOption[] = [
  { value: "not_called", label: "Not called yet" },
  { value: "no_answer", label: "Couldn't reach them" },
  { value: "not_interested", label: "Not interested" },
  { value: "talking", label: "Interested, talking" },
  { value: "viewing_booked", label: "Viewing booked" },
  { value: "contract_sent", label: "Contract sent" },
  { value: "likely_later", label: "Likely to sign later" },
  { value: "signed", label: "Contract signed" },
];

export function answersFor(leadType: LeadTypeKey): AnswerOption[] {
  return leadType === "guaranteed_rent" ? GUARANTEED_RENT : MANAGEMENT;
}

export function isAnswerFor(leadType: LeadTypeKey, value: unknown): value is BatchAnswer {
  return answersFor(leadType).some((a) => a.value === value);
}

export const DEAD_REASON_LABELS: Record<DeadReason, string> = {
  couldnt_reach: "Never picked up",
  with_other_company: "Already with another company",
  not_letting: "No longer letting",
  wrong_details: "Wrong name or number",
  numbers_dont_work: "The numbers didn't work",
  other: "Something else",
};

export function isDeadReason(value: unknown): value is DeadReason {
  return typeof value === "string" && (DEAD_REASONS as readonly string[]).includes(value);
}

/** The two answers that ask "why did it go nowhere". */
export function asksForReason(answer: BatchAnswer | null | undefined): boolean {
  return answer === "no_answer" || answer === "not_interested";
}

/**
 * ⚠️ Called / not called is DERIVED and never asked separately. Asking twice
 * invites the two answers to disagree, and "called but not called" is not a
 * fact anyone can act on.
 */
export function wasCalled(answer: BatchAnswer | null | undefined): boolean | null {
  if (!answer) return null;
  return answer !== "not_called";
}

/** The comparison every result is read against (§73): what each product's own landing page says. */
export const CONVERSION_BENCHMARK: Record<LeadTypeKey, number> = {
  management: 0.05,
  guaranteed_rent: 0.1,
};

export const COMMENT_MAX = 2000;
