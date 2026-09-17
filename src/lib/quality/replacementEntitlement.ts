/**
 * How many leads a customer may replace, and the words for it.
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
 * ⚠️ SINCE 0153 (§61) THE NUMBER IS A BALANCE THAT CARRIES OVER, not a share of
 * this month. A 10-lead plan banks one a month; unused, next month they have
 * two. So the copy says how many are AVAILABLE and what the next billing date
 * ADDS, never "N of N this month" — a sentence that would be false the first
 * time somebody carried one over.
 *
 * ⚠️ THE CREDIT PATH IS UNCHANGED AND STILL SAYS NOTHING. decideDeadLeadClaim
 * spends the same balance, and the six files `deadLeadPolicy.test.ts` guards
 * all behave exactly as they did: over the balance, a CREDIT claim still routes
 * to review with wording indistinguishable from any other review outcome. One
 * surface states the number. Nothing else restates it.
 *
 * ⚠️ IMPORT-FREE, like `deadLeadCopy.ts` and `featureRequest.ts` before it
 * (§21.8, §51.6). The replacements page is a client component, and
 * `deadLeadPolicy.ts` reaches `plans.ts` through `products.ts`. So the
 * arithmetic stays on the server — `monthlyReplacementGrant()` and
 * `replacementsAvailable()` are the ONE definition of the figures — and only
 * the resolved numbers and the wording live here.
 */

/** Why swapping is on hold for a product. Resolved server-side, per product. */
export type ReplacementHold = "past_due" | "paused";

/** Per product, or absent when the customer does not hold that product. */
export type ReplacementHolds = Partial<
  Record<"management" | "guaranteed_rent", ReplacementHold | null>
>;

/** What the page is told, already resolved. */
export interface ReplacementEntitlement {
  /** Replacements banked and not yet spent. `replacementsAvailable()`, server-side. */
  available: number;
  /** What the next billing date adds. `monthlyReplacementGrant()`, server-side. 0 when nothing accrues. */
  monthlyGrant: number;
  /** ISO date the next grant lands, or null when it cannot be resolved. */
  nextGrantOn: string | null;
}

/** The columns the next grant date is derived from. Structural, so no type import. */
export interface ResetAnchors {
  billing_cycle_anchor?: string | null;
  gr_billing_cycle_anchor?: string | null;
  created_at?: string | null;
}

/**
 * When the next grant lands.
 *
 * ⚠️ THE COALESCE ORDER MIRRORS `replacement_cycle_start` EXACTLY, and it must.
 * 0141 keyed the claim counter on coalesce(billing_cycle_anchor,
 * gr_billing_cycle_anchor, created_at), and 0153's grant lands for the cycle
 * that starts on that same day, so a GR-only customer is granted on their GR
 * anchor. Deriving this date from anything else — the management anchor alone,
 * or the signup date — prints a day on which nothing happens.
 *
 * ⚠️ The month-end branch mirrors it too: an anchor on the 31st falls on the
 * last day of a short month, exactly as the SQL's clamp does.
 */
export function nextGrantDate(
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

  // The grant day in a given month: the anchor day, or that month's last day
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

/** Where "Manage billing" already lives, for the past-due notice. */
export const MANAGE_BILLING_PATH = "/dashboard/packages";

export const REPLACEMENT_PAGE_HEADING = "Replace a lead";

export const REPLACEMENT_PAGE_INTRO =
  "Leads you rang where the landlord had already gone. Tell us what they said " +
  "and swap it for another one.";

/** Product names for the hold notice, when a customer holds both. */
export const REPLACEMENT_PRODUCT_LABELS: Record<
  "management" | "guaranteed_rent",
  string
> = {
  management: "Management",
  guaranteed_rent: "Guaranteed rent",
};

function formatGrantDate(iso: string | null): string | null {
  if (!iso) return null;
  const when = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(when.getTime())) return null;
  return when.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

/**
 * The published count.
 *
 * ⚠️ It says "replacements", never a word for the mechanism behind it. The
 * number is the customer's balance; how it is sized, earned or spent on
 * anything else is ours.
 */
export function availableSentence(e: ReplacementEntitlement): string {
  if (e.available <= 0 && e.monthlyGrant <= 0) {
    return "Replacements are not available on your account at the moment.";
  }
  if (e.available <= 0) {
    return "You have no replacements available right now.";
  }
  if (e.available === 1) {
    return "You have 1 replacement available.";
  }
  return `You have ${e.available} replacements available.`;
}

/**
 * What the next billing date adds, and that unused ones carry over — the
 * sentence that makes the balance legible as a balance.
 *
 * ⚠️ NULL WHEN THE GRANT IS ZERO. A written-off customer, or one holding no
 * product, accrues nothing, and "0 more are added on 7 October" is a lie about
 * a date on which nothing happens.
 */
export function nextGrantSentence(e: ReplacementEntitlement): string | null {
  if (e.monthlyGrant <= 0) return null;
  const formatted = formatGrantDate(e.nextGrantOn);
  if (!formatted) return null;
  const verb = e.monthlyGrant === 1 ? "is" : "are";
  return `${e.monthlyGrant} more ${verb} added on ${formatted}, and anything you don't use carries over.`;
}

/**
 * Shown when the customer has leads to replace but nothing banked.
 * ⚠️ The rows stay on screen underneath and the button stays disabled — a
 * screen that empties itself reads as broken, and they still need to see which
 * leads they were looking at. The credit report on the lead page is still open
 * to them, and the sentence says so without naming what it costs.
 */
export function exhaustedSentence(e: ReplacementEntitlement): string {
  const base =
    "You can still report these from the lead itself and we will look into them.";
  const formatted = e.monthlyGrant > 0 ? formatGrantDate(e.nextGrantOn) : null;
  return formatted
    ? `${base} Your next replacement is added on ${formatted}.`
    : base;
}

/**
 * Why swapping is on hold. ⚠️ Both say the count is KEPT: a hold is not a
 * penalty, and a customer who reads "on hold" as "taken away" has a complaint
 * we would deserve.
 */
export const HOLD_COPY: Record<ReplacementHold, string> = {
  past_due:
    "Your last payment was declined, so replacements are on hold. Please check " +
    "with your bank or update your card under Manage billing — your count is " +
    "kept and keeps building.",
  paused:
    "Your subscription is paused. Replacements are back the moment it resumes, " +
    "and your count keeps building meanwhile.",
};

/** The hold sentence, prefixed with the product when the customer holds both. */
export function holdSentence(
  hold: ReplacementHold,
  product: "management" | "guaranteed_rent" | null,
): string {
  const body = HOLD_COPY[hold];
  return product ? `${REPLACEMENT_PRODUCT_LABELS[product]}: ${body}` : body;
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
 * Shown on a row whose slot is ALREADY a replacement (0146).
 *
 * ⚠️ It says a person will look at it, and it does NOT promise a swap. The
 * mechanics already worked — a review verdict comes back with the neutral
 * sentence and nothing is swapped — but the row's button said "Swap this lead"
 * right up until it did not, which is §52.4's objection to a control that
 * silently behaves differently from how it reads.
 *
 * ⚠️ It is safe to say out loud only because this is the customer's OWN
 * history. The other two review valves must stay silent: `quality_review_required`
 * is an admin judgement about them, and a peer working the same landlord is
 * §19.7's forbidden disclosure. Naming a chain tells them nothing they did not
 * already know.
 */
export const REPLACEMENT_CHAINED_NOTICE =
  "This lead was itself a replacement. We will look at this one ourselves and come back to you, rather than sending a new lead out straight away.";

/** The submit label for a chained row, so nothing promises a swap that is not coming. */
export const REPLACEMENT_CHAINED_ACTION = "Send this to us";
