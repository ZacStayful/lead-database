import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseRadiusCentre } from "@/components/filtering/radiusSearch";
import { indexPlaces, type PlaceTuple } from "@/lib/places";
import { summariseAreas, NEAR_NATIONAL_AREAS } from "@/components/filtering/format";

const index = indexPlaces(
  (
    JSON.parse(
      readFileSync(
        resolve(__dirname, "..", "..", "..", "..", "public/data/uk-places.json"),
        "utf8"
      )
    ) as { places: PlaceTuple[] }
  ).places
);

describe("parseRadiusCentre", () => {
  it("⚠️ resolves a postcode with NO gazetteer loaded", () => {
    // The gazetteer is a separate fetch. The postcode path must not wait for
    // it, or the box does nothing for 250 KB.
    const r = parseRadiusCentre("LE67 8QN", null);
    expect(r.centre).toEqual({
      kind: "outcode",
      outcode: "LE67",
      centre: expect.any(Array),
      label: "LE67",
    });
    expect(r.suggestions).toEqual([]);
  });

  it("takes a bare outcode and tolerates spacing and case", () => {
    for (const typed of ["LE67", "le67", " le67 8qn ", "LE678QN"]) {
      expect(parseRadiusCentre(typed, index).centre?.outcode, typed).toBe("LE67");
    }
  });

  it("resolves a town typed in full", () => {
    const r = parseRadiusCentre("Salisbury", index);
    expect(r.centre).toMatchObject({
      kind: "place",
      name: "Salisbury",
      outcode: "SP1",
      label: "Salisbury (SP1)",
    });
    expect(r.suggestions).toEqual([]);
  });

  it("⚠️ refuses to choose between six Newports", () => {
    // Picking the biggest would silently centre the filter 200 miles from the
    // one they meant, and they would have no way to tell.
    const r = parseRadiusCentre("Newport", index);
    expect(r.centre).toBeNull();
    expect(r.suggestions).toHaveLength(6);
    expect(r.suggestions[0].label).toBe("Newport (NP20)");
  });

  it("⚠️ never auto-picks the top hit mid-word", () => {
    // "New" resolving to Newcastle would redraw a coverage paragraph and, on
    // the dashboard, rewrite the saved area selection, while someone is still
    // typing.
    const r = parseRadiusCentre("New", index);
    expect(r.centre).toBeNull();
    expect(r.suggestions.length).toBeGreaterThan(0);
  });

  it("⚠️ not even when the prefix narrows to exactly one town", () => {
    // The case that separates exactPlaces from searchPlaces, and the one a
    // first draft of these tests missed entirely: "Salisb" has exactly ONE
    // hit, so resolving on the search rather than on an exact name silently
    // centres the circle six letters into a word. "New" cannot catch it —
    // it has six hits either way.
    for (const partial of ["Salisb", "Inverne"]) {
      expect(parseRadiusCentre(partial, index).centre, partial).toBeNull();
      expect(parseRadiusCentre(partial, index).suggestions.length).toBe(1);
    }
  });

  it("says nothing at all for an empty box", () => {
    expect(parseRadiusCentre("", index)).toEqual({
      centre: null,
      suggestions: [],
      looksLikePostcode: false,
    });
    expect(parseRadiusCentre("   ", index).suggestions).toEqual([]);
  });

  it("⚠️ tells a bad postcode from an unknown town", () => {
    // The two need different copy — "try its first half" is nonsense for a
    // town, and "try a nearby town" is nonsense for a postcode. The
    // discriminator is a digit, which is honest because NO place name in the
    // gazetteer contains one.
    const postcodeish = parseRadiusCentre("ZZ99 9ZZ", index);
    expect(postcodeish.centre).toBeNull();
    expect(postcodeish.suggestions).toEqual([]);
    expect(postcodeish.looksLikePostcode).toBe(true);

    const townish = parseRadiusCentre("Zzzzquux", index);
    expect(townish.centre).toBeNull();
    expect(townish.suggestions).toEqual([]);
    expect(townish.looksLikePostcode).toBe(false);
  });

  it("offers nothing until there is enough to rank", () => {
    expect(parseRadiusCentre("S", index).suggestions).toEqual([]);
  });

  it("offers nothing while the gazetteer is still loading", () => {
    const r = parseRadiusCentre("Salisbury", null);
    expect(r.centre).toBeNull();
    expect(r.suggestions).toEqual([]);
  });

  it("⚠️ a real postcode is never swallowed by the town branch", () => {
    // Safe by construction — every outcode has a digit and no name does — and
    // this is what keeps it so if the gazetteer ever changes.
    for (const typed of ["BS1", "M1", "EC1A", "SW1A 1AA"]) {
      expect(parseRadiusCentre(typed, index).centre?.kind, typed).toBe("outcode");
    }
  });
});

describe("summariseAreas", () => {
  const label = (a: string) => a;

  it("names a few and counts the rest", () => {
    const a = summariseAreas(["A", "B", "C"], label);
    expect(a.head).toEqual(["A", "B", "C"]);
    expect(a.rest).toEqual([]);
  });

  it("⚠️ truncates a 78-area list instead of printing a paragraph", () => {
    // A 100-mile circle from Northampton touches 78 areas; joined, that is
    // ~1,900 characters of prose.
    const many = Array.from({ length: 78 }, (_, i) => `A${i}`);
    const a = summariseAreas(many, label);
    expect(a.head).toHaveLength(8);
    expect(a.rest).toHaveLength(70);
    expect(a.head.concat(a.rest)).toEqual(many);
  });

  it("⚠️ flags a near-national selection", () => {
    expect(summariseAreas(Array(NEAR_NATIONAL_AREAS).fill("X"), label).nearNational).toBe(true);
    expect(
      summariseAreas(Array(NEAR_NATIONAL_AREAS - 1).fill("X"), label).nearNational
    ).toBe(false);
  });

  it("labels through the caller's function", () => {
    expect(summariseAreas(["BS"], (a) => `${a} — Bristol`).head).toEqual([
      "BS — Bristol",
    ]);
  });
});
