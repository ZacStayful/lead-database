import { AD_IMAGE_CHARSET } from "../metaFields";
import { describe, expect, it } from "vitest";
import { AD_FONTS, AD_FONT_COVERAGE, fullyCovered, sanitiseForFont } from "../fonts";
import { AD_TEMPLATES } from "../templates";
import { stripEmphasis } from "../emphasis";

describe("the shipped faces", () => {
  it("ships a regular AND a bold — passing fonts replaces the default", () => {
    expect(AD_FONTS).toHaveLength(3);
    expect(AD_FONTS.filter((f) => f.weight === 400)).toHaveLength(1);
    expect(AD_FONTS.filter((f) => f.weight === 700)).toHaveLength(2);
    for (const f of AD_FONTS) {
      expect(f.data.length).toBeGreaterThan(10_000);
      // A TrueType sfnt, not woff2 — satori cannot read woff2 at all.
      expect(f.data.readUInt32BE(0)).toBe(0x00010000);
    }
  });

  it("⚠️ carries no GPOS/GSUB/GDEF — satori kerns, and kerns wrongly", () => {
    for (const f of AD_FONTS) {
      const tables: string[] = [];
      const n = f.data.readUInt16BE(4);
      for (let i = 0; i < n; i++) tables.push(f.data.subarray(12 + 16 * i, 16 + 16 * i).toString("latin1"));
      expect(tables).not.toContain("GPOS");
      expect(tables).not.toContain("GSUB");
      expect(tables).toContain("cmap");
      expect(tables).toContain("glyf");
    }
  });

  it("stays small enough to sit beside 2 MB of wasm without comment", () => {
    const total = AD_FONTS.reduce((n, f) => n + f.data.length, 0);
    expect(total).toBeLessThan(120_000);
  });
});

describe("coverage, parsed from the bytes rather than committed as a list", () => {
  it("has every character an ad actually needs", () => {
    for (const ch of "ABCXYZabcxyz0123456789 .,:;!?()£€–—’“”…%&/+-") {
      expect(AD_FONT_COVERAGE.has(ch.codePointAt(0)!), ch).toBe(true);
    }
    // Accented Latin, because a company name is not our choice.
    for (const ch of "éÓŠÆøåçñ") expect(AD_FONT_COVERAGE.has(ch.codePointAt(0)!), ch).toBe(true);
  });

  it("⚠️ does NOT have U+2713 — which is why the tick is drawn, not typed", () => {
    // Typing it makes satori fetch a font from Google mid-render, get a 400,
    // draw tofu, and return a valid PNG.
    expect(AD_FONT_COVERAGE.has(0x2713)).toBe(false);
    expect(AD_FONT_COVERAGE.has(0x1f44d)).toBe(false); // 👍
    expect(AD_FONT_COVERAGE.has(0x4e2d)).toBe(false); // 中
  });
});

describe("sanitiseForFont", () => {
  it("passes ordinary copy through untouched", () => {
    const s = "Landlords in Leeds: 8 years, 140 properties, 4.9 on Google.";
    expect(sanitiseForFont(s)).toBe(s);
    expect(fullyCovered(s)).toBe(true);
  });

  it("⚠️ strips what no face can draw, instead of making a network call", () => {
    expect(sanitiseForFont("Zhang 中文 Lets")).toBe("Zhang Lets");
    expect(sanitiseForFont("Ticked ✓ today")).toBe("Ticked today");
    expect(fullyCovered("Ticked ✓")).toBe(false);
  });

  it("⚠️ iterates by code point, so an emoji does not leave half a surrogate", () => {
    const out = sanitiseForFont("Great 👍 job");
    expect(out).toBe("Great job");
    for (const ch of out) expect(AD_FONT_COVERAGE.has(ch.codePointAt(0)!)).toBe(true);
  });

  it("leaves no double space where something was removed", () => {
    expect(sanitiseForFont("a 中 b")).toBe("a b");
    expect(sanitiseForFont("  中  ")).toBe("");
  });
});

/**
 * ⚠️ THIS IS WHAT STOPS `AD_IMAGE_CHARSET` BECOMING A SECOND COPY OF THE
 * COVERAGE SET. `metaFields.ts` is import-free — a client component renders the
 * truncation marks — so it cannot read the font bytes, and the runtime charset
 * is therefore a whitelist written by hand. A character allowed there but
 * missing from the shipped fonts is SILENTLY DELETED by `sanitiseForFont` and
 * the gap closed up, which renders as a missing word rather than as an error.
 *
 * So the drift fails here instead, on every build — the arrangement §37.1 uses
 * to pin the derived palette against the hexes it replaced.
 */
describe("the image charset is a subset of what the fonts can draw", () => {
  it("every character the validator will admit onto a card is covered", () => {
    const uncovered: string[] = [];
    // Every codepoint the regex admits, enumerated rather than sampled.
    const ranges: Array<[number, number]> = [
      [0x20, 0x7e], [0xa3, 0xa3], [0xa9, 0xa9], [0xae, 0xae], [0xb0, 0xb0],
      [0xb7, 0xb7], [0xbd, 0xbd], [0xe0, 0xff], [0x2013, 0x2014],
      [0x2018, 0x2019], [0x201c, 0x201d], [0x2022, 0x2022], [0x2026, 0x2026],
      [0x2192, 0x2192], [0x20ac, 0x20ac],
    ];
    for (const [lo, hi] of ranges) {
      for (let cp = lo; cp <= hi; cp += 1) {
        const ch = String.fromCodePoint(cp);
        // Guard against the two drifting apart in EITHER direction.
        expect(AD_IMAGE_CHARSET.test(ch), `charset should admit U+${cp.toString(16)}`).toBe(true);
        if (!fullyCovered(ch)) uncovered.push(`U+${cp.toString(16).toUpperCase()} ${ch}`);
      }
    }
    expect(uncovered).toEqual([]);
  });

  it("⚠️ refuses the two glyphs the layout draws as shapes rather than type", () => {
    // Measured on the real bytes: ★ and ✓ are the only common marks missing,
    // and §65.3 records what an uncovered glyph costs — satori fetches a font
    // from Google mid-render, gets a 400, and draws tofu.
    for (const ch of ["\u2605", "\u2713"]) {
      expect(fullyCovered(ch)).toBe(false);
      expect(AD_IMAGE_CHARSET.test(ch)).toBe(false);
    }
  });
});

describe("every shipped string renders", () => {
  it("no template's own copy loses a character", () => {
    for (const t of AD_TEMPLATES) {
      for (const s of [
        t.addressedTo, t.categoryLine, t.ctaPattern, t.footerLine ?? "",
        stripEmphasis(t.exampleHeadlineLocated), stripEmphasis(t.exampleHeadlineUnlocated),
        stripEmphasis(t.exampleSubLocated), stripEmphasis(t.exampleSubUnlocated),
      ]) {
        expect(fullyCovered(s), `${t.id}: ${s}`).toBe(true);
      }
    }
  });
});
