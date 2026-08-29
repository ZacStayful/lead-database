/**
 * The closed catalogue, the real address shapes, and the reach arithmetic.
 *
 * ⚠️ THE FIRST BLOCK IS A SECURITY TEST, NOT A TIDINESS ONE. Nothing here may
 * take a column name from the browser and read it — the §27.1 rule that has
 * held the API surface. Without it, `{{lead_profile}}` pastes the UPLOADING
 * operator's private working notes into a WhatsApp to the landlord on a resold
 * imported lead (§32.8), and `{{lead_quality_override_note}}` pastes an admin's
 * private note about the lead's contact details.
 *
 * The address cases are the six real shapes from the live book, because
 * extractCity() looked fine until it was tried on them.
 */
import { describe, it, expect } from "vitest";
import {
  MERGE_FIELDS,
  cleanAddress,
  cleanBedrooms,
  fieldCoverage,
  fieldsForProduct,
  fieldsUsed,
  renderTemplate,
  validateTemplate,
} from "../mergeFields";

const CUSTOMER = {
  business_name: "Northside Lets",
  contact_name: "Zoe",
  messaging_booking_link: "https://cal.com/zoe",
};

/** Analysed — 39% of the live book. */
const FULL = {
  lead_name: "Priya Nair",
  address: "212 Gill Avenue, Bristol BS16 2PH",
  bedrooms: "4 bedrooms",
  gross_annual_income: 36112,
  avg_nightly_rate: 157,
  occupancy_rate: 63,
};

/** The other 61%: a name, an address, a bedroom count and nothing else. */
const BARE = {
  lead_name: "Sam Doyle",
  address: "17 Sefton drive L8 3SD",
  bedrooms: "1 Bed",
  gross_annual_income: null,
  avg_nightly_rate: null,
  occupancy_rate: null,
};

describe("the catalogue is closed", () => {
  it("offers exactly these fields and no others", () => {
    // Asserted against a literal rather than derived from the source: a test
    // that read MERGE_FIELDS to build its expectation would pass whatever was
    // added to it (§27.2).
    expect(MERGE_FIELDS.map((f) => f.key).sort()).toEqual([
      "address",
      "bedrooms",
      "booking_link",
      "first_name",
      "income",
      "my_company",
      "my_name",
      "nightly_rate",
      "occupancy",
    ]);
  });

  it("REFUSES the fields that would leak another operator or an admin", () => {
    for (const key of [
      "lead_profile",
      "lead_quality_override_note",
      "lead_quality_override_by",
      "owner_customer_id",
      "email",
      "phone",
      "net_income",
      "town",
      "management_fee",
    ]) {
      const v = validateTemplate(`Hi {{${key}}}`, { hasBookingLink: true });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.error).toContain(key);
    }
  });

  it("refuses an unknown field rather than rendering it empty", () => {
    expect(validateTemplate("Hi {{nope}}", { hasBookingLink: true }).ok).toBe(false);
  });

  it("reads a field with inner spaces", () => {
    expect(fieldsUsed("Hi {{ first_name }}")).toEqual(["first_name"]);
  });

  it("deduplicates a field used twice", () => {
    expect(fieldsUsed("{{first_name}} — {{first_name}}")).toEqual(["first_name"]);
  });
});

describe("cleanAddress, on the real shapes from the live book", () => {
  const cases: [string, string | null][] = [
    ["212 Gill Avenue, Bristol BS16 2PH", "212 Gill Avenue, Bristol"],
    ["17 Sefton drive L8 3SD", "17 Sefton drive"],
    ["59 Trueman Place, Oldbrook, Milton Keynes MK6 2QU", "59 Trueman Place, Oldbrook, Milton Keynes"],
    ["2 Margaret street Bn21ts", "2 Margaret street"],
    ["Flat 2 The Old Post Office, 786 Fishponds Road BS16 3TT", "Flat 2 The Old Post Office, 786 Fishponds Road"],
    ["1 Wheelwrights Cottage, Staplecross TN32 5QG", "1 Wheelwrights Cottage, Staplecross"],
    // Only the TRAILING postcode goes; this address genuinely carries two.
    ["9 midland road, carlton, ng2 4ha NG13 9FE", "9 midland road, carlton, ng2 4ha"],
  ];

  for (const [raw, expected] of cases) {
    it(`"${raw}" -> "${expected}"`, () => {
      expect(cleanAddress(raw)).toBe(expected);
    });
  }

  it("returns null rather than a stub when nothing survives", () => {
    // A value that is only a postcode leaves an empty gap mid-sentence.
    expect(cleanAddress("BS16 2PH")).toBeNull();
    expect(cleanAddress("   ")).toBeNull();
    expect(cleanAddress(null)).toBeNull();
  });
});

describe("cleanBedrooms, on the real inconsistency", () => {
  it("tidies every shape the column actually holds", () => {
    expect(cleanBedrooms("4+ bed")).toBe("4+ bed");
    expect(cleanBedrooms("1 Bed")).toBe("1-bed");
    expect(cleanBedrooms("2 bedrooms")).toBe("2-bed");
    expect(cleanBedrooms("3 Bed")).toBe("3-bed");
    expect(cleanBedrooms("studio")).toBe("studio");
  });

  it("returns null rather than passing prose through", () => {
    expect(cleanBedrooms("ask the landlord")).toBeNull();
    expect(cleanBedrooms("")).toBeNull();
  });
});

describe("renderTemplate", () => {
  it("fills a template in for an analysed lead", () => {
    const r = renderTemplate(
      "Hi {{first_name}}, {{address}} could bring in {{income}} a year at {{occupancy}}. Worth a chat?",
      { lead: FULL, customer: CUSTOMER }
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toBe(
        "Hi Priya, 212 Gill Avenue, Bristol could bring in £36,112 a year at 63%. Worth a chat?"
      );
    }
  });

  it("NEVER renders a gap — it reports the missing field instead", () => {
    // "Hi Sam, ... could bring in  a year" is what this prevents, sent from a
    // real person's number to a member of the public.
    const r = renderTemplate("Hi {{first_name}}, about {{income}}?", {
      lead: BARE,
      customer: CUSTOMER,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toEqual(["income"]);
  });

  it("reports every missing field, not just the first", () => {
    const r = renderTemplate("{{income}} {{nightly_rate}} {{occupancy}}", {
      lead: BARE,
      customer: CUSTOMER,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing.sort()).toEqual(["income", "nightly_rate", "occupancy"]);
  });

  it("works on the 61% of the book with no analysis, given a safe template", () => {
    const r = renderTemplate("Hi {{first_name}}, still thinking about {{address}}?", {
      lead: BARE,
      customer: CUSTOMER,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("Hi Sam, still thinking about 17 Sefton drive?");
  });

  it("treats an unusable first name as missing, not as a blank", () => {
    // 5 of 449 live leads fail firstNameOf's rule.
    const r = renderTemplate("Hi {{first_name}}", {
      lead: { ...BARE, lead_name: "??" },
      customer: CUSTOMER,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toEqual(["first_name"]);
  });

  it("renders the operator's own fields", () => {
    const r = renderTemplate("{{my_name}} at {{my_company}} — {{booking_link}}", {
      lead: FULL,
      customer: CUSTOMER,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("Zoe at Northside Lets — https://cal.com/zoe");
  });

  it("treats a missing booking link as missing rather than empty", () => {
    const r = renderTemplate("Book here: {{booking_link}}", {
      lead: FULL,
      customer: { ...CUSTOMER, messaging_booking_link: null },
    });
    expect(r.ok).toBe(false);
  });
});

describe("validateTemplate", () => {
  const withLink = { hasBookingLink: true };

  it("accepts a plain template", () => {
    const v = validateTemplate("Hi {{first_name}}, any thoughts on {{address}}?", withLink);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.fields).toEqual(["first_name", "address"]);
  });

  it("REFUSES a typed URL and points at {{booking_link}}", () => {
    for (const bad of [
      "Book at https://cal.com/zoe",
      "See www.northsidelets.com",
      "Have a look at northsidelets.co.uk",
    ]) {
      const v = validateTemplate(bad, withLink);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.error).toContain("{{booking_link}}");
    }
  });

  it("accepts {{booking_link}} itself — the controlled way to send one", () => {
    expect(validateTemplate("Grab a slot: {{booking_link}}", withLink).ok).toBe(true);
  });

  it("refuses {{booking_link}} when no link is saved", () => {
    const v = validateTemplate("Grab a slot: {{booking_link}}", { hasBookingLink: false });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/have not saved a booking link/i);
  });

  it("refuses an over-long template", () => {
    expect(validateTemplate("x".repeat(481), withLink).ok).toBe(false);
    expect(validateTemplate("x".repeat(480), withLink).ok).toBe(true);
  });

  it("refuses an empty one", () => {
    expect(validateTemplate("   ", withLink).ok).toBe(false);
  });

  it("does NOT apply the model's rules to the operator's own words", () => {
    // validateDraft refuses these because a MODEL might invent them. An
    // operator quoting their own fee in their own words is their business.
    expect(validateTemplate("Our fee is 12% of net.", withLink).ok).toBe(true);
    expect(validateTemplate("Places round here clear £70,000.", withLink).ok).toBe(true);
  });
});

describe("fieldCoverage — the number that changes the decision", () => {
  const book = [
    { lead: FULL },
    { lead: BARE },
    { lead: { ...BARE, lead_name: "Ana Reid" } },
    { lead: { ...FULL, lead_name: "Tom West" } },
    { lead: { ...BARE, lead_name: "??" } },
  ];

  it("reports full reach for a template using only always-there fields", () => {
    const c = fieldCoverage("Hi {{first_name}}, about {{address}}?", book, CUSTOMER);
    expect(c.total).toBe(5);
    // Four of five: the "??" lead has no usable first name.
    expect(c.reach).toBe(4);
    expect(c.missingByField).toEqual([
      { key: "first_name", label: "Landlord's first name", count: 1 },
    ]);
  });

  it("reports the drop a figure field causes, and names it", () => {
    const c = fieldCoverage("Hi {{first_name}}, {{income}} a year?", book, CUSTOMER);
    expect(c.reach).toBe(2);
    expect(c.missingByField[0]).toEqual({
      key: "income",
      label: "Projected annual income",
      count: 3,
    });
  });

  it("orders the reasons worst first", () => {
    const c = fieldCoverage("{{income}} {{first_name}}", book, CUSTOMER);
    expect(c.missingByField[0].key).toBe("income");
  });

  it("is zero of zero for an empty book", () => {
    expect(fieldCoverage("Hi {{first_name}}", [], CUSTOMER)).toEqual({
      total: 0,
      reach: 0,
      missingByField: [],
    });
  });
});

/**
 * ⚠️ THE FINDING THAT NEARLY GOT MISSED, PINNED.
 *
 * Read across the whole `leads` table the analysis figures fill on 39%, which
 * looks like a field to use with care. Read PER PRODUCT they fill on 90% of
 * management leads and on NOT ONE of 252 guaranteed rent leads — §25's analysis
 * is management-only by design.
 *
 * So {{income}} on a GR sequence reaches nobody at all, and a feature that
 * silently sends nothing reads as broken rather than as a rule.
 */
describe("the analysis figures are management-only", () => {
  it("offers them to a management sequence", () => {
    const keys = fieldsForProduct("management").map((f) => f.key);
    expect(keys).toContain("income");
    expect(keys).toContain("nightly_rate");
    expect(keys).toContain("occupancy");
  });

  it("does NOT offer them to a guaranteed rent sequence", () => {
    const keys = fieldsForProduct("guaranteed_rent").map((f) => f.key);
    expect(keys).not.toContain("income");
    expect(keys).not.toContain("nightly_rate");
    expect(keys).not.toContain("occupancy");
    // Everything else still is: a GR operator loses three fields, not the feature.
    expect(keys).toContain("first_name");
    expect(keys).toContain("address");
    expect(keys).toContain("bedrooms");
    expect(keys).toContain("booking_link");
  });

  it("REFUSES one at save time, naming why", () => {
    const v = validateTemplate("Hi {{first_name}}, {{income}} a year?", {
      hasBookingLink: true,
      leadType: "guaranteed_rent",
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/never analysed|management leads/i);
  });

  it("accepts the same template on management", () => {
    expect(
      validateTemplate("Hi {{first_name}}, {{income}} a year?", {
        hasBookingLink: true,
        leadType: "management",
      }).ok
    ).toBe(true);
  });

  it("defaults to management when no product is given", () => {
    // Every existing caller predates the parameter; the default has to be the
    // product the figures actually exist for.
    expect(validateTemplate("{{income}}", { hasBookingLink: true }).ok).toBe(true);
  });
});

/**
 * The shapes the LIVE BOOK actually holds, which is how the email-as-a-name and
 * the paragraph-in-the-bedrooms-column were found. Every value below is real.
 */
describe("the awkward real values", () => {
  const CUST = { business_name: "X", contact_name: "Y", messaging_booking_link: null };

  it("refuses an email address as a first name", () => {
    // "natalyanaq@gmail.com" is a real lead_name. firstNameOf alone accepts it
    // — 2-40 chars with a letter — so a greeting would read
    // "Hi natalyanaq@gmail.com,". §36.3's junk detector is asked first.
    const r = renderTemplate("Hi {{first_name}}", {
      lead: { lead_name: "natalyanaq@gmail.com" },
      customer: CUST,
    });
    expect(r.ok).toBe(false);
  });

  it("refuses a junk name that reads as a person to a loose rule", () => {
    // "Dbncc" — 5 characters, no vowel, basic Latin.
    expect(renderTemplate("Hi {{first_name}}", { lead: { lead_name: "Dbncc" }, customer: CUST }).ok)
      .toBe(false);
  });

  it("still accepts the lone first names that are 87 of 437 live leads", () => {
    for (const name of ["Ann", "Mark", "sophia", "Tabitha", "shaya"]) {
      const r = renderTemplate("Hi {{first_name}}", { lead: { lead_name: name }, customer: CUST });
      expect(r.ok).toBe(true);
    }
  });

  it("refuses prose that somebody typed into the bedrooms column", () => {
    // All four are real values from the live book.
    for (const junk of [
      "said is interested looking for management info sent",
      "Replied on email saying not looking until Aug 2025",
      "E bedrooms",
      "",
    ]) {
      expect(cleanBedrooms(junk)).toBeNull();
    }
  });

  it("reads the number off a messy but usable bedrooms value", () => {
    expect(cleanBedrooms("3/4 bedrooms")).toBe("3-bed");
    expect(cleanBedrooms("2.5 bedrooms")).toBe("2-bed");
    expect(cleanBedrooms("3@ bedrooms")).toBe("3-bed");
    expect(cleanBedrooms("7+ bedrooms")).toBe("7+ bed");
    expect(cleanBedrooms("5 Bedroom")).toBe("5-bed");
  });

  it("returns null for an address that is only a house number once the postcode goes", () => {
    // "35 LS9 6EW" and "10 OX26 6YH" are real. "about 35?" is not a message.
    expect(cleanAddress("35 LS9 6EW")).toBeNull();
    expect(cleanAddress("10 OX26 6YH")).toBeNull();
  });

  it("leaves an address alone when the postcode is not at the end", () => {
    expect(cleanAddress("M11 4NH, Manchester")).toBe("M11 4NH, Manchester");
  });

  it("leaves an address with no postcode at all alone", () => {
    expect(cleanAddress("80 Clark Road Wolverhampton")).toBe("80 Clark Road Wolverhampton");
    expect(cleanAddress("48 Gray Street, Northampton")).toBe("48 Gray Street, Northampton");
  });

  it("keeps a partial postcode, which is not one it can safely strip", () => {
    expect(cleanAddress("Wisewood place sheffield S6")).toBe("Wisewood place sheffield S6");
  });
});
