/**
 * PII normalisation and hashing for Meta's Conversions API.
 *
 * Meta matches a conversion to a person by comparing SHA-256 hashes of
 * normalised contact details against the equivalent hash of a Meta account. So
 * two things have to be right, and BOTH fail silently when they are not:
 *
 *   1. The normalisation must match Meta's, or the hash is of a different
 *      string and matches nobody.
 *   2. The hash must be of the NORMALISED value, lowercase hex.
 *
 * There is no error for getting either wrong — you simply get a 0% match rate
 * and a dataset whose "Event Match Quality" score quietly sits at Poor. That is
 * why `__tests__/meta.test.ts` pins a known SHA-256 vector rather than
 * round-tripping the function against itself.
 *
 * ⚠️ SERVER ONLY — imports `node:crypto`. Never import this from a client
 * component (see the barrel warning in `consent.ts`).
 */
import { createHash } from "node:crypto";
import { EMAIL_RE, isJunkName, normaliseUkMobile } from "@/lib/leadQuality";
import { firstNameOf } from "@/lib/messaging/draftContext";

/** Lowercase hex SHA-256, which is the only form Meta accepts. */
export function hashSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Email → trimmed, lowercased, validated.
 *
 * Returns null rather than hashing garbage. A hash of "not-an-email" is a
 * permanent non-match that Meta counts against the dataset's match quality,
 * so an omitted field is strictly better than a junk one.
 */
export function normaliseEmailForMeta(raw: string | null | undefined): string | null {
  const email = String(raw ?? "").trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) return null;
  return email;
}

/**
 * Phone → country code + digits, no `+` (Meta's required form: 447700900123).
 *
 * ⚠️ BUILT ON `normaliseUkMobile` DELIBERATELY, not hand-rolled. That function
 * carries the finding that 89 of 193 live management leads store the number as
 * `+44` followed by a FULL NATIONAL number (`+4407304208011`). The obvious
 * implementation turns those into `007304208011` and loses 46% of the book's
 * phone matches — with, again, no error anywhere.
 *
 * Its failure branches need different treatment here, because it is a strict
 * UK-MOBILE gate and Meta has no such requirement — the number just has to be
 * the one on the person's Facebook account:
 *
 *   foreign     → an explicit non-UK country code is a fact, not an error.
 *   not_mobile  → a UK landline is perfectly matchable. Fall back permissively.
 *   missing     → nothing to send.
 *   placeholder → all zeros identifies nobody.
 */
export function normalisePhoneForMeta(raw: string | null | undefined): string | null {
  const result = normaliseUkMobile(raw);
  if (result.ok) {
    // National `07…` → `447…`.
    return `44${result.value.slice(1)}`;
  }

  if (result.reason === "missing" || result.reason === "placeholder") return null;

  const digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits || /^0+$/.test(digits)) return null;

  if (result.reason === "foreign") {
    // Reached only when the caller signalled international with `+` or `00`,
    // so the leading zeros are the dialling prefix, not part of the number.
    const bare = digits.replace(/^0+/, "");
    return bare.length >= 8 ? bare : null;
  }

  // not_mobile: a UK landline, or a number normaliseUkMobile could not place.
  if (digits.startsWith("44")) {
    return digits.length >= 10 ? digits : null;
  }
  if (/^0\d{9,10}$/.test(digits)) {
    return `44${digits.replace(/^0+/, "")}`;
  }
  return digits.length >= 8 ? digits : null;
}

/**
 * Full name → { fn, ln }, lowercased.
 *
 * ⚠️ `ln` is the LAST TOKEN, never "everything after the first". Meta hashes
 * the exact string and compares it to the profile's `last_name` field, so
 * "jane smith" would never match "smith".
 *
 * `isJunkName` is asked first because an email address, `asdf` or `Dbncc` in
 * the name field — all real values in the live book — become permanent
 * non-matching hashes otherwise. Single-token names are 87 of 437 rows, so
 * those legitimately send `fn` alone.
 */
export function splitNameForMeta(
  raw: string | null | undefined
): { fn: string | null; ln: string | null } {
  const name = String(raw ?? "").trim();
  if (!name || isJunkName(name)) return { fn: null, ln: null };

  const first = firstNameOf(name);
  if (!first) return { fn: null, ln: null };

  const tokens = name.split(/\s+/);
  const last = tokens.length > 1 ? tokens[tokens.length - 1]! : null;

  return { fn: first.toLowerCase(), ln: last ? last.toLowerCase() : null };
}
