import { closeEnough, moneyFigures, percentFigures } from "@/lib/copyFigures";
import { stripEmphasis } from "./emphasis";
import { AD_COPY_MAX, isMetaCtaType, type AdCopy } from "./metaFields";
import { serviceTokensFor, type AdTemplate } from "./templates";
import type { AdProfile, SlotValues, TargetingState } from "./resolveSlots";

/**
 * The last thing between a model and a live advert (§65).
 *
 * Three layers, the same arrangement `messaging/validateDraft.ts` uses:
 *   1. omission — a figure we do not have never enters the prompt
 *   2. the prompt's own prohibitions
 *   3. this, which REJECTS rather than repairs
 *
 * ⚠️ DECIDABLE RULES AND HEURISTICS ARE NOT PEERS, AND MUST NOT BE STATED AS
 * IF THEY WERE. A figure check is decidable; "is this an income claim" is not.
 * A keyword ban on `earn|income|revenue` rejects T7's OWN HEADLINE — "what
 * would your property earn on short lets?" — and `\w+est\b` matches "interest",
 * "request", "honest" and "invest".
 *
 * ⚠️ AND AN OVER-STRICT RULE DOES NOT ANNOUNCE ITSELF. A rejection retries
 * once and then collapses to the template's default text, so a bad rule does
 * not produce an error anybody sees: every ad simply comes back generic and it
 * reads as "the model is bad". Every heuristic below is scoped to a subject
 * plus a modal, and the template's OWN fixed headline and sub are exempt,
 * because they are not model-written.
 */

export type AdRejection =
  | "empty"
  | "too_long"
  | "missing_field"
  | "bad_cta"
  | "link_in_text"
  | "mentions_stayful"
  | "first_sentence_missing_audience"
  | "first_sentence_missing_category"
  | "figure_not_in_slots"
  | "fee_not_published"
  | "fee_without_vat_treatment"
  | "service_not_selected"
  | "quote_without_provenance"
  | "example_estimate"
  | "located_without_targeting"
  | "income_claim"
  | "occupancy_claim"
  | "market_superlative"
  | "legal_assurance";

export type AdVerdict =
  | { ok: true; copy: AdCopy }
  | { ok: false; reason: AdRejection; detail: string };

export type ValidationContext = {
  template: AdTemplate;
  slots: SlotValues;
  profile: AdProfile;
  targeting: TargetingState;
  /** The resolved headline and sub, which the model did not write. */
  fixed: { headline: string; sub: string };
};

const reject = (reason: AdRejection, detail: string): AdVerdict => ({ ok: false, reason, detail });

const LINK_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|co\.uk|net|org|io|app)\b)/i;
const STAYFUL_RE = /\bstayful\b/i;

/**
 * ⚠️ A NUMBER IMMEDIATELY BEFORE ONE OF THESE NOUNS IS A CLAIM, and it is the
 * only bare-number rule here. Checking every bare number would reject "3am",
 * "24 hours" and "six months"; checking none would let T8 invent "we look
 * after 400 properties" on a customer who has 140.
 */
// ⚠️ `\d[\d,]*`, NOT `[\d,]+`. The looser form matches a BARE COMMA, so the
// headline "Years, properties, reviews" parsed "," as a number, `Number("")`
// gave 0, and the validator rejected our own fallback copy. Caught by the test
// that runs every default through the rules it will be published under.
const TRUST_NUMBER_RE = /\b(\d[\d,]*(?:\.\d+)?)\s*(properties|years|reviews)\b/gi;
/** "4.9 on Google", "4.9 out of 5", "4.9 stars". */
const REVIEW_SCORE_RE = /\b(\d(?:\.\d+)?)\s*(?:\/\s*5|out of 5|on google|stars?)\b/gi;

/** A quoted span of real length, or a dash-attributed first name. */
const QUOTED_RE = /["“”'‘’]([^"“”]{12,})["“”]/;
const ATTRIBUTION_RE = /[—–-]\s*[A-Z][a-z]+(?:,\s*[A-Z][a-z]+)?\s*$/m;

/**
 * Heuristics. ⚠️ EACH IS A SUBJECT PLUS A MODAL, never a bare keyword — and
 * each was written by asking "does this reject the template's own copy?"
 */
const INCOME_CLAIM = [
  /\byou(?:'| w)ill (?:earn|make|get|see|receive)\b/i,
  /\b(?:earn|make|generate|bring in|take) (?:up to |over |more than |at least )?[£$€]?\s*[\d,]+/i,
  /\b(?:double|triple|[\d.]+x) (?:your|the) (?:rent|income|earnings|yield)\b/i,
  /\bguaranteed? (?:income|rent|return|yield)\b/i,
];
const OCCUPANCY_CLAIM = [
  /\b(?:booked|occupied|full|occupancy)\b[^.]{0,30}\b\d+\s*%/i,
  /\b\d+\s*%\b[^.]{0,30}\b(?:occupancy|occupied|booked)\b/i,
  /\b(?:always|never) (?:empty|vacant|void)\b/i,
];
const MARKET_SUPERLATIVE = [
  /\b(?:the )?(?:best|biggest|largest|leading|number one|no\.? ?1|top) (?:short let |airbnb |property |)(?:manager|management|agency|company|operator)s?\b/i,
  /\b(?:best|highest[- ]rated|most trusted) in\b/i,
  /\bnobody else\b/i,
];
/**
 * ⚠️ T6 ONLY. Three of its five angles invite legal advice directly, and the
 * spec's own claims note says the copy "must never imply legal advice or that
 * compliance is guaranteed". A footer disclaimer does not cure a body that
 * gives it — but it is also why this lexicon must not run on the other three,
 * where "you must" is ordinary English.
 */
const LEGAL_ASSURANCE = [
  /\bguarantee(?:d|s)? compliance\b/i,
  /\bfully compliant\b/i,
  /\blegally required\b/i,
  /\bthe law (?:requires|says|states)\b/i,
  /\byou must\b/i,
  /\bwe ensure\b/i,
  /\blicen[cs]e is (?:valid|in order)\b/i,
];

function firstSentence(text: string): string {
  const m = text.match(/^[^.!?]+[.!?]/);
  return (m ? m[0] : text).toLowerCase();
}

/**
 * Every marked figure in `text` must be one the customer gave us.
 *
 * ⚠️ EXPORTED BECAUSE THE IMAGE MUST PASS IT TOO. Every other rule here reads
 * copy, but T7's card is a form with an estimate row — and a "Current rent:
 * £950/mo" put there to look concrete is a figure, in the creative, from
 * nobody, which never passes through the model at all. The render flattens its
 * layout spec and runs this over it.
 */
export function figuresAreSupplied(
  text: string,
  allowed: { money: number[]; percent: number[]; trust: Record<string, number | null> }
): { ok: true } | { ok: false; detail: string } {
  const plain = stripEmphasis(text);

  for (const value of moneyFigures(plain)) {
    if (!Number.isFinite(value) || !closeEnough(value, allowed.money)) {
      return { ok: false, detail: `money ${value}` };
    }
  }
  for (const value of percentFigures(plain)) {
    if (!closeEnough(value, allowed.percent)) return { ok: false, detail: `percent ${value}` };
  }
  for (const m of Array.from(plain.matchAll(TRUST_NUMBER_RE))) {
    const value = Number(m[1].replace(/,/g, ""));
    const expected = allowed.trust[m[2].toLowerCase()];
    if (expected === null || expected === undefined || !closeEnough(value, [expected])) {
      return { ok: false, detail: `${m[1]} ${m[2]}` };
    }
  }
  for (const m of Array.from(plain.matchAll(REVIEW_SCORE_RE))) {
    const value = Number(m[1]);
    const expected = allowed.trust.score;
    // ⚠️ EXACT, NOT THE 5% TOLERANCE. That tolerance exists for honest
    // rounding of a large number — "£83,000" for 83,260. A review score is not
    // a number anybody rounds: 5.0 sits 2% from 4.9 and sails through, while
    // being a materially different claim about the business. The spec's own
    // rule is that every figure is the customer's own and must be entered.
    if (expected === null || expected === undefined || Math.abs(value - expected) > 1e-9) {
      return { ok: false, detail: `score ${m[1]}` };
    }
  }
  return { ok: true };
}

/** The figures this customer is allowed to state, from their own inputs. */
export function allowedFigures(ctx: ValidationContext) {
  const num = (k: keyof SlotValues) => {
    const v = ctx.slots[k as never];
    const n = v === undefined ? NaN : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const feePublic = ctx.profile.fee_public === true;
  const feePct = feePublic ? num("fee_pct") : null;
  return {
    // ⚠️ NO MONEY IS EVER ALLOWED IN PART 1. Not one slot in any of the four
    // templates is a money figure — the closest is a percentage fee. So a
    // pound sign in generated copy is always an invented number.
    money: [] as number[],
    percent: feePct === null ? [] : [feePct],
    trust: {
      properties: num("properties_managed"),
      years: num("years_trading"),
      reviews: num("review_count"),
      score: num("review_score"),
    } as Record<string, number | null>,
  };
}

export function validateAdCopy(raw: unknown, ctx: ValidationContext): AdVerdict {
  if (!raw || typeof raw !== "object") return reject("empty", "not an object");
  const body = raw as Record<string, unknown>;

  const message = typeof body.message === "string" ? body.message.trim() : "";
  const headline = typeof body.headline === "string" ? body.headline.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (!message || !headline || !description) return reject("missing_field", "message/headline/description");

  const cta = ctx.template.metaCta;
  if (!isMetaCtaType(cta)) return reject("bad_cta", String(cta));

  const linkUrl = ctx.slots.landing_url;
  if (!linkUrl) return reject("missing_field", "landing_url");

  if (message.length > AD_COPY_MAX.message) return reject("too_long", `message ${message.length}`);
  if (headline.length > AD_COPY_MAX.headline) return reject("too_long", `headline ${headline.length}`);
  if (description.length > AD_COPY_MAX.description) return reject("too_long", `description ${description.length}`);

  // Everything the model wrote, checked together. The template's own fixed
  // headline and sub are NOT in here — they are not model output, and running
  // the heuristics over them would reject T7's headline for saying "earn".
  const written = [message, headline, description].join("\n");

  // ⚠️ `copy.link_url` is a URL by construction, so a URL in the TEXT fields
  // is always the model adding one.
  if (LINK_RE.test(written)) return reject("link_in_text", "url in a text field");
  if (STAYFUL_RE.test(written)) return reject("mentions_stayful", "names Stayful");

  // The spec's generation check.
  const opener = firstSentence(message);
  if (!ctx.template.audienceTokens.some((t) => opener.includes(t))) {
    return reject("first_sentence_missing_audience", opener.slice(0, 80));
  }
  if (!ctx.template.categoryTokens.some((t) => opener.includes(t))) {
    return reject("first_sentence_missing_category", opener.slice(0, 80));
  }

  // ⚠️ THE FEE RULES RUN BEFORE THE GENERIC FIGURE CHECK, and the order is the
  // point. With fee_public off there are no allowed percentages at all, so the
  // figure check would reject "15%" first and file it as figure_not_in_slots —
  // true, but it hides WHICH guardrail fired, and the ledger exists to answer
  // exactly that.
  // ⚠️ AND ONLY WHEN THE PERCENTAGE IS PLAUSIBLY A FEE. Not every percentage
  // is one: "booked 90% of the year" is an occupancy claim, and filing it as
  // "they published a fee they had not published" is a wrong answer to the
  // question the ledger is asked. Anything else falls through to the figure
  // check, which rejects it as the invented number it is.
  const mentionsPercent = percentFigures(stripEmphasis(written)).length > 0;
  const soundsLikeAFee = /\b(fee|fees|charge|charges|commission|we take|our cut)\b/i.test(written);
  if (mentionsPercent && soundsLikeAFee && ctx.profile.fee_public !== true) {
    return reject("fee_not_published", "a percentage with fee_public off");
  }
  if (mentionsPercent && soundsLikeAFee && !ctx.profile.fee_vat) {
    // A bare "15%" is a different price with and without VAT, and the landlord
    // reading it cannot tell which.
    return reject("fee_without_vat_treatment", "no fee_vat recorded");
  }

  const figures = figuresAreSupplied(written, allowedFigures(ctx));
  if (!figures.ok) return reject("figure_not_in_slots", figures.detail);

  // ⚠️ Only items they tick may appear.
  const selected =
    ctx.template.services?.slot === "handled"
      ? ctx.profile.handled ?? []
      : ctx.profile.included ?? [];
  const { forbidden } = serviceTokensFor(ctx.template, selected);
  const lowered = written.toLowerCase();
  const named = forbidden.find((tok) => lowered.includes(tok));
  if (named) return reject("service_not_selected", named);

  // ⚠️ Without a confirmed quote, T8's angle 3 is dropped from the prompt —
  // and this is the stop for a model that invents one anyway.
  if (ctx.profile.review_quote_confirmed !== true) {
    if (QUOTED_RE.test(written)) return reject("quote_without_provenance", "quoted span");
    if (ATTRIBUTION_RE.test(written)) return reject("quote_without_provenance", "name attribution");
  }

  // ⚠️ T7 MUST NEVER SHOW AN EXAMPLE ESTIMATE, not even a plausible one: a
  // specific figure in the creative is a claim regardless of the disclaimer
  // beneath it. Money is already refused above; this catches the worded form.
  if (ctx.template.id === "what-would-it-earn") {
    if (/\b(?:for example|e\.g\.|say|typically|around|about)\b[^.]{0,24}[£$€]\s*[\d,]/i.test(written)) {
      return reject("example_estimate", "worked example");
    }
  }

  // A located headline with nothing behind it wastes the customer's money and
  // reads as a mail-merge to everyone outside the city.
  if (ctx.slots.city !== undefined && ctx.targeting.kind === "unset") {
    return reject("located_without_targeting", "city set with no targeting");
  }

  for (const re of INCOME_CLAIM) if (re.test(written)) return reject("income_claim", re.source.slice(0, 40));
  for (const re of OCCUPANCY_CLAIM) if (re.test(written)) return reject("occupancy_claim", re.source.slice(0, 40));
  for (const re of MARKET_SUPERLATIVE) if (re.test(written)) return reject("market_superlative", re.source.slice(0, 40));
  if (ctx.template.id === "rules-keep-changing") {
    for (const re of LEGAL_ASSURANCE) if (re.test(written)) return reject("legal_assurance", re.source.slice(0, 40));
  }

  return {
    ok: true,
    copy: { message, headline, description, call_to_action_type: cta, link_url: linkUrl },
  };
}
