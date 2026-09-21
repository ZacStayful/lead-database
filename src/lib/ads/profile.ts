import type { AdProfile, FeeBasis, FeeVat } from "./resolveSlots";
import type { AdSlotKey, AdTemplate } from "./templates";
import type { Answer, Question } from "./schemas";

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
 * fails in the direction of a quieter advert: no fee published, no place
 * named, no figure stated. A wrong value here is on a live advert in the
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
 * "Landlords in None" on an advert. Short, because a town called "Anywhere"
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
 * advert. Guessing "yes" from an ambiguous sentence publishes a price the
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

function asUrl(raw: string): string | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    // ⚠️ https ONLY, the rule §21.5 already enforces on an admin's link. The
    // button on a live advert must not be able to send somebody over http.
    if (url.protocol !== "https:") return undefined;
    if (!url.hostname.includes(".")) return undefined;
    return url.toString().slice(0, 400);
  } catch {
    return undefined;
  }
}

/** "Cleaning, linen" → the ticked keys, from the template's own vocabulary. */
function asServiceKeys(raw: string, template: AdTemplate): string[] | undefined {
  if (!template.services) return undefined;
  const text = raw.toLowerCase();
  // ⚠️ MATCHED AGAINST THE TEMPLATE'S OWN OPTIONS, so a service the model
  // invented cannot become a ticked key — and a ticked key is what licenses
  // naming it on the advert.
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
 */
export function answersToProfile(
  questions: Question[],
  answers: Answer[],
  template: AdTemplate
): Partial<AdProfile> {
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
  const put = (key: string, value: unknown) => {
    if (value !== undefined) patch[key] = value;
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
      case "landing_url":
        put(slot, asUrl(raw));
        break;
      case "fee_pct":
        put(slot, asCount(raw, { max: 99 }));
        break;
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
        // ⚠️ Only meaningful on the template that owns this multi-select.
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
  return patch as Partial<AdProfile>;
}
