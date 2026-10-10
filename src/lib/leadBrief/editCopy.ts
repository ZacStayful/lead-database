/**
 * Every word of the "Your brief" bar and editor (Lead Brief Phase 5, Part B).
 *
 * ⚠️ NO IMPORTS (§21.8): the editor and the bar are client components. The
 * questionnaire's own words (the three questions, the preview) stay in
 * briefCopy.ts and are reused, not restated.
 *
 * Copy rules, pinned by editCopy.test.ts and the briefCopy.test.ts scan:
 *   - A9: priorities, matches, service area, never filter, minimum, override.
 *   - Area changes start at the next renewal and the screen says the date; a
 *     priorities change applies to the next leads. Neither is a promise about
 *     how many leads arrive.
 *   - Sentence case, no exclamation marks.
 */

export type EditPriorityKey = "location" | "revenue" | "bedrooms" | "occupancy";

/** The editor's page. The bar, the Nearby tip and the filtering notice link here. */
export const BRIEF_EDITOR_HREF = "/dashboard/leads/brief";

/** "12 November" from an ISO date (YYYY-MM-DD), or null when unreadable. */
function dayMonth(isoDate: string | null | undefined): string | null {
  if (!isoDate) return null;
  const d = new Date(`${isoDate.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
}

function grossShort(pounds: number): string {
  return `£${Math.round(pounds / 1000)}k`;
}

export const PRIORITY_LABELS: Record<EditPriorityKey, string> = {
  location: "Location",
  revenue: "Projected revenue",
  bedrooms: "Bedrooms",
  occupancy: "Occupancy",
};

/** A priority's level, as a select option and in the summary. */
export function levelLabel(key: EditPriorityKey, value: number): string {
  switch (key) {
    case "location":
      return `Within ${value} miles of your areas`;
    case "revenue":
      return `${grossShort(value)}+ a year`;
    case "bedrooms":
      return value === 1 ? "1+ bedroom" : `${value}+ bedrooms`;
    case "occupancy":
      return `${value}%+ occupancy`;
  }
}

export interface AreaLineArgs {
  radiusMiles: number;
  basePostcode: string;
  otherAreas: number;
  minBedrooms: number | null;
  minGross: number | null;
}

/** An area and its essentials: "within 35 miles of YO10 5DD · 3+ bedrooms". */
export function areaLine(args: AreaLineArgs): string {
  const where =
    args.otherAreas > 0 ? `${args.basePostcode} and your other areas` : args.basePostcode;
  const parts = [`within ${args.radiusMiles} miles of ${where}`];
  if (args.minBedrooms !== null) parts.push(levelLabel("bedrooms", args.minBedrooms));
  if (args.minGross !== null) parts.push(`${grossShort(args.minGross)}+ projected revenue`);
  return parts.join(" · ");
}

/** The bar on the leads page. */
export function summaryLine(args: AreaLineArgs & { ranking: EditPriorityKey[] }): string {
  const parts = [areaLine(args)];
  if (args.ranking.length > 0) {
    parts.push(`Priorities: ${args.ranking.map((k) => PRIORITY_LABELS[k].toLowerCase()).join(", ")}`);
  }
  return `Your brief: ${parts.join(" · ")}`;
}

/** A pending area change, as the editor describes it. */
export function pendingAreaLine(args: AreaLineArgs): string {
  const line = areaLine(args);
  return `Your new area: ${line.charAt(0).toUpperCase()}${line.slice(1)}.`;
}

/**
 * The current area, as the editor describes it. Without the essentials: the
 * editor lists those on their own line ("A lead must have").
 */
export function currentAreaLine(args: AreaLineArgs): string {
  const line = areaLine({ ...args, minBedrooms: null, minGross: null });
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}.`;
}

export function pendingLine(startsOnIso: string | null): string {
  const d = dayMonth(startsOnIso);
  return d ? `Your new area starts on ${d}.` : "Your new area starts at your next renewal.";
}

export const EDIT_COPY = {
  barEdit: "Edit",
  editBriefLink: "Edit your brief",
  pageTitle: "Your brief",
  pageIntro:
    "Your brief decides the area your leads come from and which matches come first. Change your priorities at any time; a change to your area starts at your next renewal.",

  currentTitle: "Your current brief",
  essentialsNone: "Nothing a lead must have",
  essentialsTitle: "A lead must have",
  prioritiesTitle: "Your priorities, most important first",

  pendingTitle: "Your area change",
  pendingCancel: "Cancel this change",
  pendingCancelling: "Cancelling",
  pendingCancelled: "Your area change is cancelled. Your current area stays as it is.",
  planChanged:
    "Your plan has changed since you saved this. Please review your area and save it again.",
  pendingReview: "Your saved area change needs reviewing before it can start.",

  priorities: {
    title: "Your priorities",
    intro:
      "Leads that meet your top priorities are put first. Changes apply to your next leads.",
    up: "Move up",
    down: "Move down",
    levelLabel: "Level",
    notSet: "No level yet",
    essentialNote: "Set under Your area",
    save: "Save priorities",
    saving: "Saving",
    saved: "Saved. Your next leads use these priorities.",
  },

  area: {
    title: "Your area",
    intro:
      "How far you travel, any other areas you work and anything a lead must have. Changes start at your next renewal.",
    // Batch 05, locked decision 1. Says how to change it, without promising
    // the review flow batch 05 will build.
    postcodeLocked:
      "Your postcode is the centre of your area, so it can't be changed here. To change it, get in touch through Support.",
    edit: "Change your area",
    preview: "See your new area",
    save: "Save this change",
    saving: "Saving",
    cancel: "Keep my current area",
    savedOn: (startsOnIso: string | null) => {
      const d = dayMonth(startsOnIso);
      return d ? `Saved. These changes start on ${d}.` : "Saved. These changes start at your next renewal.";
    },
    startsOn: (startsOnIso: string | null) => {
      const d = dayMonth(startsOnIso);
      return d ? `These changes start on ${d}.` : "These changes start at your next renewal.";
    },
  },

  errors: {
    conflict: "Your brief changed in another tab. Reload the page to see the latest version.",
    nothingChanged: "That's the same as your current brief, so there's nothing to save.",
    radiusChanged:
      "Your new area has changed since you looked at it. Please check it again before saving.",
    postcodeLocked:
      "Your postcode can't be changed here. To change it, get in touch through Support.",
    unavailable: "We can't work out your area right now. Please try again in a minute.",
    failed: "We couldn't save that. Please try again.",
    level: "That level isn't available. Please choose another.",
  },

  readOnly:
    "You're viewing this customer's brief. It can't be changed while you're viewing their account.",
} as const;
