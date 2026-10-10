/**
 * Every customer-facing word about a lead's label (Lead Brief Phase 5): the
 * badge, the "Why you got this lead" panel, the one-line reason the email
 * carries, the Nearby tip and "Not for me".
 *
 * ⚠️ THIS FILE HAS NO IMPORTS, and must keep none. The card, the contact panel
 * and the home card are client components; anything reached from here is
 * bundled into the browser (the `leadRetirement.ts` rule, §21.8). It restates
 * the few shapes it needs, and labelCopy.test.ts pins them equal to the
 * engine's (score.ts) and to the reject reasons (outcomeReasons.ts).
 *
 * Copy rules, each pinned by labelCopy.test.ts:
 *   - A9: never the words the additions ban. We say priorities, matches,
 *     service area, opportunities.
 *   - Never about another operator, a shared lead, a deficit or a volume, and
 *     never "guarantee" about a match (Phase 5).
 *   - The approved D6 rewrites: Top match drops "first" (C4); First pick never
 *     claims the customer was the first or the closest operator (C5); the
 *     Nearby line is C6's. A behind-pace lead uses A11's wording.
 *   - Every sentence must be true of the lead it sits on. Where a claim holds
 *     only sometimes ("close to your base", "low competition", "sent to keep
 *     your leads on track") it appears only when the stored reasons show it.
 *   - D10: "Not for me" is final and chargeable, and nothing here mentions a
 *     replacement.
 *   - Sentence case, no exclamation marks.
 */

// --- shapes, restated (labelCopy.test.ts keeps them equal) ------------------

export type LabelKey = "top_match" | "strong_match" | "first_pick" | "nearby_opportunity";
export type LabelPriorityKey = "location" | "revenue" | "bedrooms" | "occupancy";
export type LabelArea = "service" | "first_pick" | "pace" | "outside";
export type LabelTier = "high" | "medium" | "low";

export interface LabelPriority {
  key: LabelPriorityKey;
  threshold: number | null;
  value: number | null;
  met: boolean | null;
}

export interface LabelProgress {
  received: number;
  allocation: number;
  days_left: number;
}

/** lead_assignments.match_reasons, as this module reads it (score.ts writes it). */
export interface LabelReasons {
  v: 1;
  area: LabelArea;
  first_pick: boolean;
  priorities: LabelPriority[];
  progress?: LabelProgress;
  competition?: LabelTier;
  /** Batch 04 Phase 4: sent on a top-up credit. */
  topup?: true;
}

const LABEL_KEYS: readonly LabelKey[] = ["top_match", "strong_match", "first_pick", "nearby_opportunity"];
const PRIORITY_KEYS: readonly LabelPriorityKey[] = ["location", "revenue", "bedrooms", "occupancy"];
const AREAS: readonly LabelArea[] = ["service", "first_pick", "pace", "outside"];
const TIERS: readonly LabelTier[] = ["high", "medium", "low"];

// --- formatting ------------------------------------------------------------

/** £50k, £75k. */
export function grossShort(pounds: number): string {
  return `£${Math.round(pounds / 1000)}k`;
}

/** £42,300. */
export function poundsLong(pounds: number): string {
  return `£${Math.round(pounds).toLocaleString("en-GB")}`;
}

function oneDecimal(n: number): number {
  return Math.round(n * 10) / 10;
}

function miles(n: number): string {
  const v = oneDecimal(n);
  return v === 1 ? "1 mile" : `${v} miles`;
}

function bedroomsWord(n: number): string {
  return n === 1 ? "1 bedroom" : `${n} bedrooms`;
}

function days(n: number): string {
  return n === 1 ? "1 day" : `${n} days`;
}

// --- the four labels -------------------------------------------------------

export const LABEL_NAMES: Record<LabelKey, string> = {
  top_match: "Top match",
  strong_match: "Strong match",
  first_pick: "First pick",
  nearby_opportunity: "Nearby opportunity",
};

/**
 * The approved C4/C5/D6 wording. "First pick" says where the lead is, never
 * that the customer was the first or the closest operator to receive it.
 */
export const LABEL_EXPLANATIONS: Record<LabelKey, string> = {
  top_match: "Matches every one of your priorities.",
  strong_match: "Matches all but one of your priorities.",
  first_pick: "In one of your first-pick areas, close to your base.",
  nearby_opportunity:
    "Close to your area with fewer of your priorities met, or just outside your usual area to keep your leads on track.",
};

/**
 * The badge's hover text. Unlike LABEL_EXPLANATIONS (the questionnaire's
 * definitions), this sits on ONE lead, so it claims nothing that is only
 * sometimes true: a first pick for a customer who travels anywhere need not be
 * close to their base, and a hand-placed Nearby lead was not sent to keep them
 * on track.
 */
export const LABEL_BADGE_TITLES: Record<LabelKey, string> = {
  top_match: "Matches every one of your priorities.",
  strong_match: "Matches all but one of your priorities.",
  first_pick: "In one of your first-pick areas.",
  nearby_opportunity: "Fewer of your priorities met, or outside your usual area.",
};

/** The short forms the dashboard's "This month" line uses. */
export const LABEL_SHORT: Record<LabelKey, string> = {
  top_match: "top",
  strong_match: "strong",
  first_pick: "first pick",
  nearby_opportunity: "nearby",
};

export function isLabelKey(value: unknown): value is LabelKey {
  return typeof value === "string" && (LABEL_KEYS as readonly string[]).includes(value);
}

export const PRIORITY_NAMES: Record<LabelPriorityKey, string> = {
  location: "Location",
  revenue: "Projected revenue",
  bedrooms: "Bedrooms",
  occupancy: "Occupancy",
};

export const WHY_COPY = {
  title: "Why you got this lead",
  hide: "Hide",
  firstPickTag: "It's also in one of your first-pick areas.",
  tipLead: "Tip",
  editBrief: "Edit your brief",
} as const;

// --- reading what was stored -----------------------------------------------

function numOrNull(v: unknown): number | null | undefined {
  if (v === null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
}

/**
 * match_reasons as stored, or null when it is anything other than a v1 object
 * this module understands. A malformed row hides the panel; it never breaks a
 * card.
 */
export function parseMatchReasons(raw: unknown): LabelReasons | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return null;
  if (typeof r.area !== "string" || !(AREAS as readonly string[]).includes(r.area)) return null;
  if (typeof r.first_pick !== "boolean") return null;
  if (!Array.isArray(r.priorities)) return null;

  const priorities: LabelPriority[] = [];
  for (const p of r.priorities) {
    if (!p || typeof p !== "object") return null;
    const e = p as Record<string, unknown>;
    if (typeof e.key !== "string" || !(PRIORITY_KEYS as readonly string[]).includes(e.key)) return null;
    const threshold = numOrNull(e.threshold);
    const value = numOrNull(e.value);
    if (threshold === undefined || value === undefined) return null;
    if (!(e.met === null || typeof e.met === "boolean")) return null;
    priorities.push({ key: e.key as LabelPriorityKey, threshold, value, met: e.met });
  }

  const out: LabelReasons = {
    v: 1,
    area: r.area as LabelArea,
    first_pick: r.first_pick,
    priorities,
  };

  const progress = r.progress as Record<string, unknown> | undefined;
  if (
    progress &&
    typeof progress === "object" &&
    typeof progress.received === "number" &&
    typeof progress.allocation === "number" &&
    typeof progress.days_left === "number"
  ) {
    out.progress = {
      received: progress.received,
      allocation: progress.allocation,
      days_left: progress.days_left,
    };
  }
  if (typeof r.competition === "string" && (TIERS as readonly string[]).includes(r.competition)) {
    out.competition = r.competition as LabelTier;
  }
  if (r.topup === true) out.topup = true;
  return out;
}

// --- the checklist ---------------------------------------------------------

export interface ChecklistLine {
  key: LabelPriorityKey;
  name: string;
  met: boolean;
  detail: string;
}

const NO_FIGURE: Record<LabelPriorityKey, string> = {
  location: "We can't place this property yet",
  revenue: "No projected revenue for this property yet",
  bedrooms: "The number of bedrooms isn't known yet",
  occupancy: "No projected occupancy for this property yet",
};

/** "2.3 miles beyond your 12 miles", "£4,000 under your £40k". Null when not missed or unknown. */
function gapPhrase(p: LabelPriority): string | null {
  if (p.met !== false || p.value === null || p.threshold === null) return null;
  const t = p.threshold;
  const v = p.value;
  switch (p.key) {
    case "location":
      return `${miles(v - t)} beyond your ${miles(t)}`;
    case "revenue":
      return `${poundsLong(t - v)} under your ${grossShort(t)}`;
    case "bedrooms": {
      const short = t - v;
      return `${short} fewer than your ${t}`;
    }
    case "occupancy":
      return `${Math.round(t - v)} points under your ${t}%`;
  }
}

function lineDetail(p: LabelPriority): string {
  // Location is met beyond its distance (or with no distance) only through a
  // similar area the customer added, so that is what it says.
  if (p.key === "location" && p.met && p.threshold !== null && (p.value === null || p.value > p.threshold)) {
    return "In one of the areas you added";
  }
  if (p.value === null || p.threshold === null) return NO_FIGURE[p.key];
  const t = p.threshold;
  const v = p.value;
  switch (p.key) {
    case "location":
      return p.met
        ? `${miles(v)} from your nearest area, within your ${miles(t)}`
        : `${miles(v)} from your nearest area, ${gapPhrase(p)}`;
    case "revenue":
      return p.met
        ? `${poundsLong(v)} a year, your priority ${grossShort(t)}+`
        : `${poundsLong(v)} a year, ${gapPhrase(p)}`;
    case "bedrooms":
      return p.met
        ? `${bedroomsWord(v)}, your priority ${t}+`
        : `${bedroomsWord(v)}, ${gapPhrase(p)}`;
    case "occupancy":
      return p.met ? `${Math.round(v)}%, your priority ${t}%+` : `${Math.round(v)}%, ${gapPhrase(p)}`;
  }
}

/**
 * One line per judged priority, in the customer's ranked order. A priority
 * that could not be judged (no threshold) is left out: it played no part.
 */
export function checklistLines(reasons: LabelReasons): ChecklistLine[] {
  return reasons.priorities
    .filter((p) => p.met !== null)
    .map((p) => ({
      key: p.key,
      name: PRIORITY_NAMES[p.key],
      met: p.met === true,
      detail: lineDetail(p),
    }));
}

// --- the one-line reason ---------------------------------------------------

function progressSentence(p: LabelProgress | undefined): string | null {
  if (!p) return null;
  if (p.received >= p.allocation || p.days_left <= 0) return null;
  return `sent to keep your ${p.allocation} leads on track. You're on ${p.received} of ${p.allocation}, with ${days(p.days_left)} left in your cycle.`;
}

/** The lowercase priority name used mid-sentence. */
const PRIORITY_INLINE: Record<LabelPriorityKey, string> = {
  location: "location",
  revenue: "projected revenue",
  bedrooms: "bedrooms",
  occupancy: "occupancy",
};

function strongReason(reasons: LabelReasons): string {
  const missed = reasons.priorities.filter((p) => p.met === false);
  if (missed.length !== 1) return LABEL_EXPLANATIONS.strong_match;
  const m = missed[0];
  const gap = gapPhrase(m);
  return gap
    ? `It matches your brief apart from ${PRIORITY_INLINE[m.key]}: ${gap}.`
    : `It matches your brief apart from ${PRIORITY_INLINE[m.key]}, which there's no figure for yet.`;
}

function firstPickReason(reasons: LabelReasons): string {
  const location = reasons.priorities.find((p) => p.key === "location");
  const near = location?.met === true ? ", close to your base" : "";
  const quiet =
    reasons.competition === "low" ? ", in an area with low competition from management companies" : "";
  return `This property is in one of your first-pick areas${near}${quiet}, which puts you in a strong position to sign this landlord.`;
}

/**
 * Batch 04 locked decision 6, word for word. ⚠️ THE ONE PLACE label or reason
 * copy may say "top-up" (C3): A9 bans the word everywhere else, and both
 * banned-word scans exempt this exact string and nothing more.
 */
export const TOPUP_REASON = "From just outside your area, as part of your top-up.";

function nearbyReason(reasons: LabelReasons): string {
  if (reasons.topup) return TOPUP_REASON;
  const sent = progressSentence(reasons.progress);
  switch (reasons.area) {
    case "service":
      return sent
        ? `This was the strongest lead available to you today inside your service area, ${sent}`
        : "Inside your service area.";
    case "first_pick":
      return sent
        ? `This was the strongest lead available to you today in one of your first-pick areas, ${sent}`
        : "In one of your first-pick areas.";
    case "pace":
      return sent ? `Just outside your usual area, ${sent}` : "Just outside your usual area.";
    case "outside":
      return "Outside your usual area.";
  }
}

/** The one-line reason for a label, from the reasons stored with it. */
export function reasonLine(label: LabelKey, reasons: LabelReasons): string {
  switch (label) {
    case "top_match":
      return "Sent to you because it matches your brief exactly.";
    case "strong_match":
      return strongReason(reasons);
    case "first_pick":
      return firstPickReason(reasons);
    case "nearby_opportunity":
      return nearbyReason(reasons);
  }
}

// --- the Nearby tip --------------------------------------------------------

function relativeGap(p: LabelPriority): number {
  const t = p.threshold as number;
  const v = p.value as number;
  if (t <= 0) return Number.POSITIVE_INFINITY;
  return p.key === "location" ? (v - t) / t : (t - v) / t;
}

function includingFor(p: LabelPriority): string | null {
  const v = p.value as number;
  switch (p.key) {
    case "location":
      return `Including properties up to ${miles(Math.ceil(v))} from your areas`;
    case "revenue": {
      const k = Math.floor(v / 1000) * 1000;
      return k >= 1000 ? `Including ${grossShort(k)}+ properties` : null;
    }
    case "bedrooms":
      return v >= 1 ? `Including ${v}-bedroom properties` : null;
    case "occupancy": {
      const o = Math.floor(v);
      return o >= 1 ? `Including properties at ${o}%+ occupancy` : null;
    }
  }
}

/**
 * The one change that would turn leads like this into strong matches, as a
 * gain (A6). Null when no single change would: three or more misses, or no
 * miss that a level change could fix (a missing figure can't be relaxed).
 *
 * A behind-pace or hand-placed lead outside the service area stays Nearby
 * whatever it scores, so its tip is the area itself.
 */
export function nearbyTip(reasons: LabelReasons, leadOutcode: string | null): string | null {
  if (reasons.area === "pace" || reasons.area === "outside") {
    return leadOutcode
      ? `Adding ${leadOutcode} to your areas would bring leads like this into your service area.`
      : null;
  }
  const missed = reasons.priorities.filter((p) => p.met === false);
  if (missed.length === 0 || missed.length >= 3) return null;
  const fixable = missed
    .filter((p) => p.value !== null && p.threshold !== null)
    .sort((a, b) => relativeGap(a) - relativeGap(b));
  for (const p of fixable) {
    const including = includingFor(p);
    if (!including) continue;
    const becomes = missed.length === 1 ? "top matches" : "strong matches";
    return `${including} would turn leads like this into ${becomes}.`;
  }
  return null;
}

// --- alerts ----------------------------------------------------------------

/** The notification line: "New lead (Top match): Jane Smith in York". */
export function notificationLabel(label: LabelKey): string {
  return ` (${LABEL_NAMES[label]})`;
}

/** The dashboard line: "This month: 3 top · 2 strong · 1 first pick · 4 nearby". */
export function monthLine(counts: Record<LabelKey, number>): string {
  return `This month: ${LABEL_KEYS.map((k) => `${counts[k]} ${LABEL_SHORT[k]}`).join(" · ")}`;
}

// --- "Not for me" (D10) -----------------------------------------------------

/** The three reject reasons it offers. The labels equal outcomeReasons.ts's (pinned). */
export type NotForMeReason = "wrong_area" | "wrong_property" | "poor_numbers";

export const NOT_FOR_ME_COPY = {
  button: "Not for me",
  prompt: "Why isn't it for you?",
  reasons: {
    wrong_area: "Outside the area I cover",
    wrong_property: "Not the kind of property I take on",
    poor_numbers: "The numbers do not work for me",
  } as Record<NotForMeReason, string>,
  consequence: "Passing on a lead is final, and it still counts toward your leads this month.",
  confirm: "Pass on this lead",
  cancel: "Keep it",
  working: "Passing on it",
} as const;

export const NOT_FOR_ME_REASONS: readonly NotForMeReason[] = ["wrong_area", "wrong_property", "poor_numbers"];

/** "Not for me" is offered on Strong and Nearby leads only. */
export function offersNotForMe(label: LabelKey | null | undefined): boolean {
  return label === "strong_match" || label === "nearby_opportunity";
}
