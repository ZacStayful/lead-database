import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PLACE_MIN_QUERY,
  PLACE_SUGGESTION_LIMIT,
  exactPlaces,
  indexPlaces,
  normalisePlaceName,
  placeLabel,
  searchPlaces,
  type PlaceTuple,
} from "@/lib/places";

/**
 * Driven against the REAL committed gazetteer, not a fixture. The cases that
 * matter here — six Newports, "Saint Andrews" spelled out, one typographic
 * apostrophe — are facts about the data, and a fixture would let the data
 * change underneath them.
 */
const places = (
  JSON.parse(
    readFileSync(
      resolve(__dirname, "..", "..", "..", "public/data/uk-places.json"),
      "utf8"
    )
  ) as { places: PlaceTuple[] }
).places;
const index = indexPlaces(places);
const names = (q: string) => searchPlaces(index, q).map((m) => m.label);

describe("normalisePlaceName", () => {
  it("⚠️ collides the three ways to write Bo’ness", () => {
    // The load-bearing rule: 2 of 6,222 names are non-ASCII and BOTH are
    // typographic apostrophes.
    const a = normalisePlaceName("Bo’ness");
    expect(normalisePlaceName("Bo'ness")).toBe(a);
    expect(normalisePlaceName("boness")).toBe(a);
    expect(normalisePlaceName("BO’NESS")).toBe(a);
  });

  it("treats a hyphen as a space", () => {
    expect(normalisePlaceName("Stoke-on-Trent")).toBe(
      normalisePlaceName("stoke on trent")
    );
  });

  it("expands nothing but shortens saint", () => {
    // GeoNames spells it out; nobody types it.
    expect(normalisePlaceName("Saint Andrews")).toBe("st andrews");
    expect(normalisePlaceName("St. Andrews")).toBe("st andrews");
    expect(normalisePlaceName("st andrews")).toBe("st andrews");
  });

  it("⚠️ collapses spaces and does not remove them", () => {
    // Removing them would collide "Newport" with "New Port" and wreck prefix
    // ranking.
    expect(normalisePlaceName("  New   Port ")).toBe("new port");
    expect(normalisePlaceName("Newport")).not.toBe(normalisePlaceName("New Port"));
  });

  it("strips accents", () => {
    expect(normalisePlaceName("Ystrad Mynách")).toBe("ystrad mynach");
  });
});

describe("searchPlaces", () => {
  it("⚠️ ranks the six Newports by population, Gwent first", () => {
    expect(names("Newport")).toEqual([
      "Newport (NP20)",
      "Newport (PO30)",
      "Newport (TF10)",
      "Newport (CB11)",
      "Newport (HU15)",
      "Newport (SA42)",
    ]);
  });

  it("⚠️ puts an exact name above a much bigger one that starts the same way", () => {
    // Burton is 4,106 people; Burton upon Trent is 122,199 — thirty times
    // larger. Ranking by population alone puts the wrong one first, so this
    // is the assertion that the exact tier outranks the prefix tier at all.
    // (A first draft used "Newcastle", which has no exact entry: Emlyn, under
    // Lyme, upon Tyne and Newcastleton, and no plain Newcastle.)
    const hits = names("Burton");
    expect(hits[0]).toMatch(/^Burton \(/);
    expect(hits[0]).not.toContain("upon Trent");
  });

  it("finds a place by a token in the middle of its name", () => {
    expect(names("trent").some((n) => n.startsWith("Stoke-on-Trent"))).toBe(true);
  });

  it("⚠️ a whole WORD outranks the same letters inside a longer one", () => {
    // The tier that is easiest to write a vacuous test for: "trent" finds
    // Stoke-on-Trent either way, because the substring tier catches it too —
    // so dropping the token tier entirely passed a first draft of the test
    // above. Only a case where the two tiers DISAGREE pins it.
    //
    // "ham" is that case. Birmingham is 1,157,603 people and matches only as
    // a letter run; West Ham is 15,551 and matches as a word. The word wins,
    // which is the whole point of the tier — and is the accepted cost of it:
    // a mid-word fragment ranks smaller places above much larger ones until
    // enough is typed for the prefix tier to take over.
    // Asked without a limit, because this is about the ORDER, not the
    // truncation: "ham" has 440 hits and both of these sit past the six a
    // customer is shown (West Ham 16th, Birmingham 25th).
    const hits = searchPlaces(index, "ham", 5_000).map((m) => m.label);
    const west = hits.findIndex((n) => n.startsWith("West Ham"));
    const birmingham = hits.findIndex((n) => n.startsWith("Birmingham"));
    expect(west).toBeGreaterThanOrEqual(0);
    expect(birmingham).toBeGreaterThanOrEqual(0);
    expect(west).toBeLessThan(birmingham);
    // And the exact match still leads, ahead of both.
    expect(hits[0]).toMatch(/^Ham \(/);
  });

  it("resolves an ordinary town", () => {
    expect(names("Salisbury")[0]).toBe("Salisbury (SP1)");
  });

  it("finds Saint Andrews from St Andrews", () => {
    expect(names("St Andrews")[0]).toBe("Saint Andrews (KY16)");
  });

  it("⚠️ says nothing on a query too short to rank", () => {
    expect(searchPlaces(index, "S")).toEqual([]);
    expect(searchPlaces(index, " ")).toEqual([]);
    expect(PLACE_MIN_QUERY).toBe(2);
  });

  it("caps the list", () => {
    expect(PLACE_SUGGESTION_LIMIT).toBe(6);
    expect(searchPlaces(index, "ton").length).toBeLessThanOrEqual(6);
    expect(searchPlaces(index, "ton", 3)).toHaveLength(3);
  });

  it("is deterministic", () => {
    expect(names("Newport")).toEqual(names("newport"));
    expect(names("bristol")).toEqual(names("  BRISTOL "));
  });

  it("returns a usable centre and outcode", () => {
    const [m] = searchPlaces(index, "Salisbury");
    expect(m.outcode).toBe("SP1");
    expect(m.centre[0]).toBeGreaterThan(50);
    expect(m.centre[1]).toBeLessThan(0);
    expect(m.label).toBe(placeLabel(m.name, m.outcode));
  });

  it("finds nothing for a name we do not hold", () => {
    expect(searchPlaces(index, "Zzzzquux")).toEqual([]);
  });

  it("agrees with a naive scan", () => {
    // The index is an optimisation, so it must answer what a plain filter
    // would. Compared as sets, because tiering is what changes the ORDER.
    const q = normalisePlaceName("bath");
    const naive = places
      .filter((p) => normalisePlaceName(p[0]).includes(q))
      .map((p) => placeLabel(p[0], p[3]));
    const found = searchPlaces(index, "bath", 10_000).map((m) => m.label);
    expect(new Set(found)).toEqual(new Set(naive));
  });
});

describe("exactPlaces", () => {
  it("⚠️ returns every Newport, so the resolver refuses to choose", () => {
    // Auto-picking the biggest would silently centre a filter on the wrong
    // town — one of six, 200 miles from the one they meant.
    expect(exactPlaces(index, "Newport")).toHaveLength(6);
  });

  it("returns exactly one for an unambiguous town", () => {
    const hits = exactPlaces(index, "Salisbury");
    expect(hits).toHaveLength(1);
    expect(hits[0].outcode).toBe("SP1");
  });

  it("⚠️ does not match a prefix", () => {
    // "New" must not resolve to Newcastle mid-word.
    expect(exactPlaces(index, "New")).toEqual([]);
    expect(exactPlaces(index, "Salisb")).toEqual([]);
  });
});

describe("placeLabel", () => {
  it("⚠️ uses the bare outcode, never a city name for the area", () => {
    // cityForArea("PO") is "Portsmouth", so an area label would read
    // "Newport (PO30 — Portsmouth)", which is simply wrong.
    expect(placeLabel("Newport", "PO30")).toBe("Newport (PO30)");
    expect(placeLabel("Newport", "PO30")).not.toContain("Portsmouth");
  });
});
