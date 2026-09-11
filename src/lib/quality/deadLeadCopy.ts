/**
 * The three reasons, their wording, and the length floor — the only parts of
 * §51 a browser needs.
 *
 * ⚠️ THIS FILE MUST STAY IMPORT-FREE. `DeadLeadClaimCard` is a "use client"
 * component, and `deadLeadPolicy.ts` reaches `plans.ts` through `products.ts`
 * for the allowance arithmetic — server-side reasoning that has no business in
 * a client bundle. `featureRequest.ts` is split from `announcements.ts` for
 * exactly this reason (§21.8).
 *
 * `deadLeadPolicy.ts` re-exports all of it, so there is still one definition
 * and the form, the route and the CHECK on `lead_quality_claims.reason` cannot
 * drift apart.
 */

/**
 * Mirrors the CHECK on `lead_quality_claims.reason` and the `report` branch of
 * `lead_outcome_reasons_reason_check`, both widened by 0139.
 *
 * ⚠️ THREE OF THESE ARE DISTINCT SOURCING FAILURES, which is the whole reason
 * they are separate rather than folded into `no_longer_interested`:
 * `never_interested` means the landlord was never a prospect for the service
 * at all, `property_sold` means the property itself is gone rather than the
 * letting intent, and `wrong_details` is a DATA fault pointing at the ingest
 * source where `unreachable` points at a number nobody answers. Collapsing any
 * pair loses the distinction the analysis on /admin/quality groups by.
 */
export const DEAD_LEAD_REASONS = [
  "already_with_operator",
  "never_interested",
  "no_longer_interested",
  "property_sold",
  "unreachable",
  "wrong_details",
] as const;
export type DeadLeadReason = (typeof DEAD_LEAD_REASONS)[number];

export const DEAD_LEAD_REASON_LABELS: Record<DeadLeadReason, string> = {
  /**
   * ⚠️ THE TIMING IN THIS LABEL IS LOAD-BEARING, and it is not a duplicate of
   * `CLOSE_REASONS.sorted_elsewhere` ("Already sorted with someone else").
   * `leadOutcomes.ts` carries the warning in full: those two are near-identical
   * sentences with OPPOSITE money outcomes, one a bad lead and one a lost deal,
   * and nobody noticed while they sat at opposite ends of the page.
   *
   * A second reason for "has SINCE gone with someone else" was asked for and
   * deliberately not built — it would sit one click from this one and pay
   * differently. The AGE decides instead (see REASON_WINDOW_DAYS), because an
   * age is objective and a timing adjective is not.
   */
  already_with_operator:
    "They had already gone with another management company before I got through",
  never_interested: "They were never interested in the service",
  no_longer_interested: "They are no longer letting the property",
  property_sold: "The property is sold or being sold",
  unreachable: "The contact details do not reach them",
  wrong_details: "The details were wrong — wrong name, property or postcode",
};

/**
 * The shortest useful account of what the landlord said. Enforced again inside
 * `apply_dead_lead_claim`, because the detail is the entire basis for tracing a
 * dead lead back to where it came from — which is the half of this feature that
 * improves the leads rather than merely refunding them.
 */
export const MIN_DETAIL_LENGTH = 20;

/**
 * The control's own label. §51.6 fixes this wording — it is a REPORT, never
 * "reject with a reason" — and it is now needed in two places (the prompt and
 * the outcome panel), so it is one constant rather than two literals.
 */
export const DEAD_LEAD_CONTROL_LABEL = "This landlord was already gone";

/**
 * The prompt at the top of a lead the operator keeps coming back to.
 *
 * ⚠️ IT NAMES NO CREDIT. The split matters and must be maintained: the prompt
 * is unsolicited, so leading with a credit turns discovery into an inducement
 * to fish, which is what §51's hidden allowance exists to prevent. The
 * confirmation below MAY name it, because by then the operator has chosen to
 * report and has written what the landlord said — stating the outcome there is
 * informed consent rather than an offer.
 *
 * ⚠️ IT NEVER NAMES THE TRIGGER. "You have been back to this a few times"
 * hands over the recipe for summoning it, which is the same mistake as
 * publishing the allowance one level down.
 */
export const DEAD_LEAD_PROMPT_HEADING = "Was this landlord already gone?";
export const DEAD_LEAD_PROMPT_BODY =
  "If they had already appointed someone, or had stopped letting, before you got through — tell us what they said. We trace it back to the source it came from.";
export const DEAD_LEAD_PROMPT_DISMISS = "Not this one";

/**
 * Shown immediately above the submit button, so nobody consents without being
 * told the outcome. Before §51.10 the credit was first named in the success
 * message — after the fact.
 *
 * ⚠️ It must read the same whether the claim will auto-uphold or go to review.
 * Those two paths are deliberately worded so the operator cannot tell them
 * apart, and a confirmation that promised an immediate credit would leak which
 * one fired.
 *
 * ⚠️ IT NAMES BOTH OUTCOMES AND PROMISES NEITHER, and the difference matters.
 * Until 0139 this said only "the credit goes back", because a replacement was
 * not a thing the database could record — `resolution` had no such value, and
 * a test forbade the word outright. A swap is now a real outcome, so saying
 * only "credit" would be the same kind of untruth §51.11 had to strip out of
 * the published policy pages.
 *
 * What it must NOT become is a promise. "We'll send you a replacement" turns
 * every report into a request for a better lead, which is precisely what the
 * hidden per-customer allowance exists to prevent — and management stock
 * cannot absorb it: about 70 leads carry a free slot, and each swap consumes
 * two of them. So: "either ... or", decided by us, with no commitment to
 * which. `deadLeadPolicy.test.ts` asserts both halves of that.
 */
export const DEAD_LEAD_CONFIRM_CONSEQUENCE =
  "We'll look into this one. If it stands up we'll either put the credit back on your account or send you a different lead in its place — whichever fits what we find.";

/**
 * How far back each reason can reach, in days since the lead was assigned.
 *
 * ⚠️ THE SEVEN IS THE WHOLE RULE FOR THE COMPETITOR REASON, and it is why that
 * reason was not duplicated. If a landlord appointed someone else inside the
 * first week, the operator never really got to pitch and the lead is arguably
 * void. After that they had their chance and lost, which is a lost deal — real
 * value delivered, chargeable under invariant 4, and what "Didn't work out" is
 * for.
 *
 * Everything else keeps the fortnight. An unreachable number or a sold
 * property is a fact that stays true however long the operator held the lead,
 * so binning a genuine claim because they got to it on day nine would be
 * arbitrary.
 *
 * ⚠️ Enforced in SQL, not here. The route passes the number below into BOTH
 * `claimable_dead_lead_assignments` and `apply_dead_lead_claim`, and the latter
 * re-asserts eligibility under its row lock — so this map decides what the form
 * OFFERS and the database decides what it ACCEPTS. A file-text guard in
 * `deadLeadPolicy.test.ts` pins the route to `windowDaysForReason`, because
 * reverting that one token would silently restore a fortnight to the one reason
 * that must not have it, and no behavioural test could see it.
 */
export const CLAIM_WINDOW_DAYS = 14;
export const COMPETITOR_WINDOW_DAYS = 7;

export const REASON_WINDOW_DAYS: Record<DeadLeadReason, number> = {
  already_with_operator: COMPETITOR_WINDOW_DAYS,
  never_interested: CLAIM_WINDOW_DAYS,
  no_longer_interested: CLAIM_WINDOW_DAYS,
  property_sold: CLAIM_WINDOW_DAYS,
  unreachable: CLAIM_WINDOW_DAYS,
  wrong_details: CLAIM_WINDOW_DAYS,
};

/** The window a given reason reaches back over. */
export function windowDaysForReason(reason: DeadLeadReason): number {
  return REASON_WINDOW_DAYS[reason];
}

/**
 * What to ask for, per reason.
 *
 * ⚠️ "In their words" is nonsense on two of these and this is not decoration.
 * For `wrong_details` there was no landlord to quote — that is the point of the
 * reason — and for `property_sold` there often was not either. The 20-character
 * floor stays, because the detail is the entire basis for tracing a dead lead
 * back to its source, but a question nobody can answer honestly produces "n/a"
 * padded to twenty characters, which poisons exactly the dataset the floor
 * exists to protect.
 */
export const REASON_DETAIL_PROMPT: Record<DeadLeadReason, string> = {
  already_with_operator: "What did they say?",
  never_interested: "What did they say?",
  no_longer_interested: "What did they say?",
  property_sold: "What did they tell you, or how did you find out?",
  unreachable: "What happened when you tried — dead line, wrong person, no answer?",
  wrong_details: "What was wrong with the details?",
};

/**
 * Why the control is showing but cannot be used.
 *
 * ⚠️ Before this, an ineligible lead simply hid the control. That is worse than
 * it sounds: an operator who saw it last week and not this week reads it as
 * broken, and nobody learns the rule. The window is publishable policy, so
 * saying it plainly is what gets the feature used correctly.
 *
 * ⚠️ NONE OF THIS MAY NAME THE PER-CUSTOMER ALLOWANCE. That stays hidden for
 * the reason §51.3 gives — an operator told the number has been handed exactly
 * how many leads they can write off without evidence. `deadLeadPolicy.test.ts`
 * bans "allowance", "quota", "budget", "limit" and "remaining" from this file
 * with comments stripped, and "limit" in particular is ordinary English: write
 * "within 14 days of it arriving", never "past the 14-day limit".
 */
export const UNAVAILABLE_COPY = {
  already_reported: "You've already told us about this one.",
  not_worked:
    "Open the lead and try the landlord first — we can only look into a lead once you've actually worked it.",
  too_old:
    "This one's been with you too long for us to look into. We can only trace a lead back to where it came from within 14 days of it arriving.",
  too_old_for_reason:
    "This one's been with you over a week. If a landlord picks someone else after that, they had the chance to pick you — so it counts as a lost deal rather than a bad lead. \"Didn't work out\" is the one you want.",
  settled: "We've looked into this one.",
} as const;

export type UnavailableCode = keyof typeof UNAVAILABLE_COPY;
