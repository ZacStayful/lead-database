import { describe, expect, it } from "vitest";
import {
  BRAND_PRESETS,
  DEFAULT_PRESENTATION_BRAND,
  LOGO_MAX_BYTES,
  LOGO_SVG_MAX_BYTES,
  STAYFUL_ACCENT,
  contrastRatio,
  derivePalette,
  logoMaxBytes,
  logoStoragePath,
  paletteCssVars,
  sniffLogoMime,
  validatePresentationBrand,
} from "@/lib/presentationBrand";

/** Channel-wise distance, so "imperceptibly different" can be asserted. */
function delta(a: string, b: string): number {
  const to = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [to(a), to(b)];
  return Math.max(...x.map((v, i) => Math.abs(v - y[i])));
}

describe("derivePalette", () => {
  /**
   * THE REGRESSION THAT MATTERS. Every customer starts on the default accent,
   * so the derived palette must reproduce the colours the tool shipped with —
   * otherwise this feature silently restyles every deck in the business on the
   * day it deploys. Within four parts in 255 is invisible; exact would be
   * over-fitting an HSL round trip.
   */
  it("reproduces the tool's own palette from the Stayful accent", () => {
    const p = derivePalette(STAYFUL_ACCENT);
    expect(p.accent).toBe("#2f7d4f");
    expect(delta(p.accentDark, "#245f3c")).toBeLessThanOrEqual(4);
    expect(delta(p.accentMid, "#3a9560")).toBeLessThanOrEqual(4);
    expect(delta(p.accentSoft, "#8fbf9e")).toBeLessThanOrEqual(4);
    expect(delta(p.accentBright, "#8fe0a6")).toBeLessThanOrEqual(4);
    expect(delta(p.ink, "#16241c")).toBeLessThanOrEqual(4);
    expect(delta(p.inkText, "#f4f8f2")).toBeLessThanOrEqual(4);
    expect(delta(p.tint, "#f0f6f1")).toBeLessThanOrEqual(4);
    expect(delta(p.tintDeep, "#eef4ec")).toBeLessThanOrEqual(4);
    expect(p.adjusted).toBe(false);
  });

  it("darkens a colour too pale to carry white text, and says it did", () => {
    const p = derivePalette("#ffe600");
    expect(p.adjusted).toBe(true);
    expect(contrastRatio(p.accent, "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });

  /** The guard is symmetric, which is the reason there is only one of it. */
  it("leaves the accent readable as text on white too", () => {
    for (const hex of ["#ffe600", "#00d1ff", "#ff9ecb", "#7cff00"]) {
      const p = derivePalette(hex);
      expect(contrastRatio(p.accent, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps the dark slides legible whatever hue arrives", () => {
    for (const hex of ["#ffe600", "#00d1ff", "#ff0000", "#000000", "#ffffff"]) {
      const p = derivePalette(hex);
      expect(contrastRatio(p.ink, p.inkText)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(p.ink, p.accentSoft)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(p.ink, p.accentBright)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("ships no preset that renders badly", () => {
    for (const preset of BRAND_PRESETS) {
      const p = derivePalette(preset.accent);
      expect(contrastRatio(p.accent, "#ffffff")).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(p.ink, p.inkText)).toBeGreaterThanOrEqual(7);
      // A preset that needed darkening is a preset chosen badly, not a guard
      // doing its job.
      expect(p.adjusted).toBe(false);
    }
  });

  it("falls back to the Stayful accent rather than throwing on rubbish", () => {
    expect(derivePalette("not a colour").accent).toBe(STAYFUL_ACCENT);
  });

  it("names every custom property the tool reads", () => {
    expect(Object.keys(paletteCssVars(derivePalette(STAYFUL_ACCENT))).sort()).toEqual([
      "--sf-accent",
      "--sf-accent-bright",
      "--sf-accent-dark",
      "--sf-accent-mid",
      "--sf-accent-soft",
      "--sf-ink",
      "--sf-ink-text",
      "--sf-tint",
      "--sf-tint-deep",
    ]);
  });
});

describe("validatePresentationBrand", () => {
  it("defaults everything it cannot read, and never throws", () => {
    for (const input of [null, undefined, 42, "green", { accent: "rebeccapurple" }, { accent: "#12345" }]) {
      expect(validatePresentationBrand(input)).toEqual(DEFAULT_PRESENTATION_BRAND);
    }
  });

  it("normalises a valid accent to lower case", () => {
    expect(validatePresentationBrand({ accent: "#26456F" }).accent).toBe("#26456f");
  });

  it("keeps a well-formed logo", () => {
    const brand = validatePresentationBrand({
      accent: "#26456f",
      logo: { path: "abc/logo", mime: "image/png", sizeBytes: 2048 },
    });
    expect(brand.logo).toEqual({ path: "abc/logo", mime: "image/png", sizeBytes: 2048 });
  });

  it("drops a logo it cannot trust", () => {
    const cases = [
      { path: "../other/logo", mime: "image/png", sizeBytes: 1 },
      { path: "abc/logo", mime: "application/pdf", sizeBytes: 1 },
      { path: "", mime: "image/png", sizeBytes: 1 },
      { path: "abc/logo" },
    ];
    for (const logo of cases) {
      expect(validatePresentationBrand({ logo }).logo).toBeNull();
    }
  });

  /** Unknown keys are dropped, not carried — the blob holds only what is read. */
  it("is a whitelist", () => {
    const brand = validatePresentationBrand({
      accent: "#26456f",
      background: "#000000",
      logo: { path: "abc/logo", mime: "image/png", sizeBytes: 10, url: "https://x/y" },
    });
    expect(Object.keys(brand).sort()).toEqual(["accent", "logo"]);
    expect(Object.keys(brand.logo!).sort()).toEqual(["mime", "path", "sizeBytes"]);
  });
});

describe("sniffLogoMime", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
  const webp = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
  ]);
  const svg = new TextEncoder().encode('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>');
  const pdf = new TextEncoder().encode("%PDF-1.4\n%\xE2\xE3\xCF\xD3");

  it("recognises what it accepts", () => {
    expect(sniffLogoMime(png)).toBe("image/png");
    expect(sniffLogoMime(jpeg)).toBe("image/jpeg");
    expect(sniffLogoMime(webp)).toBe("image/webp");
    expect(sniffLogoMime(svg)).toBe("image/svg+xml");
    expect(sniffLogoMime(new TextEncoder().encode('<svg viewBox="0 0 10 10"></svg>'))).toBe(
      "image/svg+xml"
    );
  });

  /**
   * The point of sniffing: the declared type is the client's word for it, and
   * the bucket's allowed_mime_types checks that same string.
   */
  it("refuses a file that is not what it claims", () => {
    expect(sniffLogoMime(pdf)).toBeNull();
    expect(sniffLogoMime(new TextEncoder().encode("<html><body>hi</body></html>"))).toBeNull();
    // An XML preamble with no <svg> after it is not an SVG.
    expect(sniffLogoMime(new TextEncoder().encode('<?xml version="1.0"?><rss></rss>'))).toBeNull();
    expect(sniffLogoMime(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("holds SVG to a tighter cap than raster", () => {
    expect(logoMaxBytes("image/svg+xml")).toBe(LOGO_SVG_MAX_BYTES);
    expect(logoMaxBytes("image/png")).toBe(LOGO_MAX_BYTES);
    expect(LOGO_SVG_MAX_BYTES).toBeLessThan(LOGO_MAX_BYTES);
  });
});

/** Fixed path: one object per customer, replaced by overwrite (0112). */
it("puts every customer's logo at one fixed path", () => {
  expect(logoStoragePath("cust-1")).toBe("cust-1/logo");
});
