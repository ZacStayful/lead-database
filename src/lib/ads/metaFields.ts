/**
 * What Meta's creative actually takes, and what it does with it (§65).
 *
 * ⚠️ IMPORT-FREE. A client component renders the truncation marks, so this
 * file must not reach anything with a side effect — the split `deadLeadCopy.ts`
 * makes from `deadLeadPolicy.ts` (§51.6) and `featureRequest.ts` from
 * `announcements.ts` (§21.8).
 */

/**
 * The call-to-action button, as `ads_create_creative` spells it. Only the four
 * our templates use — this is not a mirror of Meta's whole enum, and it should
 * not become one: a value nothing selects is a value nothing tests.
 *
 * Verified against the live tool schema on 2026-09-21 rather than recalled.
 * ASK_A_QUESTION is real, which is why T6 gets it instead of a vaguer
 * CONTACT_US: "Ask what applies to your property" is literally asking a
 * question, and the button ought to say so.
 */
export const META_CTA_TYPES = [
  "CONTACT_US",
  "ASK_A_QUESTION",
  "GET_QUOTE",
  "LEARN_MORE",
] as const;
export type MetaCtaType = (typeof META_CTA_TYPES)[number];

/**
 * ⚠️ THESE ARE TRUNCATION MARKS, NOT LIMITS, AND REJECTING ON THEM WOULD FAIL
 * NEARLY EVERY GENERATION. Meta shortens the rendered ad around these points
 * and shows "… See more"; the API accepts far longer. None of T3's angles —
 * "the landlord who self-managed for six months" — fits 125 characters with
 * the audience and the category in the first sentence as well.
 *
 * So the UI draws them as marks on the text and the validator ignores them.
 */
export const META_TRUNCATION_MARKS = {
  message: 125,
  headline: 40,
  description: 30,
} as const;

/**
 * ⚠️ OUR BOUNDS, AND SAID PLAINLY BECAUSE THEY ARE NOT META'S.
 *
 * The plan called these "the real API maxima". They could not be verified:
 * `ads_create_creative`'s schema documents no character limit on `message`,
 * `headline` or `description`, and an unverified number stated as Meta's would
 * be exactly the kind of borrowed authority §51.11 had to strip out of the
 * published policy pages.
 *
 * These are chosen to bound what the model may return — generously, so a good
 * generation is never rejected for length — and the validator rejects past
 * them. If Meta's own maxima are ever established, they replace these and the
 * comment goes with them.
 */
export const AD_COPY_MAX = {
  message: 2200,
  headline: 255,
  description: 255,
} as const;

/** The shape stored in `ad_drafts.copy`, named for the API it is mapped onto. */
export type AdCopy = {
  message: string;
  headline: string;
  description: string;
  call_to_action_type: MetaCtaType;
  link_url: string;
};

export function isMetaCtaType(value: unknown): value is MetaCtaType {
  return typeof value === "string" && (META_CTA_TYPES as readonly string[]).includes(value);
}

/** Where the rendered ad is shortened, for the marks the composer draws. */
export function truncationPoint(field: keyof typeof META_TRUNCATION_MARKS, text: string): number | null {
  const mark = META_TRUNCATION_MARKS[field];
  return text.length > mark ? mark : null;
}
