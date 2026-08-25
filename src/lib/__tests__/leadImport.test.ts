import { describe, expect, it } from "vitest";
import {
  detectHeaderRow,
  isEmptyRow,
  normaliseHeader,
  normaliseRow,
  proposeMapping,
  resolveDuplicateClaims,
  scoreColumnContent,
  syntheticHeaders,
  trimTrailingBlankRows,
  type ColumnMapping,
} from "../leadImport";

/** Build a mapping array the way proposeMapping would, for normaliseRow tests. */
function mapping(pairs: [string, ColumnMapping["target"]][]): ColumnMapping[] {
  return pairs.map(([header, target], index) => ({
    index,
    header,
    target,
    confidence: 0.9,
  }));
}

describe("normaliseHeader", () => {
  it("strips punctuation, spacing and case", () => {
    expect(normaliseHeader("Mobile No.")).toBe("mobileno");
    expect(normaliseHeader("  E-Mail Address ")).toBe("emailaddress");
    expect(normaliseHeader("No. of Bedrooms")).toBe("noofbedrooms");
  });
});

describe("detectHeaderRow", () => {
  it("finds a header on the first row", () => {
    const rows = [
      ["Name", "Email", "Phone"],
      ["Jane", "jane@example.com", "07700 900123"],
    ];
    expect(detectHeaderRow(rows)).toBe(0);
  });

  it("skips a title row and a blank line above the real header", () => {
    const rows = [
      ["Landlord leads — March 2026", "", ""],
      ["", "", ""],
      ["Landlord Name", "Email Address", "Mobile No."],
      ["Jane Landlord", "jane@example.com", "07700 900123"],
    ];
    expect(detectHeaderRow(rows)).toBe(2);
  });

  it("returns null for a headerless sheet rather than eating the first lead", () => {
    const rows = [
      ["Jane Landlord", "jane@example.com", "07700 900123"],
      ["Bob Owner", "bob@example.com", "07700 900456"],
    ];
    expect(detectHeaderRow(rows)).toBeNull();
  });
});

describe("scoreColumnContent", () => {
  it("recognises emails, phones, postcodes and bedroom counts", () => {
    expect(scoreColumnContent(["a@b.com", "c@d.co.uk"]).email).toBeGreaterThan(0.5);
    expect(scoreColumnContent(["07700 900123", "+44 7700 900456"]).phone).toBeGreaterThan(0.5);
    expect(scoreColumnContent(["1 High St, Bristol BS1 4DJ"]).address).toBeGreaterThan(0.5);
    expect(scoreColumnContent(["3", "4", "2"]).bedrooms).toBeGreaterThan(0.7);
  });

  it("says nothing about an empty column", () => {
    expect(scoreColumnContent(["", "  "])).toEqual({});
  });
});

describe("proposeMapping", () => {
  it("maps the realistic spellings operators actually use", () => {
    const headers = [
      "Landlord Name", "E-mail", "Mobile", "Property Address", "Beds", "Comments",
    ];
    const targets = proposeMapping(headers, []).map((m) => m.target);
    expect(targets).toEqual([
      "name", "email", "phone", "address", "bedrooms", "notes",
    ]);
  });

  it("maps 'Tel' and 'Contact Number' to phone", () => {
    expect(proposeMapping(["Tel"], [])[0].target).toBe("phone");
    expect(proposeMapping(["Contact Number"], [])[0].target).toBe("phone");
  });

  it("ignores a column it cannot place", () => {
    const m = proposeMapping(["Sourcing agent ref"], [["ABC-1"]])[0];
    expect(m.target).toBe("ignore");
  });

  it("maps an unlabelled sheet from its contents alone", () => {
    const headers = syntheticHeaders(3);
    const data = [
      ["Jane Landlord", "jane@example.com", "07700 900123"],
      ["Bob Owner", "bob@example.com", "07700 900456"],
    ];
    const targets = proposeMapping(headers, data).map((m) => m.target);
    expect(targets[1]).toBe("email");
    expect(targets[2]).toBe("phone");
  });

  it("trusts the data when a header has drifted from its contents", () => {
    // "Contact" reads as a name by synonym, but it holds phone numbers.
    const m = proposeMapping(["Contact"], [["07700 900123"], ["07700 900456"]])[0];
    expect(m.target).toBe("phone");
  });

  it("gives one column to each single-claim target", () => {
    const targets = proposeMapping(["Phone", "Phone 2"], []).map((m) => m.target);
    expect(targets.filter((t) => t === "phone")).toHaveLength(1);
    expect(targets).toContain("ignore");
  });

  it("lets several comment columns all feed the profile", () => {
    const targets = proposeMapping(["Notes", "Comments"], []).map((m) => m.target);
    expect(targets).toEqual(["notes", "notes"]);
  });
});

describe("resolveDuplicateClaims", () => {
  it("keeps the higher-confidence claim and demotes the other", () => {
    const resolved = resolveDuplicateClaims([
      { index: 0, header: "Phone", target: "phone", confidence: 0.95 },
      { index: 1, header: "Alt", target: "phone", confidence: 0.6 },
    ]);
    expect(resolved[0].target).toBe("phone");
    expect(resolved[1].target).toBe("ignore");
  });
});

describe("normaliseRow", () => {
  const cols = mapping([
    ["Landlord Name", "name"],
    ["Email", "email"],
    ["Mobile", "phone"],
    ["Address", "address"],
    ["Beds", "bedrooms"],
  ]);

  it("keeps a leading-zero phone number intact as text", () => {
    const row = normaliseRow(
      ["Jane", "jane@example.com", "07700 900123", "1 High St", "3"],
      cols
    );
    expect(row.phone).toBe("07700 900123");
    expect(row.bedrooms).toBe("3");
  });

  it("returns null rather than empty string for missing cells", () => {
    const row = normaliseRow(["Jane", "", "", "", ""], cols);
    expect(row.name).toBe("Jane");
    expect(row.email).toBeNull();
    expect(row.phone).toBeNull();
    expect(row.profile).toBeNull();
  });

  it("folds an unmapped column into the profile as 'Header: value'", () => {
    const withExtra = mapping([
      ["Landlord Name", "name"],
      ["Notes from viewing", "ignore"],
    ]);
    const row = normaliseRow(["Jane", "Keen, wants a call Friday"], withExtra);
    expect(row.profile).toBe("Notes from viewing: Keen, wants a call Friday");
  });

  it("keeps a notes column as bare prose, without the header prefix", () => {
    const withNotes = mapping([
      ["Landlord Name", "name"],
      ["Comments", "notes"],
    ]);
    const row = normaliseRow(["Jane", "Two properties"], withNotes);
    expect(row.profile).toBe("Two properties");
  });

  it("joins several profile sources onto separate lines", () => {
    const multi = mapping([
      ["Comments", "notes"],
      ["Source", "ignore"],
    ]);
    const row = normaliseRow(["Keen", "Facebook ad"], multi);
    expect(row.profile).toBe("Keen\nSource: Facebook ad");
  });

  it("can be told to discard unmapped columns instead", () => {
    const withExtra = mapping([
      ["Landlord Name", "name"],
      ["Internal ref", "ignore"],
    ]);
    const row = normaliseRow(["Jane", "XYZ-1"], withExtra, { keepUnmapped: false });
    expect(row.profile).toBeNull();
  });
});

describe("isEmptyRow", () => {
  it("treats a row with any contact detail as real", () => {
    expect(isEmptyRow({ name: null, email: null, phone: "07700 900123", address: null, bedrooms: null, profile: null })).toBe(false);
    expect(isEmptyRow({ name: "Jane", email: null, phone: null, address: null, bedrooms: null, profile: null })).toBe(false);
  });

  it("treats a notes-only row as empty — there is nobody to ring", () => {
    expect(isEmptyRow({ name: null, email: null, phone: null, address: null, bedrooms: "3", profile: "Nice place" })).toBe(true);
  });
});

describe("trimTrailingBlankRows", () => {
  it("drops the blank rows Excel leaves at the end but keeps interior ones", () => {
    const rows = [["a"], ["", ""], ["b"], ["", ""], [""]];
    expect(trimTrailingBlankRows(rows)).toEqual([["a"], ["", ""], ["b"]]);
  });
});

describe("syntheticHeaders", () => {
  it("names columns A..Z then AA", () => {
    const headers = syntheticHeaders(28);
    expect(headers[0]).toBe("Column A");
    expect(headers[25]).toBe("Column Z");
    expect(headers[26]).toBe("Column AA");
  });
});
