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

/**
 * ⚠️ THE IMAGE IS A CANVAS, SO ITS TWO FIELDS DO HAVE A REAL CEILING — and
 * unlike the three above it is ours to enforce because nothing else will.
 *
 * `layout.ts` sizes the headline down in three steps and then stops (64 → 56 →
 * 48px, at 58 and 84 characters), and neither the headline nor the sub carries
 * a `lineClamp`. So a 200-character headline renders at the smallest step,
 * runs off the bottom of the card, and returns a perfectly valid PNG — §65.3's
 * failure mode exactly. These were not needed while the headline came from
 * `templates.ts`; they are needed now the model writes it.
 *
 * ≈3 lines at the smallest step for the headline, ≈2.5 for the sub.
 */
export const AD_IMAGE_MAX = {
  headline: 110,
  sub: 140,
} as const;

/**
 * What may be DRAWN, as opposed to what may be published.
 *
 * ⚠️ `sanitiseForFont` DELETES a character the shipped fonts do not cover,
 * silently, and then collapses the gap — so a model-written em dash in an
 * uncovered face would render as a missing word rather than as an error.
 * Measured on the real bytes: the shared coverage is 312 codepoints and
 * includes every punctuation mark below, so this is a bound on the unusual
 * rather than a restriction on ordinary English.
 *
 * ⚠️ IT IS NOT A SECOND COPY OF THE COVERAGE SET, AND MUST NOT BECOME ONE.
 * This file is import-free (the composer renders the truncation marks), so it
 * cannot read the font bytes. `fonts.test.ts` asserts every character here is
 * in `AD_FONT_COVERAGE`, which is where a drift fails — the arrangement §37.1
 * uses to pin the derived palette against the hexes it replaced.
 */
export const AD_IMAGE_CHARSET =
  /^[\x20-\x7E\u00A3\u00A9\u00AE\u00B0\u00B7\u00BD\u00E0-\u00FF\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026\u2192\u20AC\n]*$/;

/**
 * One primary text, with the Meta headline and description that go under the
 * image beside it.
 *
 * ⚠️ PAIRED, NOT THREE INDEPENDENT LISTS. Pairing gives a unit of rejection and
 * a unit of publishing: one variant that breaks a rule loses one variant, and
 * what Meta is handed is a whole ad rather than a text and a headline that were
 * never written for each other.
 */
export type AdVariant = {
  /** The template's own stable key. Checked against a closed list on the way in. */
  angle_key: string;
  /** The angle's prose name, resolved from the key when the copy is stored, so
   *  the result page can label a variant without a lookup and the record still
   *  reads as English a year later. */
  angle: string;
  message: string;
  headline: string;
  description: string;
};

/**
 * The shape stored in `ad_drafts.copy`, named for the API it is mapped onto.
 *
 * ⚠️ AN OBJECT AT THE TOP LEVEL, NOT AN ARRAY. `0156_ad_builder.sql:181`
 * constrains `copy` to `jsonb_typeof(copy) = 'object'`, so a bare array of
 * variants fails the CHECK. That is also what makes this need no migration.
 *
 * ⚠️ `image` IS PER AD, NOT PER VARIANT, and that is Meta's own shape rather
 * than a simplification: one creative image carries several primary texts to
 * test against each other. Five on-image headlines would mean five renders per
 * ratio for one ad, and fifteen once three concepts land.
 */
export type AdCopy = {
  image: { headline: string; sub: string };
  variants: AdVariant[];
  call_to_action_type: MetaCtaType;
  link_url: string;
  /**
   * ⚠️ STORED, NOT RETURNED, AND THAT IS THE WHOLE POINT OF IT BEING HERE.
   *
   * `AdChat` renders from the server-rendered `draft.copy`, so anything handed
   * back in a route's JSON body is gone the moment `router.refresh()` runs —
   * which is exactly what happened to `degraded`, returned by three routes and
   * read by none. A claim about how much of an ad a model actually wrote has
   * to survive a reload, because the sentence it governs — "the words were
   * drafted by AI" — is on the page after every reload.
   */
  provenance: {
    /** Variants the model wrote and that survived validation. */
    written: number;
    /** Angles it was offered. `written < offered` is honest, not a failure. */
    offered: number;
    /** Whether the on-image lines are the model's or the template's example. */
    image: "model" | "example";
  };
};

export function isMetaCtaType(value: unknown): value is MetaCtaType {
  return typeof value === "string" && (META_CTA_TYPES as readonly string[]).includes(value);
}

/** Where the rendered ad is shortened, for the marks the composer draws. */
export function truncationPoint(field: keyof typeof META_TRUNCATION_MARKS, text: string): number | null {
  const mark = META_TRUNCATION_MARKS[field];
  return text.length > mark ? mark : null;
}
