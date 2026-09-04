/**
 * The consent gate for Meta advertising measurement.
 *
 * ⚠️ THIS CURRENTLY RETURNS TRUE UNCONDITIONALLY, AND THAT IS A KNOWN,
 * DELIBERATE POSITION — not an oversight to be tidied up.
 *
 * UK PECR regulation 6 requires prior consent before storing or accessing
 * non-essential information on a user's device. `_fbp` and `_fbc` are
 * advertising cookies and are squarely non-essential, so a compliant setup
 * needs an opt-in banner that gates the pixel BEFORE it loads. The privacy
 * policy (§9) discloses the position accurately and says so in as many words.
 *
 * This function exists so that adding the banner is a one-line change here
 * rather than a hunt through the codebase. Every entry point already asks:
 *
 *   - `MetaPixel.tsx` — before injecting the script AND before minting `_fbc`
 *   - `api/enquiry/route.ts` — before sending the server-side Lead
 *
 * When the banner ships, this becomes a read of whatever the banner stores.
 *
 * ⚠️ KEEP THIS FILE ISOMORPHIC AND DEPENDENCY-FREE. It is imported by a client
 * component AND by server routes. It must never import from `hash.ts`,
 * `capi.ts` or anything else that reaches `node:crypto` — which is also why
 * this directory deliberately has NO index.ts barrel (a barrel would drag the
 * server modules into the client bundle through this one import).
 */
export function metaTrackingAllowed(): boolean {
  return true;
}
