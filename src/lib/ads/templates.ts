import type { MetaCtaType } from "./metaFields";

/**
 * The four templates part 1 ships — T3, T6, T7 and T8 from the landlord ad
 * template pack (spec v1, 2026-09-20), the ones whose claims gate is `none`.
 *
 * ⚠️ IMPORT-FREE apart from a type. The picker renders these in the browser.
 *
 * ⚠️ THE MODEL DOES NOT WRITE THE HEADLINE. The spec is explicit: "Claude
 * writes the five primary texts and the sub… never the headline pattern
 * itself." Every headline below is pure slot substitution, which is what makes
 * "no invented figure" and the located/unlocated split safe by construction
 * rather than by a rule somebody has to enforce.
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

  headlineLocated: string;
  headlineUnlocated: string;
  /**
   * ⚠️ subUnlocated IS NOT OPTIONAL. T8's sub names {areas}, which is
   * unresolvable when the customer declines to narrow — and under "a template
   * whose slots are not all resolved cannot render" that would make T8
   * unrenderable for exactly the case the unlocated form exists for.
   */
  subLocated: string;
  subUnlocated: string;

  /** Goes through resolveSlots — T8's names the company. */
  ctaPattern: string;
  metaCta: MetaCtaType;

  angles: [string, string, string, string, string];
  /**
   * ⚠️ MUST BE SERVICE-NOUN-FREE. This is what a rejected generation collapses
   * to, so it has to pass the same multi-select rule with NOTHING ticked — a
   * default that names cleaning would publish cleaning for a customer who does
   * not do it. Asserted in the suite against an empty selection.
   */
  defaultPrimaryText: string;
  /**
   * ⚠️ Meta needs a headline and a description too, so the fallback cannot be
   * the primary text alone. These are ours, written to fit inside the
   * truncation marks (40 and 30) so the one ad we publish when the model has
   * failed twice is at least not clipped — and, like defaultPrimaryText, they
   * name no service and state no figure.
   */
  defaultHeadline: string;
  defaultDescription: string;
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
    setupSlots: ["company_name", "fee_pct", "fee_basis", "fee_vat", "fee_public", "included", "landing_url"],
    adSlots: ["city"],
    headlineLocated: "Landlords in {city}: you’ll never see the *3am* message.",
    headlineUnlocated: "Landlords: you’ll never see the *3am* message.",
    // The spec's sub hardcodes five services. `included` is a multi-select, so
    // a fixed string publishes what the customer does not provide (§5).
    subLocated: "Full short let management. {included_list}, all handled by {company_name}.",
    subUnlocated: "Full short let management. {included_list}, all handled by {company_name}.",
    ctaPattern: "Talk to us about your property",
    metaCta: "CONTACT_US",
    angles: [
      "the message at 3am",
      "the cleaner who cancels on a Friday",
      "what a managed week looks like",
      "the landlord who self-managed for six months",
      "plain facts, fee and what is included",
    ],
    defaultPrimaryText:
      "Landlords, and hosts managing their own place: this is short let management, done for you. " +
      "You hand the property over and stop being the person who has to answer at 3am. " +
      "We look after it and send you the statement. Ask us what your place would need.",
    defaultHeadline: "Short let management, done for you",
    defaultDescription: "Ask about your property",
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
    setupSlots: ["company_name", "councils", "handled", "landing_url"],
    adSlots: ["city"],
    headlineLocated: "Landlords in {city}: short let rules, *handled*.",
    headlineUnlocated: "Landlords: short let rules, *handled*.",
    subLocated: "{handled_list}. We keep the file, you keep the property.",
    subUnlocated: "{handled_list}. We keep the file, you keep the property.",
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
    defaultPrimaryText:
      "Landlords wondering whether short letting is even allowed: this is short let management " +
      "with the paperwork handled. We keep the file on every property we look after, so it is " +
      "somebody’s job rather than an afterthought. Ask what applies to yours.",
    // ⚠️ Fixed, and required by the spec's claims note. Three of this
    // template's five angles invite legal advice, and a footer does not cure a
    // body that gives it — but its absence would make that worse.
    footerLine: "Responsibility stays with the property owner; we manage the process.",
    defaultHeadline: "Short let rules, handled",
    defaultDescription: "Ask what applies to yours",
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
    setupSlots: ["company_name", "property_types", "turnaround", "landing_url"],
    adSlots: ["city"],
    headlineLocated: "Landlords in {city}: what would your property earn on *short lets*?",
    headlineUnlocated: "Landlords: what would your property earn on *short lets*?",
    subLocated: "Send the postcode and bedroom count. We’ll run the numbers against your current rent.",
    subUnlocated: "Send the postcode and bedroom count. We’ll run the numbers against your current rent.",
    ctaPattern: "Get my estimate",
    metaCta: "GET_QUOTE",
    angles: [
      "the question asked plainly",
      "what the estimate is based on and what it is not",
      "the landlord who assumed it was not worth it",
      "how long an answer takes",
      "what happens after, so nobody fears a sales call",
    ],
    defaultPrimaryText:
      "Any landlord with a property let out, or empty: this is short let management, and the first " +
      "question is what your place would actually do. Send the postcode and the bedroom count and " +
      "we will work it out against what you get now. No obligation, and no sales call unless you ask for one.",
    defaultHeadline: "What would your property earn?",
    defaultDescription: "Get your estimate",
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
      "review_score", "review_count", "review_quote", "review_quote_source", "landing_url",
    ],
    adSlots: ["city"],
    headlineLocated:
      "Short let management in {city}: {years_trading} years, {properties_managed} properties, *{review_score}* on Google.",
    headlineUnlocated:
      "Short let management: {years_trading} years, {properties_managed} properties, *{review_score}* on Google.",
    subLocated: "Managing short lets across {areas} for landlords who would rather not.",
    subUnlocated: "Managing short lets for landlords who would rather not.",
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
    defaultPrimaryText:
      "Landlords comparing managers: this is short let management, and here is what we are rather " +
      "than what we promise. How long we have been doing it, how many properties we look after now, " +
      "and what the people who use us have said publicly. Have a look, then talk to us.",
    defaultHeadline: "Years, properties, reviews",
    defaultDescription: "Talk to us",
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
