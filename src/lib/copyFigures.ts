/**
 * Reading money and percentages out of generated copy, shared by the two
 * places that check a model did not invent a number.
 *
 * ⚠️ A PURE MOVE OUT OF `messaging/validateDraft.ts`, NOT A SECOND COPY. That
 * file records why: its `percent` pattern once failed to match "percentage",
 * so "we take a percentage of what the property earns" reached a landlord's
 * WhatsApp as an unbounded price claim — and it was found only because §41
 * REUSED the pattern rather than copying it. "A second copy would still have
 * the gap." The ad builder is the third consumer, so the primitives move here
 * and both callers import them.
 *
 * ⚠️ `PRICE_RE` DELIBERATELY DOES NOT MOVE. For a cold WhatsApp any mention of
 * price is refused; for an ad the rule INVERTS — T3's and T6's fifth angle is
 * literally "plain facts, fee and what is included". Reusing it as a rejection
 * would refuse every T3 ad ever generated, and the failure would be invisible:
 * a rejection retries once and then falls back to the default text, so every
 * ad would simply come back generic.
 *
 * ⚠️ `Array.from(matchAll(...))`, never a spread — this tsconfig predates
 * `downlevelIteration` and a spread will not compile. Both patterns carry `g`
 * and are used only with `matchAll`, which clones them; do not call `.test()`
 * on either, which would mutate `lastIndex` between calls.
 */

/** Within 5% covers honest rounding ("£83,000" for 83,260), not a new number. */
export const FIGURE_TOLERANCE = 0.05;

/** £83,260 / £83k / £180 */
export const MONEY_RE = /£\s?([\d,]+(?:\.\d+)?)\s?(k|m)?/gi;
/** 62% */
export const PERCENT_RE = /(\d+(?:\.\d+)?)\s?%/g;

export function parseMoney(raw: string, suffix?: string): number {
  const n = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(n)) return NaN;
  if (suffix?.toLowerCase() === "k") return n * 1_000;
  if (suffix?.toLowerCase() === "m") return n * 1_000_000;
  return n;
}

export function closeEnough(value: number, allowed: number[]): boolean {
  return allowed.some((a) => a > 0 && Math.abs(value - a) / a <= FIGURE_TOLERANCE);
}

/** Every marked money figure in the text, as numbers. */
export function moneyFigures(text: string): number[] {
  return Array.from(text.matchAll(MONEY_RE)).map((m) => parseMoney(m[1], m[2]));
}

/** Every marked percentage in the text, as numbers. */
export function percentFigures(text: string): number[] {
  return Array.from(text.matchAll(PERCENT_RE)).map((m) => Number(m[1]));
}
