#!/usr/bin/env node
/**
 * Regenerate the ad builder's fonts (§65).
 *
 * The faces are the app's own — Hanken Grotesk for body and Bricolage
 * Grotesque for display, the two `globals.css` already loads — so an ad looks
 * like the product it came from.
 *
 * ⚠️ THIS SCRIPT EXISTS SO THE COMMITTED BYTES HAVE A RECIPE. A binary in the
 * tree with no way to rebuild it is the drift §11 keeps recording. Run:
 *
 *     node scripts/fetch-ad-fonts.mjs
 *
 * Three things it does that are not obvious, each proven by rendering:
 *
 * 1. ⚠️ IT ASKS GOOGLE WITH A LEGACY USER-AGENT. The CSS2 API serves woff2 to
 *    a modern browser and TTF to anything else — and satori cannot read woff2
 *    at all.
 *
 * 2. ⚠️ IT SUBSETS WITH `text=`, and the character set below is deliberately
 *    wider than English. A glyph missing from every registered font makes
 *    satori fetch a font from Google AT RENDER TIME, inside the lambda; the
 *    request 400s, the glyph draws as tofu, and a perfectly valid PNG comes
 *    back. Latin-1, Latin Extended-A, smart quotes and the currency symbols
 *    are all in, because an operator's company name is not our choice.
 *
 * 3. ⚠️ IT STRIPS `GPOS`, `GSUB` AND `GDEF`. Satori DOES apply GPOS kerning,
 *    and applies it wrongly: the glyph shifts but the run's measured width
 *    does not, so every kerned pair leaves slack at the end of its word.
 *    "Talk to" renders "Talk  to" — which is template 8's call to action, on
 *    every ad it ever makes. Dropping the tables fixes it exactly, and cuts
 *    the three files from 122 KB to 77 KB on the way.
 *
 * The output is base64 inside a .ts module rather than a .ttf on disk, on
 * purpose: a bundled module cannot fail to be traced into the lambda, where a
 * runtime `readFileSync` of a path Vercel did not trace fails at FIRST
 * INVOCATION with ENOENT — and §45 records that a preview deployment cannot be
 * used to find that out.
 */
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "lib", "ads", "fonts");

const FACES = [
  { file: "hanken-400", family: "Hanken+Grotesk:wght@400;700", pick: 0, weight: 400, name: "Hanken Grotesk" },
  { file: "hanken-700", family: "Hanken+Grotesk:wght@400;700", pick: 1, weight: 700, name: "Hanken Grotesk" },
  { file: "bricolage-700", family: "Bricolage+Grotesque:opsz,wght@12..96,700", pick: 0, weight: 700, name: "Bricolage Grotesque" },
];

const DROP = new Set(["GPOS", "GSUB", "GDEF"]);

function charset() {
  const cp = [];
  for (let c = 0x20; c < 0x7f; c++) cp.push(c);        // ASCII printable
  for (let c = 0xa0; c < 0x100; c++) cp.push(c);        // Latin-1 Supplement
  for (let c = 0x100; c < 0x180; c++) cp.push(c);       // Latin Extended-A
  // Dashes, smart quotes, ellipsis, bullet, prime, currency, arrows.
  for (const c of "‐‑‒–—―‘’‚“”„†‡•…‰′″‹›⁄₠€₹™←→×÷") {
    cp.push(c.codePointAt(0));
  }
  return String.fromCodePoint(...cp);
}

/** Rewrite the sfnt without the named tables, fixing offsets and the directory. */
function stripTables(buf, drop) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const version = dv.getUint32(0);
  const count = dv.getUint16(4);
  const records = [];
  for (let i = 0; i < count; i++) {
    const at = 12 + 16 * i;
    // tag(4) checksum(4) offset(4) length(4) — get these wrong by four bytes
    // and the script writes a plausible-looking font that renders nothing.
    records.push({
      tag: buf.subarray(at, at + 4).toString("latin1"),
      checksum: dv.getUint32(at + 4),
      offset: dv.getUint32(at + 8),
      length: dv.getUint32(at + 12),
    });
  }
  const keep = records.filter((r) => !drop.has(r.tag)).sort((a, b) => (a.tag < b.tag ? -1 : 1));
  const n = keep.length;
  let pow = 1;
  while (pow * 2 <= n) pow *= 2;
  const searchRange = pow * 16;
  const entrySelector = Math.log2(pow) | 0;

  const head = Buffer.alloc(12 + 16 * n);
  head.writeUInt32BE(version, 0);
  head.writeUInt16BE(n, 4);
  head.writeUInt16BE(searchRange, 6);
  head.writeUInt16BE(entrySelector, 8);
  head.writeUInt16BE(n * 16 - searchRange, 10);

  const chunks = [head];
  let cursor = head.length;
  const placed = [];
  for (const r of keep) {
    const pad = (4 - (cursor % 4)) % 4;
    if (pad) {
      chunks.push(Buffer.alloc(pad));
      cursor += pad;
    }
    placed.push({ ...r, newOffset: cursor });
    chunks.push(buf.subarray(r.offset, r.offset + r.length));
    cursor += r.length;
  }
  const out = Buffer.concat(chunks);
  placed.forEach((r, i) => {
    const at = 12 + 16 * i;
    out.write(r.tag, at, 4, "latin1");
    out.writeUInt32BE(r.checksum, at + 4);
    out.writeUInt32BE(r.newOffset, at + 8);
    out.writeUInt32BE(r.length, at + 12);
  });
  return out;
}

async function css(family, text) {
  const url = `https://fonts.googleapis.com/css2?family=${family}&text=${encodeURIComponent(text)}`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/4.0" } });
  if (!res.ok) throw new Error(`css ${res.status} for ${family}`);
  const body = await res.text();
  const urls = Array.from(body.matchAll(/https:\/\/[^)]+/g)).map((m) => m[0]);
  if (!urls.length) throw new Error(`no font urls for ${family} — did the API stop serving TTF?`);
  return urls;
}

const text = charset();
let total = 0;
for (const face of FACES) {
  const urls = await css(face.family, text);
  const url = urls[face.pick];
  if (!url) throw new Error(`no url at index ${face.pick} for ${face.family}`);
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/4.0" } });
  if (!res.ok) throw new Error(`font ${res.status}`);
  const raw = Buffer.from(await res.arrayBuffer());
  if (raw.readUInt32BE(0) !== 0x00010000) throw new Error("not a TrueType sfnt — woff2 was served");
  const stripped = stripTables(raw, DROP);
  total += stripped.length;

  const ident = face.file.replace(/-/g, "_").toUpperCase();
  writeFileSync(
    join(OUT, `${face.file}.ts`),
    `// GENERATED by scripts/fetch-ad-fonts.mjs — do not edit by hand.\n` +
      `// ${face.name} ${face.weight}, Latin subset, GPOS/GSUB/GDEF stripped.\n` +
      `// ${stripped.length} bytes (from ${raw.length} before stripping).\n` +
      `export const ${ident}_B64 =\n  "${stripped.toString("base64")}";\n`
  );
  console.log(`${face.file}.ts  ${raw.length} -> ${stripped.length} bytes`);
}
console.log(`total ${total} bytes of font`);
