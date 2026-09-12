/**
 * How leads arrive, in words — one definition for the guide, the Today panel,
 * the packages page, the daily digest and the new-lead email (§54).
 *
 * ⚠️ IMPORT-FREE, and it must stay so: the Today panel and the packages card
 * are client components, and pacing.ts pulls in types that pull in
 * supabase-js. The same split featureRequest.ts makes from announcements.ts.
 *
 * Four surfaces saying the same promise is four chances to drift, and this is
 * a promise about MONEY — what a customer gets for £150 a month. The wording
 * here is deliberately modest: "one a working day" is the rule, not a
 * guarantee of supply, and nothing below promises a lead on any given day.
 */

/** The rule, as a headline. */
export const RELEASE_HEADLINE = "One lead a working day";

/** The rule, as a sentence a customer can be shown anywhere. */
export const RELEASE_RULE =
  "Your month's leads arrive one per working day, Monday to Friday, rather than all at once on your renewal date — so each one gets your attention while the landlord is still fresh from enquiring.";

/** What a 10-lead plan gets, since "one a day" is not quite true for it. */
export const RELEASE_TEN_PLAN =
  "On a 10-lead plan that works out at one every other working day.";

/** What happens when supply is short for a while. */
export const RELEASE_CATCH_UP =
  "If there is nothing suitable in stock on a given day, nothing is lost: the leads you are owed catch up over the following days, a couple a day at most, so you never get a pile at once.";

/** Holds, in words. */
export const RELEASE_HOLD =
  "Away for a few days? Set a hold in Settings and your leads wait until the date you choose. Billing and credits are untouched; delivery simply pauses and catches up when you are back.";

/** The one thing it is not. */
export const RELEASE_NOT_A_GUARANTEE =
  "Leads come from real landlord enquiries, so a working day with no suitable lead is possible. Unused credits still carry forward.";

export const RELEASE_POINTS: readonly string[] = [
  RELEASE_RULE,
  RELEASE_TEN_PLAN,
  RELEASE_CATCH_UP,
  RELEASE_HOLD,
  RELEASE_NOT_A_GUARANTEE,
];

/** The packages-page highlight, kept short. */
export const RELEASE_HIGHLIGHT = "Delivered one a working day, not as a monthly batch";

/** Subject prefix for the new-lead email once the daily release is on. */
export const TODAYS_LEAD_SUBJECT_PREFIX = "Your lead for today";
