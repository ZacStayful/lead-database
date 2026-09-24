import type { LatLng } from "@/lib/areaCentroids";

/**
 * Looking a UK town up by name, for the radius search's centre (§67).
 *
 * ⚠️ IT DOES NOT SHIP THE DATA. Every function takes the loaded array as an
 * argument, exactly as areasWithinRadius(features, …) does — which is what
 * keeps 250 KB out of the landing pages' first-load JS *and* keeps the logic
 * inside vitest, where the file it reads is the one in the tree.
 *
 * public/data/uk-places.json holds the rows; scripts/generate-uk-places.mjs
 * builds it; src/lib/__tests__/ukPlaces.test.ts guards what was committed.
 */

/** `[name, lat, lng, outcode, population]` — one row of uk-places.json. */
export type PlaceTuple = [
  name: string,
  lat: number,
  lng: number,
  outcode: string,
  population: number,
];

export interface PlaceMatch {
  name: string;
  centre: LatLng;
  outcode: string;
  population: number;
  /** "Newport (NP20)" — what the customer picks from. */
  label: string;
}

/** Suggestions offered at once. More is a list nobody reads. */
export const PLACE_SUGGESTION_LIMIT = 6;
/** Below this, a query matches too much to be worth ranking. */
export const PLACE_MIN_QUERY = 2;

/**
 * ⚠️ THE DISAMBIGUATOR IS THE BARE OUTCODE, NEVER cityForArea.
 *
 * Newport on the Isle of Wight resolves to PO30, and cityForArea("PO") is
 * "Portsmouth" — so an area label would read "Newport (PO30 — Portsmouth)",
 * which is simply wrong. The six Newports land on six distinct outcodes
 * (NP20, PO30, TF10, CB11, HU15, SA42), so the outcode alone separates them.
 *
 * ⚠️ And do not reach for extractCity() either — §40.14 measured it wrong on
 * the commonest UK address shape and banned it from three surfaces. Different
 * job.
 */
export function placeLabel(name: string, outcode: string): string {
  return `${name} (${outcode})`;
}

/**
 * The comparison form of a place name.
 *
 * ⚠️ APOSTROPHES ARE THE LOAD-BEARING RULE, NOT ACCENTS. Exactly two of the
 * 6,222 names are non-ASCII — Bo’ness and Redmarley D’Abitot — and both are
 * typographic apostrophes, so `Bo’ness`, `Bo'ness` and `Boness` must all
 * collide. The NFD pass costs nothing and covers a future import; the
 * apostrophe pass is what anybody will actually hit.
 *
 * ⚠️ Spaces are COLLAPSED, never removed. Removing them wrecks prefix ranking
 * and collides "Newport" with "New Port".
 *
 * `saint` → `st` because GeoNames spells them out — "Saint Andrews", "Saint
 * Albans" — and nobody types that.
 */
export function normalisePlaceName(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’'`´]/g, "")
    .replace(/[-–—./,]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((t) => (t === "saint" ? "st" : t))
    .join(" ");
}

interface IndexedPlace {
  place: PlaceTuple;
  norm: string;
  tokens: string[];
}

export interface PlaceIndex {
  entries: IndexedPlace[];
}

/**
 * Precompute the comparison forms once per load, so a keystroke is one pass of
 * string compares rather than 6,222 normalisations.
 *
 * ⚠️ Sorted by population DESCENDING here, so every tier in searchPlaces comes
 * out ranked without a second sort. Ties break on name, then outcode, so the
 * order is total and the same query always returns the same list.
 */
export function indexPlaces(places: PlaceTuple[]): PlaceIndex {
  const entries = places.map((place) => {
    const norm = normalisePlaceName(place[0]);
    return { place, norm, tokens: norm.split(" ").filter(Boolean) };
  });
  entries.sort((a, b) => {
    if (b.place[4] !== a.place[4]) return b.place[4] - a.place[4];
    if (a.place[0] !== b.place[0]) return a.place[0] < b.place[0] ? -1 : 1;
    return a.place[3] < b.place[3] ? -1 : a.place[3] > b.place[3] ? 1 : 0;
  });
  return { entries };
}

function toMatch(p: PlaceTuple): PlaceMatch {
  return {
    name: p[0],
    centre: [p[1], p[2]],
    outcode: p[3],
    population: p[4],
    label: placeLabel(p[0], p[3]),
  };
}

/**
 * Places matching `query`, best first.
 *
 * Four tiers, in order: an exact name; a whole-name prefix; any TOKEN's prefix
 * (so "trent" finds Stoke-on-Trent); anywhere in the name. Within a tier the
 * index's population order is kept — biggest first, which is what puts the
 * Gwent Newport above the Isle of Wight one.
 *
 * ⚠️ A query shorter than PLACE_MIN_QUERY returns nothing rather than the
 * biggest towns: one letter matches too much to rank meaningfully, and an
 * unasked-for list appearing on the first keystroke reads as noise.
 */
export function searchPlaces(
  index: PlaceIndex,
  query: string,
  limit: number = PLACE_SUGGESTION_LIMIT
): PlaceMatch[] {
  const q = normalisePlaceName(query);
  if (q.length < PLACE_MIN_QUERY) return [];

  const exact: PlaceTuple[] = [];
  const prefix: PlaceTuple[] = [];
  const token: PlaceTuple[] = [];
  const anywhere: PlaceTuple[] = [];

  for (const e of index.entries) {
    if (e.norm === q) exact.push(e.place);
    else if (e.norm.startsWith(q)) prefix.push(e.place);
    else if (e.tokens.some((t) => t.startsWith(q))) token.push(e.place);
    else if (e.norm.includes(q)) anywhere.push(e.place);
  }

  return [...exact, ...prefix, ...token, ...anywhere]
    .slice(0, limit)
    .map(toMatch);
}

/**
 * Every place whose name matches `query` exactly.
 *
 * ⚠️ Separate from searchPlaces because the RESOLVER needs a different answer
 * from the dropdown. Typing "Salisbury" in full should just work, and typing
 * "Newport" must NOT — six towns share it, and picking the biggest on the
 * customer's behalf silently centres their filter on the wrong one.
 */
export function exactPlaces(index: PlaceIndex, query: string): PlaceMatch[] {
  const q = normalisePlaceName(query);
  if (q.length < PLACE_MIN_QUERY) return [];
  return index.entries
    .filter((e) => e.norm === q)
    .map((e) => toMatch(e.place));
}
