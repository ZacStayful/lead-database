/**
 * How many leads a customer may replace this month, and the words for it.
 *
 * ⚠️ THIS PUBLISHES A NUMBER §51.3 SPENT A SECTION KEEPING SECRET, and that is
 * a deliberate product decision rather than an oversight. The argument for
 * hiding it was sound and is worth restating: an operator told they have two
 * claims a month has been handed the exact number of leads it is safe to write
 * off without evidence, so the mechanism only worked while the number was
 * discovered rather than announced.
 *
 * What changed is that §53 makes the entitlement a HARD STOP on a self-serve
 * screen. A refusal with no number attached reads as the product being broken;
 * §52.4 already had to learn that lesson once, when an ineligible lead silently
 * hid its own control. Publishing it is what makes "no, and here is when that
 * changes" sayable.
 *
 * ⚠️ THE CREDIT PATH IS UNCHANGED AND STILL SAYS NOTHING. decideDeadLeadClaim,
 * claimBudget and the six files `deadLeadPolicy.test.ts` guards all behave
 * exactly as they did: over the entitlement, a CREDIT claim still routes to
 * review with wording indistinguishable from any other review outcome. One
 * surface states the number. Nothing else restates it.
 *
 * ⚠️ IMPORT-FREE, like `deadLeadCopy.ts` and `featureRequest.ts` before it
 * (§21.8, §51.6). The replacements page is a client component, and
 * `deadLeadPolicy.ts` reaches `plans.ts` through `products.ts`. So the
 * arithmetic stays on the server — `claimBudget()` is still the ONE definition
 * of the entitlement — and only the resolved numbers and the wording live here.
 */

/** What the page is told, already resolved. */
export interface ReplacementEntitlement {
  /** Replacements allowed this cycle. From `claimBudget()`, server-side. */
  entitlement: number;
  /** Claims already settled against it this cycle. */
  used: number;
  /** Never negative — see `remainingOf`. */
  remaining: number;
  /** ISO date the counter next zeroes, or null when it cannot be resolved. */
  resetsOn: string | null;
}

/**
 * ⚠️ CLAMPED AT ZERO, AND THIS IS NOT DEFENSIVE TIDINESS.
 *
 * `resolve_dead_lead_claim` consumes the entitlement when an admin upholds a
 * reviewed claim (`p_consumes_allowance` is true for the plain `uphold`
 * action), and a review can be granted after the customer has already spent
 * everything. So `used` genuinely can exceed `entitlement` — 3 of 2 — and the
 * header would otherwise render "-1 replacements left".
 */
export function remainingOf(entitlement: number, used: number): number {
  const e = Number.isFinite(entitlement) ? Math.trunc(entitlement) : 0;
  const u = Number.isFinite(used) ? Math.trunc(used) : 0;
  return Math.max(0, e - u);
}

/** The columns the reset date is derived from. Structural, so no type import. */
export interface ResetAnchors {
  billing_cycle_anchor?: string | null;
  gr_billing_cycle_anchor?: string | null;
  created_at?: string | null;
}

/**
 * When the counter next zeroes.
 *
 * ⚠️ THE COALESCE ORDER MIRRORS `reset_monthly_counts` EXACTLY, and it must.
 * 0141 moved `quality_claims_this_cycle` into a statement of its own keyed on
 * `coalesce(billing_cycle_anchor, gr_billing_cycle_anchor, created_at)`, so a
 * GR-only customer resets on their GR billing anchor. Deriving this date from
 * anything else — the management anchor alone, or the signup date — prints a
 * day on which nothing happens.
 *
 * ⚠️ The month-end branch mirrors it too: an anchor on the 31st falls on the
 * last day of a short month, exactly as the SQL's `v_dom = v_last_dom and
 * anchor_dom > v_last_dom` clause does.
 */
export function nextResetDate(
  anchors: ResetAnchors,
  now: Date = new Date(),
): string | null {
  const raw =
    anchors.billing_cycle_anchor ??
    anchors.gr_billing_cycle_anchor ??
    anchors.created_at ??
    null;
  if (!raw) return null;

  const anchor = new Date(raw);
  if (Number.isNaN(anchor.getTime())) return null;

  const anchorDom = anchor.getUTCDate();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const today = now.getUTCDate();

  const lastDomOf = (year: number, month: number) =>
    new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

  // The reset day in a given month: the anchor day, or that month's last day
  // when the anchor falls past the end of it.
  const dayIn = (year: number, month: number) =>
    Math.min(anchorDom, lastDomOf(year, month));

  const thisMonth = dayIn(y, m);
  const target =
    today < thisMonth
      ? new Date(Date.UTC(y, m, thisMonth))
      : new Date(Date.UTC(y, m + 1, dayIn(y, m + 1)));

  return target.toISOString().slice(0, 10);
}

/** Heading for the tab and the nav. */
export const REPLACEMENT_NAV_LABEL = "Replace a lead";
export const REPLACEMENT_PATH = "/dashboard/replacements";

export const REPLACEMENT_PAGE_HEADING = "Replace a lead";

export const REPLACEMENT_PAGE_INTRO =
  "Leads you rang where the landlord had already gone. Tell us what they said " +
  "and swap it for another one.";

/**
 * The published count.
 *
 * ⚠️ It says "replacements", never a word for the mechanism behind it. The
 * number is the customer's entitlement; how it is sized, earned or spent on
 * anything else is ours.
 */
export function remainingSentence(e: ReplacementEntitlement): string {
  if (e.entitlement <= 0) {
    return "Replacements are not available on your account at the moment.";
  }
  if (e.remaining <= 0) {
    return `You have used all ${e.entitlement} of this month's replacements.`;
  }
  return `${e.remaining} of ${e.entitlement} replacements left this month.`;
}

/** Said beside the count, so a zero is a date rather than a dead end. */
export function resetSentence(e: ReplacementEntitlement): string | null {
  if (!e.resetsOn) return null;
  const when = new Date(`${e.resetsOn}T00:00:00Z`);
  if (Number.isNaN(when.getTime())) return null;
  const formatted = when.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
  return e.remaining <= 0
    ? `You get more on ${formatted}.`
    : `Resets on ${formatted}.`;
}

/**
 * The empty state. ⚠️ Written as the GOOD outcome it is, following §19.7's rule
 * for an empty expired-leads pool: nothing to replace means every lead we sent
 * reached a landlord who was still there.
 */
export const REPLACEMENT_EMPTY =
  "Nothing to replace. Every lead you have worked recently reached a landlord " +
  "who was still looking.";

/**
 * Shown when the customer has leads to replace but no replacements left.
 * ⚠️ The rows stay on screen underneath. A screen that empties itself reads as
 * broken, and they still need to see which leads they were looking at.
 */
export const REPLACEMENT_EXHAUSTED =
  "You can still report these, and we will look into them — but the swap is " +
  "back next month.";
