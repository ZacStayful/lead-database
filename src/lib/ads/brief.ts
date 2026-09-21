import type { Customer } from "@/lib/types";
import {
  adProfileOf,
  areasPhrase,
  citySuggestions,
  feePhrase,
  type Resolution,
} from "./resolveSlots";
import { questionForSlot } from "./slotCopy";
import type { AdTemplate } from "./templates";

/**
 * What the model is told about the business it is writing for (§65).
 *
 * The ads counterpart of `feedback/accountState.ts`, and it takes that file's
 * one real lesson: DRAW THE CONCLUSION, do not just list the fields. A model
 * handed `review_score: null` writes around it; a model told "no review score
 * on file — the proof template cannot run today" picks a different template.
 *
 * ⚠️ ABSENCE IS STATED, NEVER OMITTED. A missing figure that simply is not in
 * the brief reads to a model as a figure it was not told about rather than one
 * it may not use, and the difference is an invented number on a live advert.
 * Every gap below says it is a gap and says what it costs.
 *
 * ⚠️ AND NOTHING HERE IS A DEFAULT. `presentationSeed.ts` fills its gaps with
 * `TOOL_INCOME_DEFAULTS` because a form needs a complete object; a prompt does
 * not, and §40.5 records what happens when the two are confused — half the
 * book would be told their property grosses £60,000 on the strength of a
 * placeholder.
 */

const yes = (v: unknown) => v === true;

/** "LS, WF and BD" → the sentence the model reads about where they work. */
function targetingLine(r: Resolution): string[] {
  switch (r.targeting.kind) {
    case "areas": {
      const cities = citySuggestions(r.targeting.areas);
      return [
        `They already work in: ${areasPhrase(r.targeting.areas)}.`,
        r.slots.city
          ? `The advert names **${r.slots.city}**, so the located headline is the one being used.`
          : cities.length
            ? `No town chosen for the advert yet. From those areas, honest options are: ${cities.join(", ")}. ` +
              "Until one is chosen the advert runs without a place name."
            : "No town chosen, and their areas do not map to one town anybody would say out loud. " +
              "Ask which town to name, or run it without one.",
      ];
    }
    case "anywhere":
      return [
        "They have said they will take work anywhere rather than naming areas.",
        "⚠️ So the advert may NOT name a town. An advert that says one place while " +
          "targeting everywhere reads as a mail-merge to everybody outside it.",
      ];
    case "unset":
      return [
        "They have not told us where they want work.",
        "⚠️ So the advert may NOT name a town until they do.",
      ];
  }
}

function feeLines(customer: Customer): string[] {
  const p = adProfileOf(customer);
  if (!yes(p.fee_public)) {
    return [
      "Fee: **not to be published**. They have not agreed to put what they charge " +
        "on the advert, so it must not appear — not as a number, not as a range, " +
        "not as \"from\".",
    ];
  }
  const phrase = feePhrase(p);
  return phrase
    ? [`Fee, which they HAVE agreed to publish: ${phrase}. State it exactly that way or not at all.`]
    : [
        // ⚠️ TWO REASONS, ONE SENTENCE, DELIBERATELY. `feePhrase` now also
        // withholds a fee whose VAT treatment nobody recorded — because a bare
        // "15%" is a different price with and without it, and the validator
        // refuses one. Either way the instruction to the model is identical,
        // and the operator is told which it was by the questionnaire asking.
        "Fee: they are happy to publish one, but we do not have it in a form " +
          "that can go on an ad, so it must not appear.",
      ];
}

function servicesLines(customer: Customer, t: AdTemplate): string[] {
  if (!t.services) return [];
  const p = adProfileOf(customer);
  const selected = (t.services.slot === "handled" ? p.handled : p.included) ?? [];
  const chosen = t.services.options.filter((o) => selected.includes(o.key));
  const rest = t.services.options.filter((o) => !selected.includes(o.key));
  if (!chosen.length) {
    return [
      "⚠️ They have ticked NONE of this template's services, so the advert may " +
        "not name a single one of them: " +
        `${t.services.options.map((o) => o.label).join(", ")}. ` +
        "Write about the service in general terms instead.",
    ];
  }
  return [
    `They do: ${chosen.map((o) => o.label).join(", ")}.`,
    rest.length
      ? `⚠️ They do NOT do, and the advert may not mention: ${rest.map((o) => o.label).join(", ")}.`
      : "That is all of them.",
  ];
}

function trustLines(customer: Customer): string[] {
  const p = adProfileOf(customer);
  const out: string[] = [];
  const state = (label: string, value: unknown, missing: string) =>
    out.push(
      value === null || value === undefined || value === ""
        ? `${label}: not on file. ⚠️ ${missing}`
        : `${label}: ${value}.`
    );

  state("Years trading", p.years_trading, "Do not state a number of years.");
  state("Properties managed", p.properties_managed, "Do not state a number of properties.");

  // ⚠️ THE SCORE AND ITS COUNT TRAVEL TOGETHER. The spec: "the review score
  // always renders with its count". A score on its own is the oldest trick in
  // the book, so the brief refuses to offer half a pair.
  if (p.review_score !== null && p.review_score !== undefined && p.review_count) {
    out.push(`Google reviews: ${p.review_score} from ${p.review_count} reviews. State both or neither.`);
  } else if (p.review_score !== null && p.review_score !== undefined) {
    out.push(
      `Google review score: ${p.review_score}, but we do not have how many reviews it is out of. ` +
        "⚠️ A score without its count must not appear."
    );
  } else {
    out.push("Google reviews: not on file. ⚠️ Do not mention reviews or a score.");
  }

  if (yes(p.review_quote_confirmed) && p.review_quote) {
    out.push(
      `A real review they have confirmed is theirs${p.review_quote_source ? ` (${p.review_quote_source})` : ""}: ` +
        `"${p.review_quote}". You may quote this, exactly, or not quote at all.`
    );
  } else {
    out.push(
      "⚠️ No confirmed review to quote. Do not put any sentence in quotation marks " +
        "and do not attribute anything to a named person."
    );
  }

  if (!p.stats_confirmed_at && (p.years_trading || p.properties_managed || p.review_score)) {
    out.push(
      "Note: they have not yet confirmed these figures are current and evidenceable. " +
        "They will be asked to before the advert is used."
    );
  }
  return out;
}

/**
 * The brief, as one string.
 *
 * ⚠️ IT NEVER CARRIES THE CUSTOMER'S EMAIL, PHONE, STRIPE ID OR ROW ID. The
 * model is being told about a business, not about an account, and §30.5
 * already records that this codebase sends real contact details to a provider
 * in one place and treats that as a decision rather than a habit.
 */
/**
 * What the model is told about where the button goes.
 *
 * ⚠️ `instant_form` NEEDS NO PAGE, and saying so is what stops the ladder
 * asking for one. An unset destination is the honest gap: ask which of the two
 * they want, never for a URL nobody has established they have.
 */
function destinationLine(r: Resolution): string {
  if (r.destination === "instant_form") {
    return "The button opens a lead form inside Facebook. They need no landing page.";
  }
  if (r.slots.landing_url) return "They have a page for the button to point at.";
  if (r.destination === "website") {
    return "⚠️ They want the button to open their own website and there is no page on file. Ask for it.";
  }
  return (
    "⚠️ Nobody has chosen where the button goes. Ask whether it should open a page on " +
    "their own website or a lead form inside Facebook — those two and no others."
  );
}

export function adBrief(customer: Customer, template: AdTemplate, r: Resolution): string {
  const p = adProfileOf(customer);
  const lines: string[] = [
    "## The business",
    `Trading name for the advert: ${r.slots.company_name ?? "⚠️ not on file — ask what name the advert goes out under."}`,
    // ⚠️ THREE CASES, NOT TWO. This read "no landing page on file, ask where
    // the button should send people" for everybody without a link — including
    // an operator who has chosen a Facebook lead form, whose ad needs no page
    // at all. Telling the model to chase one is how the question that broke
    // this feature got reworded in the first place.
    destinationLine(r),
    "",
    "## Where they want work",
    ...targetingLine(r),
    "",
    "## What they charge",
    ...feeLines(customer),
  ];

  const services = servicesLines(customer, template);
  if (services.length) lines.push("", "## What they actually do", ...services);

  if (p.property_types?.length) {
    lines.push("", `## Property types they take on`, areasPhrase(p.property_types.map(String)) ?? "");
  }
  if (p.councils?.length) {
    lines.push("", "## Councils they deal with", areasPhrase(p.councils.map(String)) ?? "");
  }
  if (p.turnaround) {
    lines.push("", "## How fast they reply", p.turnaround);
  }

  lines.push("", "## Their numbers", ...trustLines(customer));

  // ⚠️ THE MISSING LIST IS WHY THE QUESTIONS CALL ASKS THREE THINGS RATHER
  // THAN TWELVE, and it is what makes "a second advert asks fewer questions"
  // real rather than a claim in a plan.
  if (r.missing.length) {
    lines.push(
      "",
      "## Still missing, and worth asking about",
      ...r.missing.map((slot) => {
        const q = questionForSlot(slot, template);
        return `- ${slot}${q ? ` — e.g. "${q.question}"` : ""}`;
      })
    );
  } else {
    lines.push("", "## Still missing", "Nothing. Ask about the advert itself rather than the business.");
  }

  if (r.warnings.length) {
    lines.push("", "## Flags", ...r.warnings.map((w) => `- ${w}`));
  }

  return lines.join("\n");
}

/**
 * The figures the copy call is allowed to state, written out.
 *
 * ⚠️ IT MIRRORS `allowedFigures()` IN `validateAdCopy.ts`, and the two must
 * move together: this is the omission layer and that is the rejection layer,
 * and a figure offered here but refused there produces an advert that comes
 * back generic with no error anybody sees. The unit suite drives one list
 * against the other.
 */
export function figureList(customer: Customer, r: Resolution): string[] {
  const p = adProfileOf(customer);
  const out: string[] = [];
  if (yes(p.fee_public)) {
    const phrase = feePhrase(p);
    if (phrase) out.push(`The fee, written exactly as "${phrase}".`);
  }
  if (r.slots.years_trading) out.push(`${r.slots.years_trading} years trading.`);
  if (r.slots.properties_managed) out.push(`${r.slots.properties_managed} properties managed.`);
  if (r.slots.review_score && r.slots.review_count) {
    out.push(`A review score of ${r.slots.review_score} from ${r.slots.review_count} reviews — always both.`);
  }
  return out;
}
