import { closeEnough, moneyFigures, percentFigures } from "@/lib/copyFigures";
import { stripEmphasis } from "./emphasis";
import {
  AD_COPY_MAX,
  AD_IMAGE_CHARSET,
  AD_IMAGE_MAX,
  META_TRUNCATION_MARKS,
  isMetaCtaType,
  type AdCopy,
  type AdVariant,
} from "./metaFields";
import { serviceTokensFor, type AdTemplate } from "./templates";
import type { AdProfile, SlotValues, TargetingState } from "./resolveSlots";

/**
 * The last thing between a model and a live ad (§65).
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
 * plus a modal, and each was written by asking "does this reject the
 * template's own copy?"
 *
 * ⚠️ PER VARIANT, NOT PER RESPONSE, AND THAT IS THE STRUCTURAL CHANGE HERE.
 * One `message` used to be the whole ad, so any rejection cost the whole
 * generation. Five now arrive together, and a rule that fires on one of them
 * must lose one of them — otherwise a single unlucky sentence throws away four
 * good texts and the operator sees canned copy again.
 *
 * Response-level gates are the ones that read NOTHING the model wrote: the
 * template's own CTA, the destination's link, and the shape of the object.
 */

export type AdRejection =
  | "empty"
  | "too_long"
  | "missing_field"
  | "bad_cta"
  | "unknown_angle"
  | "duplicate_angle"
  | "copy_repeats_itself"
  | "unrenderable"
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
  | "income_claim"
  | "occupancy_claim"
  | "market_superlative"
  | "legal_assurance";

/** Why one variant was dropped, kept so the retry can ask for that angle again. */
export type AdVariantRejection = { angleKey: string; reason: AdRejection; detail: string };

export type AdVerdict =
  | { ok: true; copy: AdCopy; rejected: AdVariantRejection[] }
  | { ok: false; reason: AdRejection; detail: string; rejected: AdVariantRejection[] };

export type ValidationContext = {
  template: AdTemplate;
  slots: SlotValues;
  profile: AdProfile;
  targeting: TargetingState;
  /**
   * The template's own headline and sub, slot-filled.
   *
   * ⚠️ `example`, NOT `fixed`. These are shown to the model as the register to
   * write in and kept as the fallback when what it writes will not render —
   * they are no longer what is drawn by default.
   */
  example: { headline: string; sub: string };
};

const reject = (reason: AdRejection, detail: string, rejected: AdVariantRejection[] = []): AdVerdict => ({
  ok: false,
  reason,
  detail,
  rejected,
});

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

/**
 * A quoted span of real length.
 *
 * ⚠️ DOUBLE QUOTES ONLY, AND NOT ACROSS A LINE BREAK. The old form opened on
 * `["“”'‘’]` and its inner class spanned newlines, so ONE APOSTROPHE followed
 * twelve characters later by any double quote was a "fabricated testimonial":
 *   That's the whole point. Ask "what's included?"
 * matched, on an apostrophe, and every generation containing it died. An
 * apostrophe is not a quotation mark in English prose and must never open one
 * here.
 */
const QUOTED_RE = /["“]([^"“”\n]{12,})["”]/;
/**
 * A dash-attributed name — "— Sarah, Leicester".
 *
 * ⚠️ THE DASH MUST OPEN A LINE, AND MUST BE AN EM OR EN DASH. The old form
 * allowed a plain hyphen anywhere before end-of-line, so the perfectly ordinary
 * headline `Short let management — Leeds` read as a fabricated testimonial.
 * A real attribution sits on its own line; a dash mid-sentence is punctuation.
 */
const ATTRIBUTION_RE = /^[ \t]*[—–][ \t]*[A-Z][a-z]+(?:,[ \t]*[A-Z][a-z]+)?[ \t]*$/m;

/**
 * Heuristics. ⚠️ EACH IS A SUBJECT PLUS A MODAL, never a bare keyword.
 */
const INCOME_CLAIM = [
  // ⚠️ `you'll` NEEDS THE APOSTROPHE ALTERNATIVES. The old `you(?:'| w)ill`
  // could not match `you'll` at all — it wanted "you'ill" or "you will" — so
  // the commonest phrasing of the claim this rule exists for walked straight
  // past it. Under-strict, not over.
  /\byou(?:['’]ll| will| are going to)\s+(?:earn|make|get|see|receive|take home|pocket)\b/i,
  // ⚠️ A BARE NUMBER, DELIBERATELY — the currency form is already caught, and
  // more precisely, by the figure check: `allowedFigures().money` is empty in
  // part 1, so any `£` in generated copy is `figure_not_in_slots`. What this
  // adds is "earn 4000 a month", which carries no symbol and no trust noun.
  //
  // ⚠️ `take` IS NOT IN THE VERB LIST. It matched "take 24 hours" — and T7's
  // fourth angle is how long an answer takes, with the turnaround in the brief,
  // so the template's own strongest angle was unwritable.
  /\b(?:earn|make|generate|bring in)\s+(?:up to |over |more than |at least |around |about )?\d[\d,]*(?:\.\d+)?\s*(?:k\b|[£$€]|per (?:month|year|week|night)|a (?:month|year|week|night)|pcm\b|pa\b)/i,
  /\b(?:double|triple|[\d.]+x) (?:your|the) (?:rent|income|earnings|yield)\b/i,
  /\bguaranteed? (?:income|rent|return|yield)\b/i,
];
const OCCUPANCY_CLAIM = [
  /\b(?:booked|occupied|full|occupancy)\b[^.]{0,30}\b\d+\s*%/i,
  /\b\d+\s*%\b[^.]{0,30}\b(?:occupancy|occupied|booked)\b/i,
  /\b(?:always|never) (?:empty|vacant|void)\b/i,
];
const MARKET_SUPERLATIVE = [
  // ⚠️ THE EMPTY ALTERNATIVE IS DOING ITS JOB — leave it. "the best management
  // you'll find" is a market superlative about the business with no category
  // noun in between, which is exactly the shape this catches.
  /\b(?:the )?(?:best|biggest|largest|leading|number one|no\.? ?1|top) (?:short let |airbnb |property |)(?:manager|management|agency|company|operator)s?\b/i,
  // ⚠️ THE SUPERLATIVE HAS TO BE THE CLAIM, NOT AN ADVERB. A bare
  // `(?:best|most trusted) in` matched "what works best in Leeds" — ordinary
  // English about the market rather than a claim about the business.
  //
  // ⚠️ AND REQUIRING "the" ALONE IS TOO NARROW: the test's own case is
  // "Most trusted in the city.", which opens a sentence with no article. So it
  // fires on "the …" or on a superlative that STARTS a clause, and on nothing
  // that follows a verb.
  /(?:\bthe |^|[.!?]\s+)(?:best|highest[- ]rated|most trusted) in\b/i,
  // ⚠️ SCOPED TO A COMPARATIVE ABOUT THE BUSINESS. Bare `nobody else` is T3's
  // own premise — "nobody else is awake at 3am" — and rejecting it made the
  // template's first angle unwritable.
  /\bnobody else (?:comes close|can match|does (?:this|it)|offers? (?:this|that))\b/i,
];
/**
 * ⚠️ T6 ONLY. Three of its five angles invite legal advice directly, and the
 * spec's own claims note says the copy "must never imply legal advice or that
 * compliance is guaranteed". A footer disclaimer does not cure a body that
 * gives it — but it is also why this lexicon must not run on the other three.
 */
const LEGAL_ASSURANCE = [
  /\bguarantee(?:d|s)? compliance\b/i,
  /\bfully compliant\b/i,
  /\blegally required\b/i,
  /\bthe law (?:requires|says|states)\b/i,
  // ⚠️ NARROWED WITH A LOOKAHEAD, NOT DELETED. The plan said to drop these two
  // because they are "the sentences a compliance ad exists to say" — and half
  // of that is right: a bare `you must` rejects "you must be wondering" and
  // `we ensure` rejects "we ensure the place is spotless". But the other half
  // is the rule the spec actually asks for, and dropping it outright would
  // licence "you must register with the council" and "we ensure you're
  // compliant" — advice, in an operator's name, to the public.
  //
  // So the modal has to be followed by a compliance subject in the same clause.
  /\byou must\b(?=[^.!?]{0,48}\b(?:register|licen[cs]e|licensing|comply|complies|compliant|compliance|apply|notify|declare|certificate|certified|law|legally|council|regulation)\b)/i,
  // ⚠️ THE OBJECT LIST INCLUDES "paperwork", "right" AND "in order", WHICH IS
  // NOT PADDING. "We ensure the paperwork is right" states in plain English
  // exactly what the spec forbids — that compliance is guaranteed — without
  // using a single legal word. What the lookahead buys is that "we ensure the
  // place is spotless" and "we ensure your guests are looked after" pass, which
  // a bare `\bwe ensure\b` refused.
  /\bwe (?:ensure|guarantee)\b(?=[^.!?]{0,48}\b(?:compliant|compliance|legal|lawful|licen[cs]e|licensing|regulation|safety|certificate|certified|paperwork|right|correct|up to date|in order|valid)\b)/i,
  /\blicen[cs]e is (?:valid|in order)\b/i,
];

/**
 * The opening of the primary text, as Meta will show it before "… See more".
 *
 * ⚠️ 125 CHARACTERS, NOT THE FIRST SENTENCE, AND THE OLD FORM HAD TWO FAULTS.
 * It split on any `.`, so a T8 opener stating the review score truncated at
 * "4." and then failed the category check — USING THE FIGURE THE BRIEF INVITES
 * WAS AN AUTOMATIC REJECTION. And requiring both the audience and the category
 * inside sentence one forbids every hook opener the spec's own angles are
 * built on ("Your cleaner just cancelled. Landlords letting short-term…").
 *
 * The rule is really about the truncated preview, so it is stated as the
 * truncated preview. Emphasis markers are stripped first, or `*Landlords*`
 * fails an audience check for the asterisks around it.
 */
function opening(text: string): string {
  return stripEmphasis(text).slice(0, META_TRUNCATION_MARKS.message).toLowerCase();
}

/** Sentence-ish spans, for the rules that need a clause rather than a blob. */
function clauses(text: string): string[] {
  return stripEmphasis(text)
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * ⚠️ WHOLE WORDS, NOT SUBSTRINGS. `lowered.includes("check in")` is fine, but
 * `includes("license")` rejected "a licensed operator" and `includes("clean")`
 * rejected "the cleaner who cancels on a Friday" — which is T3's own second
 * angle. A service token names a service; it does not name every word that
 * contains it.
 */
function namesToken(text: string, token: string): boolean {
  return new RegExp(`(?:^|[^a-z0-9])${escapeRe(token)}(?![a-z0-9])`, "i").test(text);
}

/**
 * Does this clause CLAIM to provide something, as opposed to mentioning it?
 *
 * ⚠️ WITHOUT THIS, T3'S SECOND ANGLE IS UNWRITABLE. "The cleaner who cancels
 * on a Friday" is the problem the ad describes, not a service being offered —
 * and a customer who has not ticked cleaning is exactly the customer that angle
 * is for. The rule the spec states is "only items they tick may appear" as
 * things the operator does, and that is what a claim marker tests.
 */
const CLAIM_MARKER = /\b(?:we|our|us|i|include[ds]?|including|handles?|handled|covers?|covered|offers?|offered|takes? care of|sorted?|arrange[ds]?)\b/i;

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

/**
 * The claims rules, over one span of model-written text.
 *
 * ⚠️ `detail` IS THE MATCHED SPAN, NEVER `re.source`. The retry prompt is
 * shown this string, and four of these codes used to hand it a truncated
 * regular expression — `(\b(?:earn|make|generate|bring in|take) (?:up)` — as
 * an explanation of what the model had done wrong. A model given that writes
 * the same sentence again with different adjectives, which is the retry
 * spending a second call to arrive at the same rejection.
 */
function claimsVerdict(
  written: string,
  ctx: ValidationContext
): { reason: AdRejection; detail: string } | null {
  const hit = (list: RegExp[]) => {
    for (const re of list) {
      const m = written.match(re);
      if (m) return m[0].trim().slice(0, 60);
    }
    return null;
  };

  // ⚠️ `copy.link_url` is a URL by construction, so a URL in the TEXT fields
  // is always the model adding one.
  if (LINK_RE.test(written)) return { reason: "link_in_text", detail: "a url in the text" };
  if (STAYFUL_RE.test(written)) return { reason: "mentions_stayful", detail: "names Stayful" };

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
    return { reason: "fee_not_published", detail: "a percentage with fee_public off" };
  }
  if (mentionsPercent && soundsLikeAFee && !ctx.profile.fee_vat) {
    // A bare "15%" is a different price with and without VAT, and the landlord
    // reading it cannot tell which.
    return { reason: "fee_without_vat_treatment", detail: "no fee_vat recorded" };
  }

  const figures = figuresAreSupplied(written, allowedFigures(ctx));
  if (!figures.ok) return { reason: "figure_not_in_slots", detail: figures.detail };

  // ⚠️ Only items they tick may appear — as things the OPERATOR DOES.
  const selected =
    ctx.template.services?.slot === "handled"
      ? ctx.profile.handled ?? []
      : ctx.profile.included ?? [];
  const { forbidden } = serviceTokensFor(ctx.template, selected);
  if (forbidden.length) {
    for (const clause of clauses(written)) {
      if (!CLAIM_MARKER.test(clause)) continue;
      const named = forbidden.find((tok) => namesToken(clause, tok));
      if (named) return { reason: "service_not_selected", detail: named };
    }
  }

  // ⚠️ Without a confirmed quote, T8's angle 3 is dropped from the prompt —
  // and this is the stop for a model that invents one anyway.
  if (ctx.profile.review_quote_confirmed !== true) {
    const quoted = written.match(QUOTED_RE);
    if (quoted) return { reason: "quote_without_provenance", detail: quoted[0].slice(0, 60) };
    const attributed = written.match(ATTRIBUTION_RE);
    if (attributed) return { reason: "quote_without_provenance", detail: attributed[0].trim().slice(0, 60) };
  }

  // ⚠️ T7 MUST NEVER SHOW AN EXAMPLE ESTIMATE, not even a plausible one: a
  // specific figure in the creative is a claim regardless of the disclaimer
  // beneath it. Money is already refused above; this catches the worded form.
  if (ctx.template.id === "what-would-it-earn") {
    const worked = written.match(/\b(?:for example|e\.g\.|say|typically|around|about)\b[^.]{0,24}[£$€]\s*[\d,]/i);
    if (worked) return { reason: "example_estimate", detail: worked[0].trim().slice(0, 60) };
  }

  const income = hit(INCOME_CLAIM);
  if (income) return { reason: "income_claim", detail: income };
  const occupancy = hit(OCCUPANCY_CLAIM);
  if (occupancy) return { reason: "occupancy_claim", detail: occupancy };
  const superlative = hit(MARKET_SUPERLATIVE);
  if (superlative) return { reason: "market_superlative", detail: superlative };
  if (ctx.template.id === "rules-keep-changing") {
    const legal = hit(LEGAL_ASSURANCE);
    if (legal) return { reason: "legal_assurance", detail: legal };
  }

  return null;
}

/** Same string twice, give or take punctuation and case. */
const sameText = (a: string, b: string) => {
  const flat = (s: string) => stripEmphasis(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return flat(a).length > 0 && flat(a) === flat(b);
};

function validateVariant(
  raw: unknown,
  ctx: ValidationContext,
  offered: Map<string, string>,
  taken: Set<string>,
  messages: string[]
): { ok: true; variant: AdVariant } | { ok: false; rejection: AdVariantRejection } {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const key = typeof body.angle_key === "string" ? body.angle_key.trim() : "";
  const fail = (reason: AdRejection, detail: string) =>
    ({ ok: false as const, rejection: { angleKey: key || "(none)", reason, detail } });

  // ⚠️ A CLOSED LIST, BECAUSE THIS STRING CAME FROM A MODEL. §27.1's rule one
  // layer down, and the discipline `isChatWritable` already applies to a
  // model-chosen `Question.slot`. An invented key would label a variant with
  // an angle nobody offered.
  const angle = offered.get(key);
  if (!angle) return fail("unknown_angle", key || "no angle_key");
  if (taken.has(key)) return fail("duplicate_angle", key);

  const message = typeof body.message === "string" ? body.message.trim() : "";
  const headline = typeof body.headline === "string" ? body.headline.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (!message || !headline || !description) return fail("missing_field", "message/headline/description");

  if (message.length > AD_COPY_MAX.message) return fail("too_long", `message ${message.length}`);
  if (headline.length > AD_COPY_MAX.headline) return fail("too_long", `headline ${headline.length}`);
  if (description.length > AD_COPY_MAX.description) return fail("too_long", `description ${description.length}`);

  // ⚠️ A DECIDABLE EQUALITY, NEVER A CONTAINMENT TEST. A headline that repeats
  // a phrase from its own primary text is good writing; a headline identical to
  // the description is Meta showing the same words twice. And two variants with
  // the same message are one variant billed as two, which is the failure this
  // whole change exists to end — five identical generic texts labelled as five
  // angles is the current fault with the volume up.
  if (sameText(headline, description)) return fail("copy_repeats_itself", "headline equals description");
  if (messages.some((m) => sameText(m, message))) return fail("copy_repeats_itself", "message repeats another angle");

  // The spec's generation check, over the preview Meta actually shows.
  const preview = opening(message);
  if (!ctx.template.audienceTokens.some((t) => preview.includes(t))) {
    return fail("first_sentence_missing_audience", preview.slice(0, 80));
  }
  if (!ctx.template.categoryTokens.some((t) => preview.includes(t))) {
    return fail("first_sentence_missing_category", preview.slice(0, 80));
  }

  const verdict = claimsVerdict([message, headline, description].join("\n"), ctx);
  if (verdict) return fail(verdict.reason, verdict.detail);

  return { ok: true, variant: { angle_key: key, angle, message, headline, description } };
}

/**
 * The on-image lines, which the model writes now too.
 *
 * ⚠️ A FAILURE HERE FALLS BACK, IT DOES NOT FAIL THE GENERATION. The image is
 * one pair shared by every variant, so rejecting the response over it would
 * throw away five good primary texts for one line on a card — and the
 * template's own example, slot-filled from this customer's own answers, is a
 * perfectly good card. What must never happen is the fallback being silent:
 * `provenance.image` records which one was drawn.
 */
function imageLines(
  raw: Record<string, unknown>,
  ctx: ValidationContext
): { headline: string; sub: string; from: "model" | "example" } {
  const headline = typeof raw.image_headline === "string" ? raw.image_headline.trim() : "";
  const sub = typeof raw.image_sub === "string" ? raw.image_sub.trim() : "";
  const example = { headline: ctx.example.headline, sub: ctx.example.sub, from: "example" as const };

  if (!headline || !sub) return example;
  if (headline.length > AD_IMAGE_MAX.headline || sub.length > AD_IMAGE_MAX.sub) return example;
  // ⚠️ THE CARD IS DRAWN, NOT PUBLISHED, SO IT HAS A SECOND BOUND. Anything
  // outside the shipped fonts is DELETED by `sanitiseForFont` and the gap
  // closed up, which would render as a missing word rather than as an error.
  if (!AD_IMAGE_CHARSET.test(headline) || !AD_IMAGE_CHARSET.test(sub)) return example;
  // The claims rules apply here exactly as they do to a primary text: this is
  // the one place an invented figure could reach a rendered PNG.
  if (claimsVerdict([headline, sub].join("\n"), ctx)) return example;
  if (sameText(headline, sub)) return example;

  return { headline, sub, from: "model" };
}

export function validateAdCopy(raw: unknown, ctx: ValidationContext, offeredKeys: string[]): AdVerdict {
  if (!raw || typeof raw !== "object") return reject("empty", "not an object");
  const body = raw as Record<string, unknown>;

  // ---- Response-level: nothing here reads a word the model wrote ----------
  const cta = ctx.template.metaCta;
  if (!isMetaCtaType(cta)) return reject("bad_cta", String(cta));

  const linkUrl = ctx.slots.landing_url;
  if (!linkUrl) return reject("missing_field", "landing_url");

  const offered = new Map<string, string>();
  for (const key of offeredKeys) {
    const i = ctx.template.angleKeys.indexOf(key as never);
    if (i >= 0) offered.set(key, ctx.template.angles[i]);
  }

  // ---- Per variant --------------------------------------------------------
  const list = Array.isArray(body.variants) ? body.variants : [];
  const variants: AdVariant[] = [];
  const rejected: AdVariantRejection[] = [];
  const taken = new Set<string>();
  const messages: string[] = [];

  for (const entry of list) {
    const verdict = validateVariant(entry, ctx, offered, taken, messages);
    if (verdict.ok) {
      taken.add(verdict.variant.angle_key);
      messages.push(verdict.variant.message);
      variants.push(verdict.variant);
    } else {
      rejected.push(verdict.rejection);
    }
  }

  // ⚠️ ZERO SURVIVORS IS A FAILED GENERATION, NOT AN AD. §65's rule: if the
  // model did not write it, it is not an ad. The caller retries or fails
  // honestly; what it must not do is store the template's default text under a
  // sentence saying the words were drafted by AI.
  if (!variants.length) {
    return reject("empty", rejected.length ? `${rejected.length} variants rejected` : "no variants", rejected);
  }

  const image = imageLines(body, ctx);

  return {
    ok: true,
    rejected,
    copy: {
      image: { headline: image.headline, sub: image.sub },
      variants,
      call_to_action_type: cta,
      link_url: linkUrl,
      provenance: { written: variants.length, offered: offered.size, image: image.from },
    },
  };
}
