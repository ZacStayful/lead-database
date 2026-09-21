import { HANKEN_400_B64 } from "./fonts/hanken-400";
import { HANKEN_700_B64 } from "./fonts/hanken-700";
import { BRICOLAGE_700_B64 } from "./fonts/bricolage-700";

/**
 * The faces a creative is drawn with, and the guard that keeps satori offline
 * (§65).
 *
 * ⚠️ PASSING `fonts` REPLACES THE DEFAULT ENTIRELY. `@vercel/og` does
 * `fonts: options.fonts || defaultFonts`, so supplying a bold means supplying
 * the regular too — there is no merge.
 *
 * ⚠️ BASE64 IN A MODULE, NOT A .ttf ON DISK. A bundled module cannot fail to
 * be traced into the lambda; a runtime `readFileSync` of a path Vercel did not
 * trace fails at FIRST INVOCATION with ENOENT, and §45 records that a preview
 * deployment cannot be used to find that out. Regenerate with
 * `node scripts/fetch-ad-fonts.mjs`.
 */

export const AD_FONT_BODY = "Hanken Grotesk";
export const AD_FONT_DISPLAY = "Bricolage Grotesque";

export type AdFont = { name: string; data: Buffer; weight: 400 | 700; style: "normal" };

const decode = (b64: string) => Buffer.from(b64, "base64");

/** Parsed once at module scope — never per render. */
export const AD_FONTS: AdFont[] = [
  { name: AD_FONT_BODY, data: decode(HANKEN_400_B64), weight: 400, style: "normal" },
  { name: AD_FONT_BODY, data: decode(HANKEN_700_B64), weight: 700, style: "normal" },
  { name: AD_FONT_DISPLAY, data: decode(BRICOLAGE_700_B64), weight: 700, style: "normal" },
];

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/** Every codepoint a font's cmap maps. Formats 4 and 12 only, which is all Google serves. */
function codepoints(font: Buffer): Set<number> {
  const out = new Set<number>();
  const tables = font.readUInt16BE(4);
  let cmapAt = 0;
  for (let i = 0; i < tables; i++) {
    const at = 12 + 16 * i;
    if (font.subarray(at, at + 4).toString("latin1") === "cmap") cmapAt = font.readUInt32BE(at + 8);
  }
  if (!cmapAt) return out;

  const subtables = font.readUInt16BE(cmapAt + 2);
  let best = 0;
  let bestFormat = 0;
  for (let i = 0; i < subtables; i++) {
    const at = cmapAt + 4 + 8 * i;
    const sub = cmapAt + font.readUInt32BE(at + 4);
    const format = font.readUInt16BE(sub);
    if (format === 4 || format === 12) {
      // Prefer 12 when both exist; otherwise take whichever we found.
      if (format >= bestFormat) {
        best = sub;
        bestFormat = format;
      }
    }
  }
  if (!best) return out;

  if (bestFormat === 4) {
    const segX2 = font.readUInt16BE(best + 6);
    const segs = segX2 / 2;
    for (let i = 0; i < segs; i++) {
      const end = font.readUInt16BE(best + 14 + 2 * i);
      const start = font.readUInt16BE(best + 16 + segX2 + 2 * i);
      if (start === 0xffff) continue;
      for (let c = start; c <= Math.min(end, 0xfffe); c++) out.add(c);
    }
  } else {
    const groups = font.readUInt32BE(best + 12);
    for (let i = 0; i < groups; i++) {
      const at = best + 16 + 12 * i;
      const start = font.readUInt32BE(at);
      const end = font.readUInt32BE(at + 4);
      for (let c = start; c <= end; c++) out.add(c);
    }
  }
  return out;
}

/**
 * ⚠️ THE INTERSECTION, NOT THE UNION. A glyph present in only one face is
 * still missing whenever the other is asked to draw it, and the whole point is
 * that no draw ever finds nothing.
 *
 * Derived from the shipped bytes rather than committed as a list, so it cannot
 * drift from the fonts the way a generated table would.
 */
export const AD_FONT_COVERAGE: Set<number> = (() => {
  let shared: Set<number> | null = null;
  for (const font of AD_FONTS) {
    const cs = codepoints(font.data);
    if (shared === null) shared = cs;
    else for (const c of Array.from(shared)) if (!cs.has(c)) shared.delete(c);
  }
  return shared ?? new Set<number>();
})();

/**
 * ⚠️ A GLYPH NO REGISTERED FONT HAS MAKES SATORI FETCH ONE FROM GOOGLE, MID
 * RENDER, FROM INSIDE THE LAMBDA. Proven in step 1: U+2713 produced
 * "Failed to load dynamic font for ✓ … Status: 400", drew tofu, and returned a
 * perfectly valid PNG. Silent, plausible, and a network round trip on every
 * render — exactly what `presentationBrandStorage.ts` argues against.
 *
 * So every string is filtered to the shared coverage before it reaches satori.
 * A company name in another script loses its unrenderable characters rather
 * than turning the render into an HTTP request.
 *
 * ⚠️ Iterated by CODE POINT (`for..of`), not by UTF-16 unit, or an astral
 * character is split into two lone surrogates.
 */
export function sanitiseForFont(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && AD_FONT_COVERAGE.has(cp)) out += ch;
  }
  // Collapse whatever gap the removals left, so "Zhang 中文 Lets" does not
  // render as "Zhang  Lets" with a hole in it.
  return out.replace(/\s{2,}/g, " ").trim();
}

/** Does this string survive intact? Used to warn rather than to block. */
export function fullyCovered(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined || !AD_FONT_COVERAGE.has(cp)) return false;
  }
  return true;
}
