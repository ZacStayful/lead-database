import { describe, expect, it } from "vitest";
import type { Customer } from "@/lib/types";
import {
  adProfileOf,
  areasPhrase,
  citySuggestions,
  feePhrase,
  feeVerdict,
  fillPattern,
  resolveSlots,
  serviceListPhrase,
  targetingFor,
} from "../resolveSlots";
import { templateById } from "../templates";

const T3 = templateById("never-see-the-messages")!;
const T6 = templateById("rules-keep-changing")!;
const T8 = templateById("years-properties-review")!;

function customer(over: Record<string, unknown> = {}): Customer {
  return {
    id: "c1",
    business_name: "Adco Ltd",
    contact_name: "Zac",
    email: "zac@stayful.co.uk",
    referral_business_name: null,
    website_url: null,
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

describe("the override chain — never a copy", () => {
  it("prefers the ad profile, then the referral name, then the account", () => {
    expect(resolveSlots(customer(), T8).slots.company_name).toBe("Adco Ltd");
    expect(
      resolveSlots(customer({ referral_business_name: "Northside Lets" }), T8).slots.company_name
    ).toBe("Northside Lets");
    expect(
      resolveSlots(
        customer({ referral_business_name: "Northside Lets", ad_profile: { company_name: "Northside" } }),
        T8
      ).slots.company_name
    ).toBe("Northside");
  });

  it("falls through booking link then website for the landing url", () => {
    expect(resolveSlots(customer(), T8).slots.landing_url).toBeUndefined();
    expect(resolveSlots(customer({ website_url: "https://a.com" }), T8).slots.landing_url)
      .toBe("https://a.com");
    expect(
      resolveSlots(customer({ website_url: "https://a.com", messaging_booking_link: "https://cal.com/x" }), T8)
        .slots.landing_url
    ).toBe("https://cal.com/x");
  });

  it("treats a blank override as absent, not as an empty value", () => {
    expect(resolveSlots(customer({ ad_profile: { company_name: "   " } }), T8).slots.company_name)
      .toBe("Adco Ltd");
  });

  it("reads a malformed ad_profile as empty rather than throwing", () => {
    expect(adProfileOf({ ad_profile: null } as never)).toEqual({});
    expect(adProfileOf({ ad_profile: "nope" } as never)).toEqual({});
    expect(adProfileOf({ ad_profile: [1, 2] } as never)).toEqual({});
    expect(adProfileOf({ ad_profile: { city: "Leeds" } } as never)).toEqual({ city: "Leeds" });
  });
});

describe("⚠️ targeting has three states, not two", () => {
  it("reads set areas across BOTH filters", () => {
    expect(targetingFor(customer({ filter_status: "active", filter_areas: ["LS", "WF"] })))
      .toEqual({ kind: "areas", areas: ["LS", "WF"] });
    expect(
      targetingFor(customer({
        filter_status: "active", filter_areas: ["LS"],
        gr_filter_status: "active", gr_filter_areas: ["BD", "LS"],
      }))
    ).toEqual({ kind: "areas", areas: ["LS", "BD"] });
  });

  it("⚠️ an ACTIVE filter with EMPTY areas is 'anywhere' — the ask case", () => {
    // leadFilter.ts is explicit about this. Collapsing it into "unset" or into
    // "areas: []" silently targets an ad at nowhere.
    expect(targetingFor(customer({ filter_status: "active", filter_areas: [] })))
      .toEqual({ kind: "anywhere" });
  });

  it("no filter at all is unset", () => {
    expect(targetingFor(customer())).toEqual({ kind: "unset" });
  });

  it("counts pending_lift as on, as every routing predicate does", () => {
    expect(targetingFor(customer({ filter_status: "pending_lift", filter_areas: ["BS"] })))
      .toEqual({ kind: "areas", areas: ["BS"] });
  });

  it("⚠️ NEVER defaults a city from the business postcode", () => {
    const r = resolveSlots(customer({ filter_status: "active", filter_areas: ["LS"] }), T8);
    expect(r.slots.city).toBeUndefined();
    expect(r.unlocated).toBe(true);
  });
});

describe("⚠️ cityForArea() is not publishable copy", () => {
  it("offers a plain name as it stands", () => {
    expect(citySuggestions(["LS"])).toEqual(["Leeds"]);
    expect(citySuggestions(["BS", "BA"])).toEqual(["Bristol", "Bath"]);
  });

  it("⚠️ turns 'London (East)' into 'London', which is what a reader would say", () => {
    expect(citySuggestions(["E"])).toEqual(["London"]);
    expect(citySuggestions(["E", "N", "SW"])).toEqual(["London"]);
  });

  it("⚠️ offers NOTHING for 'Chester/Wirral' — half the audience would be told it is not for them", () => {
    expect(citySuggestions(["CH"])).toEqual([]);
    expect(citySuggestions(["LA"])).toEqual([]);
    expect(citySuggestions(["CH", "LS"])).toEqual(["Leeds"]);
  });

  it("ignores an area it has never heard of", () => {
    expect(citySuggestions(["ZZ", "QQ"])).toEqual([]);
  });
});

describe("the fee", () => {
  it("accepts anything in the usual band", () => {
    expect(feeVerdict(15, { fresh: true })).toEqual({ ok: true, warn: null });
    expect(feeVerdict(8, { fresh: true })).toEqual({ ok: true, warn: null });
    expect(feeVerdict(30, { fresh: true })).toEqual({ ok: true, warn: null });
  });

  it("⚠️ REFUSES an odd value typed today — 'a wrong fee in a live ad is worse than no ad'", () => {
    expect(feeVerdict(3, { fresh: true }).ok).toBe(false);
    expect(feeVerdict(45, { fresh: true }).ok).toBe(false);
  });

  it("⚠️ only WARNS on the same value inherited from their deck", () => {
    // They have been presenting from that number for months. Blocking the ad
    // on it helps nobody.
    expect(feeVerdict(3, { fresh: false })).toEqual({ ok: true, warn: "fee_outside_usual_range" });
    expect(feeVerdict(45, { fresh: false })).toEqual({ ok: true, warn: "fee_outside_usual_range" });
  });

  it("refuses nonsense either way, and passes an absent fee", () => {
    expect(feeVerdict(0, { fresh: false }).ok).toBe(false);
    expect(feeVerdict(120, { fresh: false }).ok).toBe(false);
    expect(feeVerdict(Number.NaN, { fresh: false }).ok).toBe(false);
    expect(feeVerdict(null, { fresh: true })).toEqual({ ok: true, warn: null });
  });

  it("⚠️ states the fee with its basis and its VAT treatment, never bare", () => {
    expect(feePhrase({ fee_public: true, fee_pct: 15, fee_basis: "gross", fee_vat: "exclusive" }))
      .toBe("15% of gross, plus VAT");
    expect(feePhrase({ fee_public: true, fee_pct: 12, fee_basis: "net", fee_vat: "inclusive" }))
      .toBe("12% of net, including VAT");
  });

  it("⚠️ says nothing at all when the fee is not published", () => {
    expect(feePhrase({ fee_public: false, fee_pct: 15 })).toBeNull();
    expect(feePhrase({ fee_pct: 15 })).toBeNull();
    expect(feePhrase({ fee_public: true })).toBeNull();
  });

  it("inherits the deck's fee and only warns when it is odd", () => {
    const r = resolveSlots(customer({ presentation_settings: { fee: { pct: 3, basis: "net" } } }), T3);
    expect(r.slots.fee_pct).toBe("3");
    expect(r.warnings).toContain("fee_outside_usual_range");
  });
});

describe("⚠️ the sub's service list is built from the multi-select", () => {
  it("names only what they ticked", () => {
    expect(serviceListPhrase(T3, ["cleaning", "linen"])).toBe("Cleaning and linen");
    expect(serviceListPhrase(T3, ["guest_messaging"])).toBe("Guest messaging");
    expect(serviceListPhrase(T6, ["licensing", "insurance", "guest_id"]))
      .toBe("Licensing, insurance and guest records");
  });

  it("⚠️ returns NOTHING when they have ticked nothing — the sub cannot render", () => {
    expect(serviceListPhrase(T3, [])).toBeNull();
    expect(serviceListPhrase(T8, ["anything"])).toBeNull();
  });

  it("⚠️ so a two-of-six customer's sub never claims the other four", () => {
    const c = customer({ ad_profile: { included: ["cleaning", "linen"] } });
    const filled = fillPattern(T3.exampleSubLocated, resolveSlots(c, T3).slots);
    expect(filled).toBe("Full short let management. Cleaning and linen, all handled by Adco Ltd.");
    expect(filled).not.toContain("pricing");
    expect(filled).not.toContain("check-in");
  });
});

describe("filling a pattern", () => {
  it("⚠️ returns null rather than a half-filled line", () => {
    // "Landlords in : 8 years" on a live ad is the failure this prevents.
    expect(fillPattern("Landlords in {city}: hello", {})).toBeNull();
    expect(fillPattern("Landlords in {city}: hello", { city: "Leeds" }))
      .toBe("Landlords in Leeds: hello");
  });

  it("leaves emphasis markers alone", () => {
    expect(fillPattern("rules, *handled*. {company_name}", { company_name: "Adco" }))
      .toBe("rules, *handled*. Adco");
  });

  it("fills T8's located headline once every figure is present", () => {
    const c = customer({
      ad_profile: { city: "Leeds", years_trading: 8, properties_managed: 140, review_score: 4.9, review_count: 63 },
    });
    const { slots, unlocated } = resolveSlots(c, T8);
    expect(unlocated).toBe(false);
    expect(fillPattern(T8.exampleHeadlineLocated, slots))
      .toBe("Short let management in Leeds: 8 years, 140 properties, *4.9* on Google.");
  });

  it("⚠️ falls to the unlocated sub when they declined to narrow", () => {
    const c = customer({ ad_profile: { years_trading: 8 } });
    const { slots } = resolveSlots(c, T8);
    expect(fillPattern(T8.exampleSubLocated, slots)).toBeNull();
    expect(fillPattern(T8.exampleSubUnlocated, slots))
      .toBe("Managing short lets for landlords who would rather not.");
  });
});

describe("what the chat still has to ask", () => {
  it("reports the declared slots that are unknown", () => {
    const missing = resolveSlots(customer(), T8).missing;
    expect(missing).toContain("years_trading");
    expect(missing).toContain("properties_managed");
    expect(missing).toContain("review_score");
    expect(missing).not.toContain("company_name");
  });

  it("⚠️ never asks for a derived list slot — nobody can answer 'included_list'", () => {
    const missing = resolveSlots(customer(), T3).missing;
    expect(missing).not.toContain("included_list");
    expect(missing).toContain("included");
  });

  it("⚠️ shrinks as the profile fills — this is what makes a second ad shorter", () => {
    const empty = resolveSlots(customer(), T8).missing.length;
    const filled = resolveSlots(
      customer({
        ad_profile: {
          years_trading: 8, properties_managed: 140, review_score: 4.9,
          review_count: 63, areas: "LS and BD", landing_url: "https://a.com",
        },
      }),
      T8
    ).missing;
    expect(filled.length).toBeLessThan(empty);
    expect(filled).toEqual([]);
  });

  it("asks for the fee treatment only when the fee is published", () => {
    expect(resolveSlots(customer({ ad_profile: { fee_public: false } }), T3).missing)
      .not.toContain("fee_vat");
    expect(resolveSlots(customer({ ad_profile: { fee_public: true, fee_pct: 15 } }), T3).missing)
      .toContain("fee_vat");
  });
});

describe("areasPhrase", () => {
  it("reads as a list a person would say", () => {
    expect(areasPhrase(["LS"])).toBe("LS");
    expect(areasPhrase(["LS", "WF"])).toBe("LS and WF");
    expect(areasPhrase(["LS", "WF", "BD"])).toBe("LS, WF and BD");
    expect(areasPhrase([])).toBeNull();
  });
});
