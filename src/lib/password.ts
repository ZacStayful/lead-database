import { randomInt } from "crypto";

/**
 * Alphabet for generated passwords, with every character that gets misread
 * removed: no O or 0, no I, L or 1. An admin reading one of these down the
 * phone to a locked-out customer is the expected case, and a character that
 * needs "no, capital i, not a one" costs more of everyone's afternoon than the
 * entropy it contributes is worth.
 */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const GROUPS = 4;
const GROUP_LENGTH = 4;

/**
 * A one-time password for an admin to hand to a customer who cannot get in.
 *
 * `randomInt` rather than `Math.random`: this is a credential. randomInt is
 * drawn from the CSPRNG and rejects the biased tail, so an index into a
 * 31-character alphabet is uniform — which a `Math.random() * length` would
 * not quite be, for free.
 *
 * Grouped into fours for dictation. Sixteen characters from this alphabet is
 * roughly 79 bits, far beyond what a password meant to be replaced within the
 * hour needs — but customers keep these, so it is priced as though it will be
 * kept.
 *
 * Deliberately generated server-side and never accepted from a request body.
 * A route that sets an arbitrary password on any account is a much sharper
 * tool than the one this needs to be, and it would let a leaked admin key set
 * a password the real owner might plausibly have chosen themselves.
 */
export function generateTemporaryPassword(): string {
  const groups: string[] = [];
  for (let group = 0; group < GROUPS; group += 1) {
    let chars = "";
    for (let i = 0; i < GROUP_LENGTH; i += 1) {
      chars += ALPHABET[randomInt(ALPHABET.length)];
    }
    groups.push(chars);
  }
  return groups.join("-");
}
