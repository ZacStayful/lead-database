import type { Customer } from "@/lib/types";
import { adBrief, figureList } from "./brief";
import { adProfileOf, fillPattern, resolveSlots, type Resolution } from "./resolveSlots";
import { AD_THEMES, AD_AMBER } from "./theme";
import type { AdTemplate } from "./templates";
import type { ValidationContext } from "./validateAdCopy";

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
  if (!resolution.slots.landing_url) unresolved.push("landing_url");

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
