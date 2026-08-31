/**
 * The last line between a model and a landlord's phone.
 *
 * A prompt is an instruction, not a guarantee. This is the third layer:
 *   1. omission — a figure we do not have never enters the prompt
 *   2. the prompt's own prohibitions
 *   3. this, which REJECTS rather than repairs
 *
 * ⚠️ IT REJECTS, IT DOES NOT REPAIR. A truncated WhatsApp cut mid-sentence, or
 * one with a number quietly deleted, is worse than no draft: the operator would
 * send it believing we had checked it. On rejection the composer keeps the empty
 * textarea it already had.
 *
 * ⚠️ AND THE FALLBACK IS NOT A TEMPLATE. claudeMapping.ts falls back to a duller
 * mapping because a duller mapping is still useful. There is no equivalent here
 * — a canned message pasted into WhatsApp is precisely the mass-outreach pattern
 * that gets the operator's own number restricted.
 */
import type { DraftContext } from "./draftContext";

export type DraftRejection =
  | "empty"
  | "too_long"
  | "too_many_sentences"
  | "figure_when_none_supplied"
  | "figure_not_supplied"
  | "mentions_price"
  | "contains_link"
  | "missing_landlord_name";

export type DraftVerdict =
  | { ok: true; text: string }
  | { ok: false; reason: DraftRejection };

const MAX_CHARS = 480;
const MAX_SENTENCES = 5;
/** Within 5% covers honest rounding ("£83,000" for 83,260), not a new number. */
const FIGURE_TOLERANCE = 0.05;

/**
 * Pricing language. The report states Stayful's 15%; the operator's own fee has
 * a different basis and therefore a different number. A first message settles it
 * by mentioning neither — including "no fee", which is still a price claim.
 */
// ⚠️ `percentages?` NOT `percent`. The original listed `percent` with a
// trailing \b, which does not match "percentage" — so "we take a percentage of
// what the property earns" passed this check and reached a landlord's WhatsApp
// as an unbounded price claim. Found by the §41 operator-intro tests, which
// reuse this pattern rather than copying it; a second copy would still have the
// gap. Ordered longest-first so the alternation cannot match the shorter form
// and stop.
export const PRICE_RE =
  /\b(fees?|commission|percentages?|per cent|percent|we charge|our charge|charges?|pricing|price list|rate card|cut of|% of)\b/i;

const LINK_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|co\.uk|net|org|io|app)\b)/i;

/** £83,260 / £83k / £180 */
const MONEY_RE = /£\s?([\d,]+(?:\.\d+)?)\s?(k|m)?/gi;
/** 62% */
const PERCENT_RE = /(\d+(?:\.\d+)?)\s?%/g;

function parseMoney(raw: string, suffix?: string): number {
  const n = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(n)) return NaN;
  if (suffix?.toLowerCase() === "k") return n * 1_000;
  if (suffix?.toLowerCase() === "m") return n * 1_000_000;
  return n;
}

function closeEnough(value: number, allowed: number[]): boolean {
  return allowed.some(
    (a) => a > 0 && Math.abs(value - a) / a <= FIGURE_TOLERANCE
  );
}

export function validateDraft(raw: unknown, ctx: DraftContext): DraftVerdict {
  if (typeof raw !== "string") return { ok: false, reason: "empty" };
  const text = raw.trim();
  if (!text) return { ok: false, reason: "empty" };

  if (text.length > MAX_CHARS) return { ok: false, reason: "too_long" };

  const sentences = text.split(/[.!?]+\s/).filter((s) => s.trim().length > 0);
  if (sentences.length > MAX_SENTENCES) {
    return { ok: false, reason: "too_many_sentences" };
  }

  // A link in a cold WhatsApp is the strongest single spam signal there is, and
  // the number at risk belongs to the operator.
  if (LINK_RE.test(text)) return { ok: false, reason: "contains_link" };

  if (PRICE_RE.test(text)) return { ok: false, reason: "mentions_price" };

  // Only MARKED numbers are checked — a bare number is a bedroom count or
  // "24/7", and rejecting those would refuse perfectly good messages.
  // Array.from rather than spread: the repo's tsconfig target predates
  // downlevelIteration, and a matchAll spread will not compile.
  const money = Array.from(text.matchAll(MONEY_RE)).map((m) =>
    parseMoney(m[1], m[2])
  );
  const percents = Array.from(text.matchAll(PERCENT_RE)).map((m) =>
    Number(m[1])
  );

  if (!ctx.figures) {
    if (money.length > 0 || percents.length > 0) {
      return { ok: false, reason: "figure_when_none_supplied" };
    }
  } else {
    const allowedMoney = [ctx.figures.grossAnnual, ctx.figures.nightlyRate]
      .filter((n): n is number => n !== null);
    const allowedPct = [ctx.figures.occupancyPct].filter(
      (n): n is number => n !== null
    );

    if (money.some((v) => !Number.isFinite(v) || !closeEnough(v, allowedMoney))) {
      return { ok: false, reason: "figure_not_supplied" };
    }
    if (percents.some((v) => !closeEnough(v, allowedPct))) {
      return { ok: false, reason: "figure_not_supplied" };
    }
  }

  // Cheap, and it catches a generic template that ignored the lead entirely.
  //
  // ⚠️ FIRST MESSAGES ONLY. On an opener, a message that never says the
  // landlord's name is a template that ignored the lead. On a fourth follow-up
  // it is often the BEST message available — "Any thoughts on this one?" is a
  // perfectly good nudge, and this rule would reject it. Worse, it would push
  // the model towards shoehorning the name into every chase, which is the
  // repetitive, obviously-automated pattern the follow-up prompt exists to
  // avoid and the one that gets a number restricted.
  //
  // Every other rule above still applies unchanged: no links, no pricing, no
  // unsupplied figures, 480 characters.
  if (ctx.landlord.firstName && !ctx.step) {
    const name = ctx.landlord.firstName.toLowerCase();
    if (!text.toLowerCase().includes(name)) {
      return { ok: false, reason: "missing_landlord_name" };
    }
  }

  return { ok: true, text };
}

/** What the operator is told when a draft is refused. Never the code. */
export function rejectionMessage(reason: DraftRejection): string {
  switch (reason) {
    case "figure_when_none_supplied":
    case "figure_not_supplied":
      return "We couldn't write a draft we trust for this one — it used a figure we can't verify. The message is yours to write.";
    case "mentions_price":
      return "We couldn't write a draft for this one — it strayed into pricing, which is better left to the call. The message is yours to write.";
    default:
      return "We couldn't write a draft for this one. The message is yours to write.";
  }
}
