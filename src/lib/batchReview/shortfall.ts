/**
 * A cycle that delivered less than the plan: the figures, and why (§73).
 *
 * Pure. The email in emails.ts renders these sentences and decides nothing.
 *
 * ⚠️ IT NEVER OFFERS OR IMPLIES A REFUND. The unspent credit carries forward
 * (invariant 2), and "owed" here means exactly that: leads still to come. §28.0
 * and §69 record why no copy may promise money back against a shortfall. A
 * test bans the words.
 *
 * ⚠️ THE CAUSE IS NAMED, because most shortfalls are the customer's own filter
 * rather than our supply (§69 measured 6 of 8 live filtered customers forecast
 * below their plan). Blaming supply for a filter is untrue, and blaming the
 * filter for supply is worse. A hold the customer set is a third cause, and the
 * simplest.
 */
import { planVsFilter } from "@/lib/planVsFilter";

export interface ShortfallSnapshot {
  allocation: number;
  delivered: number;
  balance_at_reset: number;
  next_allocation: number;
  pool_debit: number;
  cycle_start: string;
  cycle_end: string;
  filter_status: string | null;
  filter_expected_leads: number | null;
  filter_areas: string[] | null;
  filter_min_bedrooms: number | null;
  filter_max_bedrooms: number | null;
  filter_min_gross: number | null;
  release_hold_until: string | null;
}

/**
 * Short means BOTH: fewer leads than the plan, AND credit left over that will
 * roll on. A customer who delivered under plan with nothing banked (a pool
 * debit, a hand-edited balance) is owed nothing, and an email saying they are
 * would be false.
 */
export function isShortfall(s: Pick<ShortfallSnapshot, "allocation" | "delivered" | "balance_at_reset">): boolean {
  return s.delivered < s.allocation && s.balance_at_reset > 0;
}

/** Credit carried, plus the next cycle's grant, less any pool debit that grant will settle (§19.5). */
export function nextDue(s: Pick<ShortfallSnapshot, "balance_at_reset" | "next_allocation" | "pool_debit">): number {
  const grant = Math.max(0, s.next_allocation - Math.max(0, s.pool_debit));
  return Math.max(0, s.balance_at_reset) + grant;
}

export type ShortfallCause = "hold" | "filter" | "supply";

function filterInForce(status: string | null): boolean {
  return status === "active" || status === "pending_lift";
}

export function shortfallCause(s: ShortfallSnapshot): ShortfallCause {
  if (s.release_hold_until && s.release_hold_until > s.cycle_start) return "hold";
  if (filterInForce(s.filter_status)) {
    const verdict = planVsFilter({
      allocation: s.allocation,
      expected: s.filter_expected_leads,
      balance: s.balance_at_reset,
      costPerLeadPence: null,
      acknowledged: false,
    });
    // A filter with no stored figure is still the likeliest limit on supply;
    // only a filter forecast to COVER the plan clears it of blame.
    if (verdict.kind !== "covered") return "filter";
  }
  return "supply";
}

function leads(n: number): string {
  return `${n} lead${n === 1 ? "" : "s"}`;
}

function bedPhrase(min: number | null, max: number | null): string | null {
  if (min == null && max == null) return null;
  if (min != null && max != null) return min === max ? `${min}-bed` : `${min}–${max} bed`;
  if (min != null) return `${min}+ bed`;
  return `up to ${max} bed`;
}

/** "BS, GL · 3+ bed · £50k+ revenue". Null for a filter with no criteria stored. */
export function filterPhrase(s: ShortfallSnapshot): string | null {
  const parts: string[] = [];
  if (s.filter_areas && s.filter_areas.length > 0) {
    const shown = s.filter_areas.slice(0, 6).join(", ");
    parts.push(s.filter_areas.length > 6 ? `${shown} and ${s.filter_areas.length - 6} more` : shown);
  }
  const beds = bedPhrase(s.filter_min_bedrooms, s.filter_max_bedrooms);
  if (beds) parts.push(beds);
  if (s.filter_min_gross != null) parts.push(`£${Math.round(s.filter_min_gross / 1000)}k+ revenue`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export interface ShortfallCopy {
  subject: string;
  headline: string;
  figures: { label: string; value: string }[];
  cause: ShortfallCause;
  causeSentence: string;
  options: string[];
}

export function shortfallCopy(
  s: ShortfallSnapshot,
  productLabel: string,
  nextCycleLabel: string
): ShortfallCopy {
  const cause = shortfallCause(s);
  const due = nextDue(s);
  const filter = filterPhrase(s);

  const causeSentence =
    cause === "hold"
      ? "You held your leads for part of the month, so fewer were sent. Nothing is lost: the rest carry forward."
      : cause === "filter"
        ? `Your lead filter${filter ? ` (${filter})` : ""} matched fewer leads than your plan this month${
            s.filter_expected_leads != null
              ? ` — it is forecast to find at least ${leads(s.filter_expected_leads)} a month`
              : ""
          }. The leads you are owed carry forward and are sent as matching ones arrive.`
        : "We did not have enough new leads to send your full allocation this month. The leads you are owed carry forward and are sent as new ones arrive.";

  const options =
    cause === "filter"
      ? [
          "Widen your filter (more areas, a wider radius or more bedroom sizes) to receive them sooner.",
          "Or move to a plan closer to what your filter finds each month.",
        ]
      : cause === "hold"
        ? ["You can change or clear a hold under Settings at any time."]
        : [];

  return {
    subject: `${productLabel} leads: ${s.delivered} of ${s.allocation} delivered, ${leads(s.balance_at_reset)} carried forward`,
    headline: `We delivered ${s.delivered} of your ${s.allocation} ${productLabel.toLowerCase()} leads this month`,
    figures: [
      { label: "Delivered this month", value: String(s.delivered) },
      { label: "Owed, carried forward", value: String(s.balance_at_reset) },
      { label: `Due from ${nextCycleLabel}`, value: `${due} (${s.balance_at_reset} owed + ${Math.max(0, s.next_allocation - Math.max(0, s.pool_debit))} new)` },
    ],
    cause,
    causeSentence,
    options,
  };
}

/** One line for the top of the survey email, so a short customer reads the figures twice and the same way. */
export function shortfallSummaryLine(
  s: Pick<ShortfallSnapshot, "allocation" | "delivered" | "balance_at_reset">
): string {
  return `You received ${s.delivered} of your ${s.allocation} leads. ${leads(s.balance_at_reset)} carried forward and ${
    s.balance_at_reset === 1 ? "is" : "are"
  } still to come.`;
}
