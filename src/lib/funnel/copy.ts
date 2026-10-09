/**
 * The funnel's customer-facing copy (batch 02). One place, so the A9 words-to-
 * avoid scan (leadBrief/__tests__/briefCopy.test.ts) and publishedClaims.test.ts
 * can read it. Sentence case, no exclamation marks (02 locked decision 12).
 *
 * ⚠️ Import-free: the funnel screens are client components (§21.8's rule).
 */
export const FUNNEL_COPY = {
  /** On /login?notice=already_set_up (02 Phase 2). */
  alreadySetUp: "You're already set up. Log in to see your leads.",
  /** /start/[token] while the funnel is switched off. */
  unavailableTitle: "This page isn't available right now",
  unavailableBody: "Book a call and we'll take you through it.",
  /** /start/[token] before the Phase 3 screens exist. */
  comingSoonTitle: "Your lead preview",
  comingSoonBody: "We're finishing this page. Book a call and we'll take you through your preview.",
  bookCall: "Book a call",
} as const;
