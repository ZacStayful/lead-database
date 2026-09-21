import type { Customer } from "@/lib/types";
import { adBrief, figureList } from "./brief";
import { adProfileOf, fillPattern, resolveSlots, type Resolution } from "./resolveSlots";
import { destinationNeedsLink } from "./destination";
import { AD_THEMES, AD_AMBER } from "./theme";
import type { AdTemplate } from "./templates";
import type { ValidationContext } from "./validateAdCopy";
import { slotCopyLabel } from "./slotCopy";
import type { AdSlotKey } from "./templates";

/**
 * One reading of "what does this customer's advert look like right now" (§65).
 *
 * Four routes need it — questions, answers, regenerate and render — and they
 * must agree, because the copy is validated against the fixed headline that
 * the image then draws. Two readings would eventually produce an advert whose
 * words were checked against a headline it is not carrying.
 */

export type AdContext = {
  resolution: Resolution;
  ctx: ValidationContext;
  /** What the model is told about the business. */
  brief: string;
  /** The figures it may state, written out. */
  figures: string[];
  cta: string;
  /**
   * ⚠️ SLOTS THE TEMPLATE'S OWN PATTERNS NEED AND STILL DO NOT HAVE. A
   * template whose headline cannot be filled cannot render — returning the
   * half-filled string would put "Landlords in : 8 years" on an advert — so
   * this is what the route refuses on, with the list in the message.
   */
  unresolved: string[];
  accent: string;
  selected: string[];
};

/**
 * ⚠️ NEVER DEFAULTS THE ACCENT TO STAYFUL GREEN. `derivePalette` falls back to
 * `STAYFUL_ACCENT`, which would put OUR colour on a customer's advert in their
 * own name. When they have not set one the ad themes supply a neutral, which
 * is honest: an unbranded advert rather than somebody else's brand.
 */
export function adAccentFor(customer: Customer, template: AdTemplate): string {
  const brand = (customer as { presentation_brand?: unknown }).presentation_brand;
  const accent =
    brand && typeof brand === "object" && !Array.isArray(brand)
      ? (brand as { accent?: unknown }).accent
      : null;
  if (typeof accent === "string" && /^#[0-9a-f]{6}$/i.test(accent.trim())) {
    return accent.trim();
  }
  return template.theme === "light" ? AD_AMBER : AD_THEMES[template.theme].rule;
}

export function adContext(customer: Customer, template: AdTemplate): AdContext {
  const resolution = resolveSlots(customer, template);
  const profile = adProfileOf(customer);

  const located = resolution.slots.city !== undefined;
  const headlinePattern = located ? template.headlineLocated : template.headlineUnlocated;
  const subPattern = located ? template.subLocated : template.subUnlocated;

  const headline = fillPattern(headlinePattern, resolution.slots);
  const sub = fillPattern(subPattern, resolution.slots);
  const cta = fillPattern(template.ctaPattern, resolution.slots);

  const unresolved = Array.from(
    new Set(
      [headlinePattern, subPattern, template.ctaPattern]
        .flatMap((p) => Array.from(p.matchAll(/\{(\w+)\}/g)).map((m) => m[1]))
        .filter((k) => resolution.slots[k as keyof typeof resolution.slots] === undefined)
    )
  );
  // ⚠️ THIS LINE WAS THE BUG. It read
  //   if (!resolution.slots.landing_url) unresolved.push("landing_url");
  // unconditionally, and since `landing_url` appears in no headline, sub or CTA
  // pattern it was the ONLY thing that could put it here — so every run the
  // feature ever had was refused for a page an Instant Form ad never needed.
  //
  // The destination is resolved once, in `resolveSlots`. Unset means nobody has
  // been asked, and the honest gap is the QUESTION, not the page: chasing a URL
  // first is how that question came to be reworded into one whose answer could
  // not be stored.
  if (resolution.destination === undefined) unresolved.push("destination");
  else if (destinationNeedsLink(resolution.destination) && !resolution.slots.landing_url) {
    unresolved.push("landing_url");
  }

  const selected =
    (template.services?.slot === "handled" ? profile.handled : profile.included) ?? [];

  return {
    resolution,
    ctx: {
      template,
      slots: resolution.slots,
      profile,
      targeting: resolution.targeting,
      fixed: { headline: headline ?? "", sub: sub ?? "" },
    },
    brief: adBrief(customer, template, resolution),
    figures: figureList(customer, resolution),
    cta: cta ?? template.ctaPattern,
    unresolved: Array.from(new Set(unresolved)),
    accent: adAccentFor(customer, template),
    selected,
  };
}

/**
 * Everything that must be true before a generation is worth paying for.
 *
 * ⚠️ THIS EXISTS TO RUN BEFORE THE CLAIM. The answers route used to claim the
 * draft, merge the profile, and only then let `writeAd` discover the gap,
 * refuse, and release the claim it had just taken — so an operator burned a
 * generation slot to be told what was missing. The check is cheap and pure;
 * the thing it guards is not.
 *
 * `writeAd` keeps its own copy of this check as the second stop, because it is
 * the ONLY stop for the regenerate route, which never passes through here.
 */
export type PreflightVerdict =
  | { ok: true; warnings: string[] }
  | { ok: false; missing: AdSlotKey[]; labels: string[]; warnings: string[] };

export function preflight(context: AdContext): PreflightVerdict {
  const warnings = context.resolution.warnings;
  if (!context.unresolved.length) return { ok: true, warnings };
  return {
    ok: false,
    missing: context.unresolved as AdSlotKey[],
    // ⚠️ Never the raw key — `slotCopy.ts:114`. "We still need: landing_url" is
    // not a sentence anybody should read.
    labels: context.unresolved.map(slotCopyLabel),
    warnings,
  };
}
