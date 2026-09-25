import type { MetaCtaType } from "./metaFields";

/**
 * The four templates part 1 ships — T3, T6, T7 and T8 from the landlord ad
 * template pack (spec v1, 2026-09-20).
 *
 * ⚠️ THEY WERE SELECTED BY THE PHOTO LAYER, NOT BY THE CLAIMS GATE, AND THIS
 * COMMENT SAID OTHERWISE. Two independent properties, and conflating them
 * understates what is available: SIX of the spec's eight core templates have a
 * claims gate of `none` (T3–T8). Only T1 is `customer_data_required` and only
 * T2 is conditional. What holds T4 and T5 back is that they need a photograph
 * of a property, which nothing here can take or crop yet — a layout problem,
 * with no legal surface at all.
 *
 * The consequence for anybody adding templates: T4 and T5 ride in on the photo
 * layer (B4a), where T1 and T2 must wait for the claims gate (B4b). The half
 * with legal exposure does not arrive on a layout change.
 *
 * ⚠️ IMPORT-FREE apart from a type. The picker renders these in the browser.
 *
 * ⚠️ THIS SAID "THE MODEL DOES NOT WRITE THE HEADLINE", QUOTING THE SPEC, AND
 * THAT IS NO LONGER TRUE — it is corrected here rather than deleted, because
 * the spec's rule was a good one and giving it up was a decision.
 *
 * Substitution made "no invented figure" safe by CONSTRUCTION rather than by a
 * rule somebody enforces, which is strictly stronger. What it cost was every
 * "what would it earn" ad in the country carrying the identical sub-line — and
 * a model handed four fixed fields and asked for three more has nowhere to go
 * but restating them, so the first real ad said the same thing four times.
 *
 * So the four patterns below are EXAMPLES now: shown to the model as the
 * register to write in, and kept as the fallback when what it writes will not
 * render. The figure rules run over the model's headline and sub as well, so
 * an invented number is still refused — the safety is a check rather than an
 * impossibility.
 *
 * ⚠️ THE IDS ARE DUPLICATED IN 0156's template_id CHECK, on purpose, and a
 * file-text guard asserts set-equality. A CHECK and a union that drift apart
 * fail at the insert — after the model has already been paid for.
 */

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

/**
 * ⚠️ NO PHONE SLOT IN PART 1. No in-scope layout uses one, and the demo row's
 * referral_phone is the placeholder 01234 567890 — seeding it would put a fake
 * number on an ad.
 */
export const AD_SLOT_KEYS = [
  "company_name",
  "city",
  "areas",
  "landing_url",
  // Where the button sends them. Decides whether `landing_url` is needed at
  // all — see destination.ts, and §65 on the run this unblocks.
  "destination",
  "fee_pct",
  "fee_basis",
  "fee_vat",
  "fee_public",
  "included",
  "handled",
  "councils",
  "property_types",
  "turnaround",
  "years_trading",
  "properties_managed",
  "review_score",
  "review_count",
  "review_quote",
  "review_quote_source",
  // Derived for the sub, never asked: the customer's own multi-select, written
  // out as prose. See §5 — the spec's fixed subs name services the customer
  // may not provide, which is §51.11's failure aimed at the customer.
  "included_list",
  "handled_list",
] as const;
export type AdSlotKey = (typeof AD_SLOT_KEYS)[number];

export const AD_TEMPLATE_IDS = [
  "never-see-the-messages",
  "rules-keep-changing",
  "what-would-it-earn",
  "years-properties-review",
] as const;
export type AdTemplateId = (typeof AD_TEMPLATE_IDS)[number];

export type AdTheme = "dark" | "light" | "paper";
export type AdLayout = "checklist_two_col" | "document_checklist" | "form_card" | "stat_blocks";

/**
 * A multi-select option, and the words ticking it licenses.
 *
 * ⚠️ THE VOCABULARY IS FOR REJECTION, SO IT MUST BE TIGHT. A loose token
 * rejects good copy, and a rejection retries once then collapses to the
 * default text — so an over-strict rule does not announce itself, every ad
 * just comes back generic, and it reads as "the model is bad". "fire" would
 * match "fireplace"; "fire safety" cannot.
 */
export type ServiceOption = {
  key: string;
  /** How it reads in the sub, mid-sentence. */
  label: string;
  /** Lowercase needles. Present in the copy without the tick = rejection. */
  tokens: string[];
};

export interface AdTemplate {
  id: AdTemplateId;
  name: string;
  /** Who the spec says this is for. Shown in the picker, never in the ad. */
  audience: string;
  theme: AdTheme;
  /** T7 is `optional` in the spec; part 1 renders no photo for any of them. */
  photo: "none" | "optional";
  /** Widened in stage 4, not reshaped. */
  claimsGate: "none";

  /**
   * ⚠️ REQUIRED ON THE STATIC, not only in the primary text. The spec puts
   * addressed_to in "the first line of the static" too — and T8's headline
   * names no audience at all, so without this its card says who it is for
   * nowhere.
   */
  addressedTo: string;
  /**
   * ⚠️ TOKENS, NOT THE SENTENCE. You cannot implement "the first sentence
   * contains the audience" by substring-matching "Landlords, and hosts
   * managing their own place".
   */
  audienceTokens: string[];
  categoryLine: string;
  categoryTokens: string[];

  /** Collected once, reused by every later ad. */
  setupSlots: AdSlotKey[];
  /** Asked per ad. This split is what makes "a second ad asks fewer questions" real. */
  adSlots: AdSlotKey[];

  /**
   * ⚠️ EXAMPLES NOW, NOT THE OUTPUT. These four were the rendered headline and
   * sub, filled by slot substitution, and the model never wrote them. So every
   * "what would it earn" ad in the country carried the identical sub-line, and
   * the model — handed four fixed fields and asked for three more — had nowhere
   * to go but restating them. The ad said the same thing four times over.
   *
   * They are shown to the model as the register to write in, and kept as the
   * fallback when what it writes fails validation. The spec never writes a
   * primary text, but it DOES write every headline and sub — so these are the
   * worked examples the pack otherwise lacks.
   *
   * ⚠️ subUnlocated IS NOT OPTIONAL. T8's names {areas}, which is unresolvable
   * when the customer declines to narrow, and the unlocated form exists for
   * exactly that case.
   */
  exampleHeadlineLocated: string;
  exampleHeadlineUnlocated: string;
  exampleSubLocated: string;
  exampleSubUnlocated: string;

  /**
   * ⚠️ STILL A PATTERN, DELIBERATELY. It is a two- or three-word button label,
   * there is no quality to win by writing it, and T8's genuinely needs the
   * slot. It is also why `company_name` is required below.
   */
  ctaPattern: string;
  metaCta: MetaCtaType;

  angles: [string, string, string, string, string];
  /**
   * ⚠️ THE PROSE CANNOT BE THE KEY. T8's third angle is "what
   * {properties_managed} properties means day to day" — a pattern, not an
   * identifier — and the model returns the key it wrote against, so the key has
   * to be a stable token checked against a closed list before storage. §27.1's
   * rule one layer down, and the discipline `isChatWritable` already applies to
   * a model-chosen `Question.slot`.
   *
   * Positional with `angles`: index i of one names index i of the other.
   */
  angleKeys: [string, string, string, string, string];
  /**
   * ⚠️ WHAT THE ARGUMENT CANNOT SURVIVE WITHOUT — not what a string
   * interpolated, and NOT the same thing as `resolution.missing`.
   *
   *   `missing`       = what to ASK about. `setupSlots ∪ adSlots`, and it drives
   *                     the questionnaire and the brief's "Still missing".
   *   `requiredSlots` = what makes the ad IMPOSSIBLE. A subset of `setupSlots`,
   *                     and what `preflight()` refuses on.
   *
   * It exists because `unresolved` used to be derived from the `{}` a headline
   * pattern could not fill, and with the model writing the headline there is no
   * pattern left to half-fill. This is the more honest test anyway: T8 is
   * unofferable without its four figures because it cannot be ARGUED without
   * them, not because a brace would render empty.
   *
   * ⚠️ `review_quote` / `review_quote_source` are deliberately NOT here. A
   * quote is a bonus angle, not a precondition, and `resolveSlots` already
   * treats them as optional by design.
   */
  requiredSlots: AdSlotKey[];
  /**
   * ⚠️ THERE ARE NO DEFAULT AD TEXTS ANY MORE, AND THEIR ABSENCE IS THE RULE.
   *
   * `defaultPrimaryText`, `defaultHeadline` and `defaultDescription` used to be
   * what a rejected generation collapsed to. They were removed because that
   * collapse is the fault this whole change exists to end: the ad the owner
   * judged as terrible contained no model output at all — the key was unset,
   * both calls recorded `not_configured`, and the stored copy was byte-identical
   * to T7's three defaults, with "the words were drafted by AI" rendered over
   * it. The app told him a model wrote words it never saw.
   *
   * If the model did not write it, it is not an ad. Zero surviving variants
   * releases the draft and says so, with a Retry.
   */
  footerLine?: string;
  layout: AdLayout;
  /** Only the templates with a multi-select carry one. */
  services?: { slot: AdSlotKey; options: ServiceOption[] };
}

// ---------------------------------------------------------------------------

const CATEGORY = "short let management";
/** "short lets", "short letting", "short let management" all contain these. */
const CATEGORY_TOKENS = ["short let", "short-let", "shortlet"];

export const AD_TEMPLATES: AdTemplate[] = [
  {
    id: "never-see-the-messages",
    name: "You’ll never see the messages",
    audience: "Time-poor landlord, or a self-managing host who is tired of it",
    theme: "paper",
    photo: "none",
    claimsGate: "none",
    addressedTo: "Landlords, and hosts managing their own place",
    audienceTokens: ["landlord", "host"],
    categoryLine: CATEGORY,
    categoryTokens: CATEGORY_TOKENS,
    setupSlots: ["company_name", "fee_pct", "fee_basis", "fee_vat", "fee_public", "included", "landing_url", "destination"],
    adSlots: ["city"],
    exampleHeadlineLocated: "Landlords in {city}: you’ll never see the *3am* message.",
    exampleHeadlineUnlocated: "Landlords: you’ll never see the *3am* message.",
    // The spec's sub hardcodes five services. `included` is a multi-select, so
    // a fixed string publishes what the customer does not provide (§5).
    exampleSubLocated: "Full short let management. {included_list}, all handled by {company_name}.",
    exampleSubUnlocated: "Full short let management. {included_list}, all handled by {company_name}.",
    ctaPattern: "Talk to us about your property",
    metaCta: "CONTACT_US",
    angles: [
      "the message at 3am",
      "the cleaner who cancels on a Friday",
      "what a managed week looks like",
      "the landlord who self-managed for six months",
      "plain facts, fee and what is included",
    ],
    angleKeys: [
      "message_at_3am",
      "cleaner_cancels",
      "managed_week",
      "self_managed_six_months",
      "plain_facts",
    ],
    // The argument IS the list of what is handled, so an untouched multi-select
    // leaves nothing to say.
    requiredSlots: ["company_name", "included"],
    layout: "checklist_two_col",
    services: {
      slot: "included",
      options: [
        { key: "guest_messaging", label: "guest messaging", tokens: ["guest messaging", "messaging"] },
        { key: "cleaning", label: "cleaning", tokens: ["cleaning", "cleaners"] },
        { key: "linen", label: "linen", tokens: ["linen"] },
        // ⚠️ "pricing" is the one AMBIGUOUS token in either vocabulary: as a
        // service it means managing the nightly rate, and as English it means
        // what the operator charges — which this template's fifth angle
        // ("plain facts, fee and what is included") invites directly. Left
        // strict and designed out at the source instead: the prompt is told to
        // call the operator's own charge a FEE and never a price or pricing.
        { key: "pricing", label: "pricing", tokens: ["pricing"] },
        { key: "check_ins", label: "check-ins", tokens: ["check-in", "check in", "check-ins", "check ins"] },
      ],
    },
  },
  {
    id: "rules-keep-changing",
    name: "The rules keep changing",
    audience: "Cautious landlord; any landlord in a licensing or registration area",
    theme: "paper",
    photo: "none",
    claimsGate: "none",
    addressedTo: "Landlords wondering whether short letting is even allowed",
    audienceTokens: ["landlord"],
    categoryLine: CATEGORY,
    categoryTokens: CATEGORY_TOKENS,
    setupSlots: ["company_name", "councils", "handled", "landing_url", "destination"],
    adSlots: ["city"],
    exampleHeadlineLocated: "Landlords in {city}: short let rules, *handled*.",
    exampleHeadlineUnlocated: "Landlords: short let rules, *handled*.",
    exampleSubLocated: "{handled_list}. We keep the file, you keep the property.",
    exampleSubUnlocated: "{handled_list}. We keep the file, you keep the property.",
    // ⚠️ Fixed, and required by the spec's claims note. Three of this
    // template's five angles invite legal advice, and a footer does not cure a
    // body that gives it — but its absence would make that worse.
    footerLine: "Responsibility stays with the property owner; we manage the process.",
    ctaPattern: "Ask what applies to your property",
    // ASK_A_QUESTION is a real CTA in Meta's enum, verified against the live
    // tool schema. The button should say what the ad asks them to do.
    metaCta: "ASK_A_QUESTION",
    angles: [
      "what a landlord is actually responsible for",
      "the certificate nobody remembers until renewal",
      "what changed locally and what it means",
      "the file we keep on every property",
      "plain facts, fee and what is included",
    ],
    angleKeys: [
      "responsibility",
      "certificate_renewal",
      "local_change",
      "the_file",
      "plain_facts",
    ],
    requiredSlots: ["company_name", "handled"],
    layout: "document_checklist",
    services: {
      slot: "handled",
      options: [
        { key: "licensing", label: "licensing", tokens: ["licensing", "licence", "license"] },
        { key: "registration", label: "registration", tokens: ["registration"] },
        { key: "fire_safety", label: "fire safety", tokens: ["fire safety", "fire certificate", "smoke alarm"] },
        { key: "gas_electrical", label: "gas and electrical", tokens: ["gas safety", "electrical safety", "eicr", "gas and electrical"] },
        { key: "insurance", label: "insurance", tokens: ["insurance"] },
        { key: "guest_id", label: "guest records", tokens: ["guest id", "guest records", "id checks"] },
      ],
    },
  },
  {
    id: "what-would-it-earn",
    name: "What would your property earn?",
    audience: "Everyone, top of funnel",
    theme: "light",
    photo: "optional",
    claimsGate: "none",
    addressedTo: "Any landlord with a property let out, or empty",
    audienceTokens: ["landlord"],
    categoryLine: CATEGORY,
    categoryTokens: CATEGORY_TOKENS,
    setupSlots: ["company_name", "property_types", "turnaround", "landing_url", "destination"],
    adSlots: ["city"],
    exampleHeadlineLocated: "Landlords in {city}: what would your property earn on *short lets*?",
    exampleHeadlineUnlocated: "Landlords: what would your property earn on *short lets*?",
    exampleSubLocated: "Send the postcode and bedroom count. We’ll run the numbers against your current rent.",
    exampleSubUnlocated: "Send the postcode and bedroom count. We’ll run the numbers against your current rent.",
    ctaPattern: "Get my estimate",
    metaCta: "GET_QUOTE",
    angles: [
      "the question asked plainly",
      "what the estimate is based on and what it is not",
      "the landlord who assumed it was not worth it",
      "how long an answer takes",
      "what happens after, so nobody fears a sales call",
    ],
    angleKeys: [
      "question_plainly",
      "estimate_basis",
      "assumed_not_worth_it",
      "answer_speed",
      "what_happens_after",
    ],
    // ⚠️ THE VOLUME TEMPLATE, AND THE THINNEST REQUIREMENT ON PURPOSE. It asks
    // a question rather than making a claim, so it needs no figure to argue
    // from — which is why it is the default and why it must stay offerable to a
    // customer who has told us almost nothing.
    requiredSlots: ["company_name"],
    layout: "form_card",
  },
  {
    id: "years-properties-review",
    name: "Years, properties, review score",
    audience: "The sceptical landlord, and anyone comparing two managers",
    theme: "dark",
    photo: "none",
    claimsGate: "none",
    // ⚠️ T8's headline names NO audience — it opens "Short let management in
    // {city}". Without this line on the card, nothing on it says who it is for.
    addressedTo: "Landlords comparing managers",
    audienceTokens: ["landlord"],
    categoryLine: CATEGORY,
    categoryTokens: CATEGORY_TOKENS,
    setupSlots: [
      "company_name", "areas", "years_trading", "properties_managed",
      "review_score", "review_count", "review_quote", "review_quote_source", "landing_url", "destination",
    ],
    adSlots: ["city"],
    exampleHeadlineLocated:
      "Short let management in {city}: {years_trading} years, {properties_managed} properties, *{review_score}* on Google.",
    exampleHeadlineUnlocated:
      "Short let management: {years_trading} years, {properties_managed} properties, *{review_score}* on Google.",
    exampleSubLocated: "Managing short lets across {areas} for landlords who would rather not.",
    exampleSubUnlocated: "Managing short lets for landlords who would rather not.",
    ctaPattern: "Talk to {company_name}",
    metaCta: "CONTACT_US",
    angles: [
      "how long they have been doing this",
      "what {properties_managed} properties means day to day",
      // ⚠️ DROPPED FROM THE PROMPT ENTIRELY unless review_quote_confirmed. The
      // spec asks for a quote "in their words if a quote is supplied"; offered
      // without one, the model invents a testimonial that passes every other
      // rule. See prompts.ts and validateAdCopy.ts.
      "what landlords say, in their words if a quote is supplied",
      "why they started",
      "plain facts, fee and what is included",
    ],
    angleKeys: [
      "how_long",
      "what_scale_means",
      "what_landlords_say",
      "why_started",
      "plain_facts",
    ],
    // ⚠️ THE ARGUMENT **IS** THESE FOUR NUMBERS. Without them there is no
    // template here, which is why this is the one with a real precondition —
    // and why `review_quote` is absent: a quote is a bonus angle.
    requiredSlots: [
      "company_name",
      "years_trading",
      "properties_managed",
      "review_score",
      "review_count",
    ],
    layout: "stat_blocks",
  },
];

// ---------------------------------------------------------------------------

export function templateById(id: string): AdTemplate | null {
  return AD_TEMPLATES.find((t) => t.id === id) ?? null;
}

/** T7 — the spec's "the one to make the default". */
export const DEFAULT_TEMPLATE_ID: AdTemplateId = "what-would-it-earn";

/** Every `{slot}` a pattern refers to, in order of first appearance. */
export function slotsInPattern(pattern: string): string[] {
  const out: string[] = [];
  for (const m of Array.from(pattern.matchAll(/\{(\w+)\}/g))) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** Every slot a template can possibly need. */
export function slotsForTemplate(t: AdTemplate): AdSlotKey[] {
  return Array.from(new Set([...t.setupSlots, ...t.adSlots])) as AdSlotKey[];
}

/**
 * Every service noun this template knows about, whether or not it is ticked.
 * The validator rejects any of these that the customer has NOT selected.
 */
export function serviceTokensFor(t: AdTemplate, selected: string[]): { allowed: string[]; forbidden: string[] } {
  const allowed: string[] = [];
  const forbidden: string[] = [];
  for (const option of t.services?.options ?? []) {
    (selected.includes(option.key) ? allowed : forbidden).push(...option.tokens);
  }
  return { allowed, forbidden };
}
