import { describe, expect, it } from "vitest";
import type { Customer } from "@/lib/types";
import { adBrief, figureList } from "../brief";
import { resolveSlots } from "../resolveSlots";
import { templateById } from "../templates";
import { allowedFigures } from "../validateAdCopy";

const T3 = templateById("never-see-the-messages")!;
const T6 = templateById("rules-keep-changing")!;
const T7 = templateById("what-would-it-earn")!;
const T8 = templateById("years-properties-review")!;

function customer(over: Record<string, unknown> = {}): Customer {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    business_name: "Adco Ltd",
    contact_name: "Zac",
    email: "secret-login@example.com",
    phone: "+447700900123",
    stripe_customer_id: "cus_SECRET",
    referral_business_name: null,
    website_url: "https://adco.example",
    messaging_booking_link: null,
    presentation_settings: null,
    presentation_brand: null,
    ad_profile: {},
    filter_status: "off",
    gr_filter_status: "off",
    filter_areas: null,
    gr_filter_areas: null,
    ...over,
  } as unknown as Customer;
}

const brief = (c: Customer, t = T8) => adBrief(c, t, resolveSlots(c, t));

/**
 * ⚠️ THE MODEL IS BEING TOLD ABOUT A BUSINESS, NOT ABOUT AN ACCOUNT. §30.5
 * records that this codebase sends real contact details to a provider in
 * exactly one place and treats that as a decision rather than a habit; this is
 * not that place, and the brief carries nothing that identifies the row.
 */
describe("what never leaves the building", () => {
  it("carries no email, phone, Stripe id or row id", () => {
    const text = brief(customer());
    expect(text).not.toContain("secret-login@example.com");
    expect(text).not.toContain("447700900123");
    expect(text).not.toContain("cus_SECRET");
    expect(text).not.toContain("11111111-2222-3333-4444-555555555555");
  });
});

/**
 * ⚠️ ABSENCE IS STATED, NEVER OMITTED. A missing figure that is simply not in
 * the brief reads to a model as one it was not told about rather than one it
 * may not use — and the difference is an invented number on a live advert.
 */
describe("gaps say they are gaps", () => {
  it("names every missing figure and what it costs", () => {
    const text = brief(customer());
    expect(text).toContain("Years trading: not on file");
    expect(text).toContain("Do not state a number of years");
    expect(text).toContain("Properties managed: not on file");
    expect(text).toContain("Do not state a number of properties");
    expect(text).toContain("Google reviews: not on file");
  });

  it("says when there is no trading name", () => {
    const text = brief(customer({ business_name: null, website_url: null }));
    expect(text).toContain("not on file — ask what name");
  });

  /**
   * ⚠️ THREE CASES, NOT TWO, AND THE TEST USED TO PIN THE WRONG ONE. It asserted
   * "No landing page on file" for everybody without a link — which is what the
   * brief said, and it is what told the model to chase a page from an operator
   * who wanted a Facebook lead form. That is how the question the whole feature
   * broke on came to be reworded in the first place.
   */
  it("asks which destination when nobody has chosen one", () => {
    const text = brief(customer({ business_name: null, website_url: null }));
    expect(text).toContain("Nobody has chosen where the button goes");
    expect(text).toContain("those two and no others");
    expect(text).not.toContain("no landing page on file");
  });

  it("asks for the page only once they have chosen their own website", () => {
    const text = brief(customer({ website_url: null, ad_profile: { destination: "website" } }));
    expect(text).toContain("there is no page on file");
  });

  /** ⚠️ AND NEVER ASKS FOR ONE ON AN INSTANT FORM AD. */
  it("tells the model an Instant Form ad needs no page at all", () => {
    const text = brief(
      customer({ website_url: null, ad_profile: { destination: "instant_form" } })
    );
    expect(text).toContain("lead form inside Facebook");
    expect(text).toContain("They need no landing page");
    expect(text.toLowerCase()).not.toContain("ask for it");
  });

  it("says they have one when they do", () => {
    expect(brief(customer())).toContain("They have a page for the button to point at.");
  });
});

describe("where they want work", () => {
  it("offers honest city options from the areas they already chose", () => {
    const text = brief(customer({ filter_status: "active", filter_areas: ["LS", "BD"] }));
    expect(text).toContain("LS and BD");
    expect(text).toMatch(/Leeds/);
    expect(text).toContain("runs without a place name");
  });

  /**
   * ⚠️ THREE STATES, NOT TWO. An active filter with an empty area list means
   * "anywhere", which is the ask case rather than the have-areas case —
   * reading it as two states silently targets an advert at nowhere.
   */
  it("refuses a place name when they said anywhere", () => {
    const text = brief(customer({ filter_status: "active", filter_areas: [] }));
    expect(text).toContain("take work anywhere");
    expect(text).toContain("may NOT name a town");
  });

  it("refuses a place name when they have said nothing", () => {
    expect(brief(customer())).toContain("may NOT name a town");
  });

  it("says the located headline is in play once a city is chosen", () => {
    const text = brief(
      customer({ filter_status: "active", filter_areas: ["LS"], ad_profile: { city: "Leeds" } })
    );
    expect(text).toContain("names **Leeds**");
  });

  /**
   * ⚠️ `cityForArea()` IS NOT PUBLISHABLE COPY — CH is "Chester/Wirral", and
   * an advert reading "Landlords in Chester/Wirral" is a mail-merge in public.
   */
  it("offers nothing rather than half of a two-town area", () => {
    const text = brief(customer({ filter_status: "active", filter_areas: ["CH"] }));
    expect(text).not.toContain("Chester/Wirral");
    expect(text).toContain("do not map to one town");
  });
});

describe("the fee", () => {
  it("is refused outright when they have not agreed to publish it", () => {
    const text = brief(customer({ ad_profile: { fee_pct: 15, fee_basis: "gross", fee_vat: "exclusive" } }));
    expect(text).toContain("not to be published");
    expect(text).not.toContain("15%");
  });

  it("is given exactly once when they have", () => {
    const text = brief(
      customer({ ad_profile: { fee_public: true, fee_pct: 15, fee_basis: "gross", fee_vat: "exclusive" } })
    );
    expect(text).toContain("15% of gross, plus VAT");
  });

  it("is withheld when they agreed but we do not have the number", () => {
    const text = brief(customer({ ad_profile: { fee_public: true } }));
    expect(text).toContain("do not have the number");
  });
});

describe("the services", () => {
  it("names what they do and, explicitly, what they do not", () => {
    const text = brief(customer({ ad_profile: { included: ["cleaning", "linen"] } }), T3);
    expect(text).toContain("They do: cleaning, linen");
    expect(text).toMatch(/do NOT do[^\n]*guest messaging/);
    expect(text).toMatch(/do NOT do[^\n]*check-ins/);
  });

  it("forbids the lot when they have ticked nothing", () => {
    const text = brief(customer(), T6);
    expect(text).toContain("ticked NONE");
    expect(text).toContain("licensing");
  });

  it("says nothing about services on a template that has none", () => {
    expect(brief(customer(), T7)).not.toContain("What they actually do");
  });
});

/** The spec: "the review score always renders with its count". */
describe("the review pair", () => {
  it("offers both together", () => {
    const text = brief(customer({ ad_profile: { review_score: 4.9, review_count: 212 } }));
    expect(text).toContain("4.9 from 212 reviews");
    expect(text).toContain("State both or neither");
  });

  /**
   * ⚠️ THIS ASSERTION WAS WRITTEN WEAK AND THE MUTATION RUN IS WHAT FOUND IT.
   * It matched a bare "must not appear", which the FEE block also says for
   * every customer who has not published one — so dropping the count check
   * left it green while the brief offered "4.9 from undefined reviews". The
   * seventh time this repo has recorded that shape (§50.9, §53, §55, §57).
   * Anchored on the review sentence, and on the pair never forming.
   */
  it("refuses a score with no count", () => {
    const text = brief(customer({ ad_profile: { review_score: 4.9 } }));
    expect(text).toContain("A score without its count must not appear");
    expect(text).not.toMatch(/4\.9 from/);
  });
});

describe("the quote", () => {
  it("is withheld, loudly, until it is confirmed", () => {
    const text = brief(customer({ ad_profile: { review_quote: "Best decision I made." } }));
    expect(text).not.toContain("Best decision I made.");
    expect(text).toContain("No confirmed review to quote");
  });

  it("is offered once it is", () => {
    const text = brief(
      customer({
        ad_profile: {
          review_quote: "Best decision I made.",
          review_quote_source: "Google, March 2026",
          review_quote_confirmed: true,
        },
      })
    );
    expect(text).toContain("Best decision I made.");
    expect(text).toContain("Google, March 2026");
  });
});

describe("the missing list", () => {
  /**
   * ⚠️ THIS IS WHAT MAKES "a second advert asks fewer questions" REAL rather
   * than a claim in a plan.
   */
  it("shrinks as the profile fills", () => {
    const bare = brief(customer());
    const full = brief(
      customer({
        ad_profile: {
          company_name: "Adco",
          landing_url: "https://adco.example/quote",
          areas: "Leeds and Bradford",
          years_trading: 8,
          properties_managed: 140,
          review_score: 4.9,
          review_count: 212,
        },
      })
    );
    const count = (s: string) => (s.match(/^- \w+/gm) ?? []).length;
    expect(count(full)).toBeLessThan(count(bare));
    expect(full).toContain("Nothing. Ask about the advert itself");
  });
});

/**
 * ⚠️ OMISSION AND REJECTION MUST AGREE. This is the omission layer and
 * `allowedFigures` is the rejection layer; a figure offered here and refused
 * there produces an advert that comes back generic with no error anybody sees.
 */
describe("the figure list agrees with the validator", () => {
  const ctxFor = (c: Customer, t = T8) => {
    const r = resolveSlots(c, t);
    return {
      template: t,
      slots: r.slots,
      profile: (c as unknown as { ad_profile: Record<string, unknown> }).ad_profile,
      targeting: r.targeting,
      fixed: { headline: "", sub: "" },
    };
  };

  it("offers nothing when the validator allows nothing", () => {
    const c = customer();
    expect(figureList(c, resolveSlots(c, T8))).toEqual([]);
    const allowed = allowedFigures(ctxFor(c));
    expect(allowed.percent).toEqual([]);
    expect(Object.values(allowed.trust).every((v) => v === null)).toBe(true);
  });

  it("offers the fee exactly when the validator would accept it", () => {
    const off = customer({ ad_profile: { fee_pct: 15, fee_basis: "gross", fee_vat: "exclusive" } });
    expect(figureList(off, resolveSlots(off, T8)).join(" ")).not.toContain("15");
    expect(allowedFigures(ctxFor(off)).percent).toEqual([]);

    const on = customer({
      ad_profile: { fee_public: true, fee_pct: 15, fee_basis: "gross", fee_vat: "exclusive" },
    });
    expect(figureList(on, resolveSlots(on, T8)).join(" ")).toContain("15% of gross, plus VAT");
    expect(allowedFigures(ctxFor(on)).percent).toEqual([15]);
  });

  it("offers the trust numbers exactly when the validator would accept them", () => {
    const c = customer({
      ad_profile: { years_trading: 8, properties_managed: 140, review_score: 4.9, review_count: 212 },
    });
    const list = figureList(c, resolveSlots(c, T8)).join(" ");
    const allowed = allowedFigures(ctxFor(c));
    expect(list).toContain("8 years");
    expect(list).toContain("140 properties");
    expect(list).toContain("4.9 from 212");
    expect(allowed.trust).toMatchObject({ years: 8, properties: 140, score: 4.9, reviews: 212 });
  });

  it("refuses to offer half a review pair", () => {
    const c = customer({ ad_profile: { review_score: 4.9 } });
    expect(figureList(c, resolveSlots(c, T8)).join(" ")).not.toContain("4.9");
  });
});
