/**
 * What a Lead Brief customer is told about a top-up (batch 04 Phase 4), word
 * for word from docs/build/04-area-changes-pause-topups.md.
 *
 * ⚠️ IMPORT-FREE: the top-up panel and the emailed link's confirm button are
 * client components (the §21.8 rule).
 *
 * Shown to brief customers only, on both top-up screens: the dashboard's and
 * the emailed link's. Every other customer's top-up screen is unchanged.
 *
 * Not label or reason copy, so A9's ban on "top-up" does not reach it (the
 * notice is about buying one). The rest of A9 still does, and a test holds it
 * to that.
 */
export const BRIEF_TOPUP_NOTICE = {
  title: "How top-ups are delivered",
  body:
    "Top-up leads come from the closest matches to your brief, starting just outside your current area. " +
    "Your area's supply is already set by your plan, so a top-up won't add more leads inside it. " +
    "It extends how far your leads reach.",
} as const;
