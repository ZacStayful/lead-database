/**
 * The `/pay/[offerToken]` page's words (batch 02 Phase 4). Import-free, so the
 * A9 words-to-avoid scan and publishedClaims.test.ts can read it, and so a
 * client component could use it. Sentence case, no exclamation marks (02
 * locked decision 12).
 *
 * Plan lines and the discount sentence come from funnel/copy.ts, so the two
 * routes cannot describe the same plan or the same code differently.
 */
export const PAY_COPY = {
  choosePlanTitle: "Choose your plan",
  choosePlanIntro: "Pick the plan we talked about. You'll go to a secure Stripe page to pay.",
  continueWith: (leads: number) => `Continue with ${leads} leads a month`,
  cancelledTitle: "Payment not finished",
  cancelledBody: "Nothing has been taken. Choose a plan to try again, or book a call.",
  unavailableTitle: "We couldn't open payment just now",
  unavailableBody: "Please try again in a minute, or book a call and we'll get you set up.",
  bookCall: "Book a call",
} as const;
