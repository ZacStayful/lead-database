/** [latitude, longitude] */
export type LatLng = [number, number];

/**
 * Approximate centroid of each UK postcode area, [lat, lng], derived from
 * public/data/uk-postcode-areas.geojson (shoelace centroid of each area's
 * largest polygon, so islands do not skew it). Used ONLY to rank filter
 * expansion suggestions by how close an area is to the customer's existing
 * selection — never for anything precision-sensitive. Regenerate from the
 * geojson if the boundary file ever changes.
 *
 * Areas absent from the geojson (e.g. BT) simply have no entry: distance to
 * them is unknown and they rank after areas whose distance is known.
 */
export const AREA_CENTROIDS: Record<string, LatLng> = {
  AB: [57.008, -3.305],
  AL: [51.792, -0.404],
  B: [52.672, -1.654],
  BA: [51.163, -2.155],
  BB: [53.923, -2.417],
  BD: [54.069, -2.087],
  BH: [50.671, -2.146],
  BL: [53.649, -2.433],
  BN: [50.905, 0.071],
  BR: [51.357, 0.096],
  BS: [51.337, -2.688],
  CA: [54.595, -2.651],
  CB: [52.209, 0.444],
  CF: [51.761, -3.514],
  CH: [53.165, -3.184],
  CM: [51.732, 0.582],
  CO: [52.066, 0.699],
  CR: [51.369, -0.069],
  CT: [51.214, 1.066],
  CV: [52.361, -1.293],
  CW: [53.056, -2.537],
  DA: [51.374, 0.361],
  DD: [56.732, -3.01],
  DE: [52.992, -1.718],
  DG: [54.931, -4.567],
  DH: [54.846, -1.944],
  DL: [54.285, -1.922],
  DN: [53.706, -0.91],
  DT: [50.755, -2.464],
  DY: [52.386, -2.479],
  E: [51.633, -0.004],
  EC: [51.527, -0.096],
  EH: [55.645, -3.237],
  EN: [51.707, 0.024],
  EX: [50.744, -4.045],
  FK: [56.178, -4.376],
  FY: [53.736, -3.018],
  G: [56.178, -4.693],
  GL: [51.889, -1.864],
  GU: [51.131, -0.991],
  HA: [51.571, -0.413],
  HD: [53.56, -1.821],
  HG: [54.066, -1.707],
  HP: [51.823, -1.001],
  HR: [51.986, -2.849],
  HS: [58.211, -6.584],
  HU: [53.684, -0.05],
  HX: [53.754, -2.034],
  IG: [51.62, 0.099],
  IP: [52.08, 1.443],
  IV: [58.267, -4.772],
  KA: [55.162, -4.811],
  KT: [51.323, -0.41],
  KW: [59.095, -2.874],
  KY: [56.31, -3.052],
  L: [53.608, -2.844],
  LA: [54.05, -2.609],
  LD: [51.955, -3.427],
  LE: [52.782, -0.885],
  LL: [52.867, -4.55],
  LN: [53.377, 0.037],
  LS: [53.789, -1.287],
  LU: [51.904, -0.671],
  M: [53.558, -2.198],
  ME: [51.452, 0.594],
  MK: [51.975, -0.968],
  ML: [55.516, -3.583],
  N: [51.596, -0.071],
  NE: [55.169, -2.381],
  NG: [52.956, -0.373],
  NN: [52.349, -0.966],
  NP: [51.861, -2.991],
  NR: [52.763, 1.484],
  NW: [51.541, -0.255],
  OL: [53.561, -1.991],
  OX: [51.911, -1.522],
  PA: [56.053, -5.544],
  PE: [52.803, 0.059],
  PH: [56.779, -5.253],
  PL: [50.632, -4.451],
  PO: [50.887, -0.803],
  PR: [53.882, -2.727],
  RG: [51.415, -1.352],
  RH: [51.015, -0.33],
  RM: [51.553, 0.296],
  S: [53.389, -1.771],
  SA: [51.84, -5.114],
  SE: [51.446, 0.056],
  SG: [52.07, -0.016],
  SK: [53.223, -1.855],
  SL: [51.518, -0.742],
  SM: [51.323, -0.198],
  SN: [51.394, -1.688],
  SO: [51.097, -1.307],
  SP: [51.019, -1.812],
  SR: [54.829, -1.35],
  SS: [51.566, 0.904],
  ST: [52.826, -2.088],
  SW: [51.424, -0.208],
  SY: [52.364, -3.949],
  TA: [51.165, -3.597],
  TD: [55.329, -2.808],
  TF: [52.891, -2.474],
  TN: [50.981, 0.92],
  TQ: [50.605, -3.769],
  TR: [50.032, -5.177],
  TS: [54.43, -1.146],
  TW: [51.426, -0.562],
  UB: [51.586, -0.487],
  W: [51.515, -0.303],
  WA: [53.302, -2.38],
  WC: [51.525, -0.116],
  WD: [51.653, -0.484],
  WF: [53.636, -1.51],
  WN: [53.558, -2.765],
  WR: [52.23, -2.39],
  WS: [52.776, -1.902],
  WV: [52.499, -2.489],
  YO: [54.012, -0.428],
  ZE: [60.158, -1.217],};

/** Great-circle distance in km between two [lat, lng] points. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * Distance in km from `area` to the NEAREST of `fromAreas`, or null when
 * either side has no known centroid. Codes must already be uppercase.
 */
export function distanceToNearestKm(
  area: string,
  fromAreas: string[]
): number | null {
  const from = AREA_CENTROIDS[area];
  if (!from) return null;
  let best: number | null = null;
  for (const other of fromAreas) {
    const c = AREA_CENTROIDS[other];
    if (!c) continue;
    const d = haversineKm(from, c);
    if (best === null || d < best) best = d;
  }
  return best;
}
