import { describe, expect, it } from "vitest";
import type { Customer } from "@/lib/types";
import { adAccentFor, adContext } from "../context";
import { STAYFUL_ACCENT } from "@/lib/presentationBrand";
import { templateById } from "../templates";

const T3 = templateById("never-see-the-messages")!;
const T7 = templateById("what-would-it-earn")!;
const T8 = templateById("years-properties-review")!;

function customer(over: Record<string, unknown> = {}): Customer {
  return {
    id: "c1",
    business_name: "Adco Ltd",
    contact_name: "Zac",
    email: "z@x.com",
    website_url: "https://adco.example",
    referral_business_name: null,
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

/**
 * ⚠️ A TEMPLATE WHOSE HEADLINE CANNOT BE FILLED CANNOT RENDER. Returning the
 * half-filled string would put "Landlords in : 8 years" on a live advert, so
 * the route refuses and the chat asks — which only works if the context says
 * WHICH slots are missing.
 */
describe("what is still unresolved", () => {
  it("names the slots T8's headline needs and has not got", () => {
    const { unresolved } = adContext(customer(), T8);
    expect(unresolved).toContain("years_trading");
    expect(unresolved).toContain("properties_managed");
    expect(unresolved).toContain("review_score");
  });

  it("clears once they are supplied", () => {
    const c = customer({
      ad_profile: {
        years_trading: 8,
        properties_managed: 140,
        review_score: 4.9,
        review_count: 212,
        landing_url: "https://adco.example/q",
      },
    });
    expect(adContext(c, T8).unresolved).toEqual([]);
  });

  /** The button has to point somewhere, whatever the headline needs. */
  it("always names a missing landing page", () => {
    expect(adContext(customer({ website_url: null }), T7).unresolved).toContain("landing_url");
  });

  it("is empty for a template whose patterns need nothing extra", () => {
    expect(adContext(customer(), T7).unresolved).toEqual([]);
  });
});

describe("the fixed headline and sub", () => {
  it("uses the unlocated form when no town is set", () => {
    const { ctx } = adContext(customer(), T7);
    expect(ctx.fixed.headline).toBe(T7.headlineUnlocated);
    expect(ctx.fixed.headline).not.toContain("{");
  });

  it("uses the located form once one is", () => {
    const c = customer({ filter_status: "active", filter_areas: ["LS"], ad_profile: { city: "Leeds" } });
    expect(adContext(c, T7).ctx.fixed.headline).toContain("Leeds");
  });

  /**
   * ⚠️ THE SUB IS BUILT FROM THE MULTI-SELECT, NEVER FIXED. The spec's own sub
   * hardcodes five services while `included` is a multi-select, so a fixed
   * string publishes services the customer does not provide.
   */
  it("names only the services they ticked", () => {
    const c = customer({ ad_profile: { included: ["cleaning", "linen"] } });
    const { ctx } = adContext(c, T3);
    expect(ctx.fixed.sub).toContain("Cleaning and linen");
    expect(ctx.fixed.sub).not.toContain("pricing");
    expect(ctx.fixed.sub).not.toContain("check-in");
  });

  it("leaves T3 unrenderable while nothing is ticked, rather than inventing a list", () => {
    expect(adContext(customer(), T3).unresolved).toContain("included_list");
  });
});

/**
 * ⚠️ NEVER DEFAULTS TO STAYFUL GREEN. `derivePalette` falls back to
 * STAYFUL_ACCENT, which would put OUR colour on a customer's advert in their
 * own name — and they would have no way of knowing whose it was.
 */
describe("the accent", () => {
  it("is the operator's own when they have set one", () => {
    const c = customer({ presentation_brand: { accent: "#1d3f8f" } });
    expect(adAccentFor(c, T8)).toBe("#1d3f8f");
  });

  it.each([
    ["nothing set", {}],
    ["a blob with no accent", { logo: null }],
    ["a junk accent", { accent: "rebeccapurple" }],
    ["a short accent", { accent: "#fff" }],
  ])("is never Stayful green with %s", (_label, brand) => {
    for (const t of [T3, T7, T8]) {
      expect(adAccentFor(customer({ presentation_brand: brand }), t)).not.toBe(STAYFUL_ACCENT);
    }
  });

  it("is a real hex whatever happens, because satori has no cascade", () => {
    for (const t of [T3, T7, T8]) {
      expect(adAccentFor(customer(), t)).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe("what the routes share", () => {
  /**
   * The copy is validated against the fixed headline that the image then
   * draws. Two readings would eventually produce an advert whose words were
   * checked against a headline it is not carrying.
   */
  it("gives the same fixed copy to every caller", () => {
    const c = customer({ ad_profile: { city: "Leeds" }, filter_status: "active", filter_areas: ["LS"] });
    expect(adContext(c, T7).ctx.fixed).toEqual(adContext(c, T7).ctx.fixed);
  });

  it("carries the brief and the figures the model is allowed", () => {
    const c = customer({ ad_profile: { years_trading: 8 } });
    const ctx = adContext(c, T8);
    expect(ctx.brief).toContain("Years trading: 8");
    expect(ctx.figures.join(" ")).toContain("8 years");
  });

  it("resolves the CTA, because T8's names the company", () => {
    expect(adContext(customer(), T8).cta).toBe("Talk to Adco Ltd");
  });
});
