import { describe, expect, it } from "vitest";
import {
  emphasisWords,
  emphasisedSpans,
  hasEmphasis,
  stripEmphasis,
} from "../emphasis";
import { AD_TEMPLATES } from "../templates";

/** Flatten back to the string a reader sees, with one space between words. */
const flatten = (src: string) =>
  emphasisWords(src)
    .map((w) => w.map((s) => s.text).join(""))
    .join(" ");

describe("emphasis, the shape Satori can actually lay out", () => {
  it("⚠️ loses no space — the naive flexWrap version renders '4.9on Google'", () => {
    const src = "properties, *4.9* on Google.";
    expect(flatten(src)).toBe("properties, 4.9 on Google.");
  });

  it("⚠️ keeps punctuation attached across an emphasis boundary", () => {
    // Splitting on runs first strands the full stop as its own token and it
    // renders as "Dan ." — word tokens with sub-segments do not.
    const words = emphasisWords("Ask for *Dan*.");
    expect(words).toHaveLength(3);
    expect(words[2]).toEqual([
      { text: "Dan", emphasised: true },
      { text: ".", emphasised: false },
    ]);
    expect(flatten("Ask for *Dan*.")).toBe("Ask for Dan.");
  });

  it("treats plain text as one unemphasised segment per word", () => {
    const words = emphasisWords("Landlords in Leeds");
    expect(words).toEqual([
      [{ text: "Landlords", emphasised: false }],
      [{ text: "in", emphasised: false }],
      [{ text: "Leeds", emphasised: false }],
    ]);
    expect(hasEmphasis("Landlords in Leeds")).toBe(false);
  });

  it("handles a wholly emphasised line", () => {
    const words = emphasisWords("*every single word*");
    expect(words.every((w) => w.every((s) => s.emphasised))).toBe(true);
    expect(flatten("*every single word*")).toBe("every single word");
  });

  it("collapses any run of whitespace, including newlines", () => {
    expect(flatten("a  \n b\tc")).toBe("a b c");
    expect(emphasisWords("   ")).toEqual([]);
    expect(emphasisWords("")).toEqual([]);
  });

  it("⚠️ treats an unmatched asterisk as literal", () => {
    // An operator writing "5 * 3" must not lose the rest of the line to an
    // open marker.
    expect(flatten("5 * 3 beds")).toBe("5 * 3 beds");
    expect(hasEmphasis("5 * 3 beds")).toBe(false);
    expect(flatten("open *marker never closes")).toBe("open *marker never closes");
  });

  it("treats an empty ** as literal, not as emphasis", () => {
    expect(hasEmphasis("a ** b")).toBe(false);
    expect(flatten("a ** b")).toBe("a ** b");
  });

  it("emphasises mid-word without splitting the word", () => {
    const words = emphasisWords("pre*mid*post");
    expect(words).toHaveLength(1);
    expect(words[0]).toEqual([
      { text: "pre", emphasised: false },
      { text: "mid", emphasised: true },
      { text: "post", emphasised: false },
    ]);
  });
});

describe("stripEmphasis — what Meta and the figure check see", () => {
  it("removes the markers and keeps the spacing exactly", () => {
    expect(stripEmphasis("Landlords in {city}: short let rules, *handled*."))
      .toBe("Landlords in {city}: short let rules, handled.");
  });

  it("⚠️ is what any length bound must measure — never the raw pattern", () => {
    const raw = "*4.9* on Google";
    expect(stripEmphasis(raw).length).toBeLessThan(raw.length);
    expect(stripEmphasis(raw)).toBe("4.9 on Google");
  });

  it("is a no-op on text with no markers", () => {
    const plain = "Send the postcode and bedroom count.";
    expect(stripEmphasis(plain)).toBe(plain);
  });

  it("reports the emphasised spans", () => {
    expect(emphasisedSpans("a *one* b *two* c")).toEqual(["one", "two"]);
    expect(emphasisedSpans("none here")).toEqual([]);
  });
});

describe("every shipped headline survives the round trip", () => {
  it("⚠️ each template's headline emphasises exactly one span", () => {
    // The spec marks one span per headline. More than one is a design change,
    // and none means the flagship typographic feature is silently off.
    for (const t of AD_TEMPLATES) {
      expect(emphasisedSpans(t.headlineLocated)).toHaveLength(1);
      expect(emphasisedSpans(t.headlineUnlocated)).toHaveLength(1);
    }
  });

  it("strips to text with no stray markers and no doubled spaces", () => {
    for (const t of AD_TEMPLATES) {
      for (const p of [t.headlineLocated, t.headlineUnlocated, t.subLocated, t.subUnlocated]) {
        const plain = stripEmphasis(p);
        expect(plain).not.toContain("*");
        expect(plain).not.toMatch(/\s{2,}/);
        expect(flatten(p)).toBe(plain.replace(/\s+/g, " ").trim());
      }
    }
  });

  it("emphasises nothing in a sub — the spec marks only headlines", () => {
    for (const t of AD_TEMPLATES) {
      expect(hasEmphasis(t.subLocated)).toBe(false);
      expect(hasEmphasis(t.subUnlocated)).toBe(false);
    }
  });
});
