/**
 * UK postcode helpers used at ingest (to store postcode / postcode_area on a
 * lead) and in the lead-filtering UI (to label a postcode area with a friendly
 * city name).
 *
 * A UK postcode is OUTWARD + INWARD, e.g. "CR2 6BL":
 *   outward = area letters + district digit(s), e.g. "CR2"
 *   inward  = one digit + two letters,          e.g. "6BL"
 * The "postcode area" is the leading letters of the outward code ("CR").
 */

// Match a postcode anywhere in a string, tolerant of a missing/collapsed space
// between the outward and inward codes. Global + case-insensitive so we can take
// the LAST match — addresses put the postcode at the end, and run-together text
// ("…Park RdSouth Croydon CR2 6BL") does not affect a standalone postcode.
const POSTCODE_RE = /([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})/gi;

/**
 * Extract a UK postcode from the end of a free-text address, normalised to
 * uppercase with a single space before the inward code. Returns null when no
 * postcode can be found.
 */
export function extractPostcode(address?: string | null): string | null {
  if (!address) return null;
  const text = address.toUpperCase();
  let match: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  POSTCODE_RE.lastIndex = 0;
  while ((match = POSTCODE_RE.exec(text)) !== null) {
    last = match;
  }
  if (!last) return null;
  return `${last[1]} ${last[2]}`;
}

/** The postcode area — the letters before the first digit of the outward code. */
export function postcodeArea(postcode?: string | null): string | null {
  if (!postcode) return null;
  const m = postcode.toUpperCase().match(/^[A-Z]{1,2}/);
  return m ? m[0] : null;
}

/** Extract the postcode area directly from a free-text address. */
export function areaFromAddress(address?: string | null): string | null {
  return postcodeArea(extractPostcode(address));
}

/**
 * Postcode area → friendly display name. Covers the standard UK postcode areas
 * (the letter prefixes used by Royal Mail). Names favour the town most people
 * associate with the area; where an area spans a wider region the broader name
 * is used (e.g. LA → "Lancaster/Cumbria").
 */
export const POSTCODE_AREA_CITY: Record<string, string> = {
  AB: "Aberdeen",
  AL: "St Albans",
  B: "Birmingham",
  BA: "Bath",
  BB: "Blackburn",
  BD: "Bradford",
  BH: "Bournemouth",
  BL: "Bolton",
  BN: "Brighton",
  BR: "Bromley",
  BS: "Bristol",
  BT: "Belfast",
  CA: "Carlisle",
  CB: "Cambridge",
  CF: "Cardiff",
  CH: "Chester/Wirral",
  CM: "Chelmsford",
  CO: "Colchester",
  CR: "Croydon",
  CT: "Canterbury",
  CV: "Coventry",
  CW: "Crewe",
  DA: "Dartford",
  DD: "Dundee",
  DE: "Derby",
  DG: "Dumfries",
  DH: "Durham",
  DL: "Darlington",
  DN: "Doncaster",
  DT: "Dorchester",
  DY: "Dudley",
  E: "London (East)",
  EC: "London (City)",
  EH: "Edinburgh",
  EN: "Enfield",
  EX: "Exeter",
  FK: "Falkirk",
  FY: "Blackpool",
  G: "Glasgow",
  GL: "Gloucester",
  GU: "Guildford",
  GY: "Guernsey",
  HA: "Harrow",
  HD: "Huddersfield",
  HG: "Harrogate",
  HP: "Hemel Hempstead",
  HR: "Hereford",
  HS: "Outer Hebrides",
  HU: "Hull",
  HX: "Halifax",
  IG: "Ilford",
  IM: "Isle of Man",
  IP: "Ipswich",
  IV: "Inverness",
  JE: "Jersey",
  KA: "Kilmarnock",
  KT: "Kingston upon Thames",
  KW: "Kirkwall",
  KY: "Kirkcaldy",
  L: "Liverpool",
  LA: "Lancaster/Cumbria",
  LD: "Llandrindod Wells",
  LE: "Leicester",
  LL: "Llandudno",
  LN: "Lincoln",
  LS: "Leeds",
  LU: "Luton",
  M: "Manchester",
  ME: "Medway",
  MK: "Milton Keynes",
  ML: "Motherwell",
  N: "London (North)",
  NE: "Newcastle upon Tyne",
  NG: "Nottingham",
  NN: "Northampton",
  NP: "Newport",
  NR: "Norwich",
  NW: "London (North West)",
  OL: "Oldham",
  OX: "Oxford",
  PA: "Paisley",
  PE: "Peterborough",
  PH: "Perth",
  PL: "Plymouth",
  PO: "Portsmouth",
  PR: "Preston",
  RG: "Reading",
  RH: "Redhill",
  RM: "Romford",
  S: "Sheffield",
  SA: "Swansea",
  SE: "London (South East)",
  SG: "Stevenage",
  SK: "Stockport",
  SL: "Slough",
  SM: "Sutton",
  SN: "Swindon",
  SO: "Southampton",
  SP: "Salisbury",
  SR: "Sunderland",
  SS: "Southend-on-Sea",
  ST: "Stoke-on-Trent",
  SW: "London (South West)",
  SY: "Shrewsbury",
  TA: "Taunton",
  TD: "Galashiels",
  TF: "Telford",
  TN: "Tunbridge Wells",
  TQ: "Torquay",
  TR: "Truro",
  TS: "Teesside",
  TW: "Twickenham",
  UB: "Uxbridge",
  W: "London (West)",
  WA: "Warrington",
  WC: "London (West Central)",
  WD: "Watford",
  WF: "Wakefield",
  WN: "Wigan",
  WR: "Worcester",
  WS: "Walsall",
  WV: "Wolverhampton",
  YO: "York",
  ZE: "Lerwick",
};

/** Friendly city name for a postcode area, falling back to the area itself. */
export function cityForArea(area?: string | null): string {
  if (!area) return "";
  const key = area.toUpperCase();
  return POSTCODE_AREA_CITY[key] ?? key;
}

/** "CR — Croydon" style label for a postcode area. */
export function areaLabel(area: string): string {
  const city = POSTCODE_AREA_CITY[area.toUpperCase()];
  return city ? `${area.toUpperCase()} — ${city}` : area.toUpperCase();
}
