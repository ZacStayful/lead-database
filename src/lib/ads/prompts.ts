import type Anthropic from "@anthropic-ai/sdk";
import { AD_TEMPLATES, type AdTemplate } from "./templates";
import { MAX_OPTIONS, MAX_QUESTIONS, MIN_OPTIONS, MIN_QUESTIONS } from "./schemas";
import type { Answer, Question } from "./schemas";
import { AD_IMAGE_MAX, META_TRUNCATION_MARKS } from "./metaFields";
import { AD_SPEC_PROSE } from "./specProse";
import { fillPattern, type SlotValues } from "./resolveSlots";
import type { AdProfile } from "./resolveSlots";
import type { AdRejection, AdVariantRejection } from "./validateAdCopy";

/**
 * What the model is told, and in what order (§65).
 *
 * Three shapes, three `prompt_version` strings, one shared pack. The pack is
 * derived from `AD_TEMPLATES` rather than written out beside it — a second
 * prose copy of the angles would drift from the registry the validator
 * enforces, and the failure would be a model asked for an angle that is then
 * rejected as a service it cannot name.
 */

export const PROMPT_VERSIONS = {
  questions: "ad_questions_v1",
  simplify: "ad_simplify_v1",
  // ⚠️ v2 IS A DIFFERENT SHAPE, NOT A REWORDING. It asks for one text per
  // angle instead of one text, and for the on-image headline and sub the model
  // did not previously write. A single constant across both would collapse the
  // only join that could answer "did five angles convert better than one".
  copy: "ad_copy_v2",
} as const;
export type PromptVersion = (typeof PROMPT_VERSIONS)[keyof typeof PROMPT_VERSIONS];

// ---------------------------------------------------------------------------
// The pack
// ---------------------------------------------------------------------------

/**
 * ⚠️ THE TWO OBJECTIONS ARE THE SPEC'S THEORY OF WHY ANY OF THIS WORKS, and
 * they were missing from the first draft of this plan. Without them the model
 * writes upside — which is both the wrong argument for this audience and the
 * likeliest way to get an ad rejected.
 */
const OBJECTIONS = [
  "# What landlords are actually worried about",
  "",
  "Two objections come up, and both are loss aversion rather than arithmetic.",
  "",
  "- **Income consistency** is a CERTAINTY objection.",
  "  It is answered with a worst case, never a best case. A long-let landlord",
  "  knows exactly what arrives each month; every short-let pitch they have ever",
  "  seen led with a best case they did not believe.",
  "- **Setup cost** is a TIMING objection.",
  "  It is answered by shortening the time to break even, not by arguing the",
  "  cost is small.",
  "",
  "Copy that promises upside pushes against the grain. Copy that removes",
  "uncertainty works with it. When you are choosing what to say, prefer the",
  "sentence that takes a worry away over the sentence that adds a hope.",
].join("\n");

const ADDRESSING = [
  "# Who you are writing for, and who you are writing as",
  "",
  "The advertiser is a property management business. They are the one whose name",
  "goes on this ad and whose phone rings. You are writing AS them, to a landlord.",
  "",
  "This ad interrupts somebody who was not looking for it, and most of the people",
  "who see it are not landlords. So the FIRST SENTENCE of the primary text must",
  "contain both:",
  "",
  "- who it is for — the template's `addressed_to` line, in your own words if you",
  "  like, but the word \"landlord\" or \"host\" has to be in there;",
  "- what the service is — \"short let management\", or a phrase containing",
  "  \"short let\".",
  "",
  "A landlord should know in one line that this is about their property and about",
  "a service. Anybody else should know to keep scrolling. Copy whose first",
  "sentence misses either is rejected before it reaches the customer.",
].join("\n");

/**
 * ⚠️ EVERY LINE HERE IS A HARD REJECTION IN `validateAdCopy`, and that is the
 * point of stating them: a rejection retries once and then collapses to the
 * template's own default text, so a prompt that does not prevent a failure
 * does not produce an error anybody sees — every ad just comes back generic.
 */
const PROHIBITIONS = [
  "# Never, on any template",
  "",
  "- **Never state a figure the customer did not give you.** Not a pound amount,",
  "  not a percentage, not a number of properties, not a review score, not a",
  "  count of years. Not as an example, not \"around\", not \"typically\". If you",
  "  want to say something is worth doing, say it without a number.",
  "- **Never say what a landlord will earn**, or imply it. No \"you'll make\", no",
  "  \"double your rent\", no guaranteed income or yield.",
  "- **Never state an occupancy rate** or say a property is never empty.",
  "- **Never claim a market position.** Not the best, the biggest, the leading,",
  "  the most trusted, number one, or \"nobody else\".",
  "- **Never mention Stayful.** The customer is the advertiser. We are not in this",
  "  ad, and nothing may suggest a figure came from us.",
  "- **Never put a link, a URL or a domain in the text.** The button carries the",
  "  link already.",
  "- **Never quote anybody** — no sentence in quotation marks, no \"— Sarah,",
  "  Leicester\" — unless you have been given a real review to quote, with its",
  "  source, in the brief below. A testimonial you wrote is a fabricated one.",
  "- **Never name a service the customer has not ticked.** If cleaning is not on",
  "  their list, the ad does not mention cleaning, however natural it reads.",
  "",
  "⚠️ Call the customer's own charge a **fee**. Never a price, never \"pricing\",",
  "never \"our rates\". \"Pricing\" is a service some of these operators sell —",
  "managing the nightly rate — so using it for what they charge makes the ad say",
  "something they may not do.",
].join("\n");

/**
 * An angle with its slot written out rather than braced.
 *
 * ⚠️ THE PACK CANNOT FILL A SLOT — it is built once at module scope with no
 * customer in hand — and printing the raw pattern means the model literally
 * reads "what {properties_managed} properties means day to day". Exactly one
 * angle in the four templates has a slot; `copyUser` fills it for real, and
 * this is the catalogue form.
 */
function readableAngle(angle: string): string {
  return angle.replace(/\{(\w+)\}/g, (_, key: string) => `[their ${key.replace(/_/g, " ")}]`);
}

/** One template, as the model reads it. Derived, never restated. */
function describeTemplate(t: AdTemplate): string {
  const lines = [
    `## ${t.id} — ${t.name}`,
    `Who it is for: ${t.audience}`,
    `Addressed to: ${t.addressedTo}`,
    `The argument it makes: ${readableAngle(t.angles[0])}`,
    "",
    "The headline and sub-line the spec would write, as the register to aim at:",
    // ⚠️ THROUGH `readableAngle` TOO. These carry slots — {city}, {areas},
    // {review_score} — and the pack has no customer to fill them with, so a
    // raw pattern here is a brace the model could copy onto a live ad.
    `  with a place: ${readableAngle(t.exampleHeadlineLocated)}`,
    `  without one:  ${readableAngle(t.exampleHeadlineUnlocated)}`,
    `  sub:          ${readableAngle(t.exampleSubLocated)}`,
    "",
    "Angles it can take — one primary text each:",
    ...t.angles.map((a, i) => `  ${i + 1}. ${readableAngle(a)}`),
  ];
  if (t.services) {
    lines.push(
      "",
      `Multi-select (${t.services.slot}) — ONLY what the customer ticks may appear:`,
      `  ${t.services.options.map((o) => o.label).join(" · ")}`
    );
  }
  if (t.footerLine) {
    lines.push(
      "",
      `Fixed footer on the image: "${t.footerLine}"`,
      "⚠️ This template invites legal advice and must never give it. No \"fully",
      "compliant\", no \"we ensure\", no \"the law requires\", no \"you must\". Say what",
      "the business does, not what the law says.",
    );
  }
  return lines.join("\n");
}

/**
 * The shared prefix. Identical on every call of all three kinds.
 *
 * ⚠️ IT IS BUILT ONCE AT MODULE SCOPE, not per call — it is pure string
 * concatenation over a frozen registry, and a per-call rebuild would be the
 * only thing between the request and the model that could grow with traffic.
 */
export const AD_PACK: string = [
  "# What this is",
  "",
  "You are writing a Facebook advert for a UK short let management business, so",
  "that landlords near them enquire. The business is the advertiser; you are",
  "drafting on their behalf and they will read it before it goes live.",
  "",
  ADDRESSING,
  "",
  OBJECTIONS,
  "",
  "# The four templates",
  "",
  "Each is an argument, with the angles a primary text can take and an example",
  "headline and sub-line showing the register. You write everything: the words on",
  "the image, the primary texts, and the two short fields Facebook shows beneath",
  "it. The examples are there to be matched in tone and beaten in specificity,",
  "not copied.",
  "",
  AD_TEMPLATES.map(describeTemplate).join("\n\n"),
  "",
  PROHIBITIONS,
].join("\n");

/**
 * The pack, then the task, with the cache breakpoint between them.
 *
 * ⚠️ THE ORDER IS A CACHING DECISION. Everything above the breakpoint is
 * IDENTICAL on every call of all three kinds; everything that varies — the
 * customer, their words, their answers — goes in the user turn. Move one
 * varying byte above it and every request pays the write premium for nothing.
 *
 * ⚠️ AND THE BREAKPOINT WAS MEASURED, NOT ASSUMED. The cache has a ~1024-token
 * minimum and SILENTLY IGNORES a breakpoint below it, so a `cache_control`
 * here plus a guard asserting it is present would read as a working cache
 * while doing nothing whatever. This pack is 7.5 KB, whose pessimistic floor
 * is ~1,500 tokens (`adPackTokenFloor`), so it clears — but with under 50%
 * headroom, which is why the test asserts the floor rather than the presence
 * of the attribute.
 *
 * What it is worth, stated honestly rather than assumed: a cache WRITE costs
 * about 25% more than plain input and a READ about 90% less, so the pack pays
 * for itself from the second call inside the five-minute window and costs a
 * quarter of a pack when nobody comes back. Two to four calls per ad, most of
 * them within a minute of each other, is the shape that wins. It is not
 * guesswork either way: `cache_read_tokens` on every ledger row is the answer
 * from data.
 *
 * Typed as the SDK's own block type so a `cache_control` that drifts onto the
 * varying block is a type error rather than a silent miss.
 */
export function systemFor(instructions: string): Anthropic.TextBlockParam[] {
  return [
    { type: "text", text: AD_PACK, cache_control: { type: "ephemeral" } },
    { type: "text", text: instructions },
  ];
}

/**
 * A pessimistic token count for the pack.
 *
 * ⚠️ CHARACTERS OVER FIVE, NOT FOUR. English prose runs about four characters
 * to the token, so dividing by five UNDER-states the count — which is the safe
 * direction for a floor: if this clears 1024 the real count certainly does.
 * The test asserts the actual value, not the inequality, so the day somebody
 * trims the pack below the threshold they are told rather than quietly losing
 * the cache.
 */
export function adPackTokenFloor(): number {
  return Math.floor(AD_PACK.length / 5);
}

/**
 * The cache's documented minimum for the models we call. Opus and Sonnet are
 * 1024; Haiku is 2048, so a model change is also a cache decision.
 */
export const CACHE_MINIMUM_TOKENS = 1024;

// ---------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------

export const QUESTIONS_INSTRUCTIONS = [
  "# Your job",
  "",
  "A property manager has just asked for an advert. Pick the template that fits",
  "what they asked for and what their account already knows, then ask them only",
  "what you still need in order to write it.",
  "",
  `Return between ${MIN_QUESTIONS} and ${MAX_QUESTIONS} questions, each with ${MIN_OPTIONS} to ${MAX_OPTIONS} options they can tap.`,
  "",
  "# Picking the template",
  "",
  "Read what they typed first, then what their account holds. A business with a",
  "review score and a property count on file can run the proof template today; one",
  "with neither cannot, and asking them to supply both to satisfy a template they",
  "did not ask for is how this feature wastes somebody's afternoon.",
  "",
  "Your `reason` is one sentence, addressed to them, saying why this angle suits",
  "their business. Not a description of the template — they can see that.",
  "",
  "# What makes a good question here",
  "",
  "- Ask only what is genuinely missing. The brief lists exactly that; everything",
  "  else is already known and asking again is irritating.",
  "- Every answer goes on a live advert, so ask for the thing you will print.",
  "  \"How many properties do you look after right now?\" is printable. \"Tell me",
  "  about your business\" is not.",
  "- Prefer a concrete choice over an open question, and use the words a property",
  "  manager would use about their own business.",
  "- Where a question decides what the ad may CLAIM — a fee, a review score, a",
  "  count — say so in the question, briefly. They are attesting to it.",
  "- Set `slot` to the slot key from the missing list when a question fills one,",
  "  and to an empty string when it does not.",
  "",
  "# Never do these",
  "",
  "- Never ask something the brief already answers.",
  "- Never ask two things in one question. Split them.",
  "- Never ask for a figure you intend to make up if they decline. If they will",
  "  not give you a number, the ad goes out without one.",
  "- Never ask which template they want. That is your judgement, and they can",
  "  change it afterwards with one tap.",
  "- Never pad. Three good questions are better than eight.",
].join("\n");

export function questionsUser(params: {
  prompt: string;
  account: string;
  forcedTemplate: AdTemplate | null;
}): string {
  return [
    ...(params.forcedTemplate
      ? [
          "# The template is already chosen",
          "",
          `They have asked for **${params.forcedTemplate.id}** (${params.forcedTemplate.name}).`,
          "Return that id in `template_id` and write your `reason` for that template.",
          "Ask only what it needs.",
          "",
        ]
      : []),
    "# What they asked for, in their words",
    "",
    params.prompt,
    "",
    "# Their business, as we already have it",
    "",
    params.account,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Simplifying
// ---------------------------------------------------------------------------

/**
 * ⚠️ THERE IS NO SKIP BUTTON, AND THIS PROMPT IS WHY THAT IS FAIR. The code
 * guarantees the ladder terminates in a plain text box; this is what makes the
 * middle rung genuinely easier rather than merely different.
 */
export const SIMPLIFY_INSTRUCTIONS = [
  "# Your job",
  "",
  "A property manager could not answer one of your questions. Ask it again, more",
  "simply. They cannot skip it, so this has to land.",
  "",
  "# How to make it easier",
  "",
  "- Drop the jargon. If the question used a word from our product or from",
  "  advertising, use the word they would use about their own business instead.",
  "- Split a decision in half. If you asked them to choose between four things,",
  "  ask the first of the two choices that gets you there.",
  "- Make the options concrete. Two clear options beat four vague ones.",
  "- Say what the answer is FOR, in the question, in a few words. \"So the ad can",
  "  say how quickly you reply\" is usually the part that was missing.",
  "",
  "# Never",
  "",
  "- Never ask a different question. It is the same thing, asked better.",
  "- Never ask them to look something up.",
  "- Never apologise or explain that you are rephrasing. Just ask.",
].join("\n");

export function simplifyUser(params: { question: Question; account: string }): string {
  return [
    "# The question they could not answer",
    "",
    params.question.question,
    ...(params.question.options.length
      ? ["", `Options offered: ${params.question.options.join(" · ")}`]
      : []),
    "",
    "# Their business, as we already have it",
    "",
    params.account,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Writing it
// ---------------------------------------------------------------------------

export const COPY_INSTRUCTIONS = [
  "# Your job",
  "",
  "Write the ad. Two parts.",
  "",
  "## The image",
  "",
  "Two lines that go ON the card, in the customer's own colours:",
  "",
  `- \`image_headline\` — the big line. Under ${AD_IMAGE_MAX.headline} characters or it runs off the card.`,
  "  Wrap ONE short span in *asterisks* and the card draws it in their accent",
  "  colour — pick the two or three words the whole ad turns on.",
  `- \`image_sub\` — the line beneath it. Under ${AD_IMAGE_MAX.sub} characters. One sentence,`,
  "  concrete, saying what the business actually does.",
  "",
  "You are shown the headline and sub the spec would have written. Match that",
  "register and beat it on specificity, using what this customer told us. Do not",
  "reproduce it word for word.",
  "",
  "## The primary texts, one per angle",
  "",
  "You are given a list of angles, each with a key. Write ONE `variants` entry",
  "for EVERY angle in that list, returning its `angle_key` exactly as given.",
  "Each entry has three fields:",
  "",
  "- `message` — the primary text, above the image. This is the one that does the",
  `  work. Facebook shortens it at about ${META_TRUNCATION_MARKS.message} characters with a "See more", so`,
  "  everything before that mark has to stand alone, and has to name the audience",
  "  and the category somewhere inside it. Past the mark, write as long as it",
  "  needs and no longer.",
  `- \`headline\` — under the image. Aim for ${META_TRUNCATION_MARKS.headline} characters so Facebook does not`,
  "  clip it. Say the thing, do not tease it. Never the same words as the",
  "  description, and never the same words as the line on the image.",
  `- \`description\` — beneath the headline. Aim for ${META_TRUNCATION_MARKS.description} characters. Usually the`,
  "  action: what happens when they tap.",
  "",
  "⚠️ ONE ANGLE PER VARIANT, COMMITTED TO. A text that makes four arguments makes",
  "none. The point of writing several is that Facebook tests them against each",
  "other — so two that say the same thing in different words are worth less than",
  "one. If two of your angles are coming out alike, one of them is wrong.",
  "",
  "# How to write it",
  "",
  "- Write like one person telling another something true. Short sentences. No",
  "  marketing register, no \"unlock\", no \"seamless\", no exclamation marks.",
  "- Take a worry away rather than adding a hope. See the two objections above.",
  "- Be specific about what the business actually does, using only what the brief",
  "  says it does. A detail from what they told us beats an adjective.",
  "- End by saying what to do next, plainly, in the words the button uses.",
  "",
  "# The figures you may state",
  "",
  "The brief lists every number this customer has given us. You may state those",
  "and no others, ON THE IMAGE AS WELL AS IN THE TEXT. If a sentence needs a",
  "number you have not been given, write the sentence without it — it will still",
  "be a better ad than one that gets rejected.",
].join("\n");

/** An angle the model is being asked to write, with the key it must return. */
export type OfferedAngle = { key: string; angle: string };

export function copyUser(params: {
  template: AdTemplate;
  account: string;
  answers: Answer[];
  example: { headline: string; sub: string };
  cta: string;
  figures: string[];
  angles: OfferedAngle[];
  /** The previous attempt, when this is a rewrite the customer asked for. */
  previousMessage?: string | null;
  /**
   * Which angles the last attempt lost, and why. ⚠️ NOT "the last attempt was
   * refused" — a retry that re-asks for the four angles it already got right
   * pays twice for them and risks losing them the second time.
   */
  rejected?: AdVariantRejection[] | null;
}): string {
  const t = params.template;
  // ⚠️ THE SPEC'S OWN RATIONALE, NOT A PARAPHRASE OF IT. `AD_PACK` keeps the
  // angle NAMES verbatim and drops every paragraph around them, so the model
  // was told T7's angles and never told that the template "offers a calculation
  // rather than a claim, which is why it can talk about income without
  // triggering the gate". Generated from the document (§50.5's rule) rather
  // than transcribed, because §65 records four errors that came from
  // paraphrasing it.
  const prose = AD_SPEC_PROSE[t.id];
  return [
    `# Write the "${t.name}" ad`,
    "",
    `Template: ${t.id}`,
    `Addressed to: ${t.addressedTo}`,
    "",
    ...(prose ? ["## What this template is, in the spec's own words", "", prose, ""] : []),
    "## The angles to write",
    "",
    `Write one variant for each. Return the key exactly as it appears here.`,
    "",
    ...params.angles.map((a) => `- \`${a.key}\` — ${a.angle}`),
    "",
    "## The image, for reference",
    "",
    "This is what the spec would have put on the card. You are writing your own,",
    "for this customer. Aim at this register.",
    "",
    `Headline: ${params.example.headline}`,
    `Sub-line: ${params.example.sub}`,
    `Button:   ${params.cta}`,
    "",
    "# Their business",
    "",
    params.account,
    "",
    "# What they told us just now",
    "",
    ...(params.answers.length
      ? params.answers.map((a) => `- ${a.question}\n  ${a.answer}`)
      : ["Nothing beyond what is above."]),
    "",
    "# Figures you may state",
    "",
    ...(params.figures.length
      ? params.figures.map((f) => `- ${f}`)
      : ["None. This ad states no numbers at all."]),
    ...(params.previousMessage
      ? [
          "",
          "# They have asked for a rewrite",
          "",
          "This is what you wrote last time. Say it differently — a different way in,",
          "a different detail, not a rephrasing.",
          "",
          params.previousMessage,
        ]
      : []),
    ...(params.rejected?.length
      ? [
          "",
          "# These angles were refused last time",
          "",
          ...params.rejected.map(
            (r) => `- \`${r.angleKey}\`: ${rejectionAdvice(r.reason)}\n  (the part that did it: ${r.detail})`
          ),
          "",
          "Write those again without that. Everything else about the brief is unchanged.",
        ]
      : []),
  ].join("\n");
}

/**
 * The angles this template may take, with the key the model must return.
 *
 * ⚠️ T8's THIRD ANGLE IS DROPPED WHEN THERE IS NO CONFIRMED QUOTE. The spec
 * offers "what landlords say, in their words if a quote is supplied" — and
 * offered without one, the model writes a plausible testimonial that passes
 * every other rule in the file. Omission first, the prohibition second, the
 * validator third; this is the omission.
 *
 * ⚠️ AN ANGLE WHOSE SLOT IS MISSING IS DROPPED, NOT HALF-FILLED. Exactly one
 * angle carries a slot — T8's "what {properties_managed} properties means day
 * to day" — and `requiredSlots` means `preflight` has already refused a T8 with
 * no count, so this is the second stop rather than the first.
 *
 * ⚠️ THERE IS DELIBERATELY NO SERVICE-VOCABULARY FILTER HERE. The plan called
 * for one, on the model of the answer-option check: never offer an angle whose
 * words the validator will then refuse. Checked against the real registries —
 * NOT ONE of the twenty angle names contains a service token as a whole word,
 * so the filter would be dead code, and `serviceTokensFor` is where the rule
 * lives anyway. If an angle is ever written that does name one, add it then.
 */
export function angleListFor(
  t: AdTemplate,
  opts?: { profile?: AdProfile; slots?: SlotValues }
): OfferedAngle[] {
  const slots = opts?.slots ?? {};
  const confirmed = opts?.profile?.review_quote_confirmed === true;
  const out: OfferedAngle[] = [];
  t.angles.forEach((angle, i) => {
    if (!confirmed && angle.includes("in their words")) return;
    const filled = fillPattern(angle, slots);
    if (filled === null) return;
    out.push({ key: t.angleKeys[i], angle: filled });
  });
  return out;
}

/** What to do about it, in the model's terms, never our error code. */
function rejectionAdvice(reason: AdRejection): string {
  switch (reason) {
    case "figure_not_in_slots":
      return "it stated a number the customer never gave us. Write it with no number at all.";
    case "service_not_selected":
      return "it named a service this customer does not offer. Use only what the brief lists.";
    case "quote_without_provenance":
      return "it quoted somebody. Remove the quotation marks and the attribution entirely.";
    case "income_claim":
      return "it said or implied what the landlord would earn. Say what the business does instead.";
    case "occupancy_claim":
      return "it stated how often the property would be booked. Remove that.";
    case "market_superlative":
      return "it claimed a position in the market. Describe the business without ranking it.";
    case "legal_assurance":
      return "it gave legal advice or promised compliance. Say what the business handles, not what the law requires.";
    case "first_sentence_missing_audience":
      return "the opening did not say who the ad is for. Name landlords in it.";
    case "first_sentence_missing_category":
      return "the first sentence did not say what the service is. Say \"short let management\" in it.";
    case "link_in_text":
      return "it put a web address in the text. The button already carries the link.";
    case "mentions_stayful":
      return "it named Stayful. This ad is the customer's, and we are not in it.";
    case "fee_not_published":
      return "it stated a fee the customer has not agreed to publish. Leave the fee out.";
    case "fee_without_vat_treatment":
      return "it stated a fee without saying whether VAT is included. Leave the fee out.";
    case "example_estimate":
      return "it gave an example figure. This ad asks the question; it never answers it.";
    case "too_long":
      return "it was too long. Say the same thing in fewer words.";
    case "copy_repeats_itself":
      return "it said the same thing twice — either across two angles, or in the headline and the description. Each one has to earn its place.";
    case "unknown_angle":
      return "it used an angle key that was not offered. Use the keys exactly as listed.";
    case "duplicate_angle":
      return "two variants claimed the same angle. One text per key.";
    default:
      return "it broke one of the rules above. Re-read them and write it again.";
  }
}
