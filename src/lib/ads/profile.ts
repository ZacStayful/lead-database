import { feeVerdict, type AdProfile, type FeeBasis, type FeeVat } from "./resolveSlots";
import { AD_TEMPLATES, type AdSlotKey, type AdTemplate } from "./templates";
import type { Answer, Question } from "./schemas";
import { asDestination, AD_DESTINATION_REFUSAL } from "./destination";
import { parseAdUrl, URL_REFUSAL_COPY, URL_UPGRADED_NOTE, type UrlRefusal } from "./url";

/**
 * Turning what the operator typed into the chat into `ad_profile` (§65).
 *
 * ⚠️ THE WRITABLE KEYS ARE A CLOSED SET CHECKED HERE, NEVER A KEY FROM THE
 * MODEL. `Question.slot` is a string the model chose, and a mapper that trusted
 * it would let a hallucinated slot name write an arbitrary key into a column
 * every ad surface reads. §27.1's standing rule, one layer down.
 *
 * ⚠️ AND AN UNPARSEABLE ANSWER SETS NOTHING. Every coercion below fails to
 * `undefined` rather than to a guess, and every guess it declines to make
 * fails in the direction of a quieter ad: no fee published, no place
 * named, no figure stated. A wrong value here is on a live ad in the
 * operator's own name.
 */

/**
 * ⚠️ THE TWO ATTESTATIONS ARE NOT ON THIS LIST, AND THAT IS THE POINT.
 *
 * `review_quote_confirmed` is what unlocks quoting a customer's review, and
 * `stats_confirmed_at` is the one record that the published figures are real
 * and evidenceable — CAP Code 3.7 wants documentary evidence held BEFORE
 * publication. Both are deliberate ticks on a form, made by a person who is
 * attesting to something. Neither may be inferred from a sentence a model
 * mapped onto a slot.
 */
/**
 * ⚠️ THIS LIST AND THE `switch` IN `answersToProfile` ARE TWO DEFENCES AND NO
 * BEHAVIOURAL TEST CAN TELL THEM APART — a slot with no `case` writes nothing
 * whether or not the list rejects it first, which a mutation run proved by
 * deleting the check and watching every test stay green.
 *
 * So what is asserted instead is that they AGREE: `profile.test.ts` reads the
 * switch's cases out of this file and requires set-equality with this array.
 * That catches the drift that actually happens — a case added without the
 * list, or a key added to the list with no case, either of which turns a
 * documented rule into a decorative one.
 */
export const CHAT_WRITABLE_SLOTS = [
  "company_name",
  "city",
  "areas",
  "landing_url",
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
] as const satisfies readonly AdSlotKey[];
export type ChatWritableSlot = (typeof CHAT_WRITABLE_SLOTS)[number];

export const ATTESTATION_KEYS = ["review_quote_confirmed", "stats_confirmed_at"] as const;

export function isChatWritable(slot: string): slot is ChatWritableSlot {
  return (CHAT_WRITABLE_SLOTS as readonly string[]).includes(slot);
}

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

const clean = (v: string, cap: number) => v.replace(/\s+/g, " ").trim().slice(0, cap);

/**
 * ⚠️ "No", "none", "anywhere", "skip" ARE NOT A TOWN. An operator declining to
 * narrow is the unlocated case, and storing their refusal as a place name puts
 * "Landlords in None" on an ad. Short, because a town called "Anywhere"
 * does not exist but a road might.
 */
const REFUSAL_RE = /^(no|none|n\/?a|skip|any|anywhere|not sure|don'?t mind|no preference|without.*)$/i;

function asTown(raw: string): string | undefined {
  const text = clean(raw, 60);
  if (!text || REFUSAL_RE.test(text)) return undefined;
  // A sentence is not a town either. "Run it without a place name" is three
  // words past anything anybody calls a place.
  if (text.split(" ").length > 4) return undefined;
  return text;
}

function asCount(raw: string, opts: { max?: number }): number | undefined {
  const m = raw.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  if (!m) return undefined;
  const n = Number(m[0]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (opts.max !== undefined && n > opts.max) return undefined;
  return n;
}

/**
 * ⚠️ IT DECLINES RATHER THAN GUESSES, and the direction is load-bearing: an
 * unset `fee_public` reads as false everywhere, so the fee stays off the
 * ad. Guessing "yes" from an ambiguous sentence publishes a price the
 * operator never agreed to publish.
 */
function asYesNo(raw: string): boolean | undefined {
  const text = raw.trim().toLowerCase();
  const opensYes = /^(yes|yep|yeah|sure|ok|okay|please do|put it on)\b/.test(text);
  const opensNo = /^(no|nope|nah|rather not|keep it off|leave it off)\b/.test(text);
  // ⚠️ THE OPENER ALONE IS NOT ENOUGH, and a test found it: "yes and no" opens
  // with yes, so a prefix check published the operator's fee on the strength
  // of a sentence that plainly declined to answer. The whole answer is scanned
  // for the other polarity, and anything carrying both declines.
  const anyYes = /\b(yes|yep|yeah|sure|okay|ok)\b/.test(text);
  const anyNo = /\b(no|nope|nah|not|never|don'?t)\b/.test(text);
  if (opensYes && !anyNo) return true;
  if (opensNo && !anyYes) return false;
  return undefined;
}

function asFeeBasis(raw: string): FeeBasis | undefined {
  const text = raw.toLowerCase();
  const net = /\bnet\b/.test(text);
  const gross = /\bgross\b/.test(text);
  if (net === gross) return undefined;
  return net ? "net" : "gross";
}

function asFeeVat(raw: string): FeeVat | undefined {
  const text = raw.toLowerCase();
  if (/\b(plus vat|\+ ?vat|ex(?:cl(?:uding)?)? ?vat|exclusive)\b/.test(text)) return "exclusive";
  if (/\b(inc(?:l(?:uding)?)? ?vat|inclusive)\b/.test(text)) return "inclusive";
  if (/\b(rather not|not say|prefer not|no comment)\b/.test(text)) return "not_stated";
  return undefined;
}

/** "Cleaning, linen" → the ticked keys, from the template's own vocabulary. */
function asServiceKeys(raw: string, template: AdTemplate): string[] | undefined {
  if (!template.services) return undefined;
  const text = raw.toLowerCase();
  // ⚠️ MATCHED AGAINST THE TEMPLATE'S OWN OPTIONS, so a service the model
  // invented cannot become a ticked key — and a ticked key is what licenses
  // naming it on the ad.
  const keys = template.services.options
    .filter((o) => o.tokens.some((t) => text.includes(t)) || text.includes(o.label.toLowerCase()))
    .map((o) => o.key);
  return keys.length ? keys : [];
}

/** A free list — councils, property types. Split on commas and "and". */
function asList(raw: string): string[] | undefined {
  const parts = raw
    .split(/,| and | & |\n/i)
    .map((p) => clean(p, 60))
    .filter(Boolean);
  const unique = Array.from(new Set(parts)).slice(0, 12);
  return unique.length ? unique : undefined;
}

// ---------------------------------------------------------------------------

/**
 * The patch to merge, built from answers the operator actually gave.
 *
 * ⚠️ IT RETURNS A PATCH, NEVER THE WHOLE PROFILE. `merge_ad_profile` applies
 * it with `||`, so a key this function omits keeps whatever was there — which
 * is the difference between "they did not answer that" and "they cleared it".
 *
 * ⚠️ WHY IT RETURNS REFUSALS RATHER THAN JUST A PATCH.
 *
 * Every coercion below still fails to `undefined` rather than to a guess — that
 * rule is right and unchanged. What was missing is the other half: SAYING SO.
 * The first real run had three of its five answers discarded in silence, and
 * the operator was then refused for a value they believed they had given.
 *
 * So a coercion that declines now records what it saw and why, the profile PUT
 * hands them back with a 200 (the rest did save), and the chat reads them out.
 * `put` is the only place that decides, so a future slot cannot opt out of it
 * by accident.
 */
export type SlotRefusalReason =
  | UrlRefusal
  | "unreadable"
  | "not_a_destination"
  | "fee_looks_like_a_typo"
  | "fee_out_of_range";

export type SlotRefusal = {
  slot: ChatWritableSlot;
  reason: SlotRefusalReason;
  /** What they actually typed, so the message can quote it back. */
  answer: string;
};

/** Something we changed rather than refused, which must not be silent either. */
export type SlotNote = { slot: ChatWritableSlot; kind: "url_upgraded" };

export type ProfileMapping = {
  patch: Partial<AdProfile>;
  refusals: SlotRefusal[];
  notes: SlotNote[];
};

export function answersToProfile(
  questions: Question[],
  answers: Answer[],
  template: AdTemplate
): ProfileMapping {
  const bySlot = new Map<string, string>();
  const slotOf = new Map(questions.map((q) => [q.id, q.slot ?? ""]));
  for (const a of answers) {
    const slot = slotOf.get(a.id) ?? "";
    if (!slot || !isChatWritable(slot)) continue;
    const text = a.answer.trim();
    if (!text) continue;
    // First answer wins: a ladder that was simplified keeps one answer per id,
    // so a duplicate here means two questions claimed one slot.
    if (!bySlot.has(slot)) bySlot.set(slot, text);
  }

  const patch: Record<string, unknown> = {};
  const refusals: SlotRefusal[] = [];
  const notes: SlotNote[] = [];

  const put = (key: string, value: unknown, reason: SlotRefusalReason = "unreadable") => {
    if (value !== undefined) {
      patch[key] = value;
      return;
    }
    refusals.push({
      slot: key as ChatWritableSlot,
      reason,
      answer: bySlot.get(key) ?? "",
    });
  };

  // Array.from, not a bare for..of: this tsconfig predates downlevelIteration.
  for (const [slot, raw] of Array.from(bySlot)) {
    switch (slot) {
      case "company_name":
        put(slot, clean(raw, 80) || undefined);
        break;
      case "city":
        put(slot, asTown(raw));
        break;
      case "areas":
      case "turnaround":
        put(slot, clean(raw, 120) || undefined);
        break;
      case "landing_url": {
        // ⚠️ The verdict's OWN reason, never a flattened "unreadable". An
        // operator who pasted an http:// link, a mailto: or a sentence needs
        // three different things said to them.
        const verdict = parseAdUrl(raw);
        if (verdict.ok) {
          patch[slot] = verdict.url;
          if (verdict.upgraded) notes.push({ slot, kind: "url_upgraded" });
        } else {
          refusals.push({ slot, reason: verdict.reason, answer: raw });
        }
        break;
      }
      case "destination":
        put(slot, asDestination(raw), "not_a_destination");
        break;
      case "fee_pct": {
        // ⚠️ THROUGH `feeVerdict`, WHICH EXISTED AND WAS NEVER CONSULTED HERE.
        // The spec is blunt that "under 8% or over 30% is almost certainly a
        // typo, and a wrong fee in a live ad is worse than no ad" — and storing
        // it anyway was not merely permissive: `resolveSlots` then refuses the
        // same number, so the fee vanished off the ad with the reason recorded
        // in a `warnings` array nothing rendered. Refused at the point of
        // typing, it is a sentence the operator can act on.
        const n = asCount(raw, { max: 99 });
        if (n === undefined) {
          put(slot, undefined);
          break;
        }
        const verdict = feeVerdict(n, { fresh: true });
        if (verdict.ok) patch[slot] = n;
        else {
          refusals.push({
            slot: slot as ChatWritableSlot,
            reason: verdict.reason === "fee_looks_like_a_typo"
              ? "fee_looks_like_a_typo"
              : "fee_out_of_range",
            answer: raw,
          });
        }
        break;
      }
      case "fee_basis":
        put(slot, asFeeBasis(raw));
        break;
      case "fee_vat":
        put(slot, asFeeVat(raw));
        break;
      case "fee_public":
        put(slot, asYesNo(raw));
        break;
      case "included":
      case "handled":
        // ⚠️ Only meaningful on the template that owns this multi-select — and a
        // template that does not own it records NO refusal, because nothing was
        // wrong with the answer. It was asked of the wrong ad.
        if (template.services?.slot === slot) put(slot, asServiceKeys(raw, template));
        break;
      case "councils":
      case "property_types":
        put(slot, asList(raw));
        break;
      case "years_trading":
        put(slot, asCount(raw, { max: 200 }));
        break;
      case "properties_managed":
        put(slot, asCount(raw, { max: 100_000 }));
        break;
      case "review_score":
        // A Google score. Out of range is a mis-parse, not a business with
        // seven-star reviews.
        put(slot, asCount(raw, { max: 5 }));
        break;
      case "review_count":
        put(slot, asCount(raw, { max: 1_000_000 }));
        break;
    }
  }

  return { patch: patch as Partial<AdProfile>, refusals, notes };
}

/**
 * What the operator is told about an answer we could not use.
 *
 * ⚠️ NEVER NAMES THE SLOT KEY. §65's rule (`slotCopy.ts:114`): "We still need:
 * landing_url" is not a sentence anybody should read. The label comes from
 * `slotCopyLabel` at the call site if one is wanted; this is the reason.
 */
export function refusalMessage(refusal: SlotRefusal): string {
  if (refusal.reason === "not_a_destination") return AD_DESTINATION_REFUSAL;
  // ⚠️ THE NUMBER IS QUOTED BACK. "That doesn't look right" about a fee they
  // cannot see is the shape of refusal this whole change exists to remove.
  if (refusal.reason === "fee_looks_like_a_typo") {
    return `A fee of ${refusal.answer.trim()} is outside the 8% to 30% most managers charge, so I've left it off in case it was a typo. Send it again if that really is your fee and I'll use it.`;
  }
  if (refusal.reason === "fee_out_of_range") {
    return `I couldn't use ${refusal.answer.trim()} as a percentage fee, so I've left it off.`;
  }
  if (refusal.reason === "unreadable") {
    return refusal.answer
      ? `I couldn’t make sense of “${refusal.answer.slice(0, 60)}”, so I’ve left that off.`
      : "I couldn’t make sense of that, so I’ve left it off.";
  }
  return URL_REFUSAL_COPY[refusal.reason];
}

/** What changed rather than what was refused — an http link stored as https. */
export function noteMessage(note: SlotNote): string {
  return note.kind === "url_upgraded" ? URL_UPGRADED_NOTE : "";
}

/** Every sentence for one mapping, in order, ready to append to a refusal. */
export function mappingSentences(mapping: ProfileMapping): string[] {
  return [
    ...mapping.refusals.map(refusalMessage),
    ...mapping.notes.map(noteMessage),
  ].filter(Boolean);
}

// ---------------------------------------------------------------------------
// Options the slot can actually store
// ---------------------------------------------------------------------------

/**
 * ⚠️ THE ROOT CAUSE OF THE BUG THIS FEATURE SHIPPED WITH.
 *
 * The model writes the question AND its options, and nothing checked the options
 * against the slot they answer. So on the first real run it simplified the
 * `landing_url` question into a choice between "a message straight to your
 * phone" and "landing on your website", the operator tapped the phone, and the
 * coercer binned an option the system had offered them itself.
 *
 * An option that cannot survive the write path must never appear. And rather
 * than restate the coercers here — which is precisely how two copies of one
 * rule drift — THE CHECK IS THE WRITE PATH: each option is run through
 * `answersToProfile` and kept only if it lands in the patch. There is no second
 * definition to keep in step.
 */
const SERVICE_SLOTS = new Set<string>(["included", "handled"]);

export function answerableOptions(
  slot: string | undefined,
  options: string[],
  template?: AdTemplate
): string[] {
  if (!slot || !isChatWritable(slot)) return options;
  // A multi-select's options ARE the template's own vocabulary, so they are
  // answerable by construction — and with no template there is nothing to check
  // them against.
  if (SERVICE_SLOTS.has(slot)) return options;

  // Any template will do for a non-service slot: the switch consults
  // `template.services` and nothing else.
  const t = template ?? AD_TEMPLATES[0];
  return options.filter((option) => {
    const probe: Question = {
      id: "probe",
      question: "probe",
      options: [],
      allowOther: true,
      slot,
      depth: 0,
      calls: 0,
    };
    const answer: Answer = { id: "probe", question: "probe", answer: option, depth: 0 };
    const { patch } = answersToProfile([probe], [answer], t);
    return (patch as Record<string, unknown>)[slot] !== undefined;
  });
}

/**
 * The same rule over a whole question set.
 *
 * ⚠️ A QUESTION LEFT WITH TOO FEW OPTIONS BECOMES FREE TEXT, never a one-option
 * choice. Offering a single button is not a question, and the ladder already
 * terminates in a plain box — so the honest degradation is to ask in words.
 */
export function answerableQuestions(questions: Question[], template?: AdTemplate): Question[] {
  return questions.map((q) => {
    if (!q.options.length) return q;
    const kept = answerableOptions(q.slot, q.options, template);
    if (kept.length === q.options.length) return q;
    return kept.length >= 2
      ? { ...q, options: kept }
      : { ...q, options: [], allowOther: true };
  });
}

/** One question, for the simplify rung — which is the rung the bug happened on. */
export function answerableQuestion(question: Question, template?: AdTemplate): Question {
  return answerableQuestions([question], template)[0];
}
