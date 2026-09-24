import { describe, it, expect } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { OUTCODE_CENTROIDS } from "@/lib/outcodes";
import { distanceToAreaKm, type AreaFeature } from "@/lib/geoRadius";

/**
 * The drift guard over public/data/uk-places.json.
 *
 * ⚠️ IT GUARDS THE COMMITTED FILE, NOT THE GENERATOR. A `--check` that
 * re-derives from GeoNames would need the network and would fail on an
 * unrelated Tuesday, because GeoNames republishes weekly — so it could not
 * gate the build. These are invariants over what is actually in the tree.
 *
 * ⚠️ The inside-its-own-area check uses the REAL distanceToAreaKm. That is the
 * whole reason the generator is allowed to restate the ray-cast: an .mjs
 * script cannot import TypeScript, so the copy exists — and this is what
 * catches it drifting rather than trusting it not to.
 */

const ROOT = resolve(__dirname, "..", "..", "..");
const PATH = resolve(ROOT, "public/data/uk-places.json");
const GEOJSON = resolve(ROOT, "public/data/uk-postcode-areas.geojson");

type PlaceTuple = [string, number, number, string, number];
interface File {
  generated: string;
  source: string;
  count: number;
  places: PlaceTuple[];
}

const raw = readFileSync(PATH, "utf8");
const data = JSON.parse(raw) as File;
const places = data.places;

/** The server's own outcode rule, from api/customer/filter/route.ts. */
const OUTCODE_RE = /^[A-Z]{1,2}\d[A-Z0-9]?$/;
const areaOf = (outcode: string) => outcode.match(/^[A-Z]{1,2}/)![0];

const featureByArea = new Map<string, AreaFeature>();
for (const f of JSON.parse(readFileSync(GEOJSON, "utf8"))
  .features as AreaFeature[]) {
  featureByArea.set(String(f.properties.area).toUpperCase(), f);
}

describe("uk-places.json", () => {
  it("parses, and says how many it holds", () => {
    expect(Array.isArray(places)).toBe(true);
    expect(data.count).toBe(places.length);
    expect(places.length).toBeGreaterThan(5_000);
  });

  it("⚠️ keeps the CC BY attribution, which is a licence obligation", () => {
    // Asserted rather than trusted: the obvious way to shrink the payload is
    // to strip the header fields, and this one is not ours to drop.
    expect(data.source).toContain("GeoNames");
    expect(data.source).toContain("CC BY");
  });

  it("every row is the documented shape", () => {
    for (const p of places) {
      expect(p).toHaveLength(5);
      const [name, lat, lng, outcode, population] = p;
      expect(typeof name).toBe("string");
      expect(name.trim()).not.toBe("");
      expect(lat).toBeGreaterThan(49);
      expect(lat).toBeLessThan(61);
      expect(lng).toBeGreaterThan(-9);
      expect(lng).toBeLessThan(2.1);
      expect(typeof outcode).toBe("string");
      expect(population).toBeGreaterThan(0);
    }
  });

  it("⚠️ every outcode matches the server's regex", () => {
    // The highest-value assertion here. A town resolves, the client POSTs
    // radius_outcode, the server regex rejects it, the column goes null —
    // 200 OK, no error — and admin then reads "Hand-picked areas" for what
    // was a radius search. The column is plain text with no DB constraint, so
    // nothing downstream would complain.
    const bad = places.filter((p) => !OUTCODE_RE.test(p[3]));
    expect(bad.map((p) => `${p[0]} → ${p[3]}`)).toEqual([]);
  });

  it("every outcode is one we hold a centroid for", () => {
    const missing = places.filter((p) => !(p[3] in OUTCODE_CENTROIDS));
    expect(missing.map((p) => `${p[0]} → ${p[3]}`)).toEqual([]);
  });

  it("⚠️ every place sits INSIDE the area its outcode names", () => {
    // Uses the shipped distanceToAreaKm, which returns 0 for a point inside
    // any of a feature's polygons. This is what makes the generator's
    // restated ray-cast non-load-bearing.
    const strays: string[] = [];
    for (const [name, lat, lng, outcode] of places) {
      const feature = featureByArea.get(areaOf(outcode));
      if (!feature) {
        strays.push(`${name}: no feature for ${areaOf(outcode)}`);
        continue;
      }
      if (distanceToAreaKm([lat, lng], feature) !== 0) {
        strays.push(`${name} (${outcode}) is outside ${areaOf(outcode)}`);
      }
    }
    expect(strays.slice(0, 10)).toEqual([]);
  });

  it("no place is far from the outcode it was given", () => {
    // ⚠️ The thresholds are the generator's own printed figures with headroom,
    // not a guess. Measured on the committed file: mean 3.68 km, median 3.11,
    // p95 9.02, max 30.68 — and 72.5% within 5 km, which is where a first
    // draft of this assertion guessed 80% and failed. The point is to catch a
    // source change that moves the distribution, so it has to be anchored on
    // what the distribution actually is.
    const d = places
      .map(([, lat, lng, outcode]) => {
        const [oLat, oLng] = OUTCODE_CENTROIDS[outcode];
        const kx = 111.32 * Math.cos((lat * Math.PI) / 180);
        return Math.hypot((lng - oLng) * kx, (lat - oLat) * 110.57);
      })
      .sort((a, b) => a - b);
    const median = d[Math.floor(d.length / 2)];
    const p95 = d[Math.floor(d.length * 0.95)];
    expect(median).toBeLessThan(5);
    expect(p95).toBeLessThan(12);
    expect(d[d.length - 1]).toBeLessThan(35);
  });

  it("⚠️ holds nothing we have no boundary for", () => {
    // BT, IM, GY and JE all have centroids and NO feature in the geojson, so
    // a centre there resolves to zero areas — which §66.2 records applying as
    // an "anywhere" filter. Dropping them makes that unreachable through the
    // town path rather than merely guarded.
    const uncovered = ["BT", "IM", "GY", "JE"];
    for (const area of uncovered) {
      expect(
        Object.keys(OUTCODE_CENTROIDS).some((o) => areaOf(o) === area),
        `${area} should still have centroids`
      ).toBe(true);
      expect(featureByArea.has(area), `${area} should have no feature`).toBe(
        false
      );
      expect(
        places.filter((p) => areaOf(p[3]) === area).map((p) => p[0])
      ).toEqual([]);
    }
  });

  it("⚠️ no name could be mistaken for a postcode", () => {
    // parseOutcode is tried FIRST, so a name that parses as an outcode would
    // be unreachable by typing it. Safe by construction today — every outcode
    // contains a digit and no name does — and this is what keeps it so.
    const digits = places.filter((p) => /\d/.test(p[0]));
    expect(digits.map((p) => p[0])).toEqual([]);
    const parseable = places.filter((p) =>
      OUTCODE_RE.test(p[0].toUpperCase().replace(/\s+/g, ""))
    );
    expect(parseable.map((p) => p[0])).toEqual([]);
  });

  it("is sorted by codepoint, and holds no duplicate name+outcode", () => {
    // Codepoint, never localeCompare: ICU ordering is version-dependent, so
    // "deterministic output" would be machine-dependent.
    const keys = places.map((p) => `${p[0]}|${p[3]}`);
    expect(new Set(keys).size).toBe(keys.length);
    const sorted = [...places].sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : 0
    );
    expect(places.map((p) => p[0])).toEqual(sorted.map((p) => p[0]));
  });

  it("stays small enough to fetch on intent", () => {
    // ~252 KB raw, ~98 KB gzip. It loads only when someone uses radius search,
    // alongside the 562 KB boundary file they have already opted into.
    expect(statSync(PATH).size).toBeLessThan(300 * 1024);
  });

  it("names the towns a customer would actually type", () => {
    const byName = new Map(places.map((p) => [p[0], p]));
    for (const town of ["Salisbury", "Bristol", "Leicester", "Inverness"]) {
      expect(byName.has(town), `${town} is missing`).toBe(true);
    }
    // Five Newports on five distinct outcodes — the case the disambiguator
    // exists for.
    const newports = places.filter((p) => p[0] === "Newport");
    expect(newports.length).toBeGreaterThanOrEqual(2);
    expect(new Set(newports.map((p) => p[3])).size).toBe(newports.length);
  });
});
