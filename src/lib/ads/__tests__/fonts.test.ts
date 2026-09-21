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

describe("every shipped string renders", () => {
  it("no template's own copy loses a character", () => {
    for (const t of AD_TEMPLATES) {
      for (const s of [
        t.addressedTo, t.categoryLine, t.ctaPattern, t.defaultPrimaryText,
        t.defaultHeadline, t.defaultDescription, t.footerLine ?? "",
        stripEmphasis(t.headlineLocated), stripEmphasis(t.headlineUnlocated),
        stripEmphasis(t.subLocated), stripEmphasis(t.subUnlocated),
      ]) {
        expect(fullyCovered(s), `${t.id}: ${s}`).toBe(true);
      }
    }
  });
});
