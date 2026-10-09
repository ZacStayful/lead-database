/**
 * Every customer-facing word on the Lead Brief questionnaire (Phase 3).
 *
 * IMPORT-FREE except for the one booking link and the label copy, both
 * modules themselves import-free: the questionnaire is a client component, and
 * nothing here may pull the supply loader or supabase-js into the browser
 * (§21.8). The label names and money formatting live in labelCopy.ts (Phase 5)
 * and are re-exported here, so there is one definition of each.
 *
 * Copy rules, each pinned by briefCopy.test.ts:
 *   - A9: never the words the additions ban (the test lists them). We say
 *     priorities, matches, service area, opportunities.
 *   - A1: the promise is "every lead you pay for is delivered", with any short
 *     month carrying forward. Never a timeframe, never "guarantee".
 *   - A6: a trade-off is a gain ("Including … brings your area in by N
 *     miles"), never "drop" or "remove".
 *   - Locked decisions 7 and 8 (and the approved C4/C5 rewrites): a first pick
 *     never claims exclusivity or "closest operator"; competition is "from
 *     management companies", never about our other customers.
 *   - Sentence case and no exclamation marks.
 *   - Nothing here ever states a lead count or an area's volume (A4).
 */

import { BOOKING_URL } from "@/lib/prospect/copy";
import { LABEL_NAMES, grossShort, poundsLong, type LabelKey } from "@/lib/leadBrief/labelCopy";

export {
  grossShort,
  poundsLong,
  LABEL_NAMES,
  LABEL_EXPLANATIONS,
  type LabelKey,
} from "@/lib/leadBrief/labelCopy";

// --- fixed lists -----------------------------------------------------------

/**
 * A8 Q3 revenue options, in pounds. The same list as GROSS_THRESHOLDS
 * (filterPrediction.ts) and the 0162 CHECK on min_gross; a test keeps them
 * equal. Restated here because that module is not client-safe.
 */
export const BRIEF_GROSS_OPTIONS = [25000, 30000, 40000, 50000, 75000] as const;

/** A8 Q3 bedroom options: 1 to MAX_MIN_BEDROOMS (5), pinned by a test. */
export const BRIEF_BEDROOM_OPTIONS = [1, 2, 3, 4, 5] as const;

/** A7: "Book a call". The env var wins; the fallback is the one booking link. */
export const BRIEF_BOOKING_URL = process.env.NEXT_PUBLIC_BOOKING_URL || BOOKING_URL;

// --- formatting helpers ----------------------------------------------------

/** "12 November" from an ISO date (YYYY-MM-DD), or null when unreadable. */
export function dayMonth(isoDate: string | null | undefined): string | null {
  if (!isoDate) return null;
  const d = new Date(`${isoDate.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
}

// --- the questions (A8) ----------------------------------------------------

export const BRIEF_COPY = {
  pageTitle: "Your lead brief",
  pageIntro:
    "Three quick questions about how you work. We use your answers to set the area your leads come from and to put your best matches first.",
  stepOf: (n: number, total: number) => `Question ${n} of ${total}`,

  q1: {
    title: "Where do you operate?",
    help: "Your business postcode. Your service area is set around it.",
    postcodeLabel: "Business postcode",
    postcodePlaceholder: "e.g. YO10 5DD",
    addArea: "Add another area",
    addAreaHelp: "Another postcode district you work in, such as LS6.",
    areaPlaceholder: "e.g. LS6",
    removeArea: "Remove",
  },

  q2: {
    title: "How far will you travel?",
    help: "The furthest you would go to view a property or meet a landlord.",
    options: [
      { value: 10, label: "Up to 10 miles" },
      { value: 25, label: "Up to 25 miles" },
      { value: 50, label: "Up to 50 miles" },
      { value: null, label: "Anywhere" },
    ] as const,
    anywhereNote:
      "Your service area still stays within 75 miles on 20 leads a month, or 40 miles on 10.",
  },

  q3: {
    title: "Anything a lead must have?",
    help: "Choose up to two, or none. Everything else is ranked, so your best matches come first.",
    bedroomsLabel: "Bedrooms",
    bedroomsOption: (n: number) => `At least ${n} bedroom${n === 1 ? "" : "s"}`,
    revenueLabel: "Projected revenue",
    revenueOption: (pounds: number) => `At least ${grossShort(pounds)} a year`,
    anyLabel: "Any",
    showEverything: "No, show me everything",
  },

  back: "Back",
  next: "Next",
  seePreview: "See your match preview",
  working: "Working out your area",
  /** A funnel payer's first sign-in opens on their preview (batch 02 Phase 5, C1). */
  reopening: "Opening the preview you saw before paying",
  confirmIntro:
    "This is the preview you saw before paying, worked out again now. Check it, change anything you need, then confirm it to start your leads.",
  confirm: "Confirm my brief",
  confirming: "Saving your brief",
  unavailable:
    "We can't work out your area right now. Please try again in a minute.",
  saveFailed: "We couldn't save your brief. Please try again.",
  readOnlyTitle: "Viewing as this customer",
  readOnlyBody:
    "This customer hasn't completed their lead brief yet. It can't be filled in while you're viewing their account.",
} as const;

// --- input issues ----------------------------------------------------------

export type BriefIssueCode =
  | "base_postcode_unrecognised"
  | "base_outcode_unplaceable"
  | "travel_limit_invalid"
  | "min_bedrooms_invalid"
  | "min_gross_invalid"
  | "priority_outcode_unrecognised"
  | "similar_area_invalid"
  | "ranking_invalid"
  | "threshold_invalid";

/** Which question an issue belongs to, so it is shown in the right place. */
export const ISSUE_QUESTION: Record<BriefIssueCode, 1 | 2 | 3 | "preview"> = {
  base_postcode_unrecognised: 1,
  base_outcode_unplaceable: 1,
  priority_outcode_unrecognised: 1,
  travel_limit_invalid: 2,
  min_bedrooms_invalid: 3,
  min_gross_invalid: 3,
  similar_area_invalid: "preview",
  ranking_invalid: "preview",
  threshold_invalid: "preview",
};

export function issueMessage(issue: { code: string; value?: string; outcode?: string }): string {
  switch (issue.code as BriefIssueCode) {
    case "base_postcode_unrecognised":
      return "We couldn't read that postcode. Try the full postcode, such as YO10 5DD.";
    case "base_outcode_unplaceable":
      return `We can't place ${issue.outcode ?? "that postcode"} on our map yet. Try a nearby postcode.`;
    case "travel_limit_invalid":
      return "Choose how far you'll travel.";
    case "min_bedrooms_invalid":
      return "Choose a number of bedrooms from 1 to 5.";
    case "min_gross_invalid":
      return "Choose a projected revenue from the list.";
    case "priority_outcode_unrecognised":
      return `We couldn't read "${issue.value ?? ""}" as a postcode district, such as LS6.`;
    case "similar_area_invalid":
      return "That suggested area couldn't be added. Please refresh and try again.";
    case "ranking_invalid":
    case "threshold_invalid":
      return "One of your priorities couldn't be read. Please refresh and try again.";
    default:
      return "Something in your answers couldn't be read. Please check them and try again.";
  }
}

// --- the preview -----------------------------------------------------------

export const PREVIEW_COPY = {
  title: "Your match preview",
  coverageTitle: "Your coverage area",
  coverageExplainer:
    "Your area is set from live lead supply, so every lead you pay for is delivered. A tighter area means fewer landlords enquire there each month, so a smaller plan keeps your area tighter. Pick the balance that suits how far you're willing to travel.",
  promise:
    "Every lead you pay for is delivered. If a month runs short, the balance carries forward.",
  yourPlan: "Your plan",

  labelsTitle: "How your leads are labelled",
  labelsIntro: "Every lead tells you why you got it. There are four labels.",

  areasTitle: "Your areas",
  similarTitle: "Similar areas",
  similarIntro: "Areas with properties like yours. Tick any you'd like added to your service area.",
  recommended: "Recommended for your brief",
  includeArea: "Add to my area",

  firstPicksTitle: "Your first-pick areas",
  firstPicksIntro: "Areas close to you where new leads can reach you first.",
  moreFirstPicks: "and more nearby",
  noFirstPicks: "No first-pick areas near you at the moment. We'll check again each month.",

  tradeoffsTitle: "Ways to bring your area in",
  mixTitle: "Expected mix",
  mixNote:
    "This is our expectation from recent leads, not a promise. The number of leads is what you pay for; the mix can vary.",

  bottleneckTitle: "Your priorities are holding your area back",
  optionsIntro: "Or, if you'd rather keep your priorities as they are:",
  widen: "Widen your area",
  switchTo10: "Switch to 10 leads a month",
  bookCall: "Book a call",
  canConfirmAnyway:
    "You can still confirm your brief as it is. Every lead you pay for is delivered, and if a month runs short the balance carries forward.",
} as const;

/** "20 leads a month: within 35 miles of YO10 5DD" (A5). */
export function coverageLine(args: {
  plan: number;
  radiusMiles: number;
  basePostcode: string;
  otherAreas: number;
}): string {
  const where =
    args.otherAreas > 0 ? `${args.basePostcode} and your other areas` : args.basePostcode;
  return `${args.plan} leads a month: within ${args.radiusMiles} miles of ${where}`;
}

export type CompetitionTierKey = "high" | "medium" | "low";

/** Locked decision 8: always "from management companies". */
export function competitionLine(tier: CompetitionTierKey | null): string | null {
  if (tier === "high") return "High competition from management companies";
  if (tier === "medium") return "Medium competition from management companies";
  if (tier === "low") return "Low competition from management companies";
  return null;
}

/**
 * A first-pick area's line. "Low competition" appears only when the area's
 * tier really is low (build prompt, screen 4).
 */
export function firstPickLine(outcode: string, tier: CompetitionTierKey | null): string {
  return tier === "low" ? `${outcode}, low competition from management companies` : outcode;
}

export function outsideCapLine(outcodes: string[]): string | null {
  if (outcodes.length === 0) return null;
  const list = outcodes.join(", ");
  return outcodes.length === 1
    ? `${list} is further than your plan reaches, so it isn't part of your service area.`
    : `${list} are further than your plan reaches, so they aren't part of your service area.`;
}

export interface FiguresLike {
  gross: number | null;
  nightly: number | null;
  occupancy: number | null;
}

/** "Projected revenue £42,300 (yours £39,800) · £145 a night · 61% occupancy". */
export function similarFiguresLine(figures: FiguresLike, reference: FiguresLike): string {
  const parts: string[] = [];
  if (figures.gross !== null) {
    parts.push(
      reference.gross !== null
        ? `Projected revenue ${poundsLong(figures.gross)} (yours ${poundsLong(reference.gross)})`
        : `Projected revenue ${poundsLong(figures.gross)}`
    );
  }
  if (figures.nightly !== null) parts.push(`£${figures.nightly} a night`);
  if (figures.occupancy !== null) parts.push(`${figures.occupancy}% occupancy`);
  return parts.join(" · ");
}

/** "Top match: 12". The mix is a split of the customer's own plan (A4). */
export function mixLine(label: LabelKey, count: number): string {
  return `${LABEL_NAMES[label]}: ${count}`;
}

// --- trade-offs (A6) and the bottleneck (A7) -------------------------------

export type EssentialKind = "bedrooms" | "revenue";

/** What relaxing an essential lets in, as a gain. */
export function includingPhrase(essential: EssentialKind, from: number | null, to: number | null): string {
  if (essential === "bedrooms") {
    if (to === null) return "Including properties of every size";
    if (from !== null && to === from - 1) return `Including ${to}-bedroom properties`;
    return `Including properties with ${to} or more bedrooms`;
  }
  if (to === null) return "Including properties at every revenue level";
  return `Including ${grossShort(to)}+ properties`;
}

/** "Including £50k+ properties brings your area in by 20 miles, to within 35 miles." */
export function tradeoffLine(t: {
  essential: EssentialKind;
  from: number;
  to: number | null;
  radiusMiles: number;
  milesSaved: number;
}): string {
  const miles = t.milesSaved === 1 ? "1 mile" : `${t.milesSaved} miles`;
  return `${includingPhrase(t.essential, t.from, t.to)} brings your area in by ${miles}, to within ${t.radiusMiles} miles.`;
}

/** "your 5+ bedroom priority", "your £75k+ revenue priority". */
function essentialName(essential: EssentialKind, value: number | null): string {
  if (essential === "bedrooms") return value !== null ? `${value}+ bedroom` : "bedroom";
  return value !== null ? `${grossShort(value)}+ revenue` : "revenue";
}

/**
 * The bottleneck as sentences, from exactly what the engine returns
 * (bottleneck.ts).
 *
 * ⚠️ HONEST IN BOTH OF THE ENGINE'S SHAPES. With several causes, a non-null
 * `relaxTo` on any of them means each was found to work on its own, so each
 * gets its own sentence. When every `relaxTo` is null, the engine may mean
 * "both must go"; a combined sentence is true either way, because relaxing
 * more never shrinks supply.
 */
export function bottleneckLines(args: {
  causes: { essential: EssentialKind; relaxTo: number | null }[];
  current: { minBedrooms: number | null; minGross: number | null };
  radiusMiles: number;
}): string[] {
  const { causes, current, radiusMiles } = args;
  const valueOf = (e: EssentialKind) => (e === "bedrooms" ? current.minBedrooms : current.minGross);
  if (causes.length === 0) return [];

  if (causes.length === 1) {
    const c = causes[0];
    return [
      `Your ${essentialName(c.essential, valueOf(c.essential))} priority is what's holding your area back.`,
      `${includingPhrase(c.essential, valueOf(c.essential), c.relaxTo)} covers your plan within ${radiusMiles} miles.`,
    ];
  }

  const names = causes.map((c) => essentialName(c.essential, valueOf(c.essential)));
  const anyStep = causes.some((c) => c.relaxTo !== null);
  if (!anyStep) {
    return [
      `Together, your ${names.join(" and ")} priorities are what's holding your area back.`,
      `Including properties of every size and at every revenue level covers your plan within ${radiusMiles} miles.`,
    ];
  }
  return [
    `Your ${names.join(" and ")} priorities are what's holding your area back. Either of these covers your plan within ${radiusMiles} miles:`,
    ...causes.map((c) => `${includingPhrase(c.essential, valueOf(c.essential), c.relaxTo)}.`),
  ];
}

// --- switching to 10 leads (approved 9 Oct: the §24 tier change) -----------

/** Shown before the customer presses it. */
export function switchExplainer(renewalIso: string | null): string {
  const when = dayMonth(renewalIso);
  return when
    ? `Your plan changes to 10 leads a month from your next renewal on ${when}. Nothing is charged or refunded today, and the leads you've paid for this month are still yours.`
    : "Your plan changes to 10 leads a month from your next renewal. Nothing is charged or refunded today, and the leads you've paid for this month are still yours.";
}

/** Shown after the switch is accepted. */
export function switchDone(renewalIso: string | null): string {
  const when = dayMonth(renewalIso);
  return when
    ? `Done. You'll move to 10 leads a month on ${when}. Your preview now shows the 10-lead area.`
    : "Done. You'll move to 10 leads a month at your next renewal. Your preview now shows the 10-lead area.";
}

export const SWITCH_COPY = {
  confirm: "Switch to 10 leads a month",
  cancel: "Keep 20 leads a month",
  working: "Changing your plan",
  failed: "We couldn't change your plan just now. You can still confirm your brief, or try again from Settings.",
} as const;

// --- confirmation ----------------------------------------------------------

export function radiusChangedLine(radiusMiles: number, basePostcode: string): string {
  return `Your coverage area has changed since you started: it's now within ${radiusMiles} miles of ${basePostcode}. Please check it before confirming.`;
}

// --- the legacy area screen, for a brief customer (C15) ---------------------

/** The refusal a brief customer gets if they try to set areas the old way. */
export const SERVICE_AREA_FROM_BRIEF =
  "Your Management service area comes from your lead brief, so it can't be set here.";

export const SERVICE_AREA_NOTICE = {
  title: "Your service area comes from your lead brief",
  body:
    "Your Management leads are matched to the area and priorities in your lead brief, so there is nothing to set on this page for them.",
} as const;
