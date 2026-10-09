/**
 * The funnel's customer-facing copy (batch 02). One place, so the A9 words-to-
 * avoid scan (leadBrief/__tests__/briefCopy.test.ts) and publishedClaims.test.ts
 * can read it. Sentence case, no exclamation marks (02 locked decision 12).
 *
 * ⚠️ Import-free apart from releaseCopy.ts, itself import-free: the funnel
 * screens are client components (§21.8's rule).
 *
 * What this copy must never say, each pinned by a test:
 *   - a volume, a count of leads in an area, or anything about our supply
 *     (02 locked decision 7);
 *   - anything about other operators beyond "up to three operators" (locked
 *     decision 12). Escalation can take a lead further (§18), so the FAQ says
 *     "normally" (decision C4, approved 9 Oct);
 *   - "within minutes": leads arrive one a working day (§54, C4);
 *   - a replacement lead: the rule is not decided (C7, the index), so the
 *     sentence is left out entirely.
 */
import { RELEASE_RULE, RELEASE_TEN_PLAN } from "@/lib/releaseCopy";

export const FUNNEL_COPY = {
  /** On /login?notice=already_set_up (02 Phase 2). */
  alreadySetUp: "You're already set up. Log in to see your leads.",
  /** /start/[token] while the funnel is switched off. */
  unavailableTitle: "This page isn't available right now",
  unavailableBody: "Book a call and we'll take you through it.",
  bookCall: "Book a call",

  // --- every screen ---------------------------------------------------------
  questionsLabel: "3 quick questions",
  previewLabel: "Your preview",
  bookCallInstead: "Book a call instead",
  sendToPartner: "Send to my partner",
  sendToPartnerHelp: "A read-only page with your answers and preview. It has no payment button and none of your contact details.",

  // --- the questions ----------------------------------------------------------
  intro:
    "Three quick questions about how you work. We use your answers to set the area your leads come from and to put your best matches first.",
  next: "Next",
  back: "Back",
  seePreview: "See your preview",
  showEverything: "No, show me everything",
  working: "Working out your area",
  postcodeLocked: "Your postcode is set for this link. To change it, book a call.",

  // --- the preview ------------------------------------------------------------
  previewTitle: "Your preview",
  previewIntro: "Here is how your leads would be matched on each plan.",
  planToggleLabel: "Show the preview for",
  planOption: (leads: number) => `${leads} leads a month`,
  previewAnyway:
    "You can still go ahead with these answers. Every lead you pay for is delivered, and if a month runs short the balance carries forward.",
  toWhy: "Why it works",
  changeAnswers: "Change my answers",

  howTitle: "How your leads work",
  howPoints: [
    "Your leads are matched to what you've told us, best matches first.",
    "Every lead is labelled Top match, Strong match, First pick or Nearby opportunity, with a “Why you got this lead” explanation.",
    "Every lead you pay for is delivered. If a month runs short, the balance carries forward.",
  ],

  // --- why it works -----------------------------------------------------------
  whyTitle: "Why it works",
  demoTitle: "A look at your dashboard",
  sampleTitle: "What a lead looks like",
  sampleNote: "A sample lead. The details are made up.",
  sampleHeading: "3-bedroom house, YO31",
  sampleFigures: "Projected revenue £46,300 a year · £165 a night · 64% occupancy",
  faqTitle: "Questions operators ask",
  toPlan: "Choose your plan",

  // --- the plan screen --------------------------------------------------------
  planTitle: "Choose your plan",
  planRadius: (miles: number, basePostcode: string) => `Leads from within ${miles} miles of ${basePostcode}`,
  planChosen: "Selected",
  discountLine: (code: string, until: string) =>
    `Your code ${code} takes 10% off your first month. It expires at ${until}.`,
  continueToPayment: "Continue to payment",
  startingPayment: "Opening payment",
  paymentNotReady:
    "Payment isn't open on this page yet. Book a call and we'll get you set up.",
  noPreviewYet: "See your preview first, so each plan can show its area.",

  // --- errors -----------------------------------------------------------------
  rateLimited:
    "You've seen a lot of previews today. Come back tomorrow, or book a call and we'll go through it with you.",
  linkExpired: "This link is no longer active. Book a call and we'll take you through it.",
  saveFailed: "We couldn't save that just now. Please try again.",
  previewUnavailable: "We can't work out your area right now. Please try again in a minute.",

  // --- the partner summary ------------------------------------------------------
  summaryTitle: "A lead preview to look over",
  summaryIntro:
    "Shared by an operator looking at Stayful leads. These are their answers and the preview they were shown.",
  summaryAnswersTitle: "Their answers",
  summaryNoPreview: "They haven't seen a preview yet.",
  answerLabels: {
    postcode: "Business postcode",
    otherAreas: "Other areas",
    travel: "How far they'll travel",
    bedrooms: "Bedrooms",
    revenue: "Projected revenue",
  },
  notAnswered: "Not answered yet",
  anyLabel: "Any",
  anywhere: "Anywhere",
  upToMiles: (miles: number) => `Up to ${miles} miles`,
} as const;

/**
 * The plan prices, as the plan screen shows them. Restated rather than
 * imported because plans.ts is not client-safe to rely on here; a test keeps
 * these equal to PLANS (lead_10, lead_20).
 */
export const FUNNEL_PLAN_PRICES: Record<10 | 20, number> = { 10: 150, 20: 300 };

export function planPriceLine(leads: 10 | 20): string {
  return `${leads} leads a month, £${FUNNEL_PLAN_PRICES[leads]} a month`;
}

/**
 * The questions on the "Why it works" screen (02 Phase 3), with the two
 * approved corrections (C4) and the replacement sentence left out (C7).
 */
export const FUNNEL_FAQ: readonly { q: string; a: string }[] = [
  {
    q: "How many other operators get the same lead?",
    a: "Each lead normally goes to up to three operators at once.",
  },
  {
    q: "Are these leads any good?",
    // C9 (decided by Zac, 9 Oct): the doc says "Each one is financially
    // modelled", which is not true of every lead (§25: some Monday items carry
    // no analysis). Measured 9 Oct: 182 of the 198 Management leads ingested
    // in the last 60 days carry a projected figure (92%). All-time is 302 of
    // 337 (89.6%), so the sentence is a claim about what a buyer gets now, and
    // the last-60-days figure is the one to re-measure: if it ever reads under
    // 90%, reword this. "Nearly every one" was read as "nearly everyone", so it
    // states the share instead.
    a: "Every lead is a landlord who searched Google for short-term let management and completed an enquiry form. More than 9 in 10 are financially modelled against the landlord's current income using live Airbnb data for their postcode. Before any lead reaches you, the landlord receives an email telling them a trusted local operator will be in touch. They're expecting your call.",
  },
  {
    q: "How fast do leads arrive, and how do I contact them?",
    // C4: the speed answer comes from releaseCopy.ts, so it cannot drift from
    // the guide and the packages page. Never "within minutes" (§54).
    a: `${RELEASE_RULE} ${RELEASE_TEN_PLAN} Each one reaches you by email, text and in your dashboard the moment it's yours, with phone, email and WhatsApp options on every lead. Our contact strategy guide shows the sequence that works best: call first, up to five attempts.`,
  },
  {
    q: "What should I realistically expect?",
    a: "The long-run conversion rate is 1 in 20, validated across more than 1,100 Google-sourced STR management enquiries over three years. Leads typically take 4 to 12 weeks from first contact to a signed management agreement. Operators who treat this as a consistent acquisition channel over 12–24 months see the strongest results.",
  },
  {
    q: "How is this different from running my own ads?",
    a: "A Google Ads click on a property management keyword costs £8–25 in the UK. That is a click — not a name, a phone number, or a completed enquiry form. At £15 per financially modelled, Google-intent enquiry, the cost is for the output of a campaign, not a step within one.",
  },
  {
    q: "What if it doesn't work for me?",
    // C7: the replacement sentence is left out until its rule is decided.
    a: "Cancel anytime — no lock-in, no penalty. You can pause for up to three months. Every lead you pay for is delivered.",
  },
];

/**
 * "14:30 on 10 October", in UK time: when a discount code stops working. The
 * server runs in UTC and Britain is an hour ahead for half the year (§40.12),
 * so the zone is named rather than assumed.
 */
export function discountExpiry(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const time = d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/London",
  });
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "Europe/London" });
  return `${time} on ${day}`;
}
