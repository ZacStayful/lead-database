/**
 * The `user_data` block of a Conversions API event — the matching information.
 *
 * ⚠️ TWO CLASSES OF FIELD, AND MIXING THEM UP IS SILENT.
 *
 *   HASHED  — em, ph, fn, ln, country. Each is an ARRAY of lowercase hex
 *             SHA-256 strings.
 *   PLAIN   — fbp, fbc, client_ip_address, client_user_agent. Hashing any of
 *             these makes it permanently unmatchable, and Meta reports no
 *             error for it. `meta.test.ts` asserts the exact input strings
 *             survive, precisely to catch that.
 *
 * A field with no usable value is OMITTED ENTIRELY. Never `em: [""]` and never
 * `em: [null]` — an empty hash counts against the dataset's match quality.
 */
import { hashSha256, normaliseEmailForMeta, normalisePhoneForMeta, splitNameForMeta } from "./hash";

export type MetaUserData = {
  em?: string[];
  ph?: string[];
  fn?: string[];
  ln?: string[];
  country?: string[];
  fbp?: string;
  fbc?: string;
  client_ip_address?: string;
  client_user_agent?: string;
};

export type MetaUserInput = {
  email?: string | null;
  phone?: string | null;
  fullName?: string | null;
  /** Plain, never hashed. From the `_fbp` cookie. */
  fbp?: string | null;
  /** Plain, never hashed. From the `_fbc` cookie. */
  fbc?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export function buildMetaUserData(input: MetaUserInput): MetaUserData {
  const data: MetaUserData = {};

  const email = normaliseEmailForMeta(input.email);
  if (email) data.em = [hashSha256(email)];

  const phone = normalisePhoneForMeta(input.phone);
  if (phone) data.ph = [hashSha256(phone)];

  const { fn, ln } = splitNameForMeta(input.fullName);
  if (fn) data.fn = [hashSha256(fn)];
  if (ln) data.ln = [hashSha256(ln)];

  // The book is UK-only, so this is free match quality rather than a guess.
  // ct / zp / st are NOT sent: we do not hold them, and inventing them would
  // be worse than omitting them.
  data.country = [hashSha256("gb")];

  // --- Plain values below this line. Do not hash any of them. ---
  if (input.fbp) data.fbp = input.fbp;
  if (input.fbc) data.fbc = input.fbc;
  if (input.ipAddress) data.client_ip_address = input.ipAddress;
  if (input.userAgent) data.client_user_agent = input.userAgent;

  return data;
}
