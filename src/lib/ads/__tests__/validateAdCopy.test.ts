import { describe, expect, it } from "vitest";
import {
  allowedFigures,
  figuresAreSupplied,
  validateAdCopy,
  type ValidationContext,
} from "../validateAdCopy";
import { AD_TEMPLATES, templateById } from "../templates";
import { AD_COPY_MAX, META_TRUNCATION_MARKS } from "../metaFields";
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
    fixed: over.fixed ?? { headline: "x", sub: "y" },
  };
}

const GOOD = {
  message:
    "Landlords comparing managers: this is short let management, and here is what we actually are. " +
    "We have been doing it a while, we look after a good number of places, and people say so publicly.",
  headline: "Years, properties, reviews",
  description: "Talk to us",
};
const ok = (over: Partial<typeof GOOD> = {}, c = ctx()) => validateAdCopy({ ...GOOD, ...over }, c);

describe("the shape", () => {
  it("accepts a clean generation and returns Meta's five fields", () => {
    const v = ok();
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.copy).toEqual({
      ...GOOD,
      call_to_action_type: "CONTACT_US",
      link_url: "https://northside.example",
    });
  });

  it("refuses a missing field rather than publishing a blank one", () => {
    for (const k of ["message", "headline", "description"] as const) {
      const v = ok({ [k]: "  " });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toBe("missing_field");
    }
    expect(validateAdCopy(null, ctx())).toMatchObject({ reason: "empty" });
    expect(validateAdCopy("a string", ctx())).toMatchObject({ reason: "empty" });
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

describe("⚠️ a located headline needs targeting behind it", () => {
  it("refuses a city with no targeting set", () => {
    expect(ok({}, ctx({ targeting: { kind: "unset" } }))).toMatchObject({ reason: "located_without_targeting" });
  });

  it("allows an unlocated ad with no targeting", () => {
    const v = ok({}, ctx({ targeting: { kind: "unset" }, slots: { city: undefined } as SlotValues }));
    expect(v.ok).toBe(true);
  });

  it("allows a city against 'anywhere' — they set a filter and chose a city", () => {
    expect(ok({}, ctx({ targeting: { kind: "anywhere" } })).ok).toBe(true);
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

describe("⚠️ our own fallback copy must survive our own rules", () => {
  it("every template's default passes the validator it will be published under", () => {
    // This is the one that matters. The default is what we publish when the
    // model has been rejected twice — a rule that rejects it would leave no
    // ad at all, and nothing anywhere would say why.
    for (const t of AD_TEMPLATES) {
      const v = validateAdCopy(
        {
          message: t.defaultPrimaryText,
          headline: t.defaultHeadline,
          description: t.defaultDescription,
        },
        ctx({ template: t, profile: {}, slots: { city: undefined } as SlotValues, targeting: { kind: "unset" } })
      );
      expect(v.ok, `${t.id}: ${(v as { reason?: string }).reason} ${(v as { detail?: string }).detail}`).toBe(true);
    }
  });
});
