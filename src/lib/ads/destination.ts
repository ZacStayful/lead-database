/**
 * Where the button on the ad sends a landlord (§65).
 *
 * ⚠️ THIS EXISTS BECAUSE THE SYSTEM ASKED A QUESTION IT COULD NOT STORE THE
 * ANSWER TO. The first real run simplified the `landing_url` question into
 * "…how would you rather they got in touch — a message straight to your phone,
 * or landing on your website?", the operator picked the phone, and `asUrl` binned
 * it silently. The model had intuited a genuine product choice the schema did
 * not have. It has one now.
 *
 * Two values, deliberately:
 *
 *   website       the button opens a page they own. Needs `landing_url`.
 *   instant_form  the button opens a lead form inside Facebook. Needs no link
 *                 at all, which is what unblocks an operator with no website.
 *
 * ⚠️ "A message straight to my phone" IS NOT ONE OF THEM, and that is a product
 * decision rather than an oversight. Meta does support click-to-message ads, but
 * adding a third destination is a separate piece of work — so anything that is
 * neither of the two above is REFUSED WITH BOTH CHOICES NAMED, rather than
 * dropped. An operator must never again answer a question correctly and be told
 * they have not.
 *
 * ⚠️ Stored in `customers.ad_profile`, which is jsonb with no key whitelist, so
 * this needs no migration. The per-draft override lands with 0157 in PR C.
 *
 * Import-free: the profile form and the chat both render this copy (§21.8).
 */

export const AD_DESTINATIONS = ["website", "instant_form"] as const;
export type AdDestination = (typeof AD_DESTINATIONS)[number];

export function isAdDestination(value: unknown): value is AdDestination {
  return typeof value === "string" && (AD_DESTINATIONS as readonly string[]).includes(value);
}

/**
 * ⚠️ ONLY `website` NEEDS A LINK, and this is the one function that decides it.
 * `context.ts` asserted `landing_url` unconditionally, which is the single line
 * that refused every run the feature has ever had.
 *
 * An UNSET destination needs no link either — it needs the question asked. The
 * caller reports the missing destination, not a missing page, or the operator is
 * chased for a URL before anybody has established they want one.
 */
export function destinationNeedsLink(destination: AdDestination | undefined): boolean {
  return destination === "website";
}

const FORM_WORDS =
  /\b(instant form|lead form|facebook form|a form|the form|form on facebook|fill in a form|on facebook|in facebook|facebook itself)\b/;

const SITE_WORDS =
  /\b(website|web site|my site|our site|my page|our page|landing page|web page|webpage|my own (?:site|page|website)|enquiry page|contact page|booking page)\b/;

/** Something that is plainly a web address. Answering the destination question
 *  with a URL is answering "my website" and handing over the link at once. */
const LOOKS_LIKE_URL = /(^https?:\/\/)|([a-z0-9-]+\.[a-z]{2,}(\/|$))/i;

/**
 * Reads a destination out of what was typed or tapped. Returns `undefined`
 * rather than guessing — the caller turns that into a question with both
 * options named, never into a silent no-op.
 */
export function asDestination(raw: string): AdDestination | undefined {
  const text = raw.toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return undefined;

  // Order matters: "a form on my website" is a form. Asked before the site
  // words, because the site words would otherwise claim it.
  const form = FORM_WORDS.test(text);
  const site = SITE_WORDS.test(text) || LOOKS_LIKE_URL.test(text);

  // ⚠️ Both, or neither, is a question rather than a coin toss. An operator who
  // said "a form on my website" means something we should ask about.
  if (form && site) return undefined;
  if (form) return "instant_form";
  if (site) return "website";
  return undefined;
}

export const AD_DESTINATION_LABELS: Record<AdDestination, string> = {
  website: "a page on your own website",
  instant_form: "a form inside Facebook",
};

/** The question, asked in the chat before anything is generated. */
export const AD_DESTINATION_QUESTION =
  "When a landlord taps the button on your ad, where should they land — a page on your own website, or a form inside Facebook?";

/**
 * ⚠️ NAMES BOTH CHOICES. The whole failure this module exists for was a refusal
 * that told the operator what was missing without telling them what would
 * count.
 */
export const AD_DESTINATION_REFUSAL =
  "I can send them to a page on your own website, or to a form inside Facebook. Which of those two would you like?";

/**
 * ⚠️ SAID ON THE `instant_form` PATH, AND IT MUST NOT OVERSTATE WHAT WE DO.
 * Nothing here publishes to Meta and nothing retrieves the leads: an Instant
 * Form lead lands in Meta's own Leads Centre. Getting it into this CRM is the
 * operator's own automation posting to their lead webhook, or a CSV. Claiming
 * otherwise would be §51.11's failure aimed at the customer.
 */
export const AD_INSTANT_FORM_NOTE =
  "You won't need a link for that. Leads from a Facebook form arrive in Meta's Leads Centre — to get them in here automatically you can point your own automation at your lead webhook in Settings.";

/**
 * The destination for a run, resolved once.
 *
 * ⚠️ AN ALREADY-RESOLVED LINK MEANS `website`, AND THAT IS WHAT KEEPS THIS FROM
 * BEING A REGRESSION. Most customers have a `website_url` on file, so the
 * override chain already produces a `landing_url` for them; asking those
 * operators to choose a destination before their first ad would be new friction
 * for no gain. An explicit choice always wins over the inference.
 *
 * `undefined` means ASK — nobody has chosen and nothing implies one. That is
 * the state the account that hit the bug is in, and the question is now the
 * destination rather than a page they never said they had.
 */
export function resolveDestination(
  explicit: unknown,
  hasLink: boolean
): AdDestination | undefined {
  if (isAdDestination(explicit)) return explicit;
  return hasLink ? "website" : undefined;
}
