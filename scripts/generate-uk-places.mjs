#!/usr/bin/env node
/**
 * Regenerate public/data/uk-places.json — the town gazetteer the radius search
 * resolves a typed place name against (§66 / §67).
 *
 *     npm run gen:places            # download GeoNames GB.zip and rebuild
 *     npm run gen:places -- ./GB.zip  # rebuild from a local copy
 *
 * ⚠️ THIS SCRIPT EXISTS SO THE COMMITTED DATA HAS A RECIPE. A data file in the
 * tree with no way to rebuild it is the drift §11 keeps recording, and
 * scripts/fetch-ad-fonts.mjs is the precedent.
 *
 * Source: GeoNames GB.zip, CC BY 4.0 — ⚠️ ATTRIBUTION IS REQUIRED, and it
 * lives in the output file's own `source` field so a commit that shrinks the
 * payload cannot quietly drop it. ukPlaces.test.ts asserts it is still there.
 *
 * ── The three things that would otherwise fail silently ──────────────────
 *
 * 1. ⚠️ THE ZIP CANNOT BE READ FROM ITS LOCAL FILE HEADER. GB.zip sets
 *    general-purpose bit 3, so every local header reports compressed size 0
 *    and uncompressed size 0 and the real figures live in a trailing data
 *    descriptor. A local-header reader inflates nothing and writes an EMPTY
 *    GAZETTEER SUCCESSFULLY. Verified on the live download: flags 0x808, and
 *    the first entry is `readme.txt` rather than GB.txt, so "take the first
 *    entry" is wrong too. We scan back for the EOCD, read the central
 *    directory — whose sizes ARE correct — and seek from there.
 *
 * 2. ⚠️ THE OUTCODE IS THE NEAREST CENTROID WITHIN THE PLACE'S OWN POSTCODE
 *    AREA, not the nearest overall. Unconstrained, the nearest centroid sits
 *    in a different area for roughly 3% of places, which would put
 *    "Salisbury (BA12)" in front of a customer. Constrained it costs about
 *    five hundredths of a kilometre on the mean.
 *
 * 3. ⚠️ SORTED BY CODEPOINT, NEVER localeCompare. ICU ordering is
 *    version-dependent, which makes "deterministic output" machine-dependent
 *    and the drift test unreproducible.
 *
 * ⚠️ THE ONE OUTCOME THIS MUST NEVER HAVE IS A SMALLER FILE WRITTEN
 * SUCCESSFULLY, so every checked failure throws with its cause named and the
 * floors below refuse a plausible-looking but shrunken result. An unchecked
 * failure still aborts with nothing written — verified by mutation — it just
 * reports a TypeError rather than a sentence.
 *
 * ⚠️ The ray-cast below restates the one in src/lib/geoRadius.ts, because an
 * .mjs script cannot import TypeScript. That is only acceptable because
 * src/lib/__tests__/ukPlaces.test.ts re-checks the COMMITTED OUTPUT with the
 * real distanceToAreaKm — so this copy drifting is caught rather than trusted.
 */
import { createHash } from "node:crypto";
import { gzipSync, inflateRawSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GEOJSON = resolve(ROOT, "public/data/uk-postcode-areas.geojson");
const OUTCODES_TS = resolve(ROOT, "src/lib/outcodes.ts");
const OUT = resolve(ROOT, "public/data/uk-places.json");
const URL = "https://download.geonames.org/export/dump/GB.zip";

/** Below this, a place is too small to be worth a customer typing. */
const MIN_POPULATION = 1;
/** Sanity floors — a source change that halves the data must fail, not ship. */
const MIN_ROWS = 90_000;
const MIN_OUTCODES = 2_856;
const MIN_KEPT = 5_000;

// ── zip ───────────────────────────────────────────────────────────────────

/** The entry's raw bytes, read via the CENTRAL DIRECTORY (see note 1). */
function readZipEntry(buf, wanted) {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65_536; i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error("GB.zip: no end-of-central-directory record — truncated?");
  }

  const entries = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let n = 0; n < entries; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) {
      throw new Error(`GB.zip: bad central directory entry ${n}`);
    }
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const localAt = buf.readUInt32LE(at + 42);
    const name = buf.slice(at + 46, at + 46 + nameLen).toString("utf8");
    names.push(name);

    if (name === wanted) {
      if (buf.readUInt32LE(localAt) !== 0x04034b50) {
        throw new Error(`GB.zip: ${name} has no local file header`);
      }
      // ⚠️ The LOCAL header's name/extra lengths, not the central one's —
      // they legitimately differ, and getting this wrong offsets the data.
      const lNameLen = buf.readUInt16LE(localAt + 26);
      const lExtraLen = buf.readUInt16LE(localAt + 28);
      const from = localAt + 30 + lNameLen + lExtraLen;
      const raw = buf.slice(from, from + compressed);
      if (method === 0) return raw;
      if (method === 8) return inflateRawSync(raw);
      throw new Error(`GB.zip: ${name} uses compression method ${method}`);
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(
    `GB.zip: ${wanted} is not in the archive (found: ${names.join(", ")})`
  );
}

// ── geometry (restated from src/lib/geoRadius.ts — see the header) ─────────

const KM_PER_DEG_LAT = 110.57;
const KM_PER_DEG_LNG_EQUATOR = 111.32;

function insideFeature(lat, lng, feature) {
  for (const polygon of feature.geometry.coordinates) {
    const outer = polygon[0];
    let inside = false;
    for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
      const [xi, yi] = outer[i];
      const [xj, yj] = outer[j];
      if (
        yi > lat !== yj > lat &&
        lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
      ) {
        inside = !inside;
      }
    }
    if (inside) return true;
  }
  return false;
}

function km(aLat, aLng, bLat, bLng) {
  const kx = KM_PER_DEG_LNG_EQUATOR * Math.cos((aLat * Math.PI) / 180);
  const dx = (aLng - bLng) * kx;
  const dy = (aLat - bLat) * KM_PER_DEG_LAT;
  return Math.sqrt(dx * dx + dy * dy);
}

// ── inputs ────────────────────────────────────────────────────────────────

/** OUTCODE_CENTROIDS, parsed out of the TypeScript (an .mjs cannot import it). */
function readOutcodes() {
  const src = readFileSync(OUTCODES_TS, "utf8");
  const out = [];
  const re = /^\s*([A-Z]{1,2}\d[A-Z0-9]?):\s*\[\s*(-?[\d.]+),\s*(-?[\d.]+)\s*\]/gm;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    out.push({
      outcode: m[1],
      area: m[1].match(/^[A-Z]{1,2}/)[0],
      lat: Number(m[2]),
      lng: Number(m[3]),
    });
  }
  if (out.length < MIN_OUTCODES) {
    throw new Error(
      `outcodes.ts: parsed only ${out.length} centroids, expected at least ${MIN_OUTCODES} — has the file's shape changed?`
    );
  }
  return out;
}

async function loadZip(arg) {
  if (arg) return readFileSync(resolve(arg));
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`GeoNames: HTTP ${res.status} for ${URL}`);
  return Buffer.from(await res.arrayBuffer());
}

// ── build ─────────────────────────────────────────────────────────────────

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

async function main() {
  const zip = await loadZip(process.argv[2]);
  const text = readZipEntry(zip, "GB.txt").toString("utf8");
  const rows = text.split("\n");
  if (rows.length < MIN_ROWS) {
    throw new Error(
      `GB.txt: ${rows.length} rows, expected at least ${MIN_ROWS} — wrong entry, or a truncated download?`
    );
  }

  const features = JSON.parse(readFileSync(GEOJSON, "utf8")).features;
  const outcodes = readOutcodes();
  const byArea = new Map();
  for (const o of outcodes) {
    if (!byArea.has(o.area)) byArea.set(o.area, []);
    byArea.get(o.area).push(o);
  }

  const stats = {
    rows: rows.length,
    populated: 0,
    outsideAnyArea: 0,
    noOutcodeInArea: 0,
    duplicates: 0,
  };
  const seen = new Set();
  const places = [];
  const distances = [];

  for (const line of rows) {
    if (!line) continue;
    const c = line.split("\t");
    if (c.length < 15 || c[6] !== "P") continue;
    const population = Number(c[14]);
    if (!Number.isFinite(population) || population < MIN_POPULATION) continue;
    stats.populated++;

    const lat = Number(c[4]);
    const lng = Number(c[5]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const feature = features.find((f) => insideFeature(lat, lng, f));
    if (!feature) {
      // ⚠️ Northern Ireland and the offshore islands. The boundary file has no
      // BT feature at all, so a BT centre resolves to zero areas — dropping
      // these makes that trap unreachable through the town path (§66.2).
      stats.outsideAnyArea++;
      continue;
    }

    const area = String(feature.properties.area).toUpperCase();
    const candidates = byArea.get(area);
    if (!candidates || candidates.length === 0) {
      stats.noOutcodeInArea++;
      continue;
    }
    let best = candidates[0];
    let bestD = Infinity;
    for (const o of candidates) {
      const d = km(lat, lng, o.lat, o.lng);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }

    const name = c[1];
    // ⚠️ Defensive, and currently a no-op: GeoNames yields zero duplicate
    // name|outcode pairs today, so removing this changes nothing — a mutation
    // run confirmed it. Kept because the pair is the gazetteer's identity and
    // ukPlaces.test.ts asserts uniqueness over the committed file, so a source
    // that ever does produce one must fail here rather than there.
    const key = `${name}|${best.outcode}`;
    if (seen.has(key)) {
      stats.duplicates++;
      continue;
    }
    seen.add(key);
    distances.push(bestD);
    places.push([
      name,
      Math.round(lat * 1000) / 1000,
      Math.round(lng * 1000) / 1000,
      best.outcode,
      population,
    ]);
  }

  if (places.length < MIN_KEPT) {
    throw new Error(
      `Only ${places.length} places survived, expected at least ${MIN_KEPT} — refusing to write a gazetteer that small.`
    );
  }

  // ⚠️ Codepoint order, never localeCompare (see note 3).
  places.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : 0));

  const body = places.map((p) => JSON.stringify(p)).join(",\n");
  const json =
    `{ "generated": ${JSON.stringify(new Date().toISOString().slice(0, 10))},\n` +
    `  "source": "GeoNames GB.txt (CC BY 4.0) — feature class P, resolved against public/data/uk-postcode-areas.geojson",\n` +
    `  "count": ${places.length},\n` +
    `  "places": [\n${body}\n]}\n`;
  writeFileSync(OUT, json, "utf8");

  const sorted = [...distances].sort((a, b) => a - b);
  const names = new Set(places.map((p) => p[0]));
  const byName = new Map();
  for (const p of places) byName.set(p[0], (byName.get(p[0]) ?? 0) + 1);
  const ambiguous = [...byName.values()].filter((n) => n > 1).length;
  const gz = gzipSync(Buffer.from(json)).length;

  const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
  console.log(`
  uk-places.json written to ${OUT}

    rows read            ${stats.rows}
    class P, populated   ${stats.populated}
    outside any area     ${stats.outsideAnyArea}   (NI + offshore, dropped on purpose)
    no outcode in area   ${stats.noOutcodeInArea}
    duplicates dropped   ${stats.duplicates}
    KEPT                 ${places.length}

    distinct names       ${names.size}
    ambiguous names      ${ambiguous}   (${places.length - names.size} extra entries share one)

    outcode distance     mean ${(distances.reduce((a, b) => a + b, 0) / distances.length).toFixed(2)} km` +
    `  median ${median(sorted).toFixed(2)}  p95 ${sorted[Math.floor(sorted.length * 0.95)].toFixed(2)}  max ${sorted[sorted.length - 1].toFixed(2)}

    size                 ${kb(json.length)} raw · ${kb(gz)} gzip
    sha256               ${createHash("sha256").update(json).digest("hex").slice(0, 16)}
`);
}

main().catch((err) => {
  console.error(`\n  gen:places FAILED — nothing written.\n  ${err.message}\n`);
  process.exit(1);
});
