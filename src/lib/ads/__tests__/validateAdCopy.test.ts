import { describe, expect, it } from "vitest";
import {
  allowedFigures,
  figuresAreSupplied,
  validateAdCopy,
  type ValidationContext,
} from "../validateAdCopy";
import { AD_TEMPLATES, templateById } from "../templates";
import { AD_COPY_MAX, AD_IMAGE_MAX, META_TRUNCATION_MARKS } from "../metaFields";
import { stripEmphasis } from "../emphasis";
import type { AdProfile, SlotValues, TargetingState } from "../resolveSlots";

const T3 = templateById("never-see-the-messages")!;
const T6 = templateById("rules-keep-changing")!;
const T7 = templateById("what-would-it-earn")!;
const T8 = templateById("years-properties-review")!;

const AREAS: TargetingState = { kind: "areas", areas: ["LS"] };

function ctx(over: Partial<ValidationContext> = {}): ValidationContext {
  const template = over.template ?? T8;
  return {
    template,
    slots: {
      company_name: "Northside Lets",
      landing_url: "https://northside.example",
      city: "Leeds",
      years_trading: "8",
      properties_managed: "140",
      review_score: "4.9",
      review_count: "63",
      ...(over.slots ?? {}),
    } as SlotValues,
    profile: { review_quote_confirmed: false, ...(over.profile ?? {}) } as AdProfile,
    targeting: over.targeting ?? AREAS,
    example: over.example ?? { headline: "x", sub: "y" },
  };
}

const GOOD = {
  message:
    "Landlords comparing managers: this is short let management, and here is what we actually are. " +
    "We have been doing it a while, we look after a good number of places, and people say so publicly.",
  headline: "Years, properties, reviews",
  description: "Talk to us",
};

/** Two lines that pass every claims rule, so an image failure is never the subject. */
const IMAGE = {
  image_headline: "Landlords: here is what we actually are.",
  image_sub: "Short let management, run by people who answer.",
};

const key = (c: ValidationContext) => c.template.angleKeys[0];

/**
 * One variant of the template's first angle, with the verdict flattened so the
 * per-variant rejections read the way they did when one text was the whole ad.
 *
 * ⚠️ A SINGLE-VARIANT RESPONSE WHOSE ONLY VARIANT IS REFUSED COMES BACK
 * `ok: false` WITH `reason: "empty"`, because zero survivors is not an ad. The
 * rule that actually fired is in `rejected[0]` — which is the thing these
 * assertions are about, and what the retry is told.
 */
function ok(over: Partial<typeof GOOD> = {}, c = ctx()) {
  const v = validateAdCopy({ ...IMAGE, variants: [{ angle_key: key(c), ...GOOD, ...over }] }, c, [key(c)]);
  if (v.ok) return v;
  const first = v.rejected[0];
  return first ? { ...v, reason: first.reason, detail: first.detail } : v;
}

describe("the shape", () => {
  it("accepts a clean generation and returns Meta's fields", () => {
    const v = ok();
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.copy.variants).toEqual([{ angle_key: key(ctx()), angle: T8.angles[0], ...GOOD }]);
    expect(v.copy.call_to_action_type).toBe("CONTACT_US");
    expect(v.copy.link_url).toBe("https://northside.example");
    expect(v.copy.image).toEqual({ headline: IMAGE.image_headline, sub: IMAGE.image_sub });
    expect(v.copy.provenance).toEqual({ written: 1, offered: 1, image: "model" });
  });

  it("refuses a missing field rather than publishing a blank one", () => {
    for (const k of ["message", "headline", "description"] as const) {
      const v = ok({ [k]: "  " });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toBe("missing_field");
    }
    expect(validateAdCopy(null, ctx(), [])).toMatchObject({ reason: "empty" });
    expect(validateAdCopy("a string", ctx(), [])).toMatchObject({ reason: "empty" });
  });

  it("refuses when there is nowhere for the ad to click to", () => {
    const v = ok({}, ctx({ slots: { landing_url: undefined } as SlotValues }));
    expect(v).toMatchObject({ reason: "missing_field", detail: "landing_url" });
  });
});

describe("⚠️ 125/40/30 are truncation MARKS, not limits", () => {
  it("accepts copy well past every mark", () => {
    // Rejecting on these would fail nearly every generation — none of T3's
    // angles fits 125 characters with the audience and category as well.
    expect(GOOD.message.length).toBeGreaterThan(META_TRUNCATION_MARKS.message);
    expect(ok().ok).toBe(true);
    expect(ok({ headline: "x".repeat(META_TRUNCATION_MARKS.headline + 20) }).ok).toBe(true);
    expect(ok({ description: "x".repeat(META_TRUNCATION_MARKS.description + 20) }).ok).toBe(true);
  });

  it("rejects only past our own stated bound", () => {
    expect(ok({ message: "Landlords, short let management. " + "x".repeat(AD_COPY_MAX.message) }))
      .toMatchObject({ reason: "too_long" });
    expect(ok({ headline: "x".repeat(AD_COPY_MAX.headline + 1) }))
      .toMatchObject({ reason: "too_long" });
  });
});

describe("the decidable rejections", () => {
  it("refuses a URL in a text field — link_url is a URL by construction", () => {
    expect(ok({ message: GOOD.message + " See northside.co.uk" })).toMatchObject({ reason: "link_in_text" });
    expect(ok({ description: "https://x.com" })).toMatchObject({ reason: "link_in_text" });
  });

  it("refuses any mention of Stayful — the ad is the operator's", () => {
    expect(ok({ description: "Powered by Stayful" })).toMatchObject({ reason: "mentions_stayful" });
  });

  it("⚠️ refuses a first sentence missing the audience or the category", () => {
    expect(ok({ message: "This is short let management and it is very good. More words here." }))
      .toMatchObject({ reason: "first_sentence_missing_audience" });
    expect(ok({ message: "Landlords comparing managers: we do a thing. More words here." }))
      .toMatchObject({ reason: "first_sentence_missing_category" });
  });

  it("⚠️ refuses any money at all — not one slot in part 1 is a money figure", () => {
    expect(ok({ message: "Landlords, short let management from £99 a month. And more." }))
      .toMatchObject({ reason: "figure_not_in_slots" });
  });

  it("refuses a trust number that is not theirs, and accepts the one that is", () => {
    expect(ok({ message: "Landlords, short let management. We look after 400 properties." }))
      .toMatchObject({ reason: "figure_not_in_slots" });
    expect(ok({ message: "Landlords, short let management. We look after 140 properties." }).ok)
      .toBe(true);
    expect(ok({ message: "Landlords, short let management. Eight years and 140 properties." }).ok)
      .toBe(true);
  });

  it("refuses an invented review score", () => {
    expect(ok({ message: "Landlords, short let management. We are 5.0 on Google." }))
      .toMatchObject({ reason: "figure_not_in_slots" });
    expect(ok({ message: "Landlords, short let management. We are 4.9 on Google." }).ok).toBe(true);
  });

  it("⚠️ leaves harmless bare numbers alone", () => {
    // "3am" and "24 hours" are the whole reason the bare-number rule is
    // scoped to three nouns rather than applied to every digit.
    expect(ok({ message: "Landlords, short let management. The 3am message, answered within 24 hours." }).ok)
      .toBe(true);
  });
});

describe("the fee", () => {
  const withFee = (profile: AdProfile) =>
    ok(
      { message: "Landlords, short let management. Our fee is 15% and that is all of it." },
      ctx({ profile, slots: { fee_pct: "15" } as SlotValues })
    );

  it("accepts the published fee with its VAT treatment", () => {
    expect(withFee({ fee_public: true, fee_vat: "exclusive" }).ok).toBe(true);
  });

  it("⚠️ refuses a fee the customer has not published", () => {
    expect(withFee({ fee_public: false, fee_vat: "exclusive" })).toMatchObject({ reason: "fee_not_published" });
  });

  it("⚠️ refuses a bare percentage with no VAT treatment recorded", () => {
    // "15%" is a different price with and without VAT, and the landlord
    // reading it cannot tell which.
    expect(withFee({ fee_public: true })).toMatchObject({ reason: "fee_without_vat_treatment" });
  });

  it("refuses a percentage that is not their fee", () => {
    const v = ok(
      { message: "Landlords, short let management. Our fee is 22% of the take." },
      ctx({ profile: { fee_public: true, fee_vat: "exclusive" }, slots: { fee_pct: "15" } as SlotValues })
    );
    expect(v).toMatchObject({ reason: "figure_not_in_slots" });
  });
});

describe("⚠️ only items they tick may appear", () => {
  const t3ctx = (included: string[]) =>
    ctx({ template: T3, profile: { included }, slots: { fee_public: undefined } as SlotValues });

  it("refuses a service they did not select", () => {
    const v = ok(
      { message: "Landlords and hosts, short let management. We handle the cleaning for you." },
      t3ctx(["linen"])
    );
    expect(v).toMatchObject({ reason: "service_not_selected", detail: "cleaning" });
  });

  it("accepts one they did", () => {
    expect(
      ok(
        { message: "Landlords and hosts, short let management. We handle the linen for you." },
        t3ctx(["linen"])
      ).ok
    ).toBe(true);
  });

  it("⚠️ a two-of-six T6 customer cannot have the other four named", () => {
    const v = ok(
      { message: "Landlords, short let management. We keep the registration up to date." },
      ctx({ template: T6, profile: { handled: ["licensing", "insurance"] } })
    );
    expect(v).toMatchObject({ reason: "service_not_selected", detail: "registration" });
  });
});

describe("⚠️ T8's testimonial", () => {
  it("refuses a quoted span with no confirmed quote", () => {
    const v = ok({
      message:
        'Landlords comparing managers, short let management. One said "best decision I ever made about the flat".',
    });
    expect(v).toMatchObject({ reason: "quote_without_provenance" });
  });

  it("refuses a dash-attributed first name", () => {
    const v = ok({ message: "Landlords, short let management. It just works now.\n— Sarah, Leicester" });
    expect(v).toMatchObject({ reason: "quote_without_provenance" });
  });

  it("allows both once the customer has confirmed the quote is real", () => {
    const v = ok(
      { message: 'Landlords comparing managers, short let management. One said "best decision I ever made".' },
      ctx({ profile: { review_quote_confirmed: true } })
    );
    expect(v.ok).toBe(true);
  });
});

describe("⚠️ T7 must never show an example estimate", () => {
  const t7 = ctx({ template: T7, profile: {} });
  it("refuses a worked example even hedged", () => {
    const v = ok(
      { message: "Landlords, short let management. For example around £2,400 a month." },
      t7
    );
    expect(["example_estimate", "figure_not_in_slots"]).toContain((v as { reason: string }).reason);
  });

  it("⚠️ but does NOT refuse T7's own headline for saying 'earn'", () => {
    // A keyword ban on earn|income|revenue rejects the template's own copy,
    // and the failure is silent: it retries once and comes back generic.
    const v = ok(
      {
        message:
          "Landlords, short let management: what would your property earn on short lets? " +
          "Send the postcode and we will work it out against what you get now.",
        headline: "What would your property earn?",
      },
      t7
    );
    expect(v.ok).toBe(true);
  });
});

describe("the heuristics, and what they must NOT reject", () => {
  it("catches an income promise", () => {
    expect(ok({ message: "Landlords, short let management. You will earn more every month." }))
      .toMatchObject({ reason: "income_claim" });
    expect(ok({ message: "Landlords, short let management. Double your rent with us." }))
      .toMatchObject({ reason: "income_claim" });
    expect(ok({ message: "Landlords, short let management. Guaranteed income, every month." }))
      .toMatchObject({ reason: "income_claim" });
  });

  it("catches an occupancy claim", () => {
    const v = ok({ message: "Landlords, short let management. Our places are booked 90% of the year." });
    expect(["occupancy_claim", "figure_not_in_slots"]).toContain((v as { reason: string }).reason);
    expect(ok({ message: "Landlords, short let management. Your flat is never empty with us." }))
      .toMatchObject({ reason: "occupancy_claim" });
  });

  it("catches a market superlative", () => {
    expect(ok({ message: "Landlords, short let management. We are the best short let managers around." }))
      .toMatchObject({ reason: "market_superlative" });
    expect(ok({ message: "Landlords, short let management. Most trusted in the city." }))
      .toMatchObject({ reason: "market_superlative" });
  });

  it("⚠️ does not fire on 'interest', 'request', 'honest' or 'invest'", () => {
    // The \\w+est\\b version of a superlative rule matches all four.
    expect(
      ok({
        message:
          "Landlords comparing managers, short let management. An honest request: if you have any " +
          "interest in what your invest property could do, ask us.",
      }).ok
    ).toBe(true);
  });

  it("⚠️ applies the legal lexicon to T6 ONLY", () => {
    const legal = "Landlords, short let management. We ensure the paperwork is right.";
    expect(ok({ message: legal }, ctx({ template: T6, profile: { handled: [] } })))
      .toMatchObject({ reason: "legal_assurance" });
    // "you must" is ordinary English everywhere else.
    expect(ok({ message: "Landlords, short let management. You must be tired of the messages." }).ok)
      .toBe(true);
  });

  it("catches T6's compliance guarantee, which a footer does not cure", () => {
    for (const bad of ["We guarantee compliance for you.", "Your property will be fully compliant.", "It is legally required."]) {
      const v = ok(
        { message: `Landlords, short let management. ${bad}` },
        ctx({ template: T6, profile: { handled: [] } })
      );
      expect(v).toMatchObject({ reason: "legal_assurance" });
    }
  });
});

/**
 * ⚠️ `located_without_targeting` WAS THE WORST RULE IN THIS FILE AND IS NO
 * LONGER HERE. It read NOTHING the model wrote — true or false before the first
 * call was made — so for a customer with a town and no lead filter it failed
 * BOTH paid attempts identically and guaranteed the canned text. `filter_status`
 * is `off` on most of the book, so anybody who answered a question about where
 * they work could reach it, and a rejection retries once and then collapses
 * silently.
 *
 * It was never a reason to refuse an ad either. Nothing here publishes: the
 * operator sets the audience in Meta. It is a warning now — `resolveSlots`
 * raises it and `context.test.ts` pins it.
 */
describe("⚠️ a town with no targeting is no longer a rejection", () => {
  it("writes the ad, and does not care about targeting at all", () => {
    expect(ok({}, ctx({ targeting: { kind: "unset" } })).ok).toBe(true);
    expect(ok({}, ctx({ targeting: { kind: "anywhere" } })).ok).toBe(true);
    const unlocated = ctx({ targeting: { kind: "unset" }, slots: { city: undefined } as SlotValues });
    expect(ok({}, unlocated).ok).toBe(true);
  });
});

describe("⚠️ the figure check runs over the IMAGE too", () => {
  it("catches a figure rendered onto the card that no slot supplied", () => {
    // T7's card is a form. "Current rent: £950/mo" put there to look concrete
    // is a figure, in the creative, from nobody — and it never passes through
    // the model, so no copy rule would ever see it.
    const allowed = allowedFigures(ctx({ template: T7, profile: {} }));
    expect(figuresAreSupplied("Postcode · Bedrooms · Current rent £950/mo", allowed).ok).toBe(false);
    expect(figuresAreSupplied("Postcode · Bedrooms · Current rent · Estimate", allowed).ok).toBe(true);
  });

  it("accepts T8's card, whose three numbers are all the customer's own", () => {
    const allowed = allowedFigures(ctx());
    expect(figuresAreSupplied("8 years 140 properties 4.9 on Google from 63 reviews", allowed).ok).toBe(true);
    expect(figuresAreSupplied("8 years 400 properties 4.9 on Google", allowed).ok).toBe(false);
  });

  it("reads through emphasis markers", () => {
    const allowed = allowedFigures(ctx());
    expect(figuresAreSupplied("*140* properties", allowed).ok).toBe(true);
    expect(stripEmphasis("*140* properties")).toBe("140 properties");
  });
});


// ---------------------------------------------------------------------------
// Five variants
// ---------------------------------------------------------------------------

const other = (n: number) =>
  `Landlords comparing managers: short let management, and here is angle ${n}. ` +
  `A different way in, a different detail, and nothing the others already said.`;

/** A full response over the template's real angle keys. */
function many(c: ValidationContext, texts: Array<Partial<typeof GOOD> & { angle_key?: string }>) {
  const keys = c.template.angleKeys.slice(0, texts.length);
  return validateAdCopy(
    {
      ...IMAGE,
      variants: texts.map((t, i) => ({
        angle_key: t.angle_key ?? keys[i],
        message: t.message ?? other(i),
        headline: t.headline ?? `Angle ${i}`,
        description: t.description ?? `Ask about angle ${i}`,
      })),
    },
    c,
    keys
  );
}

describe("⚠️ one bad variant loses one variant, not the ad", () => {
  it("keeps the good three when two break a rule", () => {
    const c = ctx();
    const v = many(c, [
      {},
      { message: "Landlords, short let management. We look after 400 properties." },
      {},
      { description: "Powered by Stayful" },
      {},
    ]);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.copy.variants).toHaveLength(3);
    expect(v.copy.provenance).toEqual({ written: 3, offered: 5, image: "model" });
    expect(v.rejected.map((r) => r.reason)).toEqual(["figure_not_in_slots", "mentions_stayful"]);
    // ⚠️ THE RETRY IS TOLD WHICH ANGLES IT LOST, so it never re-earns the rest.
    expect(v.rejected.map((r) => r.angleKey)).toEqual([c.template.angleKeys[1], c.template.angleKeys[3]]);
  });

  it("⚠️ zero survivors is not an ad", () => {
    const v = many(ctx(), [
      { description: "Powered by Stayful" },
      { message: "Landlords, short let management. Double your rent with us." },
    ]);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe("empty");
    expect(v.rejected).toHaveLength(2);
  });

  it("⚠️ four of four is complete, not degraded — T8 without a quote offers four", () => {
    const c = ctx();
    const keys = c.template.angleKeys.slice(0, 4);
    const v = validateAdCopy(
      { ...IMAGE, variants: keys.map((k, i) => ({ angle_key: k, message: other(i), headline: `H${i}`, description: `D${i}` })) },
      c,
      keys
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.copy.provenance.written).toBe(4);
    expect(v.copy.provenance.offered).toBe(4);
  });
});

describe("⚠️ the angle key is a closed list — it came from a model", () => {
  it("refuses a key nobody offered", () => {
    const v = many(ctx(), [{ angle_key: "totally_made_up" }]);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.rejected[0]).toMatchObject({ reason: "unknown_angle", angleKey: "totally_made_up" });
  });

  it("refuses a real key that was not offered THIS time", () => {
    const c = ctx();
    // The second key exists on the template but only the first was asked for.
    const v = validateAdCopy(
      { ...IMAGE, variants: [{ angle_key: c.template.angleKeys[1], ...GOOD }] },
      c,
      [c.template.angleKeys[0]]
    );
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.rejected[0].reason).toBe("unknown_angle");
  });

  it("refuses the same angle twice, keeping the first", () => {
    const c = ctx();
    const v = validateAdCopy(
      {
        ...IMAGE,
        variants: [
          { angle_key: c.template.angleKeys[0], ...GOOD },
          { angle_key: c.template.angleKeys[0], message: other(9), headline: "H", description: "D" },
        ],
      },
      c,
      [c.template.angleKeys[0]]
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.copy.variants).toHaveLength(1);
    expect(v.rejected[0].reason).toBe("duplicate_angle");
  });

  it("resolves the angle's prose name from the key, so the page can label it", () => {
    const v = ok();
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.copy.variants[0].angle).toBe(T8.angles[0]);
  });
});

describe("⚠️ five texts that say one thing are one text billed as five", () => {
  it("refuses a second variant whose message repeats the first", () => {
    const c = ctx();
    const v = many(c, [{}, { message: other(0) }]);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.copy.variants).toHaveLength(1);
    expect(v.rejected[0].reason).toBe("copy_repeats_itself");
  });

  it("refuses a headline identical to its own description", () => {
    expect(ok({ headline: "Talk to us", description: "Talk to us." }))
      .toMatchObject({ reason: "copy_repeats_itself" });
  });

  it("⚠️ but a headline echoing a phrase from its own text is good writing", () => {
    expect(ok({ headline: "Here is what we actually are", description: "Have a look" }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The image, which the model writes now
// ---------------------------------------------------------------------------

describe("⚠️ the image falls back, it never fails the response", () => {
  const example = { headline: "Landlords: the *spec's* line.", sub: "And the spec's sub." };

  const withImage = (image: Record<string, unknown>, c = ctx({ example })) =>
    validateAdCopy({ ...image, variants: [{ angle_key: key(c), ...GOOD }] }, c, [key(c)]);

  it("takes the model's lines when they are usable", () => {
    const v = withImage(IMAGE);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.copy.image.headline).toBe(IMAGE.image_headline);
    expect(v.copy.provenance.image).toBe("model");
  });

  it("falls back to the template's example rather than losing five good texts", () => {
    for (const bad of [
      {},
      { image_headline: "x", image_sub: "" },
      // ⚠️ `layout.ts` has NO lineClamp on either line, so a long headline
      // renders at the smallest step and runs off the card, silently.
      { image_headline: "x".repeat(AD_IMAGE_MAX.headline + 1), image_sub: "ok" },
      { image_headline: "ok", image_sub: "x".repeat(AD_IMAGE_MAX.sub + 1) },
      // ⚠️ An invented figure ON THE CARD is the one place a number could reach
      // a rendered PNG without passing a copy rule.
      { image_headline: "We look after 400 properties.", image_sub: "ok" },
      // ⚠️ `sanitiseForFont` DELETES an uncovered glyph and closes the gap, so
      // this would render as a missing word rather than as an error.
      { image_headline: "Landlords ✓ sorted", image_sub: "ok" },
    ]) {
      const v = withImage(bad);
      expect(v.ok, JSON.stringify(bad)).toBe(true);
      if (!v.ok) continue;
      expect(v.copy.image, JSON.stringify(bad)).toEqual({ headline: example.headline, sub: example.sub });
      expect(v.copy.provenance.image).toBe("example");
      // The variants are untouched by any of it.
      expect(v.copy.variants).toHaveLength(1);
    }
  });

  it("accepts the punctuation a model actually writes", () => {
    const v = withImage({
      image_headline: "Landlords — you’ll never see the *3am* message",
      // ⚠️ NO CURRENCY FIGURE. `allowedFigures().money` is empty in part 1, so
      // a pound amount on the card is `figure_not_in_slots` however it is
      // punctuated — which is the rule working, not the charset.
      image_sub: "“Full” short let management … cafés and all → sorted.",
    });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.copy.provenance.image).toBe("model");
  });
});

// ---------------------------------------------------------------------------
// ⚠️ The repairs: each rule gets a case that USED to be rejected and must now
// pass, and a case that must still be rejected. A loosened rule that stopped
// catching anything would be worse than the over-strict one it replaced.
// ---------------------------------------------------------------------------

describe("⚠️ the rules that were rejecting good English", () => {
  it("⚠️ a T8 opener stating the review score is not truncated at the decimal", () => {
    // `firstSentence` split on any ".", so "4.9" ended the sentence at "4." and
    // the category check then failed — USING THE FIGURE THE BRIEF INVITES WAS
    // AN AUTOMATIC REJECTION.
    expect(
      ok({
        message:
          "4.9 on Google from 63 reviews. Landlords comparing short let management: " +
          "here is what we are rather than what we promise.",
      }).ok
    ).toBe(true);
  });

  it("⚠️ a hook opener is allowed — the audience may arrive in sentence two", () => {
    expect(
      ok({
        message:
          "Your cleaner just cancelled, and it is Friday. Landlords doing short let " +
          "management themselves know the feeling.",
      }).ok
    ).toBe(true);
  });

  it("but still refuses both when they are absent from the whole preview", () => {
    expect(ok({ message: "We are quite good at what we do, and have been for a while. " + "x".repeat(200) }))
      .toMatchObject({ reason: "first_sentence_missing_audience" });
  });

  it("⚠️ an apostrophe no longer opens a fabricated quotation", () => {
    // `["“”'‘’]` as the OPENING class meant one apostrophe followed twelve
    // characters later by any double quote was a testimonial. Here the only
    // genuine quoted span is one short word, so the old rule matched on the
    // apostrophe in "That's" and the new one matches nothing at all.
    const line =
      'Landlords, short let management. That’s the whole point. We call it "management".';
    expect(/["“”'‘’]([^"“”]{12,})["“”]/.test(line)).toBe(true);
    expect(ok({ message: line }).ok).toBe(true);
  });

  it("but still refuses a real quoted span", () => {
    expect(
      ok({ message: 'Landlords, short let management. One said "best decision I made about the flat".' })
    ).toMatchObject({ reason: "quote_without_provenance" });
  });

  it("⚠️ an em dash mid-headline is punctuation, not an attribution", () => {
    expect(ok({ headline: "Short let management — Leeds" }).ok).toBe(true);
  });

  it("but still refuses a dash-attributed name on its own line", () => {
    expect(ok({ message: "Landlords, short let management. It works.\n— Sarah, Leicester" }))
      .toMatchObject({ reason: "quote_without_provenance" });
  });

  it("⚠️ 'you must' and 'we ensure' are ordinary English on T6 too", () => {
    const t6 = ctx({ template: T6, profile: { handled: [] } });
    for (const line of [
      "You must be tired of chasing it all yourself.",
      "We ensure the place is spotless before every guest.",
      "You must have better things to do on a Sunday.",
    ]) {
      expect(ok({ message: `Landlords, short let management. ${line}` }, t6).ok, line).toBe(true);
    }
  });

  it("but still refuses the compliance sentences the spec forbids", () => {
    const t6 = ctx({ template: T6, profile: { handled: [] } });
    for (const line of [
      "You must register with the council first.",
      "We ensure you are compliant.",
      "We ensure the paperwork is right.",
    ]) {
      expect(ok({ message: `Landlords, short let management. ${line}` }, t6), line)
        .toMatchObject({ reason: "legal_assurance" });
    }
  });

  it("⚠️ 'takes 24 hours' is a turnaround, not an income claim", () => {
    // T7's fourth angle is how long an answer takes, with the turnaround in
    // the brief — and `take (?:up to )?[\d,]+` matched it.
    expect(
      ok(
        // ⚠️ "take 24 hours", NOT "takes". The old rule was `take ` with a
        // literal space, so the inflected form never matched it and a test
        // using it could not tell the two rules apart — the mutation reverting
        // this regex survived on exactly that.
        { message: "Landlords, short let management. An answer can take 24 hours, usually less." },
        ctx({ template: T7, profile: {} })
      ).ok
    ).toBe(true);
  });

  it("⚠️ but 'you'll earn' is caught, which the old alternation could not match", () => {
    // `you(?:'| w)ill` wanted "you'ill" or "you will" — the commonest phrasing
    // of the claim walked straight past it.
    expect(ok({ message: "Landlords, short let management. You’ll earn far more this way." }))
      .toMatchObject({ reason: "income_claim" });
    expect(ok({ message: "Landlords, short let management. You'll make more than you do now." }))
      .toMatchObject({ reason: "income_claim" });
  });

  it("and a bare number with a period word is still an income claim", () => {
    expect(ok({ message: "Landlords, short let management. Earn 4000 a month on short lets." }))
      .toMatchObject({ reason: "income_claim" });
  });

  it("⚠️ 'what works best in Leeds' is not a market superlative", () => {
    expect(ok({ message: "Landlords, short let management. We know what works best in Leeds." }).ok)
      .toBe(true);
  });

  it("⚠️ nor is T3's own premise about being awake at 3am", () => {
    const t3 = ctx({ template: T3, profile: { included: [] } });
    expect(
      ok({ message: "Landlords and hosts, short let management. Nobody else is awake at 3am." }, t3).ok
    ).toBe(true);
  });

  it("but still refuses a ranking of the business", () => {
    expect(ok({ message: "Landlords, short let management. Nobody else comes close." }))
      .toMatchObject({ reason: "market_superlative" });
    expect(ok({ message: "Landlords, short let management. We are the best in the city." }))
      .toMatchObject({ reason: "market_superlative" });
  });

  it("⚠️ a licensed operator is not a licensing claim, and a cleaner is not cleaning", () => {
    // `lowered.includes("license")` rejected "a licensed operator", and
    // `includes("cleaning")` was reached by nothing — but the CLAIM scoping is
    // what lets T3's own second angle be written by a customer who has not
    // ticked cleaning.
    const t6 = ctx({ template: T6, profile: { handled: [] } });
    expect(ok({ message: "Landlords, short let management. A licensed operator, on your side." }, t6).ok)
      .toBe(true);
    const t3 = ctx({ template: T3, profile: { included: ["linen"] } });
    expect(
      ok(
        { message: "Landlords and hosts, short let management. The cleaner who cancels on a Friday? Not your problem." },
        t3
      ).ok
    ).toBe(true);
  });

  it("but still refuses a service CLAIMED without the tick", () => {
    const t3 = ctx({ template: T3, profile: { included: ["linen"] } });
    expect(ok({ message: "Landlords and hosts, short let management. We handle the cleaning." }, t3))
      .toMatchObject({ reason: "service_not_selected", detail: "cleaning" });
  });

  it("⚠️ the detail is the model's own words, never a truncated regex", () => {
    const v = ok({ message: "Landlords, short let management. Double your rent with us." });
    expect(v).toMatchObject({ reason: "income_claim" });
    expect((v as { detail: string }).detail).toContain("Double your rent");
    expect((v as { detail: string }).detail).not.toContain("?:");
    expect((v as { detail: string }).detail).not.toContain("\\b");
  });
});
